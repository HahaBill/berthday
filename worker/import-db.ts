import type { ImportDiagnostic, ImportFileDTO, ImportFileRegistration, ImportJobDTO, ImportPreviewDTO, ImportRowPreview, ParsedImportRow } from '../shared/import-types';
import { getBerths, normalizeName } from './db';
import { ApiError, missing } from './errors';
import { importRowSchema } from './import-validation';

type Row = Record<string, unknown>;
type Value = string | number | null;
const stamp = () => new Date().toISOString();
const nullable = (value: unknown) => value == null ? null : String(value);
const num = (value: unknown) => Number(value ?? 0);
function parseJson<T>(value: unknown, fallback: T): T { try { return typeof value === 'string' ? JSON.parse(value) as T : fallback; } catch { return fallback; } }
const stateError = (message: string) => new ApiError(409, 'IMPORT_STATE', message);

function jobDTO(row: Row): ImportJobDTO {
  return { id: String(row.id), name: String(row.name), status: row.status as ImportJobDTO['status'], createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    fileCount: num(row.file_count), totalRows: num(row.total_rows), stagedRows: num(row.staged_rows), processedRows: num(row.processed_rows),
    importedReservations: num(row.imported_reservations), importedVessels: num(row.imported_vessels), duplicateRows: num(row.duplicate_rows), invalidRows: num(row.invalid_rows),
    issueCount: num(row.issue_count), dateFrom: nullable(row.date_from), dateTo: nullable(row.date_to) };
}
function fileDTO(row: Row): ImportFileDTO {
  return { id: String(row.id), jobId: String(row.job_id), name: String(row.name), sha256: String(row.sha256), rowCount: num(row.row_count), stagedRows: num(row.staged_rows),
    processedRows: num(row.processed_rows), importedReservations: num(row.imported_reservations), importedVessels: num(row.imported_vessels),
    duplicateRows: num(row.duplicate_rows), invalidRows: num(row.invalid_rows), status: row.status as ImportFileDTO['status'], diagnostics: parseJson(row.diagnostics, []),
    duplicateOfFileId: nullable(row.duplicate_of_file_id), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}
export async function getImportJob(db: D1Database, id: string): Promise<ImportJobDTO> {
  const row = await db.prepare('SELECT * FROM import_jobs WHERE id = ?').bind(id).first<Row>();
  if (!row) throw missing('Import job'); return jobDTO(row);
}
export async function getImportFile(db: D1Database, jobId: string, fileId: string): Promise<ImportFileDTO> {
  const row = await db.prepare('SELECT * FROM import_files WHERE id = ? AND job_id = ?').bind(fileId, jobId).first<Row>();
  if (!row) throw missing('Import file'); return fileDTO(row);
}
export async function createImportJob(db: D1Database, name?: string): Promise<ImportJobDTO> {
  const id = crypto.randomUUID(), now = stamp();
  await db.prepare('INSERT INTO import_jobs (id,name,created_at,updated_at) VALUES (?,?,?,?)').bind(id, name ?? 'Workbook import', now, now).run();
  return getImportJob(db, id);
}
export async function listImportJobs(db: D1Database, limit = 20, cursor?: string) {
  const values: Value[] = []; let condition = '';
  if (cursor) {
    let parts: unknown;
    try { parts = JSON.parse(decodeURIComponent(cursor)); } catch { throw new ApiError(400, 'VALIDATION_ERROR', 'The import job cursor is invalid.'); }
    if (!Array.isArray(parts) || parts.length !== 2 || parts.some(value => typeof value !== 'string')) throw new ApiError(400, 'VALIDATION_ERROR', 'The import job cursor is invalid.');
    condition = 'WHERE created_at < ? OR (created_at = ? AND id < ?)'; values.push(parts[0], parts[0], parts[1]);
  }
  const { results } = await db.prepare(`SELECT * FROM import_jobs ${condition} ORDER BY created_at DESC,id DESC LIMIT ?`).bind(...values, limit + 1).all<Row>();
  const items = results.slice(0, limit).map(jobDTO), last = items.at(-1);
  return { items, nextCursor: results.length > limit && last ? encodeURIComponent(JSON.stringify([last.createdAt, last.id])) : null };
}
export async function listImportFiles(db: D1Database, jobId: string, limit = 100, offset = 0) {
  const job = await getImportJob(db, jobId);
  const { results } = await db.prepare('SELECT * FROM import_files WHERE job_id = ? ORDER BY created_at,id LIMIT ? OFFSET ?').bind(jobId, limit, offset).all<Row>();
  return { items: results.map(fileDTO), total: job.fileCount, limit, offset };
}
export async function registerImportFile(db: D1Database, jobId: string, input: { name: string; sha256: string; rowCount: number; diagnostics?: ImportDiagnostic[] }): Promise<ImportFileRegistration> {
  const job = await getImportJob(db, jobId);
  const existing = await db.prepare('SELECT * FROM import_files WHERE job_id = ? AND sha256 = ?').bind(jobId, input.sha256).first<Row>();
  if (existing) {
    if (num(existing.row_count) !== input.rowCount) throw stateError('This file was already registered with a different row count. Start a new import job.');
    const file = fileDTO(existing); return { ...file, duplicate: file.status === 'duplicate' };
  }
  if (job.status !== 'staging') throw stateError('Files can only be added while an import is being prepared. Start a new import job.');
  // A cancelled or unfinished file is never a whole-file duplicate: its remaining
  // records still need importing. Per-row semantic keys cover partial retries.
  const prior = await db.prepare("SELECT id FROM import_files WHERE sha256 = ? AND row_count = ? AND status = 'completed' AND invalid_rows = 0 LIMIT 1").bind(input.sha256, input.rowCount).first<{ id: string }>();
  const id = crypto.randomUUID(), now = stamp(), duplicate = Boolean(prior), progress = duplicate ? input.rowCount : 0;
  const diagnostics = (input.diagnostics ?? []).slice(0, 100);
  if ((input.diagnostics?.length ?? 0) > 100) diagnostics.push({ code: 'ADDITIONAL_DIAGNOSTICS', severity: 'info', message: `${input.diagnostics!.length - 100} additional parser diagnostics were omitted from this stored preview.` });
  if (!input.rowCount) diagnostics.push({ code: 'NO_IMPORTABLE_ROWS', severity: 'warn', message: 'No importable records were found. Check the workbook layout and parser diagnostics.' });
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO import_files (id,job_id,name,sha256,row_count,staged_rows,processed_rows,duplicate_rows,status,diagnostics,duplicate_of_file_id,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM import_jobs WHERE id = ? AND status = 'staging')`)
      .bind(id, jobId, input.name, input.sha256, input.rowCount, progress, progress, progress, duplicate ? 'duplicate' : input.rowCount ? 'staging' : 'staged', JSON.stringify(diagnostics), prior?.id ?? null, now, now, jobId),
    db.prepare(`UPDATE import_jobs SET file_count = file_count + 1, total_rows = total_rows + ?, staged_rows = staged_rows + ?, processed_rows = processed_rows + ?, duplicate_rows = duplicate_rows + ?, updated_at = ?
      WHERE id = ? AND EXISTS (SELECT 1 FROM import_files WHERE id = ?)`)
      .bind(input.rowCount, progress, progress, progress, now, jobId, id),
  ]);
  const registered = await db.prepare('SELECT * FROM import_files WHERE job_id = ? AND sha256 = ?').bind(jobId, input.sha256).first<Row>();
  if (!registered) throw stateError('The import changed while registering this file. Reload its status.');
  const file = fileDTO(registered); return { ...file, duplicate: file.status === 'duplicate' };
}

interface StagedRow {
  index: number; hash: string; payload: string | null; error: string | null; recordType: string | null;
  kind: string | null; berthId: string | null; vesselName: string | null; vesselKey: string | null;
  vesselLength: number | null; vesselStatus: string | null; vesselNote: string | null; vesselId: string | null;
  reservationId: string | null; title: string | null; normalizedTitle: string | null; start: string | null; end: string | null; notes: string | null; source: string | null;
}
async function contentHash(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
async function prepareRow(raw: unknown, index: number, berths: Set<string>): Promise<StagedRow> {
  const serialized = JSON.stringify(raw), result = importRowSchema.safeParse(raw);
  const base: StagedRow = { index, hash: await contentHash(serialized), payload: serialized.length <= 25_000 ? serialized : null, error: null,
    recordType: null, kind: null, berthId: null, vesselName: null, vesselKey: null, vesselLength: null, vesselStatus: null, vesselNote: null,
    vesselId: null, reservationId: null, title: null, normalizedTitle: null, start: null, end: null, notes: null, source: null };
  if (!result.success) { base.error = result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 2000); return base; }
  const row = result.data;
  if (row.recordType !== 'vessel' && !berths.has(row.berthId)) { base.error = `Unknown berth ${row.berthId}. Add the resource before importing this record.`; return base; }
  base.recordType = row.recordType ?? 'reservation'; base.source = row.sourceRef ?? null;
  if (row.vesselName) {
    base.vesselName = normalizeName(row.vesselName); base.vesselKey = base.vesselName.toUpperCase(); base.vesselLength = row.vesselLengthFt ?? null;
    base.vesselStatus = base.vesselLength == null ? 'unknown' : row.vesselLengthStatus === 'disputed' ? 'disputed' : 'known';
    base.vesselNote = row.vesselLengthNote ?? null; base.vesselId = crypto.randomUUID();
  }
  if (row.recordType !== 'vessel') {
    base.kind = row.kind; base.berthId = row.berthId; base.start = row.startDate; base.end = row.endDate;
    base.title = row.kind === 'vessel' ? row.title ?? null : normalizeName(row.title!);
    base.normalizedTitle = row.kind === 'vessel' ? '' : base.title;
    base.notes = row.notes ?? null; base.reservationId = crypto.randomUUID();
  }
  return base;
}
export async function stageImportRows(db: D1Database, jobId: string, fileId: string, offset: number, rawRows: unknown[]) {
  const [job, file, berths] = await Promise.all([getImportJob(db, jobId), getImportFile(db, jobId, fileId), getBerths(db)]);
  if (offset + rawRows.length > file.rowCount) throw new ApiError(400, 'VALIDATION_ERROR', 'This batch exceeds the registered file row count.');
  if (offset > file.stagedRows) throw stateError(`Resume this file from row ${file.stagedRows}. Batches must be staged in order.`);
  const known = new Set(berths.map(berth => berth.id));
  const rows = await Promise.all(rawRows.map((row, index) => prepareRow(row, offset + index, known)));
  const payload = JSON.stringify(rows);
  if (new TextEncoder().encode(payload).byteLength > 1_800_000) throw new ApiError(413, 'IMPORT_BATCH_TOO_LARGE', 'The expanded staging batch is too large. Send fewer records in this batch and retry from the same row.');
  const previous = await db.prepare('SELECT row_index,content_hash FROM import_rows WHERE file_id = ? AND row_index >= ? AND row_index < ?').bind(fileId, offset, offset + rawRows.length).all<{ row_index: number; content_hash: string }>();
  if (previous.results.some(row => rows[row.row_index - offset].hash !== row.content_hash)) throw new ApiError(409, 'IMPORT_ROW_CONFLICT', 'A staged row changed during a retry. Start a new import job for the modified file.');
  if (previous.results.length === rows.length) return { job, file };
  if (job.status !== 'staging' || !['staging', 'staged'].includes(file.status)) throw stateError('This import is no longer accepting staged rows.');
  const token = crypto.randomUUID(), now = stamp();
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO import_rows (job_id,file_id,row_index,content_hash,payload,validation_error,record_type,kind,berth_id,vessel_name,vessel_key,vessel_length_ft,vessel_length_status,vessel_length_note,generated_vessel_id,generated_reservation_id,title,normalized_title,start_date,end_date,notes,source_ref,stage_token)
      SELECT ?1,?2,json_extract(value,'$.index'),json_extract(value,'$.hash'),json_extract(value,'$.payload'),json_extract(value,'$.error'),json_extract(value,'$.recordType'),json_extract(value,'$.kind'),json_extract(value,'$.berthId'),json_extract(value,'$.vesselName'),json_extract(value,'$.vesselKey'),json_extract(value,'$.vesselLength'),json_extract(value,'$.vesselStatus'),json_extract(value,'$.vesselNote'),json_extract(value,'$.vesselId'),json_extract(value,'$.reservationId'),json_extract(value,'$.title'),json_extract(value,'$.normalizedTitle'),json_extract(value,'$.start'),json_extract(value,'$.end'),json_extract(value,'$.notes'),json_extract(value,'$.source'),?3
      FROM json_each(?4) WHERE EXISTS (SELECT 1 FROM import_jobs WHERE id = ?1 AND status = 'staging')`).bind(jobId, fileId, token, payload),
    db.prepare(`UPDATE import_files SET staged_rows = staged_rows + (SELECT count(*) FROM import_rows WHERE stage_token = ?1),
      invalid_rows = invalid_rows + (SELECT count(*) FROM import_rows WHERE stage_token = ?1 AND validation_error IS NOT NULL),
      status = CASE WHEN staged_rows + (SELECT count(*) FROM import_rows WHERE stage_token = ?1) = row_count THEN 'staged' ELSE status END, updated_at = ?2 WHERE id = ?3
      AND EXISTS (SELECT 1 FROM import_rows WHERE stage_token = ?1)`).bind(token, now, fileId),
    db.prepare(`UPDATE import_jobs SET staged_rows = staged_rows + (SELECT count(*) FROM import_rows WHERE stage_token = ?1),
      invalid_rows = invalid_rows + (SELECT count(*) FROM import_rows WHERE stage_token = ?1 AND validation_error IS NOT NULL),
      date_from = coalesce(min(date_from,(SELECT min(start_date) FROM import_rows WHERE stage_token = ?1)),date_from,(SELECT min(start_date) FROM import_rows WHERE stage_token = ?1)),
      date_to = coalesce(max(date_to,(SELECT max(end_date) FROM import_rows WHERE stage_token = ?1)),date_to,(SELECT max(end_date) FROM import_rows WHERE stage_token = ?1)), updated_at = ?2 WHERE id = ?3
      AND EXISTS (SELECT 1 FROM import_rows WHERE stage_token = ?1)`).bind(token, now, jobId),
  ]);
  const stored = await db.prepare('SELECT row_index,content_hash FROM import_rows WHERE file_id = ? AND row_index >= ? AND row_index < ?').bind(fileId, offset, offset + rawRows.length).all<{ row_index: number; content_hash: string }>();
  if (stored.results.length !== rows.length || stored.results.some(row => rows[row.row_index - offset].hash !== row.content_hash)) throw stateError('The import changed while staging rows. Reload its progress before resuming.');
  return { job: await getImportJob(db, jobId), file: await getImportFile(db, jobId, fileId) };
}

export async function previewImport(db: D1Database, jobId: string): Promise<ImportPreviewDTO> {
  let job = await getImportJob(db, jobId);
  if (job.status === 'staging') {
    if (!job.fileCount || job.stagedRows !== job.totalRows) throw stateError('Finish staging every file before reviewing this import.');
    await db.prepare("UPDATE import_jobs SET status = 'ready', updated_at = ? WHERE id = ? AND status = 'staging' AND staged_rows = total_rows AND file_count > 0").bind(stamp(), jobId).run();
    job = await getImportJob(db, jobId);
  }
  const results = await db.batch<Row>([
    db.prepare(`SELECT r.*, f.name AS file_name FROM import_rows r JOIN import_files f ON f.id = r.file_id WHERE r.job_id = ?
      ORDER BY (r.validation_error IS NOT NULL) DESC, (r.record_type = 'reservation') DESC, r.id LIMIT 20`).bind(jobId),
    db.prepare('SELECT j.value AS diagnostic FROM import_files f, json_each(f.diagnostics) j WHERE f.job_id = ? LIMIT 100').bind(jobId),
  ]);
  const rows: ImportRowPreview[] = results[0].results.map(row => ({ fileId: String(row.file_id), fileName: String(row.file_name), index: num(row.row_index), row: parseJson<ParsedImportRow | null>(row.payload, null), error: nullable(row.validation_error), status: row.status as ImportRowPreview['status'] }));
  const diagnostics = results[1].results.map(row => parseJson<ImportDiagnostic>(row.diagnostic, { code: 'IMPORT_NOTE', message: 'Parser note unavailable.' }));
  return { job, rows, diagnostics, message: job.totalRows ? 'Review these records before importing. Existing bookings and vessel facts stay unchanged. Exact duplicates are skipped when each batch is applied; imported conflicts appear in Issues.' : 'No importable records were found. Check the file diagnostics before continuing.' };
}

export async function cancelImport(db: D1Database, jobId: string): Promise<ImportJobDTO> {
  await getImportJob(db, jobId);
  await db.batch([
    db.prepare("UPDATE import_jobs SET status = 'cancelled', updated_at = ? WHERE id = ? AND status NOT IN ('completed','cancelled')").bind(stamp(), jobId),
    db.prepare("UPDATE import_files SET status = 'cancelled', updated_at = ? WHERE job_id = ? AND status NOT IN ('completed','duplicate') AND EXISTS (SELECT 1 FROM import_jobs WHERE id = ? AND status = 'cancelled')").bind(stamp(), jobId, jobId),
  ]);
  return getImportJob(db, jobId);
}

/** One small transaction advances a persistent cursor. Every data mutation is
 * guarded by the same compare-and-swap token, so a racing commit or cancellation
 * cannot apply stale work. JSON payloads keep each statement below D1's 100 binds;
 * this operation uses 15 batch statements and three reads, independent of rows. */
export async function commitImport(db: D1Database, jobId: string, requestedLimit = 10): Promise<ImportJobDTO> {
  const job = await getImportJob(db, jobId);
  if (job.status === 'completed' || job.status === 'cancelled') return job;
  if (job.status === 'staging') throw stateError('Review the completed import preview before applying records.');
  const pending = await db.prepare("SELECT id FROM import_rows WHERE job_id = ? AND status = 'staged' ORDER BY id LIMIT ?")
    .bind(jobId, Math.min(requestedLimit, 20)).all<{ id: number }>();
  const token = crypto.randomUUID(), now = stamp(), ids = JSON.stringify(pending.results.map(row => row.id));
  const guard = "EXISTS (SELECT 1 FROM import_jobs WHERE id = ?1 AND commit_token = ?2 AND status = 'importing')";
  const prefix = `WITH selected AS (SELECT * FROM import_rows WHERE job_id = ?1 AND status = 'staged'
      AND id IN (SELECT value FROM json_each(?3)) AND ?4 IS NOT NULL AND ${guard}),
    processed AS (SELECT * FROM import_rows WHERE job_id = ?1 AND commit_token = ?2),
    added AS (SELECT a.*, r.file_id FROM reservations a JOIN selected r ON a.id = r.generated_reservation_id),
    span AS (SELECT coalesce(CAST((SELECT value FROM app_meta WHERE key = 'max_span_days') AS INTEGER),366) AS days)`;
  const statement = (sql: string) => db.prepare(`${prefix} ${sql}`).bind(jobId, token, ids, now);
  const semantic = "json_array(berth_id,kind,coalesce(resolved_vessel_id,''),CASE WHEN kind = 'vessel' THEN '' ELSE upper(normalized_title) END,start_date,end_date)";
  await db.batch([
    db.prepare("UPDATE import_jobs SET status = 'importing', commit_token = ?, updated_at = ? WHERE id = ? AND status IN ('ready','importing') AND processed_rows = ?")
      .bind(token, now, jobId, job.processedRows),
    statement(`INSERT OR IGNORE INTO vessels (id,name,name_key,length_ft,length_status,length_note,source,created_at,updated_at)
      SELECT r.generated_vessel_id,r.vessel_name,r.vessel_key,r.vessel_length_ft,r.vessel_length_status,r.vessel_length_note,
        'Workbook import: ' || f.name,?4,?4 FROM selected r JOIN import_files f ON f.id = r.file_id
      WHERE r.validation_error IS NULL AND r.vessel_key IS NOT NULL ORDER BY r.id`),
    statement(`UPDATE import_rows SET resolved_vessel_id = (SELECT v.id FROM vessels v WHERE v.name_key = import_rows.vessel_key)
      WHERE id IN (SELECT id FROM selected) AND validation_error IS NULL`),
    statement(`INSERT OR IGNORE INTO reservation_import_keys (reservation_id,semantic_key)
      SELECT generated_reservation_id,${semantic} FROM selected WHERE validation_error IS NULL AND record_type = 'reservation' ORDER BY id`),
    statement(`INSERT OR IGNORE INTO reservations (id,berth_id,kind,vessel_id,title,start_date,end_date,notes,origin,source_ref,created_at,updated_at)
      SELECT r.generated_reservation_id,r.berth_id,r.kind,r.resolved_vessel_id,r.title,r.start_date,r.end_date,r.notes,'legacy',
        f.name || CASE WHEN coalesce(r.source_ref,'') <> '' THEN ': ' || r.source_ref ELSE '' END,?4,?4
      FROM selected r JOIN import_files f ON f.id = r.file_id JOIN reservation_import_keys k ON k.reservation_id = r.generated_reservation_id
      WHERE r.validation_error IS NULL AND r.record_type = 'reservation'`),
    statement(`INSERT INTO app_meta (key,value) SELECT 'max_span_days',CAST(max((SELECT days FROM span),max(CAST(julianday(end_date)-julianday(start_date)+1 AS INTEGER))) AS TEXT)
      FROM added HAVING count(*) > 0 ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
    statement(`INSERT INTO app_meta (key,value)
      SELECT 'data_range',json_object('from',coalesce(min(min(start_date),json_extract((SELECT value FROM app_meta WHERE key = 'data_range'),'$.from')),min(start_date)),
        'to',coalesce(max(max(end_date),json_extract((SELECT value FROM app_meta WHERE key = 'data_range'),'$.to')),max(end_date)))
      FROM added HAVING count(*) > 0 ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
    statement(`INSERT OR IGNORE INTO issues (id,type,reservation_id,other_reservation_id,berth_id,start_date,end_date,details,created_at)
      SELECT 'im-ov-' || min(a.id,o.id) || '~' || max(a.id,o.id),'overlap',min(a.id,o.id),max(a.id,o.id),a.berth_id,
        max(a.start_date,o.start_date),min(a.end_date,o.end_date),json_object('shared_days',CAST(julianday(min(a.end_date,o.end_date))-julianday(max(a.start_date,o.start_date))+1 AS INTEGER)),?4
      FROM added a JOIN berths b ON b.id = a.berth_id AND b.is_exclusive = 1
      JOIN reservations o ON o.berth_id = a.berth_id AND o.id <> a.id AND o.start_date <= a.end_date AND o.end_date >= a.start_date
        AND o.start_date >= coalesce(date(a.start_date,'-' || (SELECT days FROM span) || ' days'),'0001-01-01')
      WHERE NOT EXISTS (SELECT 1 FROM issues i WHERE i.type = 'overlap' AND ((i.reservation_id = a.id AND i.other_reservation_id = o.id) OR (i.reservation_id = o.id AND i.other_reservation_id = a.id)))`),
    statement(`INSERT OR IGNORE INTO issues (id,type,reservation_id,other_reservation_id,berth_id,start_date,end_date,details,created_at)
      SELECT 'im-fi-' || a.id,'fit',a.id,NULL,a.berth_id,a.start_date,a.end_date,
        json_object('vessel_length_ft',v.length_ft,'berth_length_ft',b.length_ft,'length_status',v.length_status),?4
      FROM added a JOIN vessels v ON v.id = a.vessel_id JOIN berths b ON b.id = a.berth_id
      WHERE a.kind = 'vessel' AND v.length_ft IS NOT NULL AND b.length_ft IS NOT NULL AND v.length_ft > b.length_ft
        AND NOT EXISTS (SELECT 1 FROM issues i WHERE i.type = 'fit' AND i.reservation_id = a.id)`),
    statement(`INSERT OR IGNORE INTO issues (id,type,reservation_id,other_reservation_id,berth_id,start_date,end_date,details,created_at)
      SELECT 'im-vd-' || min(a.id,o.id) || '~' || max(a.id,o.id),'vessel_double',min(a.id,o.id),max(a.id,o.id),NULL,
        max(a.start_date,o.start_date),min(a.end_date,o.end_date),json_object('berths',json_array(a.berth_id,o.berth_id),
        'shared_days',CAST(julianday(min(a.end_date,o.end_date))-julianday(max(a.start_date,o.start_date))+1 AS INTEGER)),?4
      FROM added a JOIN reservations o ON o.vessel_id = a.vessel_id AND o.kind = 'vessel' AND o.berth_id <> a.berth_id
        AND o.start_date <= a.end_date AND o.end_date >= a.start_date
        AND o.start_date >= coalesce(date(a.start_date,'-' || (SELECT days FROM span) || ' days'),'0001-01-01')
      WHERE a.kind = 'vessel' AND julianday(min(a.end_date,o.end_date))-julianday(max(a.start_date,o.start_date)) >= 1
        AND NOT EXISTS (SELECT 1 FROM issues i WHERE i.type = 'vessel_double' AND ((i.reservation_id = a.id AND i.other_reservation_id = o.id) OR (i.reservation_id = o.id AND i.other_reservation_id = a.id)))`),
    statement(`INSERT OR IGNORE INTO import_issue_links (issue_id,job_id,file_id,commit_token)
      SELECT i.id,?1,a.file_id,?2 FROM added a JOIN issues i ON i.reservation_id = a.id OR i.other_reservation_id = a.id`),
    statement(`UPDATE import_files SET diagnostics = json_insert(diagnostics,'$[#]',json_object('code','VESSEL_FACTS_PRESERVED','severity','warn',
        'message','One or more incoming vessel lengths differ from the registry. Existing vessel facts were preserved. Review the vessel registry before changing them.'))
      WHERE id IN (SELECT r.file_id FROM selected r JOIN vessels v ON v.name_key = r.vessel_key
        WHERE r.validation_error IS NULL AND v.id <> r.generated_vessel_id AND r.vessel_length_ft IS NOT NULL AND (v.length_ft IS NOT r.vessel_length_ft OR v.length_status <> r.vessel_length_status))
      AND NOT EXISTS (SELECT 1 FROM json_each(diagnostics) d WHERE json_extract(d.value,'$.code') = 'VESSEL_FACTS_PRESERVED')`),
    statement(`UPDATE import_rows SET status = CASE WHEN validation_error IS NOT NULL THEN 'invalid'
        WHEN record_type = 'reservation' AND EXISTS (SELECT 1 FROM reservations a WHERE a.id = generated_reservation_id) THEN 'imported'
        WHEN record_type = 'vessel' AND EXISTS (SELECT 1 FROM vessels v WHERE v.id = generated_vessel_id) THEN 'imported' ELSE 'duplicate' END,
      commit_token = ?2,processed_at = ?4 WHERE id IN (SELECT id FROM selected)`),
    statement(`UPDATE import_files SET processed_rows = processed_rows + (SELECT count(*) FROM processed r WHERE r.file_id = import_files.id),
      imported_reservations = imported_reservations + (SELECT count(*) FROM processed r WHERE r.file_id = import_files.id AND r.record_type = 'reservation' AND r.status = 'imported'),
      imported_vessels = imported_vessels + (SELECT count(*) FROM processed r JOIN vessels v ON v.id = r.generated_vessel_id WHERE r.file_id = import_files.id),
      duplicate_rows = duplicate_rows + (SELECT count(*) FROM processed r WHERE r.file_id = import_files.id AND r.status = 'duplicate'),
      status = CASE WHEN processed_rows + (SELECT count(*) FROM processed r WHERE r.file_id = import_files.id) = row_count THEN 'completed' ELSE 'importing' END,updated_at = ?4
      WHERE job_id = ?1 AND ${guard} AND (id IN (SELECT file_id FROM processed) OR (row_count = 0 AND status = 'staged'))`),
    statement(`UPDATE import_jobs SET processed_rows = processed_rows + (SELECT count(*) FROM processed),
      imported_reservations = imported_reservations + (SELECT count(*) FROM processed WHERE record_type = 'reservation' AND status = 'imported'),
      imported_vessels = imported_vessels + (SELECT count(*) FROM processed r JOIN vessels v ON v.id = r.generated_vessel_id),
      duplicate_rows = duplicate_rows + (SELECT count(*) FROM processed WHERE status = 'duplicate'),
      issue_count = issue_count + (SELECT count(*) FROM import_issue_links WHERE commit_token = ?2),
      status = CASE WHEN processed_rows + (SELECT count(*) FROM processed) = total_rows THEN 'completed' ELSE 'importing' END,updated_at = ?4
      WHERE id = ?1 AND ${guard}`),
  ]);
  return getImportJob(db, jobId);
}
