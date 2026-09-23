/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import app from '../index';
import type { Bindings } from '../types';
import type { AskResponse, IssueDTO, ReservationDTO } from '../../shared/types';

const bindings = env as unknown as Bindings & { TEST_MIGRATIONS: { name: string; queries: string[] }[] };
const stamp = '2026-09-22T00:00:00.000Z';
const request = (path: string, method = 'GET', payload?: unknown) => app.request(`https://berthday.test/api${path}`, {
  method, ...(payload === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
}, bindings);
const booking = (overrides: Record<string, unknown> = {}) => ({ berthId: 'small', kind: 'vessel', vesselId: 'tern', startDate: '2026-07-03', endDate: '2026-07-10', ...overrides });
const askBody = (q: string) => ({ q, today: '2026-09-22', viewedMonth: '2019-12' });
const draftBerth = () => bindings.DB.prepare("INSERT INTO berths (id,name,length_ft,is_exclusive,sort_order) VALUES ('north-pier-face','North Pier Face',75,1,5)").run();

beforeEach(async () => {
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
  await bindings.DB.batch([
    bindings.DB.prepare("INSERT INTO berths (id,name,length_ft,is_exclusive,sort_order) VALUES ('small','South Float East',90,1,0),('medium','North Pier East',240,1,1),('large','North Pier West',410,1,2),('pool','Small craft slips',NULL,0,3),('unassigned','Unassigned',NULL,0,4)"),
    bindings.DB.prepare("INSERT INTO vessels (id,name,name_key,length_ft,length_status,created_at,updated_at) VALUES ('tern','R/V Clear Tern','R/V CLEAR TERN',80,'known',?1,?1),('wild','M/Y Wild Tern','M/Y WILD TERN',145,'known',?1,?1),('unknown','R/V Golden Compass','R/V GOLDEN COMPASS',NULL,'unknown',?1,?1)").bind(stamp),
    bindings.DB.prepare("INSERT INTO app_meta (key,value) VALUES ('max_span_days','425'),('data_range','{\"from\":\"1997-08-01\",\"to\":\"2019-12-31\"}'),('import_summary','{}')"),
  ]);
});
afterEach(async () => { await reset(); });

describe('Berthday API on actual D1', () => {
  it('prioritizes January 2000 navigation over malformed AI navigation output', async () => {
    let aiCalls = 0;
    for (const q of ['Go to January 2000', 'Go to January2000']) {
      const response = await app.request('https://berthday.test/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(askBody(q)) },
        { ...bindings, AI: { run: async () => { aiCalls++; return { response: { intent: 'navigate', vesselQuery: 'January 2000' } }; } } });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ intent: 'navigate', filters: { dateFrom: '2000-01-01' }, source: 'fallback' });
    }
    expect(aiCalls).toBe(0);
  });

  it('rejects an AI navigate intent with no date instead of silently using the viewed month', async () => {
    const response = await app.request('https://berthday.test/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(askBody('Please help me find the next page')) },
      { ...bindings, AI: { run: async () => ({ response: { intent: 'navigate', vesselQuery: 'January 2000' } }) } });
    expect(await response.json()).toMatchObject({ intent: 'unsupported', source: 'fallback', message: expect.any(String) });
  });

  it('prioritizes complete date, kind, and berth filters over invented AI vessel filters', async () => {
    let aiCalls = 0;
    const queries = [
      ['bookings in 2000', { dateFrom: '2000-01-01', dateTo: '2000-12-31' }],
      ['bookings for 2000', { dateFrom: '2000-01-01', dateTo: '2000-12-31' }],
      ['bookings for July 2010', { dateFrom: '2010-07-01', dateTo: '2010-07-31' }],
      ['events in July 2010', { kinds: ['event'], dateFrom: '2010-07-01', dateTo: '2010-07-31' }],
      ['Inner Channel July 2010', { berthIds: ['inner-channel'], dateFrom: '2010-07-01', dateTo: '2010-07-31' }],
    ] as const;
    for (const [q, filters] of queries) {
      const response = await app.request('https://berthday.test/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(askBody(q)) },
        { ...bindings, AI: { run: async () => { aiCalls++; return { response: { intent: 'search', vesselQuery: q } }; } } });
      expect(await response.json()).toMatchObject({ intent: 'search', filters, source: 'fallback' });
    }
    expect(aiCalls).toBe(0);
  });

  it('returns a complete event draft without any booking or vessel writes', async () => {
    await draftBerth();
    let aiCalls = 0;
    const response = await app.request('https://berthday.test/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(askBody('Create a community sail day at North Pier Face on July 10, 2026')) },
      { ...bindings, AI: { run: async () => { aiCalls++; throw new Error('Explicit creation must not need AI'); } } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ intent: 'create_booking', filters: {}, draft: {
      kind: 'event', title: 'community sail day', berthId: 'north-pier-face', startDate: '2026-07-10', endDate: '2026-07-10',
    }, missingFields: [], source: 'fallback' });
    expect(aiCalls).toBe(0);
    expect(await bindings.DB.prepare('SELECT count(*) AS n FROM reservations').first('n')).toBe(0);
    expect(await bindings.DB.prepare('SELECT count(*) AS n FROM vessels').first('n')).toBe(3);
  });

  it('leaves partial event drafts blank and reports missing fields', async () => {
    const partial = await request('/ask', 'POST', askBody('Add event "Open day"'));
    expect(await partial.json()).toMatchObject({ intent: 'create_booking', draft: { kind: 'event', title: 'Open day' }, missingFields: ['berthId', 'startDate', 'endDate'] });
    const unknown = await request('/ask', 'POST', askBody('Create event Open day at Mystery Dock on July 10'));
    const unknownBody = await unknown.json<AskResponse>();
    expect(unknownBody.draft).toEqual({ kind: 'event', title: 'Open day', startDate: '2026-07-10', endDate: '2026-07-10' });
    expect(unknownBody.missingFields).toEqual(['berthId']);
    const negated = await request('/ask', 'POST', askBody('Do not create an event at North Pier Face tomorrow'));
    expect(await negated.json()).toMatchObject({ intent: 'unsupported', message: expect.any(String) });
    expect(await bindings.DB.prepare('SELECT count(*) AS n FROM reservations').first('n')).toBe(0);
  });

  it('resolves only a unique vessel into an unsaved vessel draft', async () => {
    await draftBerth();
    const unique = await request('/ask', 'POST', askBody('Book R/V Clear Tern at NPF July 10, 2026'));
    expect(await unique.json()).toMatchObject({ intent: 'create_booking', draft: { kind: 'vessel', vesselId: 'tern' }, missingFields: [] });
    await bindings.DB.prepare("INSERT INTO vessels (id,name,name_key,length_ft,length_status,created_at,updated_at) VALUES ('tern-2','R/V Clear Tern II','R/V CLEAR TERN II',80,'known',?1,?1)").bind(stamp).run();
    const ambiguous = await (await request('/ask', 'POST', askBody('Book vessel Clear Tern at NPF July 10, 2026'))).json<AskResponse>();
    expect(ambiguous.draft?.vesselId).toBeUndefined(); expect(ambiguous.missingFields).toEqual(['vesselId']);
    const unknown = await (await request('/ask', 'POST', askBody('Book R/V Unrecorded Vessel at NPF July 10, 2026'))).json<AskResponse>();
    expect(unknown.draft?.vesselId).toBeUndefined(); expect(unknown.missingFields).toEqual(['vesselId']);
    expect(await bindings.DB.prepare('SELECT count(*) AS n FROM reservations').first('n')).toBe(0);
    expect(await bindings.DB.prepare('SELECT count(*) AS n FROM vessels').first('n')).toBe(4);
  });

  it('grounds AI-assisted drafts in the request instead of invented dates or berths', async () => {
    await draftBerth();
    const response = await app.request('https://berthday.test/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(askBody('Can you perhaps add event Open day at NPF?')) },
      { ...bindings, AI: { run: async () => ({ response: { intent: 'create_booking', draft: { kind: 'event', title: 'Invented title', berthId: 'large', startDate: '2099-01-01', endDate: '2099-01-02' } } }) } });
    expect(await response.json()).toMatchObject({ intent: 'create_booking', draft: { kind: 'event', title: 'Open day', berthId: 'north-pier-face' }, missingFields: ['startDate', 'endDate'] });
    expect(await bindings.DB.prepare('SELECT count(*) AS n FROM reservations').first('n')).toBe(0);
  });

  it('creates, rejects overlapping saves with alternatives, and rejects bad fit', async () => {
    const created = await request('/reservations', 'POST', booking()); expect(created.status).toBe(201);
    const conflict = await request('/reservations', 'POST', booking({ vesselId: 'unknown' }));
    expect(conflict.status).toBe(409);
    const error = await conflict.json<{ error: { code: string; conflicts: ReservationDTO[]; alternatives: { berths: unknown[]; dateShifts: unknown[] } } }>();
    expect(error.error.code).toBe('BERTH_CONFLICT'); expect(error.error.conflicts).toHaveLength(1);
    expect(error.error.alternatives.berths.length).toBeGreaterThan(0); expect(error.error.alternatives.dateShifts).toHaveLength(2);
    const fit = await request('/reservations', 'POST', booking({ vesselId: 'wild', startDate: '2026-08-01', endDate: '2026-08-07' }));
    expect(fit.status).toBe(422);
    expect(await fit.json()).toMatchObject({ error: { code: 'FIT_VIOLATION', message: expect.stringContaining('145 ft'), alternatives: { berths: [{ berthId: 'medium' }, { berthId: 'large' }] } } });
  });

  it('creates fit issues after a length edit and removes them on delete', async () => {
    const created = await (await request('/reservations', 'POST', booking({ vesselId: 'unknown' }))).json<ReservationDTO>();
    expect(created.fitStatus).toBe('unverified');
    const update = await request('/vessels/unknown', 'PATCH', { lengthFt: 120 });
    expect(await update.json()).toMatchObject({ newFitIssues: 1, clearedFitIssues: 0 });
    expect(await (await request(`/reservations/${created.id}`)).json()).toMatchObject({ fitStatus: 'violation', issues: [{ type: 'fit' }] });
    expect((await request(`/reservations/${created.id}`, 'DELETE')).status).toBe(204);
    expect(await (await request('/issues')).json()).toMatchObject({ items: [] });
  });

  it('reviews issues, hides reviewed records, and reports cleared fit issues', async () => {
    await request('/reservations', 'POST', booking());
    await request('/vessels/tern', 'PATCH', { lengthFt: 120 });
    const queue = await (await request('/issues?type=fit')).json<{ items: IssueDTO[] }>();
    const review = await request(`/issues/${queue.items[0].id}/review`, 'POST', { note: 'Measured length confirmed.' });
    expect(review.status).toBe(200); expect(await review.json()).toMatchObject({ reviewNote: 'Measured length confirmed.', reviewedAt: expect.any(String) });
    expect((await (await request('/issues')).json<{ items: IssueDTO[] }>()).items).toHaveLength(0);
    expect((await (await request('/issues?includeReviewed=true')).json<{ items: IssueDTO[] }>()).items).toHaveLength(1);
    // Saving an unchanged fact must not discard a coordinator's review.
    await request('/vessels/tern', 'PATCH', { lengthFt: 120 });
    expect((await (await request('/issues')).json<{ items: IssueDTO[] }>()).items).toHaveLength(0);
    const correction = await request('/vessels/tern', 'PATCH', { lengthFt: 80 });
    expect(await correction.json()).toMatchObject({ newFitIssues: 0, clearedFitIssues: 1 });
  });

  it('normalizes vessel names and uses stable keyset pagination', async () => {
    const duplicate = await request('/vessels', 'POST', { name: '  r/v   clear tern  ', lengthFt: 90 });
    expect(duplicate.status).toBe(409); expect(await duplicate.json()).toMatchObject({ error: { code: 'VESSEL_EXISTS' } });
    await request('/reservations', 'POST', booking({ berthId: 'pool', kind: 'event', vesselId: null, title: 'Community sail' }));
    await request('/reservations', 'POST', booking({ berthId: 'pool', kind: 'event', vesselId: null, title: 'Open day' }));
    const first = await (await request('/reservations?from=2026-07-01&to=2026-07-31&limit=1')).json<{ items: ReservationDTO[]; nextCursor: string }>();
    const second = await (await request(`/reservations?from=2026-07-01&to=2026-07-31&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`)).json<{ items: ReservationDTO[]; nextCursor: null }>();
    expect(first.items).toHaveLength(1); expect(second.items).toHaveLength(1);
    expect(first.items[0].id).not.toBe(second.items[0].id); expect(second.nextCursor).toBeNull();
    expect((await request('/reservations?from=2026-07-01&to=2026-07-31&cursor=bad')).status).toBe(400);
  });

  it('preserves both changes when a rename races a vessel length edit', async () => {
    await request('/reservations', 'POST', booking());
    const results = await Promise.all([
      request('/vessels/tern', 'PATCH', { name: 'R/V Renamed Tern' }),
      request('/vessels/tern', 'PATCH', { lengthFt: 120 }),
    ]);
    expect(results.map(r => r.status)).toEqual([200, 200]);
    const vessels = await (await request('/vessels?q=Renamed')).json<{ items: { name: string; lengthFt: number }[] }>();
    expect(vessels.items).toMatchObject([{ name: 'R/V Renamed Tern', lengthFt: 120 }]);
    expect((await (await request('/issues?type=fit')).json<{ items: IssueDTO[] }>()).items).toHaveLength(1);
  });

  it('preserves legacy issues on notes-only and rejected edits; clears them on a valid move', async () => {
    const created = await (await request('/reservations', 'POST', booking())).json<ReservationDTO>();
    await request('/vessels/tern', 'PATCH', { lengthFt: 120 });
    expect((await request(`/reservations/${created.id}`, 'PATCH', { notes: 'Measured again' })).status).toBe(200);
    expect((await (await request('/issues')).json<{ items: IssueDTO[] }>()).items).toHaveLength(1);
    expect((await request(`/reservations/${created.id}`, 'PATCH', { startDate: '2026-07-02' })).status).toBe(422);
    expect((await (await request('/issues')).json<{ items: IssueDTO[] }>()).items).toHaveLength(1);
    expect((await request(`/reservations/${created.id}`, 'PATCH', { berthId: 'medium' })).status).toBe(200);
    expect((await (await request('/issues')).json<{ items: IssueDTO[] }>()).items).toHaveLength(0);
  });

  it('allows notes on a 425-day legacy booking and finds it through the bounded window', async () => {
    await bindings.DB.prepare(`INSERT INTO reservations (id,berth_id,kind,vessel_id,start_date,end_date,origin,created_at,updated_at)
      VALUES ('legacy-long','large','vessel','tern','2018-11-02','2019-12-31','legacy',?1,?1)`).bind(stamp).run();
    const update = await request('/reservations/legacy-long', 'PATCH', { notes: 'Verified against the source workbook.' });
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({ notes: 'Verified against the source workbook.', startDate: '2018-11-02', endDate: '2019-12-31' });
    const month = await request('/reservations?from=2019-12-01&to=2019-12-31');
    expect((await month.json<{ items: ReservationDTO[] }>()).items.map(r => r.id)).toEqual(['legacy-long']);
    const conflict = await request('/reservations', 'POST', booking({ berthId: 'large', vesselId: 'unknown', startDate: '2019-12-30', endDate: '2019-12-31' }));
    expect(conflict.status).toBe(409);
  });

  it('allows one shift day but rejects two shared days for the same vessel', async () => {
    expect((await request('/reservations', 'POST', booking())).status).toBe(201);
    expect((await request('/reservations', 'POST', booking({ berthId: 'medium', startDate: '2026-07-10', endDate: '2026-07-13' }))).status).toBe(201);
    const conflict = await request('/reservations', 'POST', booking({ berthId: 'large', startDate: '2026-07-09', endDate: '2026-07-10' }));
    expect(conflict.status).toBe(409); expect(await conflict.json()).toMatchObject({ error: { code: 'VESSEL_CONFLICT' } });
  });

  it('atomically admits only one concurrent booking on an exclusive berth', async () => {
    const results = await Promise.all([request('/reservations', 'POST', booking()), request('/reservations', 'POST', booking({ vesselId: 'unknown' }))]);
    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
    expect((await (await request('/reservations?from=2026-07-01&to=2026-07-31')).json<{ items: unknown[] }>()).items).toHaveLength(1);
  });

  it('sorts availability by fit and still checks vessels on shared pools', async () => {
    const availability = await (await request('/availability?start=2026-08-01&end=2026-08-07&lengthFt=120')).json<{ items: { berth: { id: string }; status: string }[] }>();
    expect(availability.items.map(v => [v.berth.id, v.status])).toEqual([['medium', 'available'], ['large', 'available'], ['pool', 'shared'], ['small', 'too_short']]);
    await request('/reservations', 'POST', booking());
    const busy = await (await request('/availability?start=2026-07-03&end=2026-07-10&vesselId=tern')).json<{ items: { berth: { id: string }; status: string }[] }>();
    expect(busy.items.find(v => v.berth.id === 'pool')?.status).toBe('busy');
  });

  it('validates writes and returns JSON for every API error', async () => {
    expect((await request('/reservations', 'POST', booking({ startDate: '2026-02-30' }))).status).toBe(400);
    expect((await request('/reservations', 'POST', booking({ berthId: 'unassigned' }))).status).toBe(422);
    expect((await request('/reservations', 'POST', booking({ endDate: '2027-07-10' }))).status).toBe(400);
    const missing = await request('/does-not-exist'); expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toContain('application/json');
    expect(await (await request('/health')).json()).toEqual({ ok: true, version: 'test' });
  });

  it('uses Ask fallback with editable filters and exports filtered CSV', async () => {
    const answer = await request('/ask', 'POST', { q: 'which berths fit a 120 ft boat 3–10 July 2026', today: '2026-09-22', viewedMonth: '2019-12' });
    expect(await answer.json()).toMatchObject({ intent: 'availability', source: 'fallback', filters: { lengthFt: 120, dateFrom: '2026-07-03', dateTo: '2026-07-10' } });
    await request('/reservations', 'POST', booking({ kind: 'event', vesselId: null, title: '=Unsafe spreadsheet formula' }));
    const csv = await request('/export.csv?from=2026-07-01&to=2026-07-31&kind=event');
    expect(csv.status).toBe(200); expect(await csv.text()).toContain("'=Unsafe spreadsheet formula");
  });

  it('searches long, multibyte, and escaped literal text within D1 pattern limits', async () => {
    const titles = ['Research vessel with a deliberately long descriptive name beyond fifty bytes', '航'.repeat(30), '%_'.repeat(30)];
    for (const title of titles) {
      const create = await request('/reservations', 'POST', booking({ berthId: 'pool', kind: 'event', vesselId: null, title }));
      expect(create.status).toBe(201);
      const query = encodeURIComponent(title.toLowerCase());
      const search = await request(`/reservations?from=2026-07-01&to=2026-07-31&q=${query}`);
      expect(search.status).toBe(200);
      expect((await search.json<{ items: ReservationDTO[] }>()).items.map(row => row.title)).toEqual([title]);
      expect((await request(`/export.csv?from=2026-07-01&to=2026-07-31&q=${query}`)).status).toBe(200);
    }
    const name = 'R/V Vessel With A Name That Is Longer Than The D1 Pattern Limit';
    expect((await request('/vessels', 'POST', { name, lengthFt: 120 })).status).toBe(201);
    const vessels = await request(`/vessels?q=${encodeURIComponent(name.toLowerCase())}`);
    expect(vessels.status).toBe(200);
    expect((await vessels.json<{ items: { name: string }[] }>()).items.map(v => v.name)).toEqual([name]);
  });

  it('normalizes model vessel searches and rejects oversized model text safely', async () => {
    const ask = (vesselQuery: string) => app.request('https://berthday.test/api/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: 'A detail I need interpreted', today: '2026-09-22', viewedMonth: '2019-12' }),
    }, { ...bindings, AI: { run: async () => ({ response: { intent: 'search', vesselQuery } }) } });
    const name = 'R/V Vessel With A Name That Is Longer Than The D1 Pattern Limit';
    await request('/vessels', 'POST', { name, lengthFt: 120 });
    const answer = await ask(`  ${name.replaceAll(' ', '\n  ')}  `);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ source: 'ai', filters: { vesselQuery: name, vesselIds: [expect.any(String)] } });
    const tooLong = await ask('x'.repeat(201));
    expect(tooLong.status).toBe(200);
    expect(await tooLong.json()).toMatchObject({ source: 'fallback', intent: 'unsupported' });
  });

  it('uses deterministic filters when a model-generated vessel lookup fails', async () => {
    const db = new Proxy(bindings.DB, { get(target, key) {
      if (key === 'prepare') return (sql: string) => {
        if (sql.includes('FROM vessels v ') && sql.includes('booking_count')) throw new Error('Simulated vessel lookup failure');
        return target.prepare(sql);
      };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const response = await app.request('https://berthday.test/api/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: 'A detail I need interpreted', today: '2026-09-22', viewedMonth: '2019-12' }),
    }, { ...bindings, DB: db, AI: { run: async () => ({ response: { intent: 'search', vesselQuery: 'Clear Tern' } }) } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ source: 'fallback', intent: 'unsupported' });
  });

  it('accepts structured AI output, clamps dates, and falls back on invalid AI output', async () => {
    const ask = (response: unknown) => app.request('https://berthday.test/api/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: 'A detail I need interpreted', today: '2026-09-22', viewedMonth: '2019-12' }),
    }, { ...bindings, AI: { run: async () => ({ response }) } });
    const object = await ask({ intent: 'navigate', dateFrom: '2101-01-01' });
    expect(await object.json()).toMatchObject({ source: 'ai', intent: 'navigate', filters: { dateFrom: '2100-12-31' } });
    const string = await ask(JSON.stringify({ intent: 'search', dateFrom: '2010-07-31', dateTo: '2010-07-01' }));
    expect(await string.json()).toMatchObject({ source: 'ai', filters: { dateFrom: '2010-07-01', dateTo: '2010-07-31' } });
    const invalid = await ask({ intent: 'search', berthIds: ['invented-berth'] });
    expect(await invalid.json()).toMatchObject({ source: 'fallback', intent: 'unsupported' });
  });
});
