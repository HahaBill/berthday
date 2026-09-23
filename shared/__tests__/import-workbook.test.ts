import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { parseWorkbook, WorkbookImportError } from '../import-workbook';
import type { ImportReservationRow } from '../import-types';

const bytes = (path: string): ArrayBuffer => Uint8Array.from(readFileSync(path)).buffer;
const canonical = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).sort();
const goldenAvailable = ['vessels', 'reservations', 'import_issues'].every(name => existsSync(`migration/out/${name}.json`));
const blue: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3399FF' } };
async function workbookBytes(workbook: ExcelJS.Workbook): Promise<ArrayBuffer> {
  return Uint8Array.from(new Uint8Array(await workbook.xlsx.writeBuffer())).buffer;
}
function month(ws: ExcelJS.Worksheet, label = 'JANUARY 2030', row = 1) {
  ws.getCell(row, 1).value = label;
  for (let day = 1; day <= 31; day++) ws.getCell(row + 1, day + 1).value = day;
}
function bar(ws: ExcelJS.Worksheet, row: number, first: number, last: number, label?: string) {
  for (let col = first; col <= last; col++) ws.getCell(row, col).fill = blue;
  if (label) ws.getCell(row, first).value = label;
}
const bookings = (result: Awaited<ReturnType<typeof parseWorkbook>>) => result.rows.filter((row): row is ImportReservationRow => row.recordType !== 'vessel');

describe('legacy workbook import', () => {
  it.skipIf(!goldenAvailable)('matches every supplied migration booking and vessel (npm run migrate supplies the golden output)', async () => {
    const actual = await parseWorkbook(bytes('data/dock_schedule.xlsx'), 'dock_schedule.xlsx');
    const oldVessels = JSON.parse(readFileSync('migration/out/vessels.json', 'utf8'));
    const oldReservations = JSON.parse(readFileSync('migration/out/reservations.json', 'utf8'));
    const oldIssues = JSON.parse(readFileSync('migration/out/import_issues.json', 'utf8'));
    const byId = new Map<string, { name: string }>(oldVessels.map((v: { id: string; name: string }) => [v.id, v]));
    expect(actual.metadata).toMatchObject({ sheetsParsed: 23, reservationCount: 2587, vesselCount: 635 });
    expect(actual.rows).toHaveLength(3222);
    expect(actual.rows.slice(0, 635).every(row => row.recordType === 'vessel')).toBe(true);
    expect(canonical(actual.rows.filter(row => row.recordType === 'vessel').map(row => [row.vesselName, row.vesselLengthFt, row.vesselLengthStatus, row.vesselLengthNote, row.sourceRef])))
      .toEqual(canonical(oldVessels.map((row: Record<string, unknown>) => [row.name, row.length_ft, row.length_status, row.length_note, row.source])));
    expect(canonical(actual.rows.filter((row): row is ImportReservationRow => row.recordType !== 'vessel').map(row => [row.kind, row.berthId, row.vesselName ?? null, row.title ?? null, row.startDate, row.endDate, row.notes, row.sourceRef])))
      .toEqual(canonical(oldReservations.map((row: Record<string, string | null>) => [row.kind, row.berth_id, row.vessel_id ? byId.get(row.vessel_id)!.name : null, row.title, row.start_date, row.end_date, row.notes, row.source_ref])));
    const counts = (items: { code: string }[]) => items.reduce<Record<string, number>>((result, row) => { result[row.code] = (result[row.code] ?? 0) + 1; return result; }, {});
    expect(counts(actual.diagnostics)).toEqual(counts(oldIssues));
  }, 30_000);

  it('gives a readable failure for non-Excel, older .xls, and corrupt files', async () => {
    await expect(parseWorkbook(new ArrayBuffer(25), 'schedule.xls')).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE' });
    await expect(parseWorkbook(new ArrayBuffer(25), 'schedule.xlsx')).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
    await expect(parseWorkbook(new ArrayBuffer(26 * 1024 * 1024), 'schedule.xlsx')).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });

  it('keeps mid-bar vessel names, timing notes, merged events, holds, and closures distinct', async () => {
    const workbook = new ExcelJS.Workbook(), ws = workbook.addWorksheet('2030');
    month(ws);
    ws.getCell('A3').value = "North Pier Face - 100'";
    bar(ws, 3, 2, 4); ws.getCell('C3').value = 'R/V Clear Tern'; ws.getCell('D3').value = 'ETA noon';
    bar(ws, 3, 6, 7, 'Dock maintenance');
    bar(ws, 3, 9, 10);
    ws.mergeCells('L3:N3'); ws.getCell('L3').value = 'Harbor tour';
    const actual = await parseWorkbook(await workbookBytes(workbook), 'schedule.xlsm');
    expect(bookings(actual).map(row => [row.kind, row.startDate, row.endDate])).toEqual([
      ['vessel', '2030-01-01', '2030-01-03'], ['closure', '2030-01-05', '2030-01-06'],
      ['hold', '2030-01-08', '2030-01-09'], ['event', '2030-01-11', '2030-01-13'],
    ]);
    expect(bookings(actual)[0]).toMatchObject({ vesselName: 'R/V Clear Tern', sourceRef: '2030!B3:D3; 2030!C3', notes: 'ETA noon (2030!D3)' });
  });

  it('preserves duplicate lanes, maps unlabelled exclusive rows to Unassigned, and keeps pool rows shared', async () => {
    const workbook = new ExcelJS.Workbook(), ws = workbook.addWorksheet('2030');
    month(ws);
    ws.getCell('A3').value = "North Pier Face - 100'"; bar(ws, 3, 2, 3, 'R/V First');
    ws.getCell('A4').value = "North Pier Face - 100'"; bar(ws, 4, 2, 3, 'R/V Second');
    bar(ws, 5, 2, 3, 'R/V Unassigned');
    ws.getCell('A6').value = 'NORTH FINGER PIERS'; bar(ws, 6, 2, 3, 'R/V Pool One');
    bar(ws, 7, 2, 3, 'R/V Pool Two');
    const actual = await parseWorkbook(await workbookBytes(workbook), 'schedule.xlsx');
    expect(bookings(actual).map(row => row.berthId).sort()).toEqual(['north-finger-piers', 'north-finger-piers', 'north-pier-face', 'north-pier-face', 'unassigned']);
    expect(actual.diagnostics.map(d => d.code)).toEqual(expect.arrayContaining(['DUPLICATE_BERTH_ROW', 'UNLABELLED_ROW', 'UNLABELLED_POOL_ROW']));
  });

  it('stitches month boundaries and skips the repeated December rather than duplicating it', async () => {
    const workbook = new ExcelJS.Workbook(), original = workbook.addWorksheet('2029'), next = workbook.addWorksheet('2030');
    month(original, 'DECEMBER 2029'); original.getCell('A3').value = "North Pier West - 200'"; bar(original, 3, 31, 32, 'R/V Year End');
    month(next, 'DECEMBER 2029'); next.getCell('A3').value = "North Pier West - 200'"; bar(next, 3, 31, 32, 'R/V Year End');
    month(next, 'JANUARY 2030', 5); next.getCell('A7').value = "North Pier West - 200'"; bar(next, 7, 2, 3);
    const actual = await parseWorkbook(await workbookBytes(workbook), 'schedule.xlsx');
    expect(bookings(actual)).toHaveLength(1);
    expect(bookings(actual)[0]).toMatchObject({ startDate: '2029-12-30', endDate: '2030-01-02', vesselName: 'R/V Year End', sourceRef: '2029!AE3:AF3; 2030!B7:C7' });
    expect(actual.diagnostics).toContainEqual(expect.objectContaining({ code: 'CARRYOVER_DUPLICATE' }));
  });

  it('retains the only December copy when an annual workbook omits the original year', async () => {
    const workbook = new ExcelJS.Workbook(), ws = workbook.addWorksheet('2030');
    month(ws, 'DECEMBER 2029'); ws.getCell('A3').value = "North Pier West - 200'"; bar(ws, 3, 31, 32, 'R/V Year End');
    month(ws, 'JANUARY 2030', 5); ws.getCell('A7').value = "North Pier West - 200'"; bar(ws, 7, 2, 3);
    const actual = await parseWorkbook(await workbookBytes(workbook), 'annual.xlsx');
    expect(bookings(actual)).toHaveLength(1);
    expect(bookings(actual)[0]).toMatchObject({ startDate: '2029-12-30', endDate: '2030-01-02', sourceRef: '2030!AE3:AF3; 2030!B7:C7' });
    expect(actual.diagnostics).toContainEqual(expect.objectContaining({ code: 'CARRYOVER_ORIGINAL_MISSING', severity: 'warn' }));
  });

  it('uses numeric votes without evaluating formulas or importing invalid February dates', async () => {
    const workbook = new ExcelJS.Workbook(), ws = workbook.addWorksheet('2028');
    month(ws, 'FEBRUARY 2028');
    ws.getCell('C2').value = { formula: 'B2+1', result: 20 };
    ws.getCell('A3').value = "North Pier Face - 100'";
    bar(ws, 3, 29, 32, 'R/V Leap Day');
    const actual = await parseWorkbook(await workbookBytes(workbook), 'schedule.xlsx');
    expect(bookings(actual)[0]).toMatchObject({ startDate: '2028-02-28', endDate: '2028-02-29' });
    expect(actual.diagnostics.map(d => d.code)).toEqual(expect.arrayContaining(['HEADER_INVALID_DAY', 'DAY_NUMBERS_ARE_FORMULAS']));
  });

  it('preserves reference-only vessels and uses the larger disputed length with its evidence', async () => {
    const workbook = new ExcelJS.Workbook(), science = workbook.addWorksheet('Science'), yachts = workbook.addWorksheet('Yachts');
    science.getCell('A1').value = "R/V CLEAR TERN 24'"; science.getCell('B1').value = "LOA: 100'";
    yachts.getCell('A1').value = "R/V CLEAR TERN 90'";
    const actual = await parseWorkbook(await workbookBytes(workbook), 'registry.xlsx');
    expect(actual.rows).toHaveLength(1);
    expect(actual.rows[0]).toMatchObject({ recordType: 'vessel', vesselName: 'R/V Clear Tern', vesselLengthFt: 100, vesselLengthStatus: 'disputed', vesselLengthNote: "Disputed: 24' (Science!A1), 100' (Science!B1), 90' (Yachts!A1)" });
    expect(actual.diagnostics).toContainEqual(expect.objectContaining({ code: 'VESSEL_LENGTH_DISPUTED' }));
  });

  it('uses current custom resource names and warns when a labelled berth must be added first', async () => {
    const workbook = new ExcelJS.Workbook(), ws = workbook.addWorksheet('2030');
    month(ws);
    ws.getCell('A3').value = '  Visiting   dinghy floats '; bar(ws, 3, 2, 3, 'R/V Pool One');
    bar(ws, 4, 2, 3, 'R/V Pool Two');
    ws.getCell('A5').value = 'Custom North'; bar(ws, 5, 2, 3, 'R/V Custom');
    ws.getCell('A6').value = "Missing Dock - 75'"; bar(ws, 6, 2, 3, 'R/V Missing');
    ws.getCell('A7').value = 'Missing shared floats'; bar(ws, 7, 2, 3, 'Community sail day');
    bar(ws, 8, 2, 3, 'R/V Other Missing Vessel');
    ws.getCell('A9').value = 'Service notes'; ws.getCell('B9').value = 'ETA noon';
    const actual = await parseWorkbook(await workbookBytes(workbook), 'schedule.xlsx', [
      { id: 'dinghy-floats', name: 'Visiting dinghy floats', lengthFt: null, isExclusive: false, sortOrder: 1 },
      { id: 'custom-north', name: 'Custom North', lengthFt: 150, isExclusive: true, sortOrder: 2 },
    ]);
    expect(bookings(actual).map(row => row.berthId).sort()).toEqual(['custom-north', 'dinghy-floats', 'dinghy-floats', 'missing-dock']);
    expect(actual.diagnostics).toContainEqual(expect.objectContaining({ code: 'RESOURCE_NOT_FOUND', message: expect.stringContaining('Add this resource') }));
    expect(actual.diagnostics.filter(d => d.code === 'RESOURCE_NOT_FOUND').map(d => d.cell)).toEqual(['A6', 'A7']);
  });

  it('retains missing-header diagnostics in a clear empty-workbook error', async () => {
    const workbook = new ExcelJS.Workbook(), ws = workbook.addWorksheet('2030');
    ws.getCell('A1').value = 'JANUARY 2030'; ws.getCell('A3').value = "North Pier Face - 100'"; bar(ws, 3, 2, 3, 'R/V Missing Dates');
    let error: unknown;
    try { await parseWorkbook(await workbookBytes(workbook), 'schedule.xlsx'); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(WorkbookImportError);
    expect(error).toMatchObject({ code: 'NO_BOOKINGS_FOUND', diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'NO_DAY_HEADER', cell: 'A1' })]) });
  });

  it('rejects an enormous sparse merge before ExcelJS can instantiate the cells', async () => {
    const workbook = new ExcelJS.Workbook(), ws = workbook.addWorksheet('2030');
    month(ws); ws.getCell('A3').value = "North Pier Face - 100'"; bar(ws, 3, 2, 3, 'R/V Small');
    const zip = await JSZip.loadAsync(await workbookBytes(workbook));
    const path = 'xl/worksheets/sheet1.xml', xml = await zip.file(path)!.async('string');
    zip.file(path, xml.replace('</worksheet>', '<mergeCells count="1"><mergeCell ref="B3:XFD1048576"/></mergeCells></worksheet>'));
    await expect(parseWorkbook(await zip.generateAsync({ type: 'arraybuffer' }), 'schedule.xlsx')).rejects.toMatchObject({ code: 'WORKBOOK_TOO_COMPLEX' });
  });
});
