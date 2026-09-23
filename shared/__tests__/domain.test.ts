import { describe, expect, it } from 'vitest';
import { addDays } from '../dates';
import { detectIssues, fitStatus, reservationConflicts, suggestAlternatives, validateCandidate, type DomainContext } from '../domain';
import { availabilityQuerySchema, askRequestSchema, reservationCreateSchema, reservationPatchSchema, reservationQuerySchema, vesselCreateSchema } from '../schemas';
import type { BerthDTO, Candidate, ReservationLike, VesselDTO } from '../types';

const berth = (id: string, lengthFt: number | null, isExclusive = true): BerthDTO => ({ id, name: id, lengthFt, isExclusive, sortOrder: 0 });
const vessel = (id: string, lengthFt: number | null, lengthStatus: VesselDTO['lengthStatus'] = lengthFt === null ? 'unknown' : 'known'): VesselDTO => ({
  id, name: `R/V ${id}`, lengthFt, lengthStatus, lengthNote: null,
});
const baseBerths = [berth('small', 90), berth('medium', 240), berth('large', 410), berth('pool', null, false), berth('unassigned', null, false)];
const baseVessels = [vessel('one', 80), vessel('two', 145), vessel('unknown', null), vessel('disputed', 100, 'disputed')];
const booking = (overrides: Partial<ReservationLike> = {}): ReservationLike => ({
  id: 'old', berthId: 'small', kind: 'vessel', vesselId: 'one', title: null,
  startDate: '2026-01-01', endDate: '2026-01-05', ...overrides,
});
const candidate = (overrides: Partial<Candidate> = {}): Candidate => ({
  berthId: 'small', kind: 'vessel', vesselId: 'one', startDate: '2026-01-06', endDate: '2026-01-09', ...overrides,
});
const context = (reservations: ReservationLike[] = [], berths = baseBerths): DomainContext => ({ berths, vessels: baseVessels, reservations });
const failureCode = (input: Candidate, ctx = context()) => {
  const result = validateCandidate(input, ctx);
  return result.valid ? null : result.code;
};

describe('O: exclusive berth occupancy', () => {
  it('accepts back-to-back bookings with no shared day', () => {
    expect(validateCandidate(candidate(), context([booking()]))).toEqual({ valid: true, fitStatus: 'ok' });
  });

  it('rejects a shared last/first day and names the conflicting booking', () => {
    const result = validateCandidate(candidate({ startDate: '2026-01-05' }), context([booking()]));
    expect(result).toMatchObject({ valid: false, status: 409, code: 'BERTH_CONFLICT', conflicts: [{ id: 'old' }] });
    if (!result.valid) expect(result.message).toContain('R/V one');
  });

  it('detects containment in both directions', () => {
    expect(failureCode(candidate({ startDate: '2026-01-02', endDate: '2026-01-03' }), context([booking()]))).toBe('BERTH_CONFLICT');
    expect(failureCode(candidate({ startDate: '2025-12-31', endDate: '2026-01-09' }), context([booking()]))).toBe('BERTH_CONFLICT');
  });

  it('makes every booking kind occupy an exclusive berth', () => {
    for (const kind of ['event', 'closure', 'hold'] as const) {
      expect(failureCode(candidate({ startDate: '2026-01-05' }), context([booking({ kind, vesselId: null, title: 'Occupied' })]))).toBe('BERTH_CONFLICT');
    }
  });

  it('does not treat shared pools as exclusive berths', () => {
    expect(failureCode(candidate({ berthId: 'pool', startDate: '2026-01-01' }), context([booking({ berthId: 'pool' })]))).toBeNull();
  });

  it('excludes the edited reservation by candidate id or explicit excludeId', () => {
    expect(failureCode(candidate({ id: 'old', startDate: '2026-01-01' }), context([booking()]))).toBeNull();
    expect(failureCode(candidate({ startDate: '2026-01-01' }), { ...context([booking()]), excludeId: 'old' })).toBeNull();
  });
});

describe('F: vessel length', () => {
  it('rejects 145 ft on a 90 ft berth with both lengths in the error', () => {
    const result = validateCandidate(candidate({ vesselId: 'two' }), context());
    expect(result).toMatchObject({ valid: false, status: 422, code: 'FIT_VIOLATION' });
    if (!result.valid) expect(result.message).toBe('R/V two is 145 ft; small takes up to 90 ft.');
  });

  it('accepts an exact fit', () => {
    expect(fitStatus(candidate(), berth('exact', 80), baseVessels[0])).toBe('ok');
  });

  it('allows either unknown length with unverified fit', () => {
    expect(validateCandidate(candidate({ vesselId: 'unknown' }), context())).toEqual({ valid: true, fitStatus: 'unverified' });
    expect(validateCandidate(candidate({ berthId: 'pool' }), context())).toEqual({ valid: true, fitStatus: 'unverified' });
  });

  it('uses the conservative imported disputed length', () => {
    const result = validateCandidate(candidate({ vesselId: 'disputed' }), context());
    expect(result).toMatchObject({ valid: false, code: 'FIT_VIOLATION' });
    if (!result.valid) expect(result.message).toContain('larger disputed length');
  });

  it('marks non-vessel bookings as n/a', () => {
    expect(validateCandidate(candidate({ kind: 'event', vesselId: null, title: 'Community sail day' }), context())).toEqual({ valid: true, fitStatus: 'n/a' });
  });
});

describe('V: vessel in two places', () => {
  it('allows one shared day for changing berths', () => {
    expect(failureCode(candidate({ berthId: 'medium', startDate: '2026-01-05' }), context([booking()]))).toBeNull();
  });

  it('rejects two shared days and identifies the other berth', () => {
    const result = validateCandidate(candidate({ berthId: 'medium', startDate: '2026-01-04' }), context([booking()]));
    expect(result).toMatchObject({ valid: false, status: 409, code: 'VESSEL_CONFLICT' });
    if (!result.valid) expect(result.message).toContain('small');
  });

  it('applies the vessel rule even to shared pools', () => {
    expect(failureCode(candidate({ berthId: 'pool', startDate: '2026-01-01' }), context([booking()]))).toBe('VESSEL_CONFLICT');
  });

  it('does not confuse different vessels', () => {
    expect(failureCode(candidate({ berthId: 'medium', vesselId: 'two', startDate: '2026-01-01' }), context([booking()]))).toBeNull();
  });
});

describe('shared availability conflict checks', () => {
  it('returns berth and vessel conflicts separately for the same candidate', () => {
    const rows = [booking({ vesselId: 'unknown' }), booking({ id: 'elsewhere', berthId: 'medium' })];
    const conflicts = reservationConflicts(candidate({ startDate: '2026-01-04' }), context(rows));
    expect(conflicts.berth.map((row) => row.id)).toEqual(['old']);
    expect(conflicts.vessel.map((row) => row.id)).toEqual(['elsewhere']);
  });

  it('honors shared resources, shift days, and excluded edits', () => {
    const rows = [booking({ id: 'editing', berthId: 'pool' }), booking({ berthId: 'medium' })];
    expect(reservationConflicts(candidate({ id: 'editing', berthId: 'pool', startDate: '2026-01-05' }), context(rows)))
      .toEqual({ berth: [], vessel: [] });
  });
});

describe('booking shape and write bounds', () => {
  it('rejects unassigned, missing references, and invalid dates', () => {
    expect(failureCode(candidate({ berthId: 'unassigned' }))).toBe('UNASSIGNED_TARGET');
    expect(failureCode(candidate({ berthId: 'missing' }))).toBe('NOT_FOUND');
    expect(failureCode(candidate({ vesselId: 'missing' }))).toBe('NOT_FOUND');
    expect(failureCode(candidate({ startDate: '2026-02-30' }))).toBe('VALIDATION_ERROR');
    expect(failureCode(candidate({ startDate: '2026-02-01', endDate: '2026-01-01' }))).toBe('VALIDATION_ERROR');
  });

  it('allows exactly 366 occupied days, but not 367', () => {
    expect(failureCode(candidate({ startDate: '2026-01-01', endDate: addDays('2026-01-01', 365) }))).toBeNull();
    expect(failureCode(candidate({ startDate: '2026-01-01', endDate: addDays('2026-01-01', 366) }))).toBe('VALIDATION_ERROR');
  });

  it('enforces kind/vessel/title consistency', () => {
    expect(failureCode(candidate({ vesselId: null }))).toBe('VALIDATION_ERROR');
    expect(failureCode(candidate({ kind: 'hold', title: 'Reserved' }))).toBe('VALIDATION_ERROR');
    expect(failureCode(candidate({ kind: 'hold', title: '  ', vesselId: null }))).toBe('VALIDATION_ERROR');
  });
});

describe('deterministic alternatives', () => {
  it('orders verified best fits before unverified and excludes short, busy, shared, and requested berths', () => {
    const berths = [berth('requested', 70), berth('short', 60), berth('busy', 85), berth('fit', 90), berth('big', 100), berth('unknown', null), berth('pool', null, false)];
    const result = suggestAlternatives(candidate({ berthId: 'requested' }), context([booking({ berthId: 'busy', endDate: '2026-01-10', vesselId: 'two' })], berths));
    expect(result.berths.map((option) => option.berthId)).toEqual(['fit', 'big', 'unknown']);
    expect(result.berths.map((option) => option.fit)).toEqual(['ok', 'ok', 'unverified']);
    expect(result.dateShifts).toEqual([]); // Moving dates cannot make a short berth fit.
  });

  it('caps other berth suggestions at three', () => {
    const berths = [berth('requested', 70), ...[100, 110, 120, 130].map((length) => berth(String(length), length))];
    expect(suggestAlternatives(candidate({ berthId: 'requested' }), context([], berths)).berths.map((option) => option.lengthFt)).toEqual([100, 110, 120]);
  });

  it('offers the nearest window on either side and sorts by days moved', () => {
    const result = suggestAlternatives(candidate({ startDate: '2026-01-04', endDate: '2026-01-06' }), context([booking()]));
    expect(result.dateShifts).toEqual([
      { startDate: '2026-01-06', endDate: '2026-01-08', direction: 'later', days: 2 },
      { startDate: '2025-12-29', endDate: '2025-12-31', direction: 'earlier', days: 6 },
    ]);
  });

  it('rechecks vessel conflicts on another berth and on date shifts', () => {
    const result = suggestAlternatives(candidate({ startDate: '2026-01-04', endDate: '2026-01-06' }), context([
      booking(), booking({ id: 'other', berthId: 'medium', startDate: '2026-01-06', endDate: '2026-01-09' }),
    ]));
    // The same vessel cannot move to any different berth while the first booking still occupies 2 days.
    expect(result.berths).toEqual([]);
    expect(result.dateShifts.find((shift) => shift.direction === 'later')).toMatchObject({ startDate: '2026-01-09', days: 5 });
  });

  it('never suggests moving closures or holds', () => {
    for (const kind of ['closure', 'hold'] as const) {
      expect(suggestAlternatives(candidate({ kind, vesselId: null, title: 'Maintenance' }), context())).toEqual({ berths: [], dateShifts: [] });
    }
  });

  it('never searches beyond 60 days', () => {
    const result = suggestAlternatives(candidate(), context([booking({ startDate: '2025-01-01', endDate: '2027-01-01' })]));
    expect(result.dateShifts).toEqual([]);
  });

  it('handles the first and last representable ISO dates without throwing', () => {
    expect(suggestAlternatives(candidate({ startDate: '0001-01-01', endDate: '0001-01-01' }), context()).dateShifts)
      .toEqual([{ startDate: '0001-01-02', endDate: '0001-01-02', direction: 'later', days: 1 }]);
    expect(suggestAlternatives(candidate({ startDate: '9999-12-31', endDate: '9999-12-31' }), context()).dateShifts)
      .toEqual([{ startDate: '9999-12-30', endDate: '9999-12-30', direction: 'earlier', days: 1 }]);
  });

  it('does not mutate its candidate or context', () => {
    const input = candidate(), ctx = context([booking()]);
    const before = JSON.stringify({ input, ctx });
    suggestAlternatives(input, ctx);
    expect(JSON.stringify({ input, ctx })).toBe(before);
  });
});

describe('legacy issue detection', () => {
  it('detects overlap, fit, and vessel double issues with clipped inclusive ranges', () => {
    const issues = detectIssues([
      booking(),
      booking({ id: 'overlap', vesselId: 'unknown', startDate: '2026-01-05', endDate: '2026-01-07' }),
      booking({ id: 'fit', vesselId: 'two', startDate: '2026-02-01', endDate: '2026-02-02' }),
      booking({ id: 'double', berthId: 'medium', startDate: '2026-01-04', endDate: '2026-01-10' }),
    ], baseBerths, baseVessels);
    expect(issues.map((issue) => issue.type).sort()).toEqual(['fit', 'overlap', 'vessel_double']);
    expect(issues.find((issue) => issue.type === 'overlap')).toMatchObject({ startDate: '2026-01-05', endDate: '2026-01-05', details: { shared_days: 1 } });
    expect(issues.find((issue) => issue.type === 'vessel_double')).toMatchObject({ startDate: '2026-01-04', endDate: '2026-01-05', berthId: null, details: { shared_days: 2 } });
  });

  it('does not flag a shift day or shared pool overlap', () => {
    expect(detectIssues([
      booking(), booking({ id: 'shift', berthId: 'medium', startDate: '2026-01-05', endDate: '2026-01-09' }),
      booking({ id: 'pool-one', berthId: 'pool', vesselId: 'two' }), booking({ id: 'pool-two', berthId: 'pool', vesselId: 'unknown' }),
    ], baseBerths, baseVessels)).toEqual([]);
  });

  it('detects all pairs in a three-way overlap without duplicates', () => {
    const rows = [booking(), booking({ id: 'b' }), booking({ id: 'c' })];
    expect(detectIssues(rows, baseBerths, baseVessels)).toHaveLength(3);
    expect(detectIssues([...rows].reverse(), baseBerths, baseVessels)).toEqual(detectIssues(rows, baseBerths, baseVessels));
  });
});

describe('request schemas', () => {
  it('rejects malformed dates, overlong bookings, and unknown body fields', () => {
    expect(reservationCreateSchema.safeParse(candidate({ startDate: '2019-02-29' })).success).toBe(false);
    expect(reservationCreateSchema.safeParse(candidate({ startDate: '2026-01-01', endDate: '2027-01-02' })).success).toBe(false);
    expect(reservationCreateSchema.safeParse({ ...candidate(), origin: 'legacy' }).success).toBe(false);
  });

  it('permits notes-only patches but rejects empty updates', () => {
    expect(reservationPatchSchema.parse({ notes: 'Reviewed against the workbook.' })).toEqual({ notes: 'Reviewed against the workbook.' });
    expect(reservationPatchSchema.safeParse({}).success).toBe(false);
  });

  it('bounds list windows and page sizes', () => {
    expect(reservationQuerySchema.safeParse({ from: '2026-01-01', to: addDays('2026-01-01', 400) }).success).toBe(true);
    expect(reservationQuerySchema.safeParse({ from: '2026-01-01', to: addDays('2026-01-01', 401) }).success).toBe(false);
    expect(reservationQuerySchema.safeParse({ from: '2026-01-01', to: '2026-02-01', limit: '201' }).success).toBe(false);
    expect(reservationQuerySchema.parse({ from: '2026-01-01', to: '2026-02-01', hasIssues: 'false' }).hasIssues).toBe(false);
  });

  it('requires a measured length for new vessels and the client date for Ask', () => {
    expect(vesselCreateSchema.safeParse({ name: 'R/V New' }).success).toBe(false);
    expect(vesselCreateSchema.safeParse({ name: 'R/V New', lengthFt: 1001 }).success).toBe(false);
    expect(vesselCreateSchema.safeParse({ name: 'R/V New', lengthFt: 145 }).success).toBe(true);
    expect(askRequestSchema.safeParse({ q: 'next week', viewedMonth: '2019-12' }).success).toBe(false);
    expect(askRequestSchema.safeParse({ q: 'next week', today: '2026-09-22', viewedMonth: '2019-12' }).success).toBe(true);
  });

  it('prevents ambiguous availability vessel and length inputs', () => {
    expect(availabilityQuerySchema.safeParse({ start: '2026-01-01', end: '2026-01-03', vesselId: 'one', lengthFt: '90' }).success).toBe(false);
  });
});
