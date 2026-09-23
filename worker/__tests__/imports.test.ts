/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import app from '../index';
import type { Bindings } from '../types';
import type { ImportFileRegistration, ImportJobDTO, ImportPreviewDTO, ImportStageResponse } from '../../shared/import-types';
import { detectIssues } from '../../shared/domain';
import { getBerths, getSpan, listReservations, listVessels } from '../db';
import { commitImport } from '../import-db';

const bindings = env as unknown as Bindings & { TEST_MIGRATIONS: { name: string; queries: string[] }[] };
const db = bindings.DB;
const request = (path: string, method = 'GET', payload?: unknown) => app.request(`https://berthday.test/api${path}`, {
  method, ...(payload === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
}, bindings);
const call = async <T>(path: string, payload?: unknown, method = 'POST'): Promise<T> => {
  const response = await request(path, method, payload);
  const json = await response.json();
  expect(response.status, JSON.stringify(json)).toBeLessThan(300);
  return json as T;
};
const event = (title: string, extra: Record<string, unknown> = {}) => ({ kind: 'event', berthId: 'small', title, startDate: '2026-07-10', endDate: '2026-07-11', ...extra });
const hash = (value: number) => value.toString(16).padStart(64, '0');
async function staged(rows: unknown[], sha = hash(1)) {
  const job = await call<ImportJobDTO>('/import/jobs', { name: 'Test import' });
  const file = await call<ImportFileRegistration>(`/import/jobs/${job.id}/files`, { name: 'schedule.xlsx', sha256: sha, rowCount: rows.length });
  if (rows.length) await call(`/import/jobs/${job.id}/files/${file.id}/rows`, { offset: 0, rows });
  return { job, file };
}
async function reviewed(rows: unknown[], sha = hash(1)) {
  const item = await staged(rows, sha);
  await call(`/import/jobs/${item.job.id}/preview`, {});
  return item;
}
const apply = (id: string, limit = 10) => call<ImportJobDTO>(`/import/jobs/${id}/commit`, { limit });
const count = (table: 'reservations' | 'vessels' | 'issues') => db.prepare(`SELECT count(*) AS n FROM ${table}`).first<number>('n');

beforeEach(async () => {
  await applyD1Migrations(db, bindings.TEST_MIGRATIONS);
  await db.batch([
    db.prepare("INSERT INTO berths (id,name,length_ft,is_exclusive,sort_order) VALUES ('small','South Float East',90,1,0),('large','North Pier West',410,1,1),('pool','Small craft slips',NULL,0,2),('unassigned','Unassigned',NULL,0,3)"),
    db.prepare("INSERT INTO vessels (id,name,name_key,length_ft,length_status,created_at,updated_at) VALUES ('existing','Existing Boat','EXISTING BOAT',80,'known','2026-01-01','2026-01-01')"),
    db.prepare("INSERT INTO app_meta (key,value) VALUES ('max_span_days','425'),('data_range','{\"from\":\"1997-08-01\",\"to\":\"2019-12-31\"}'),('import_summary','{\"reservation_count\":2587}')"),
  ]);
});
afterEach(async () => { await reset(); });

describe('resumable workbook imports', () => {
  it('stages idempotently, requires preview, imports a bounded chunk, and resumes persisted progress', async () => {
    const rows = [event('Open day'), event('Second event', { berthId: 'pool' }), { recordType: 'vessel', vesselName: 'Reference only', vesselLengthFt: null }];
    const { job, file } = await staged(rows);
    const retry = await call<ImportStageResponse>(`/import/jobs/${job.id}/files/${file.id}/rows`, { offset: 0, rows });
    expect(retry.job).toMatchObject({ totalRows: 3, stagedRows: 3, processedRows: 0, importedReservations: 0 });
    expect(await count('reservations')).toBe(0);
    expect((await request(`/import/jobs/${job.id}/commit`, 'POST', {})).status).toBe(409);
    const preview = await call<ImportPreviewDTO>(`/import/jobs/${job.id}/preview`, {});
    expect(preview.job.status).toBe('ready'); expect(preview.rows[0].row).toMatchObject({ kind: 'event', title: 'Open day' });
    expect(await apply(job.id, 1)).toMatchObject({ status: 'importing', processedRows: 1, importedReservations: 1 });
    expect(await call(`/import/jobs/${job.id}`, undefined, 'GET')).toMatchObject({ processedRows: 1 });
    expect(await apply(job.id)).toMatchObject({ status: 'completed', processedRows: 3, importedReservations: 2, importedVessels: 1 });
    expect(await count('reservations')).toBe(2); expect(await count('vessels')).toBe(2);
    expect(await apply(job.id)).toMatchObject({ status: 'completed', processedRows: 3, importedReservations: 2 });
    expect(await call(`/import/jobs/${job.id}/files?limit=1&offset=0`, undefined, 'GET')).toMatchObject({ total: 1, items: [{ status: 'completed', processedRows: 3 }] });
  });

  it('preserves legacy conflicts and creates exactly the shared domain O/F/V issues', async () => {
    const rows = [
      { recordType: 'vessel', vesselName: 'Large boat', vesselLengthFt: 120, vesselLengthStatus: 'disputed', vesselLengthNote: 'Lengths 100 and 120; using 120.' },
      { kind: 'vessel', berthId: 'small', vesselName: 'large boat', vesselLengthFt: 100, startDate: '2026-07-10', endDate: '2026-07-15' },
      { kind: 'vessel', berthId: 'large', vesselName: 'Large boat', startDate: '2026-07-14', endDate: '2026-07-20' },
      event('Harbor event'),
      { kind: 'vessel', berthId: 'pool', vesselName: 'Unknown length', startDate: '2026-07-01', endDate: '2026-07-03' },
    ];
    const { job } = await reviewed(rows);
    const result = await apply(job.id);
    expect(result).toMatchObject({ importedReservations: 4, importedVessels: 2, issueCount: 3, duplicateRows: 0, status: 'completed' });
    const [berths, vessels, reservations] = await Promise.all([getBerths(db), listVessels(db, { limit: 500 }), listReservations(db, { limit: 500, from: '2026-01-01', to: '2026-12-31' })]);
    const key = (issue: { type: string; reservationId: string; otherReservationId: string | null }) => [issue.type, ...[issue.reservationId, issue.otherReservationId].filter(Boolean).sort()].join(':');
    const detected = detectIssues(reservations.items, berths, vessels.items).map(key).sort();
    const actual = await db.prepare('SELECT type,reservation_id AS reservationId,other_reservation_id AS otherReservationId FROM issues').all<{ type: string; reservationId: string; otherReservationId: string | null }>();
    expect(actual.results.map(key).sort()).toEqual(detected);
    expect(reservations.items.find(row => row.vessel?.name === 'Unknown length')?.fitStatus).toBe('unverified');
    expect(await db.prepare("SELECT length_ft FROM vessels WHERE name_key = 'LARGE BOAT'").first('length_ft')).toBe(120);
    expect(await call(`/import/jobs/${job.id}/files`, undefined, 'GET')).toMatchObject({ items: [{ diagnostics: [{ code: 'VESSEL_FACTS_PRESERVED' }] }] });
  });

  it('deduplicates normalized semantic rows against existing legacy and other files without changing notes or lengths', async () => {
    await db.prepare("INSERT INTO reservations (id,berth_id,kind,vessel_id,title,start_date,end_date,notes,origin,created_at,updated_at) VALUES ('legacy','small','vessel','existing',NULL,'2026-07-10','2026-07-11','Keep notes','legacy','2026-01-01','2026-01-01')").run();
    const row = { kind: 'vessel', berthId: 'small', vesselName: '  existing   BOAT ', vesselLengthFt: 150, startDate: '2026-07-10', endDate: '2026-07-11', notes: 'Replace notes?', sourceRef: 'Sheet!B2' };
    const first = await reviewed([row, event('Open   day', { berthId: 'pool' }), event(' open day ', { berthId: 'pool', notes: 'Another source' })]);
    expect(await apply(first.job.id)).toMatchObject({ importedReservations: 1, importedVessels: 0, duplicateRows: 2 });
    expect(await count('reservations')).toBe(2);
    expect(await db.prepare("SELECT notes FROM reservations WHERE id='legacy'").first('notes')).toBe('Keep notes');
    expect(await db.prepare("SELECT length_ft FROM vessels WHERE id='existing'").first('length_ft')).toBe(80);
    const again = await reviewed([row], hash(2));
    expect(await apply(again.job.id)).toMatchObject({ importedReservations: 0, duplicateRows: 1 });
    const same = await call<ImportJobDTO>('/import/jobs', {});
    expect(await call(`/import/jobs/${same.id}/files`, { name: 'renamed.xlsx', sha256: hash(1), rowCount: 3 })).toMatchObject({ duplicate: true, status: 'duplicate', processedRows: 3 });
    await call(`/import/jobs/${same.id}/preview`, {});
    expect(await apply(same.id)).toMatchObject({ status: 'completed', processedRows: 3, duplicateRows: 3 });
  });

  it('keeps invalid rows visible and permits recovery of the same file after a missing resource is added', async () => {
    const rows = [event('Valid'), event('Custom resource', { berthId: 'custom' }), event('Impossible date', { startDate: '2026-02-30' })];
    const first = await reviewed(rows);
    const preview = await call<ImportPreviewDTO>(`/import/jobs/${first.job.id}/preview`, {});
    expect(preview.job.invalidRows).toBe(2); expect(preview.rows[0].error).toContain('Unknown berth');
    expect(await apply(first.job.id)).toMatchObject({ status: 'completed', importedReservations: 1, invalidRows: 2, processedRows: 3 });
    await db.prepare("INSERT INTO berths (id,name,length_ft,is_exclusive,sort_order) VALUES ('custom','New shared resource',NULL,0,10)").run();
    const second = await reviewed(rows);
    expect(second.file.duplicate).toBe(false);
    expect(await apply(second.job.id)).toMatchObject({ importedReservations: 1, duplicateRows: 1, invalidRows: 1 });
    expect(await count('reservations')).toBe(2);
  });

  it('does not treat a partly imported cancelled file as complete, and preserves committed chunks', async () => {
    const rows = [event('One'), event('Two', { berthId: 'pool' }), event('Three', { berthId: 'large' })];
    const first = await reviewed(rows);
    expect(await apply(first.job.id, 1)).toMatchObject({ importedReservations: 1 });
    expect(await call(`/import/jobs/${first.job.id}/cancel`, {})).toMatchObject({ status: 'cancelled', importedReservations: 1, processedRows: 1 });
    expect(await apply(first.job.id)).toMatchObject({ status: 'cancelled', processedRows: 1 });
    const second = await reviewed(rows);
    expect(second.file.duplicate).toBe(false);
    expect(await apply(second.job.id)).toMatchObject({ importedReservations: 2, duplicateRows: 1, status: 'completed' });
    expect(await count('reservations')).toBe(3);
  });

  it('serializes racing commits and deduplicates racing jobs with the same bookings', async () => {
    const rows = [event('One', { berthId: 'pool' }), event('Two', { berthId: 'pool' })];
    const first = await reviewed(rows, hash(1)), second = await reviewed(rows, hash(2));
    await Promise.all([apply(first.job.id, 1), apply(first.job.id, 1), apply(second.job.id)]);
    await apply(first.job.id); await apply(second.job.id);
    expect(await count('reservations')).toBe(2);
    const a = await call<ImportJobDTO>(`/import/jobs/${first.job.id}`, undefined, 'GET'), b = await call<ImportJobDTO>(`/import/jobs/${second.job.id}`, undefined, 'GET');
    expect(a.processedRows).toBe(2); expect(b.processedRows).toBe(2);
    expect(a.importedReservations + b.importedReservations).toBe(2);
    expect(a.duplicateRows + b.duplicateRows).toBe(2);
  });

  it('allows cancellation to race a commit without partial rows, stale counters, or later writes', async () => {
    const { job } = await reviewed([event('One'), event('Two', { berthId: 'large' })]);
    await Promise.all([apply(job.id, 1), call(`/import/jobs/${job.id}/cancel`, {})]);
    const final = await call<ImportJobDTO>(`/import/jobs/${job.id}`, undefined, 'GET');
    expect(final.status).toBe('cancelled');
    expect(final.processedRows).toBeLessThanOrEqual(1);
    expect(final.importedReservations).toBe(final.processedRows);
    expect(await count('reservations')).toBe(final.processedRows);
    await apply(job.id);
    expect(await count('reservations')).toBe(final.processedRows);
  });

  it('updates live data range and max span so long imports remain visible and prevent later overlapping app saves', async () => {
    expect(await getSpan(db)).toBe(425);
    const { job } = await reviewed([event('Long closure', { kind: 'closure', startDate: '2025-01-01', endDate: '2029-12-31' })]);
    await apply(job.id);
    expect(await getSpan(db)).toBe(1826);
    const bookings = await call<{ items: unknown[] }>('/reservations?from=2029-12-01&to=2029-12-31', undefined, 'GET');
    expect(bookings.items).toHaveLength(1);
    const save = await request('/reservations', 'POST', { kind: 'event', berthId: 'small', title: 'Overlapping', startDate: '2029-12-05', endDate: '2029-12-05' });
    expect(save.status).toBe(409);
    expect(await db.prepare("SELECT value FROM app_meta WHERE key='data_range'").first('value')).toBe('{"from":"1997-08-01","to":"2029-12-31"}');
    expect(await db.prepare("SELECT value FROM app_meta WHERE key='import_summary'").first('value')).toBe('{"reservation_count":2587}');
  });

  it('keeps semantic keys valid when one of two identical legacy rows is deleted or edited', async () => {
    await db.prepare("INSERT INTO reservations (id,berth_id,kind,title,start_date,end_date,origin,created_at,updated_at) VALUES ('a','pool','event','Shared event','2026-07-10','2026-07-11','legacy','2026-01-01','2026-01-01'),('b','pool','event','Shared event','2026-07-10','2026-07-11','legacy','2026-01-01','2026-01-01')").run();
    await db.prepare("DELETE FROM reservations WHERE id='a'").run();
    const first = await reviewed([event('Shared event', { berthId: 'pool' })]);
    expect(await apply(first.job.id)).toMatchObject({ importedReservations: 0, duplicateRows: 1 });
    await db.prepare("INSERT INTO reservations (id,berth_id,kind,title,start_date,end_date,origin,created_at,updated_at) VALUES ('c','pool','event','Shared event','2026-07-10','2026-07-11','legacy','2026-01-01','2026-01-01')").run();
    await db.prepare("UPDATE reservations SET title='Changed event' WHERE id='b'").run();
    const second = await reviewed([event('Shared event', { berthId: 'pool' })], hash(2));
    expect(await apply(second.job.id)).toMatchObject({ importedReservations: 0, duplicateRows: 1 });
  });

  it('rejects changed stage retries, out-of-order batches, oversized batches, and mismatched file ownership', async () => {
    const first = await staged([event('Original')]);
    expect((await request(`/import/jobs/${first.job.id}/files/${first.file.id}/rows`, 'POST', { offset: 0, rows: [event('Changed')] })).status).toBe(409);
    const other = await call<ImportJobDTO>('/import/jobs', {});
    expect((await request(`/import/jobs/${other.id}/files/${first.file.id}/rows`, 'POST', { offset: 0, rows: [event('Original')] })).status).toBe(404);
    const file = await call<ImportFileRegistration>(`/import/jobs/${other.id}/files`, { name: 'other.xlsx', sha256: hash(2), rowCount: 102 });
    expect((await request(`/import/jobs/${other.id}/files/${file.id}/rows`, 'POST', { offset: 1, rows: [event('Gap')] })).status).toBe(409);
    expect((await request(`/import/jobs/${other.id}/files/${file.id}/rows`, 'POST', { offset: 0, rows: Array.from({ length: 101 }, () => event('Large batch')) })).status).toBe(400);
    expect((await request(`/import/jobs/${other.id}/preview`, 'POST', {})).status).toBe(409);
    expect(await count('reservations')).toBe(0);
  });

  it('retains diagnostics for zero-row workbooks and completes without schedule writes', async () => {
    const job = await call<ImportJobDTO>('/import/jobs', {});
    await call(`/import/jobs/${job.id}/files`, { name: 'unsupported.xlsx', sha256: hash(1), rowCount: 0, diagnostics: [{ code: 'NO_DAY_HEADER', severity: 'error', message: 'No valid day header was found.' }] });
    const preview = await call<ImportPreviewDTO>(`/import/jobs/${job.id}/preview`, {});
    expect(preview.message).toContain('No importable records'); expect(preview.diagnostics.map(d => d.code)).toEqual(['NO_DAY_HEADER', 'NO_IMPORTABLE_ROWS']);
    expect(await apply(job.id)).toMatchObject({ status: 'completed', importedReservations: 0, processedRows: 0 });
    expect(await count('reservations')).toBe(0);
  });

  it('bounds expanded staging bytes and can resume with a smaller batch', async () => {
    const rows = Array.from({ length: 100 }, (_, index) => event(`Long notes ${index}`, { notes: 'n'.repeat(10_000), sourceRef: 's'.repeat(10_000) }));
    const job = await call<ImportJobDTO>('/import/jobs', {});
    const file = await call<ImportFileRegistration>(`/import/jobs/${job.id}/files`, { name: 'large-notes.xlsx', sha256: hash(1), rowCount: 100 });
    const oversized = await request(`/import/jobs/${job.id}/files/${file.id}/rows`, 'POST', { offset: 0, rows });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ error: { code: 'IMPORT_BATCH_TOO_LARGE' } });
    expect(await call(`/import/jobs/${job.id}`, undefined, 'GET')).toMatchObject({ stagedRows: 0 });
    expect(await call<ImportStageResponse>(`/import/jobs/${job.id}/files/${file.id}/rows`, { offset: 0, rows: rows.slice(0, 10) })).toMatchObject({ file: { stagedRows: 10 } });
  });

  it('rolls back a failed commit together with vessel inserts, deduplication keys, and progress', async () => {
    const { job } = await reviewed([
      { kind: 'vessel', berthId: 'pool', vesselName: 'New imported boat', startDate: '2026-07-10', endDate: '2026-07-11' },
      event('Reject this row', { berthId: 'pool' }),
    ]);
    await db.prepare("CREATE TRIGGER reject_import_test BEFORE INSERT ON reservations WHEN NEW.title = 'Reject this row' BEGIN SELECT RAISE(ABORT, 'Intentional import failure'); END").run();
    await expect(commitImport(db, job.id)).rejects.toThrow('Intentional import failure');
    expect(await count('reservations')).toBe(0);
    expect(await count('vessels')).toBe(1);
    expect(await db.prepare('SELECT count(*) AS n FROM reservation_import_keys').first('n')).toBe(0);
    expect(await call(`/import/jobs/${job.id}`, undefined, 'GET')).toMatchObject({ status: 'ready', processedRows: 0, importedReservations: 0, importedVessels: 0 });
    expect(await db.prepare('SELECT commit_token FROM import_jobs WHERE id = ?').bind(job.id).first('commit_token')).toBeNull();
    await db.prepare('DROP TRIGGER reject_import_test').run();
    expect(await apply(job.id)).toMatchObject({ status: 'completed', importedReservations: 2, importedVessels: 1, duplicateRows: 0 });
  });

  it('stages one hundred records and caps each commit at twenty even when a larger limit is requested', async () => {
    const { job } = await reviewed(Array.from({ length: 100 }, (_, index) => event(`Batch event ${index}`, { berthId: 'pool' })));
    let result = await apply(job.id, 50);
    expect(result).toMatchObject({ status: 'importing', stagedRows: 100, processedRows: 20, importedReservations: 20 });
    for (let processed = 40; processed <= 100; processed += 20) {
      result = await apply(job.id, 50);
      expect(result.processedRows).toBe(processed);
    }
    expect(result).toMatchObject({ status: 'completed', importedReservations: 100, duplicateRows: 0, issueCount: 0 });
    expect(await count('reservations')).toBe(100);
  });
});
