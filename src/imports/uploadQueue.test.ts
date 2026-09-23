import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportFileRegistration, ImportJobDTO, ImportReservationRow, ParsedImportFile } from '../../shared/import-types';
import { api, ApiError } from '../api';
import { parseWorkbookFile } from './parseClient';
import { canPrepareWorkbook, importRequest, MAX_FILE_BYTES, prepareFiles, stageWorkbook } from './uploadQueue';

vi.mock('../api', async importOriginal => ({ ...await importOriginal<typeof import('../api')>(), api: vi.fn() }));
vi.mock('./parseClient', () => ({ parseWorkbookFile: vi.fn() }));
const request = vi.mocked(api), parse = vi.mocked(parseWorkbookFile);
const job = { id: 'job-1', name: 'Test import', status: 'staging', fileCount: 1, totalRows: 250, stagedRows: 0, processedRows: 0, importedReservations: 0, importedVessels: 0, duplicateRows: 0, invalidRows: 0, issueCount: 0, dateFrom: null, dateTo: null, createdAt: '2030-01-01T00:00:00Z', updatedAt: '2030-01-01T00:00:00Z' } satisfies ImportJobDTO;
function selected() { return prepareFiles([new File(['workbook bytes'], 'schedule.xlsx')], [])[0]; }
function parsed(count: number): ParsedImportFile {
  return { rows: Array.from({ length: count }, (_, index): ImportReservationRow => ({ recordType: 'reservation', kind: 'event', berthId: 'north-pier-face', title: `Event ${index}`, startDate: '2030-01-01', endDate: '2030-01-02' })), diagnostics: [], metadata: { reservationCount: count, vesselCount: 0 } };
}
function registered(stagedRows = 0, overrides: Partial<ImportFileRegistration> = {}): ImportFileRegistration {
  return { id: 'file-1', jobId: job.id, name: 'schedule.xlsx', sha256: '0'.repeat(64), rowCount: 250, stagedRows, processedRows: 0, importedReservations: 0, importedVessels: 0, duplicateRows: 0, invalidRows: 0, status: 'staging', diagnostics: [], duplicateOfFileId: null, createdAt: job.createdAt, updatedAt: job.updatedAt, duplicate: false, ...overrides };
}
function postedRows() { return request.mock.calls.filter(([path]) => path.endsWith('/rows')).map(([, init]) => JSON.parse(String(init?.body)) as { offset: number; rows: ImportReservationRow[] }); }
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); });

describe('bulk workbook queue', () => {
  it('allows 5,000 selected files and rejects a batch that would exceed the combined queue limit', () => {
    const file = new File(['x'], 'schedule.xlsx');
    expect(prepareFiles(Array(5000).fill(file), [])).toHaveLength(5000);
    expect(() => prepareFiles(Array(5000).fill(file), [selected()])).toThrow('5,000');
    expect(prepareFiles(Array(4999).fill(file), [selected()])).toHaveLength(4999);
  });

  it('keeps per-file errors beside valid files and preserves the folder-relative name', () => {
    const big = new File(['x'], 'large.xlsx'); Object.defineProperty(big, 'size', { value: MAX_FILE_BYTES + 1 });
    const nested = new File(['x'], 'schedule.XLSM'); Object.defineProperty(nested, 'webkitRelativePath', { value: 'harbor/2030/schedule.XLSM' });
    const result = prepareFiles([new File(['x'], 'old.xls'), new File([], 'empty.xlsx'), big, nested], []);
    expect(result.map(file => file.status)).toEqual(['error', 'error', 'error', 'queued']);
    expect(result[0].detail).toContain('.xlsx'); expect(result[1].detail).toContain('empty'); expect(result[2].detail).toContain('25 MB');
    expect(result[3].name).toBe('harbor/2030/schedule.XLSM');
    expect(result.map(canPrepareWorkbook)).toEqual([false, false, false, true]);
    expect(canPrepareWorkbook({ ...result[3], status: 'error' })).toBe(true);
    expect(canPrepareWorkbook({ ...result[3], status: 'ready' })).toBe(false);
  });

  it('prepares a whole workbook before server writes and stages records in chunks of 100', async () => {
    const result = parsed(250), update = vi.fn(), onJob = vi.fn(), controller = new AbortController();
    const berths = [{ id: 'north-pier-face', name: 'North Pier Face', lengthFt: 100, isExclusive: true, sortOrder: 1 }];
    parse.mockResolvedValue(result);
    request.mockImplementation(async (path, init) => {
      expect(parse).toHaveBeenCalledOnce();
      if (path.endsWith('/files')) return registered();
      const body = JSON.parse(String(init?.body));
      return { job: { ...job, stagedRows: body.offset + body.rows.length }, file: { ...registered(), stagedRows: body.offset + body.rows.length } };
    });
    await stageWorkbook(job.id, selected(), controller.signal, update, onJob, berths);
    expect(parse).toHaveBeenCalledWith(expect.any(File), expect.objectContaining({ signal: controller.signal, berths }));
    expect(postedRows().map(chunk => [chunk.offset, chunk.rows.length])).toEqual([[0, 100], [100, 100], [200, 50]]);
    expect(postedRows().flatMap(chunk => chunk.rows)).toEqual(result.rows);
    expect(request.mock.calls[0][0]).toBe('/import/jobs/job-1/files');
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toMatchObject({ rowCount: 250, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(onJob).toHaveBeenCalledTimes(3);
    expect(update).toHaveBeenLastCalledWith({ status: 'ready', detail: '250 bookings ready to review' });
  });

  it('resumes at the server offset even when the saved offset is not a chunk boundary', async () => {
    parse.mockResolvedValue(parsed(250));
    request.mockResolvedValueOnce(registered(175)).mockResolvedValueOnce({ job: { ...job, stagedRows: 250 }, file: registered(250) });
    await stageWorkbook(job.id, selected(), new AbortController().signal, vi.fn(), vi.fn());
    expect(postedRows().map(chunk => [chunk.offset, chunk.rows.length])).toEqual([[175, 75]]);
    expect(postedRows()[0].rows[0].title).toBe('Event 175');
  });

  it('does not restage a duplicate or already completed workbook', async () => {
    parse.mockResolvedValue(parsed(250));
    request.mockResolvedValue(registered(250, { duplicate: true, status: 'duplicate' }));
    const update = vi.fn();
    await stageWorkbook(job.id, selected(), new AbortController().signal, update, vi.fn());
    expect(request).toHaveBeenCalledOnce(); expect(postedRows()).toEqual([]);
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'duplicate' }));
  });

  it('identifies a same-job staged duplicate as prepared once rather than already imported', async () => {
    parse.mockResolvedValue(parsed(250)); request.mockResolvedValue(registered(250, { status: 'staged' }));
    const update = vi.fn();
    await stageWorkbook(job.id, selected(), new AbortController().signal, update, vi.fn());
    expect(request).toHaveBeenCalledOnce(); expect(postedRows()).toEqual([]);
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'duplicate', detail: expect.stringContaining('already prepared in this import') }));
  });

  it('never registers or stages a malformed workbook or a parse result with no records', async () => {
    parse.mockRejectedValueOnce(new Error('No day numbers found'));
    await expect(stageWorkbook(job.id, selected(), new AbortController().signal, vi.fn(), vi.fn())).rejects.toThrow('No day numbers');
    expect(request).not.toHaveBeenCalled();
    parse.mockResolvedValueOnce({ rows: [], diagnostics: [{ code: 'NO_DAY_HEADER', severity: 'error', message: 'Missing day header' }] });
    await expect(stageWorkbook(job.id, selected(), new AbortController().signal, vi.fn(), vi.fn())).rejects.toThrow('Missing day header');
    expect(request).not.toHaveBeenCalled();
  });

  it('stops on a rejected staging chunk and does not mark the partially saved file ready', async () => {
    parse.mockResolvedValue(parsed(250));
    request.mockResolvedValueOnce(registered()).mockResolvedValueOnce({ job: { ...job, stagedRows: 100 }, file: registered(100) })
      .mockRejectedValueOnce(new ApiError({ code: 'VALIDATION', message: 'Invalid record' }));
    const update = vi.fn();
    await expect(stageWorkbook(job.id, selected(), new AbortController().signal, update, vi.fn())).rejects.toThrow('Invalid record');
    expect(postedRows().map(chunk => chunk.offset)).toEqual([0, 100]);
    expect(update.mock.calls.some(([patch]) => patch.status === 'ready')).toBe(false);
  });

  it('checks cancellation after local hashing before parsing or making a server request', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(stageWorkbook(job.id, selected(), controller.signal, vi.fn(), vi.fn())).rejects.toMatchObject({ name: 'AbortError' });
    expect(parse).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  });
});

describe('idempotent import request retries', () => {
  it('retries a transient network error with the identical request', async () => {
    vi.useFakeTimers();
    request.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce({ ok: true });
    const pending = importRequest('/import/jobs/job-1/files/file-1/rows', { offset: 100, rows: parsed(1).rows });
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]).toEqual(request.mock.calls[1]);
  });

  it('does not retry a validation failure', async () => {
    request.mockRejectedValue(new ApiError({ code: 'VALIDATION', message: 'Wrong offset' }));
    await expect(importRequest('/import/jobs/job-1/files/file-1/rows', {})).rejects.toThrow('Wrong offset');
    expect(request).toHaveBeenCalledOnce();
  });

  it('cancels a scheduled retry without sending the next request', async () => {
    vi.useFakeTimers();
    request.mockRejectedValue(new TypeError('Failed to fetch'));
    const controller = new AbortController(), pending = importRequest('/import/jobs/job-1/commit', { limit: 10 }, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0); controller.abort();
    await rejected; await vi.advanceTimersByTimeAsync(2000);
    expect(request).toHaveBeenCalledOnce();
  });
});
