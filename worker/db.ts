import { z } from 'zod';
import type { BerthDTO, IssueDTO, Kind, ReservationDTO, VesselDTO } from '../shared/types';
import { getFitStatus } from '../shared/domain';
import { ApiError, missing } from './errors';

type Row = Record<string, unknown>;
type Value = string | number | null;
export interface BookingWrite { berthId: string; kind: Kind; vesselId?: string | null; title?: string | null; startDate: string; endDate: string; notes?: string | null }
export interface BookingQuery { from: string; to: string; berthId?: string; vesselId?: string; kind?: Kind; q?: string; hasIssues?: boolean; limit?: number; cursor?: string }
export interface IssueQuery { type?: string; from?: string; to?: string; berthId?: string; includeReviewed?: boolean; limit?: number; cursor?: string }
export interface VesselQuery { q?: string; lengthStatus?: string; limit?: number; cursor?: string }

const spanCache = new WeakMap<D1Database, number>();
const text = (value: unknown) => value == null ? null : String(value);
const number = (value: unknown) => value == null ? null : Number(value);
const json = <T>(value: unknown, fallback: T): T => {
  try { return typeof value === 'string' ? JSON.parse(value) as T : fallback; } catch { return fallback; }
};
const cursor = (a: string, b: string) => encodeURIComponent(JSON.stringify([a, b]));
function decodeCursor(value?: string): [string, string] | undefined {
  if (!value) return undefined;
  try { return z.tuple([z.string().max(300), z.string().max(300)]).parse(JSON.parse(decodeURIComponent(value))); }
  catch { throw new ApiError(400, 'VALIDATION_ERROR', 'The pagination cursor is invalid. Start again from the first page.'); }
}
const like = (value: string) => `%${value.replace(/[\\%_]/g, '\\$&')}%`;
const utf8 = new TextEncoder();
function contains(column: string, value: string) {
  const pattern = like(value);
  // D1 caps LIKE/GLOB patterns at 50 bytes, including escaped characters and
  // wildcards. INSTR preserves a long literal substring instead of truncating it.
  return utf8.encode(pattern).byteLength <= 50
    ? { sql: `${column} LIKE ? ESCAPE '\\' COLLATE NOCASE`, value: pattern }
    : { sql: `instr(lower(${column}), lower(?)) > 0`, value };
}

function mapBerth(row: Row): BerthDTO {
  return { id: String(row.id), name: String(row.name), lengthFt: number(row.length_ft), isExclusive: Boolean(row.is_exclusive), sortOrder: Number(row.sort_order) };
}
function mapVessel(row: Row): VesselDTO {
  return { id: String(row.id), name: String(row.name), lengthFt: number(row.length_ft), lengthStatus: row.length_status as VesselDTO['lengthStatus'], lengthNote: text(row.length_note), ...(row.booking_count == null ? {} : { bookingCount: Number(row.booking_count) }) };
}

const reservationSelect = `SELECT r.*, v.name AS vessel_name, v.length_ft AS vessel_length_ft,
  v.length_status AS vessel_length_status, b.length_ft AS berth_length_ft,
  COALESCE((SELECT json_group_array(json_object('id', i.id, 'type', i.type, 'reviewed', i.reviewed_at IS NOT NULL))
    FROM issues i WHERE i.reservation_id = r.id OR i.other_reservation_id = r.id), '[]') AS issue_json
  FROM reservations r JOIN berths b ON b.id = r.berth_id LEFT JOIN vessels v ON v.id = r.vessel_id`;

function mapReservation(row: Row): ReservationDTO {
  const kind = row.kind as Kind;
  const vessel = row.vessel_id == null ? null : { id: String(row.vessel_id), name: String(row.vessel_name), lengthFt: number(row.vessel_length_ft), lengthStatus: String(row.vessel_length_status) };
  return { id: String(row.id), berthId: String(row.berth_id), kind, vesselId: text(row.vessel_id), vessel,
    title: text(row.title), startDate: String(row.start_date), endDate: String(row.end_date), notes: text(row.notes),
    origin: row.origin as 'legacy' | 'app', sourceRef: text(row.source_ref),
    fitStatus: getFitStatus({ kind }, { lengthFt: number(row.berth_length_ft) }, vessel),
    issues: json<Array<{ id: string; type: ReservationDTO['issues'][number]['type']; reviewed: number }>>(row.issue_json, []).map(i => ({ ...i, reviewed: Boolean(i.reviewed) })),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}

export async function getSpan(db: D1Database): Promise<number> {
  const existing = spanCache.get(db);
  if (existing) return existing;
  const row = await db.prepare("SELECT value FROM app_meta WHERE key = 'max_span_days'").first<{ value: string }>();
  const value = Math.max(366, Number(row?.value) || 366);
  spanCache.set(db, value);
  return value;
}
export async function getBerths(db: D1Database): Promise<BerthDTO[]> {
  const { results } = await db.prepare('SELECT id, name, length_ft, is_exclusive, sort_order FROM berths ORDER BY sort_order, id').all<Row>();
  return results.map(mapBerth);
}
export async function getMeta(db: D1Database) {
  const [meta, berths] = await Promise.all([
    db.prepare("SELECT key, value FROM app_meta WHERE key IN ('data_range', 'import_summary')").all<{ key: string; value: string }>(), getBerths(db),
  ]);
  const values = Object.fromEntries(meta.results.map(row => [row.key, row.value]));
  return { dataRange: json<{ from: string; to: string } | null>(values.data_range, null), importSummary: json<Record<string, unknown>>(values.import_summary, {}), berths };
}
export async function getVessel(db: D1Database, id: string): Promise<VesselDTO | null> {
  const row = await db.prepare('SELECT v.*, (SELECT count(*) FROM reservations r WHERE r.vessel_id = v.id) AS booking_count FROM vessels v WHERE v.id = ?').bind(id).first<Row>();
  return row ? mapVessel(row) : null;
}
export async function getReservation(db: D1Database, id: string): Promise<ReservationDTO | null> {
  const row = await db.prepare(`${reservationSelect} WHERE r.id = ?`).bind(id).first<Row>();
  return row ? mapReservation(row) : null;
}
function bookingConditions(query: BookingQuery, span: number) {
  const terms = ["r.start_date <= ? AND r.end_date >= ? AND r.start_date >= date(?, '-' || ? || ' days')"];
  const values: Value[] = [query.to, query.from, query.from, span];
  for (const [key, value] of [['berth_id', query.berthId], ['vessel_id', query.vesselId], ['kind', query.kind]] as const) {
    if (value) { terms.push(`r.${key} = ?`); values.push(value); }
  }
  if (query.q) {
    const vessel = contains('v.name', query.q), title = contains('r.title', query.q);
    terms.push(`(${vessel.sql} OR ${title.sql})`); values.push(vessel.value, title.value);
  }
  if (query.hasIssues) terms.push('EXISTS (SELECT 1 FROM issues i WHERE (i.reservation_id = r.id OR i.other_reservation_id = r.id) AND i.reviewed_at IS NULL)');
  return { terms, values };
}
export async function listReservations(db: D1Database, query: BookingQuery) {
  const { terms, values } = bookingConditions(query, await getSpan(db));
  const after = decodeCursor(query.cursor);
  if (after) { terms.push('(r.start_date > ? OR (r.start_date = ? AND r.id > ?))'); values.push(after[0], after[0], after[1]); }
  const limit = Math.min(200, query.limit ?? 100);
  const { results } = await db.prepare(`${reservationSelect} WHERE ${terms.join(' AND ')} ORDER BY r.start_date, r.id LIMIT ?`).bind(...values, limit + 1).all<Row>();
  const items = results.slice(0, limit).map(mapReservation);
  const last = items.at(-1);
  return { items, nextCursor: results.length > limit && last ? cursor(last.startDate, last.id) : null };
}
/** Internal window reads are bounded but unpaginated so validation never misses a conflict. */
export async function windowReservations(db: D1Database, from: string, to: string): Promise<ReservationDTO[]> {
  const { terms, values } = bookingConditions({ from, to }, await getSpan(db));
  const { results } = await db.prepare(`${reservationSelect} WHERE ${terms.join(' AND ')} ORDER BY r.start_date, r.id`).bind(...values).all<Row>();
  return results.map(mapReservation);
}
export async function exportReservations(db: D1Database, query: BookingQuery): Promise<ReservationDTO[]> {
  const { terms, values } = bookingConditions(query, await getSpan(db));
  const { results } = await db.prepare(`${reservationSelect} WHERE ${terms.join(' AND ')} ORDER BY r.start_date, r.id`).bind(...values).all<Row>();
  return results.map(mapReservation);
}

// The fit and reference guards supplement O/V: a length edit between preflight and
// insertion cannot slip a newly too-long vessel into the berth.
const atomicGuard = `EXISTS (SELECT 1 FROM berths WHERE id = ?2 AND id <> 'unassigned')
  AND (?4 IS NULL OR EXISTS (SELECT 1 FROM vessels WHERE id = ?4))
  AND (?3 <> 'vessel' OR NOT EXISTS (SELECT 1 FROM vessels v JOIN berths b ON b.id = ?2
    WHERE v.id = ?4 AND v.length_ft IS NOT NULL AND b.length_ft IS NOT NULL AND v.length_ft > b.length_ft))
  AND ((SELECT is_exclusive FROM berths WHERE id = ?2) = 0 OR NOT EXISTS (
    SELECT 1 FROM reservations o WHERE o.berth_id = ?2 AND o.id <> ?1
      AND o.start_date <= ?7 AND o.end_date >= ?6 AND o.start_date >= date(?6, '-' || ?10 || ' days')))
  AND (?4 IS NULL OR NOT EXISTS (SELECT 1 FROM reservations o WHERE o.vessel_id = ?4
    AND o.berth_id <> ?2 AND o.id <> ?1 AND o.start_date <= ?7 AND o.end_date >= ?6
    AND o.start_date >= date(?6, '-' || ?10 || ' days')
    AND julianday(min(o.end_date, ?7)) - julianday(max(o.start_date, ?6)) >= 1))`;

function writeValues(id: string, value: BookingWrite, now: string, span: number): Value[] {
  return [id, value.berthId, value.kind, value.kind === 'vessel' ? value.vesselId ?? null : null,
    value.title ?? null, value.startDate, value.endDate, value.notes ?? null, now, span];
}
export async function insertReservation(db: D1Database, id: string, value: BookingWrite): Promise<boolean> {
  const result = await db.prepare(`INSERT INTO reservations
    (id, berth_id, kind, vessel_id, title, start_date, end_date, notes, origin, source_ref, created_at, updated_at)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'app', NULL, ?9, ?9 WHERE ${atomicGuard}`)
    .bind(...writeValues(id, value, new Date().toISOString(), await getSpan(db))).run();
  return result.meta.changes > 0;
}
export async function updateReservation(db: D1Database, id: string, value: BookingWrite, keyChanged: boolean): Promise<boolean> {
  const now = new Date().toISOString();
  if (!keyChanged) {
    const result = await db.prepare('UPDATE reservations SET title = ?, notes = ?, updated_at = ? WHERE id = ?').bind(value.title ?? null, value.notes ?? null, now, id).run();
    return result.meta.changes > 0;
  }
  // The conditional issue deletion observes changes() from the previous UPDATE in
  // the same transaction. A rejected write cannot erase a legacy review record.
  const results = await db.batch([
    db.prepare(`UPDATE reservations SET berth_id = ?2, kind = ?3, vessel_id = ?4, title = ?5,
      start_date = ?6, end_date = ?7, notes = ?8, updated_at = ?9 WHERE id = ?1 AND ${atomicGuard}`)
      .bind(...writeValues(id, value, now, await getSpan(db))),
    db.prepare('DELETE FROM issues WHERE (reservation_id = ? OR other_reservation_id = ?) AND changes() > 0').bind(id, id),
  ]);
  return results[0].meta.changes > 0;
}
export async function deleteReservation(db: D1Database, id: string): Promise<boolean> {
  const results = await db.batch([
    db.prepare('DELETE FROM issues WHERE reservation_id = ? OR other_reservation_id = ?').bind(id, id),
    db.prepare('DELETE FROM reservations WHERE id = ?').bind(id),
  ]);
  return results[1].meta.changes > 0;
}
export async function listVessels(db: D1Database, query: VesselQuery) {
  const terms: string[] = []; const values: Value[] = [];
  if (query.q) { const search = contains('v.name', query.q); terms.push(search.sql); values.push(search.value); }
  if (query.lengthStatus) { terms.push('v.length_status = ?'); values.push(query.lengthStatus); }
  const after = decodeCursor(query.cursor);
  if (after) { terms.push('(v.name_key > ? OR (v.name_key = ? AND v.id > ?))'); values.push(after[0], after[0], after[1]); }
  const limit = Math.min(query.limit ?? 100, 200);
  const { results } = await db.prepare(`SELECT v.*, (SELECT count(*) FROM reservations r WHERE r.vessel_id = v.id) AS booking_count
    FROM vessels v ${terms.length ? `WHERE ${terms.join(' AND ')}` : ''} ORDER BY v.name_key, v.id LIMIT ?`).bind(...values, limit + 1).all<Row>();
  const items = results.slice(0, limit).map(mapVessel); const last = results[Math.min(results.length, limit) - 1];
  return { items, nextCursor: results.length > limit && last ? cursor(String(last.name_key), String(last.id)) : null };
}
export function normalizeName(name: string) { return name.trim().replace(/\s+/g, ' '); }
export async function createVessel(db: D1Database, input: { name: string; lengthFt: number }): Promise<VesselDTO> {
  const id = crypto.randomUUID(), now = new Date().toISOString(), name = normalizeName(input.name);
  const result = await db.prepare(`INSERT INTO vessels (id,name,name_key,length_ft,length_status,length_note,source,created_at,updated_at)
    SELECT ?,?,?,?,'known',NULL,'app',?,? WHERE NOT EXISTS (SELECT 1 FROM vessels WHERE name_key = ?)`)
    .bind(id, name, name.toUpperCase(), input.lengthFt, now, now, name.toUpperCase()).run();
  if (!result.meta.changes) throw new ApiError(409, 'VESSEL_EXISTS', `${name} already exists in the vessel registry. Select the existing vessel.`);
  return (await getVessel(db, id))!;
}
export async function updateVessel(db: D1Database, id: string, input: { name?: string; lengthFt?: number | null }) {
  const existing = await getVessel(db, id); if (!existing) throw missing('Vessel');
  const name = input.name === undefined ? existing.name : normalizeName(input.name);
  const duplicate = input.name === undefined ? null
    : await db.prepare('SELECT id FROM vessels WHERE name_key = ? AND id <> ?').bind(name.toUpperCase(), id).first();
  if (duplicate) throw new ApiError(409, 'VESSEL_EXISTS', `${name} already exists in the vessel registry. Choose a different name.`);
  const now = new Date().toISOString();
  const hasLength = input.lengthFt !== undefined;
  const fields = ['updated_at = ?'];
  const values: Value[] = [now];
  if (input.name !== undefined) { fields.push('name = ?', 'name_key = ?'); values.push(name, name.toUpperCase()); }
  if (hasLength) { fields.push('length_ft = ?', 'length_status = ?', 'length_note = NULL'); values.push(input.lengthFt!, input.lengthFt == null ? 'unknown' : 'known'); }
  const statements = [
    db.prepare("SELECT count(*) AS n FROM issues i JOIN reservations r ON r.id = i.reservation_id WHERE i.type = 'fit' AND r.vessel_id = ?").bind(id),
  ];
  // Compare against the current database value inside the same transaction.
  // Re-saving an unchanged known length preserves reviewed issues, and a racing
  // rename cannot restore a stale length or leave an inconsistent fit queue.
  if (hasLength) statements.push(db.prepare(`DELETE FROM issues WHERE type = 'fit'
    AND reservation_id IN (SELECT id FROM reservations WHERE vessel_id = ?1)
    AND EXISTS (SELECT 1 FROM vessels WHERE id = ?1 AND (length_ft IS NOT ?2 OR length_status <> ?3))`)
    .bind(id, input.lengthFt!, input.lengthFt == null ? 'unknown' : 'known'));
  statements.push(db.prepare(`UPDATE vessels SET ${fields.join(', ')} WHERE id = ?`).bind(...values, id));
  if (hasLength) statements.push(
    db.prepare(`INSERT INTO issues (id,type,reservation_id,other_reservation_id,berth_id,start_date,end_date,details,created_at)
      SELECT 'fi-' || lower(hex(randomblob(16))), 'fit', r.id, NULL, r.berth_id, r.start_date, r.end_date,
        json_object('vessel_length_ft',v.length_ft,'berth_length_ft',b.length_ft,'length_status',v.length_status), ?
      FROM reservations r JOIN vessels v ON v.id = r.vessel_id JOIN berths b ON b.id = r.berth_id
      WHERE r.vessel_id = ? AND r.kind = 'vessel' AND v.length_ft IS NOT NULL AND b.length_ft IS NOT NULL AND v.length_ft > b.length_ft
        AND NOT EXISTS (SELECT 1 FROM issues i WHERE i.reservation_id = r.id AND i.type = 'fit')`).bind(now, id),
  );
  statements.push(db.prepare("SELECT count(*) AS n FROM issues i JOIN reservations r ON r.id = i.reservation_id WHERE i.type = 'fit' AND r.vessel_id = ?").bind(id));
  let results: D1Result<Row>[];
  try { results = await db.batch<Row>(statements); } catch (error) {
    if (String(error).includes('UNIQUE')) throw new ApiError(409, 'VESSEL_EXISTS', `${name} already exists in the vessel registry.`);
    throw error;
  }
  const before = Number(results[0].results[0]?.n ?? 0), after = Number(results.at(-1)!.results[0]?.n ?? 0);
  return { vessel: (await getVessel(db, id))!, newFitIssues: Math.max(0, after - before), clearedFitIssues: Math.max(0, before - after) };
}

async function mapIssues(db: D1Database, rows: Row[]): Promise<IssueDTO[]> {
  if (!rows.length) return [];
  const ids = [...new Set(rows.flatMap(r => [String(r.reservation_id), ...(r.other_reservation_id ? [String(r.other_reservation_id)] : [])]))];
  const reservations = new Map<string, ReservationDTO>();
  // D1 allows at most 100 bound parameters per statement.
  for (let offset = 0; offset < ids.length; offset += 90) {
    const part = ids.slice(offset, offset + 90);
    const { results } = await db.prepare(`${reservationSelect} WHERE r.id IN (${part.map(() => '?').join(',')})`).bind(...part).all<Row>();
    results.map(mapReservation).forEach(r => reservations.set(r.id, r));
  }
  return rows.map(row => ({ id: String(row.id), type: row.type as IssueDTO['type'], startDate: String(row.start_date), endDate: String(row.end_date), berthId: text(row.berth_id),
    reservation: reservations.get(String(row.reservation_id))!, other: row.other_reservation_id ? reservations.get(String(row.other_reservation_id)) ?? null : null,
    details: json<Record<string, unknown>>(row.details, {}), reviewedAt: text(row.reviewed_at), reviewNote: text(row.review_note) }));
}
export async function listIssues(db: D1Database, query: IssueQuery) {
  const terms: string[] = []; const values: Value[] = [];
  if (!query.includeReviewed) terms.push('i.reviewed_at IS NULL');
  if (query.type) { terms.push('i.type = ?'); values.push(query.type); }
  if (query.berthId) { terms.push('(i.berth_id = ? OR EXISTS (SELECT 1 FROM reservations r WHERE (r.id = i.reservation_id OR r.id = i.other_reservation_id) AND r.berth_id = ?))'); values.push(query.berthId, query.berthId); }
  if (query.from) { terms.push("i.end_date >= ? AND i.start_date >= date(?, '-' || ? || ' days')"); values.push(query.from, query.from, await getSpan(db)); }
  if (query.to) { terms.push('i.start_date <= ?'); values.push(query.to); }
  const after = decodeCursor(query.cursor);
  if (after) { terms.push('(i.start_date < ? OR (i.start_date = ? AND i.id < ?))'); values.push(after[0], after[0], after[1]); }
  const limit = Math.min(query.limit ?? 100, 200);
  const { results } = await db.prepare(`SELECT i.* FROM issues i ${terms.length ? `WHERE ${terms.join(' AND ')}` : ''} ORDER BY i.start_date DESC, i.id DESC LIMIT ?`).bind(...values, limit + 1).all<Row>();
  const items = await mapIssues(db, results.slice(0, limit)); const last = items.at(-1);
  return { items, nextCursor: results.length > limit && last ? cursor(last.startDate, last.id) : null };
}
export async function reviewIssue(db: D1Database, id: string, note?: string | null): Promise<IssueDTO> {
  const result = await db.prepare('UPDATE issues SET reviewed_at = ?, review_note = ? WHERE id = ?').bind(new Date().toISOString(), note ?? null, id).run();
  if (!result.meta.changes) throw missing('Issue');
  const row = await db.prepare('SELECT * FROM issues WHERE id = ?').bind(id).first<Row>();
  return (await mapIssues(db, [row!]))[0];
}
export async function listImportIssues(db: D1Database, query: { code?: string; severity?: string; limit?: number; offset?: number }) {
  const terms: string[] = [], values: Value[] = [];
  if (query.code) { terms.push('code = ?'); values.push(query.code); }
  if (query.severity) { terms.push('severity = ?'); values.push(query.severity); }
  const condition = terms.length ? `WHERE ${terms.join(' AND ')}` : '', limit = Math.min(query.limit ?? 100, 200), offset = query.offset ?? 0;
  const results = await db.batch<Row>([
    db.prepare(`SELECT * FROM import_issues ${condition} ORDER BY id LIMIT ? OFFSET ?`).bind(...values, limit, offset),
    db.prepare(`SELECT count(*) AS n FROM import_issues ${condition}`).bind(...values),
  ]);
  return { items: results[0].results.map((r: Row) => ({ id: Number(r.id), code: String(r.code), severity: String(r.severity), sheet: text(r.sheet), cell: text(r.cell), message: String(r.message), reservationId: text(r.reservation_id) })), total: Number(results[1].results[0]?.n ?? 0), limit, offset };
}
export async function importCodes(db: D1Database) {
  const { results } = await db.prepare(`SELECT code, count(*) AS count,
    CASE max(CASE severity WHEN 'error' THEN 3 WHEN 'warn' THEN 2 ELSE 1 END) WHEN 3 THEN 'error' WHEN 2 THEN 'warn' ELSE 'info' END AS severity
    FROM import_issues GROUP BY code ORDER BY code`).all<{ code: string; count: number; severity: string }>();
  return { items: results };
}
