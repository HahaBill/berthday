import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectIssues } from '../domain';
import type { BerthDTO, Kind, LengthStatus, ReservationLike, VesselDTO } from '../types';

const directory = fileURLToPath(new URL('../../migration/out/', import.meta.url));
const files = ['reservations', 'berths', 'vessels', 'issues'];
const available = files.every((name) => existsSync(`${directory}${name}.json`));
const load = <T>(name: string): T[] => JSON.parse(readFileSync(`${directory}${name}.json`, 'utf8')) as T[];

type LegacyReservation = { id: string; berth_id: string; kind: Kind; vessel_id: string | null; title: string | null; start_date: string; end_date: string };
type LegacyBerth = { id: string; name: string; length_ft: number | null; is_exclusive: number; sort_order: number };
type LegacyVessel = { id: string; name: string; length_ft: number | null; length_status: LengthStatus; length_note?: string | null };
type LegacyIssue = { type: string; reservation_id: string; other_reservation_id: string | null };
const key = (type: string, first: string, other: string | null) => `${type}|${[first, ...(other ? [other] : [])].sort().join('|')}`;

describe('TypeScript / audited Python migration parity', () => {
  it.skipIf(!available)('matches every issue pair (run npm run migrate first if this test is skipped: migration/out JSON is absent)', () => {
    const reservations: ReservationLike[] = load<LegacyReservation>('reservations').map((row) => ({
      id: row.id, berthId: row.berth_id, kind: row.kind, vesselId: row.vessel_id,
      title: row.title, startDate: row.start_date, endDate: row.end_date,
    }));
    const berths: BerthDTO[] = load<LegacyBerth>('berths').map((row) => ({
      id: row.id, name: row.name, lengthFt: row.length_ft, isExclusive: Boolean(row.is_exclusive), sortOrder: row.sort_order,
    }));
    const vessels: VesselDTO[] = load<LegacyVessel>('vessels').map((row) => ({
      id: row.id, name: row.name, lengthFt: row.length_ft, lengthStatus: row.length_status, lengthNote: row.length_note ?? null,
    }));
    const expected = load<LegacyIssue>('issues').map((issue) => key(issue.type, issue.reservation_id, issue.other_reservation_id)).sort();
    const actual = detectIssues(reservations, berths, vessels).map((issue) => key(issue.type, issue.reservationId, issue.otherReservationId)).sort();
    expect(actual).toEqual(expected);
    expect(new Set(actual).size).toBe(actual.length);
  });
});
