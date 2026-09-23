/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import app from '../index';
import type { Bindings } from '../types';
import type { BerthDTO } from '../../shared/types';

const bindings = env as unknown as Bindings & { TEST_MIGRATIONS: { name: string; queries: string[] }[] };
const request = (path: string, method = 'GET', payload?: unknown) => app.request(`https://berthday.test/api${path}`, {
  method, ...(payload === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
}, bindings);
const create = (payload: unknown) => request('/berths', 'POST', payload);

beforeEach(async () => {
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
  await bindings.DB.batch([
    bindings.DB.prepare(`INSERT INTO berths (id,name,length_ft,is_exclusive,sort_order) VALUES
      ('north-pier-east','North Pier East',240,1,0),('pool','Existing pool',NULL,0,1),('unassigned','Unassigned (legacy rows)',NULL,0,999)`),
    bindings.DB.prepare(`INSERT INTO vessels (id,name,name_key,length_ft,length_status,created_at,updated_at) VALUES
      ('short','R/V Small','R/V SMALL',80,'known','2026-09-23','2026-09-23'),('long','R/V Large','R/V LARGE',145,'known','2026-09-23','2026-09-23')`),
    bindings.DB.prepare("INSERT INTO app_meta (key,value) VALUES ('max_span_days','425'),('data_range','null'),('import_summary','{}')"),
  ]);
});
afterEach(async () => { await reset(); });

describe('Resource creation on actual D1', () => {
  it('adds a normalized dedicated berth and exposes it in resource and meta lists', async () => {
    const response = await create({ name: '  West   floating dock  ', type: 'exclusive', lengthFt: 120 });
    expect(response.status).toBe(201);
    const resource = await response.json<BerthDTO>();
    expect(resource).toMatchObject({ id: 'west-floating-dock', name: 'West floating dock', lengthFt: 120, isExclusive: true });
    const list = await (await request('/berths')).json<{ items: BerthDTO[] }>();
    expect(list.items).toContainEqual(resource);
    expect(list.items.at(-1)?.id).toBe('unassigned');
    const meta = await (await request('/meta')).json<{ berths: BerthDTO[] }>();
    expect(meta.berths).toContainEqual(resource);
    expect(await bindings.DB.prepare('SELECT source FROM berths WHERE id = ?').bind(resource.id).first('source')).toBe('app');
  });

  it('adds shared resources without a fixed length or exclusive booking rule', async () => {
    for (const input of [{ name: 'Guest slips', type: 'shared' }, { name: 'Equipment area', type: 'shared', lengthFt: null }]) {
      const response = await create(input);
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ name: input.name, lengthFt: null, isExclusive: false });
    }
  });

  it('rejects missing names, wrong types, missing lengths, and invalid length boundaries', async () => {
    const invalid = [
      { name: ' ', type: 'shared' }, { name: 'a'.repeat(121), type: 'shared' },
      { name: 'Dock', type: 'exclusive' }, { name: 'Dock', type: 'exclusive', lengthFt: 0 },
      { name: 'Dock', type: 'exclusive', lengthFt: 1001 }, { name: 'Dock', type: 'exclusive', lengthFt: 120.5 },
      { name: 'Dock', type: 'exclusive', lengthFt: '120' }, { name: 'Dock', type: 'shared', lengthFt: 120 },
      { name: 'Dock', type: 'unassigned' }, { name: 'Dock', type: 'shared', id: 'injected' },
      { name: 'Unassigned', type: 'shared' },
    ];
    for (const payload of invalid) {
      const response = await create(payload);
      expect(response.status, JSON.stringify(payload)).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
    expect(await bindings.DB.prepare('SELECT count(*) AS n FROM berths').first('n')).toBe(3);
  });

  it('rejects names already present regardless of case and repeated whitespace', async () => {
    const response = await create({ name: '  north   PIER east  ', type: 'shared' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'RESOURCE_EXISTS' } });
    const existing = await bindings.DB.prepare("SELECT length_ft,is_exclusive FROM berths WHERE id = 'north-pier-east'").first();
    expect(existing).toEqual({ length_ft: 240, is_exclusive: 1 });
  });

  it('uses the Python slug convention and rejects a colliding name without overwriting', async () => {
    const first = await create({ name: 'A/B Jetty', type: 'exclusive', lengthFt: 1000 });
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ id: 'ab-jetty', lengthFt: 1000 });
    expect((await create({ name: 'AB Jetty', type: 'shared' })).status).toBe(409);
    expect(await bindings.DB.prepare("SELECT name FROM berths WHERE id = 'ab-jetty'").first('name')).toBe('A/B Jetty');
  });

  it('accepts non-Latin names with a stable ID and prevents their duplicate', async () => {
    const first = await create({ name: '港口', type: 'shared' });
    expect(first.status).toBe(201);
    expect((await first.json<BerthDTO>()).id).toMatch(/^resource-[a-f0-9]{24}$/);
    expect((await create({ name: '港口', type: 'exclusive', lengthFt: 1 })).status).toBe(409);
  });

  it('allows only one of two racing duplicate creates', async () => {
    const responses = await Promise.all([
      create({ name: 'Visitor dock', type: 'exclusive', lengthFt: 90 }),
      create({ name: 'visitor DOCK', type: 'shared' }),
    ]);
    expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
    expect(await bindings.DB.prepare("SELECT count(*) AS n FROM berths WHERE id = 'visitor-dock'").first('n')).toBe(1);
  });

  it('uses new resources immediately for fit, overlap, and shared-resource booking rules', async () => {
    await create({ name: 'West dock', type: 'exclusive', lengthFt: 120 });
    await create({ name: 'Visitor pool', type: 'shared' });
    const stay = { startDate: '2031-07-03', endDate: '2031-07-05', kind: 'vessel' };
    expect((await request('/reservations', 'POST', { ...stay, berthId: 'west-dock', vesselId: 'long' })).status).toBe(422);
    expect((await request('/reservations', 'POST', { ...stay, berthId: 'west-dock', vesselId: 'short' })).status).toBe(201);
    expect((await request('/reservations', 'POST', { ...stay, berthId: 'west-dock', kind: 'event', title: 'Public tour' })).status).toBe(409);
    for (const title of ['Open day', 'Boat display']) {
      expect((await request('/reservations', 'POST', { ...stay, berthId: 'visitor-pool', kind: 'event', title })).status).toBe(201);
    }
    expect((await request('/reservations', 'POST', { ...stay, berthId: 'visitor-pool', vesselId: 'long' })).status).toBe(201);
    expect(await bindings.DB.prepare("SELECT count(*) AS n FROM reservations WHERE berth_id = 'visitor-pool'").first('n')).toBe(3);
  });
});
