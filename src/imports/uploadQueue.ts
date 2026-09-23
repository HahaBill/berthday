import type { ImportFileRegistration, ImportJobDTO, ImportStageResponse } from '../../shared/import-types';
import type { BerthDTO } from '../../shared/types';
import { api, ApiError } from '../api';
import { parseWorkbookFile } from './parseClient';

export const MAX_QUEUE_FILES = 5000;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export interface QueuedWorkbook {
  id: string;
  file: File;
  name: string;
  status: 'queued' | 'reading' | 'staging' | 'ready' | 'duplicate' | 'error';
  detail: string;
  records?: number;
  warnings?: number;
}
export const canPrepareWorkbook = (item: QueuedWorkbook) => ['queued', 'error'].includes(item.status) && /\.(xlsx|xlsm)$/i.test(item.file.name) && item.file.size > 0 && item.file.size <= MAX_FILE_BYTES;
export function prepareFiles(files: File[], existing: QueuedWorkbook[]): QueuedWorkbook[] {
  if (files.length + existing.length > MAX_QUEUE_FILES) throw new Error('Choose up to 5,000 workbooks per import. You can create another import for the remaining files.');
  return files.map(file => {
    const reason = !/\.(xlsx|xlsm)$/i.test(file.name) ? 'Save this file as .xlsx or .xlsm before importing.' : file.size > MAX_FILE_BYTES ? 'This workbook exceeds 25 MB. Split it into smaller workbooks.' : file.size === 0 ? 'This file is empty.' : '';
    return { id: crypto.randomUUID(), file, name: file.webkitRelativePath || file.name, status: reason ? 'error' : 'queued', detail: reason || 'Waiting to read' };
  });
}
export async function importRequest<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try { return await api<T>(path, { method: 'POST', body: JSON.stringify(body), signal }); }
    catch (error) {
      if (signal?.aborted || attempt >= 2 || (error instanceof ApiError && error.code !== 'INTERNAL')) throw error;
      await new Promise<void>((resolve, reject) => {
        const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
        const timer = setTimeout(finish, 500 * 2 ** attempt);
        const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')); };
        signal?.addEventListener('abort', abort, { once: true });
      });
    }
  }
}
async function fileHash(file: File) {
  const bytes = await file.arrayBuffer();
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
}
export async function stageWorkbook(jobId: string, item: QueuedWorkbook, signal: AbortSignal, update: (patch: Partial<QueuedWorkbook>) => void, onJob: (job: ImportJobDTO) => void, berths: readonly BerthDTO[] = []) {
  update({ status: 'reading', detail: 'Checking workbook' });
  const hash = await fileHash(item.file);
  signal.throwIfAborted();
  const parsed = await parseWorkbookFile(item.file, { signal, berths, onProgress: detail => update({ detail }) });
  signal.throwIfAborted();
  if (!parsed.rows.length) throw new Error(parsed.diagnostics.find(diagnostic => diagnostic.severity === 'error')?.message ?? 'No bookings or vessel records were found. Use the annual dock-schedule layout with month and day headings.');
  const file = await importRequest<ImportFileRegistration>(`/import/jobs/${jobId}/files`, { name: item.name.slice(0, 255), sha256: hash, rowCount: parsed.rows.length, diagnostics: parsed.diagnostics }, signal);
  if (file.duplicate || file.status === 'duplicate' || file.status === 'completed') {
    update({ status: 'duplicate', records: parsed.rows.length, detail: 'This workbook was already imported. Skipped.' }); return;
  }
  if (file.status === 'staged') {
    update({ status: 'duplicate', records: parsed.rows.length, detail: 'This workbook is already prepared in this import. Included once.' }); return;
  }
  update({ status: 'staging', records: parsed.rows.length, warnings: parsed.diagnostics.filter(d => d.severity !== 'info').length });
  for (let offset = file.stagedRows; offset < parsed.rows.length; offset += 100) {
    signal.throwIfAborted();
    const result = await importRequest<ImportStageResponse>(`/import/jobs/${jobId}/files/${file.id}/rows`, { offset, rows: parsed.rows.slice(offset, offset + 100) }, signal);
    onJob(result.job); update({ detail: `${result.file.stagedRows.toLocaleString()} of ${parsed.rows.length.toLocaleString()} records prepared` });
  }
  update({ status: 'ready', detail: `${parsed.metadata?.reservationCount ?? parsed.rows.filter(row => row.recordType !== 'vessel').length} bookings ready to review` });
}
