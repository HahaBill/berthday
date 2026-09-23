import { addDays, diffDays, isValidDate, sharedDays } from './dates';
import type {
  Alternatives, ApiErrorCode, BerthDTO, Candidate, FitStatus, IssueType, ReservationLike, VesselDTO,
} from './types';

export type { Candidate, ReservationInput, ReservationLike } from './types';

export interface DomainContext<R extends ReservationLike = ReservationLike> {
  berths: readonly BerthDTO[];
  vessels: readonly VesselDTO[];
  reservations: readonly R[];
  excludeId?: string;
}

export type ValidationResult<R extends ReservationLike = ReservationLike> =
  | { valid: true; fitStatus: FitStatus }
  | { valid: false; status: 400 | 404 | 409 | 422; code: ApiErrorCode; message: string; conflicts: R[] };

export interface DetectedIssue {
  id: string;
  type: IssueType;
  reservationId: string;
  otherReservationId: string | null;
  berthId: string | null;
  startDate: string;
  endDate: string;
  details: Record<string, unknown>;
}

/** The migration has already selected the larger disputed length; never substitute the smaller one. */
export function fitStatus(
  candidate: Pick<Candidate, 'kind'>,
  berth: Pick<BerthDTO, 'lengthFt'> | null | undefined,
  vessel: Pick<VesselDTO, 'lengthFt'> | null | undefined,
): FitStatus {
  if (candidate.kind !== 'vessel') return 'n/a';
  if (berth?.lengthFt == null || vessel?.lengthFt == null) return 'unverified';
  return vessel.lengthFt > berth.lengthFt ? 'violation' : 'ok';
}

export const getFitStatus = fitStatus;

function otherReservations<R extends ReservationLike>(candidate: Candidate, context: DomainContext<R>): R[] {
  const excluded = context.excludeId ?? candidate.id;
  return context.reservations.filter((row) => row.id !== excluded);
}

/** Shared O/V checks for authoritative writes, availability, and alternative suggestions. */
export function reservationConflicts<R extends ReservationLike>(candidate: Candidate, context: DomainContext<R>): { berth: R[]; vessel: R[] } {
  const others = otherReservations(candidate, context);
  const berth = context.berths.find((item) => item.id === candidate.berthId);
  return {
    berth: berth?.isExclusive ? others.filter((row) => row.berthId === candidate.berthId && sharedDays(candidate, row) > 0) : [],
    vessel: candidate.kind === 'vessel' && candidate.vesselId ? others.filter((row) => row.kind === 'vessel'
      && row.vesselId === candidate.vesselId && row.berthId !== candidate.berthId && sharedDays(candidate, row) >= 2) : [],
  };
}

function conflictLabel(row: ReservationLike, vessels: readonly VesselDTO[]): string {
  return (row.vesselId ? vessels.find((vessel) => vessel.id === row.vesselId)?.name : row.title)
    || (row.kind === 'vessel' ? 'another vessel' : 'another booking');
}

/** Validate an entire create or merged edit. Notes-only legacy edits bypass this in the Worker. */
export function validateCandidate<R extends ReservationLike>(candidate: Candidate, context: DomainContext<R>): ValidationResult<R> {
  const fail = (
    status: 400 | 404 | 409 | 422, code: ApiErrorCode, message: string, conflicts: R[] = [],
  ): ValidationResult<R> => ({ valid: false, status, code, message, conflicts });

  if (!isValidDate(candidate.startDate) || !isValidDate(candidate.endDate)) {
    return fail(400, 'VALIDATION_ERROR', 'Enter valid dates in YYYY-MM-DD format.');
  }
  if (candidate.endDate < candidate.startDate) {
    return fail(400, 'VALIDATION_ERROR', 'The last day at berth must be on or after the start date.');
  }
  if (diffDays(candidate.startDate, candidate.endDate) + 1 > 366) {
    return fail(400, 'VALIDATION_ERROR', 'A booking can occupy at most 366 days. Choose an earlier last day.');
  }
  if (!['vessel', 'event', 'closure', 'hold'].includes(candidate.kind)) {
    return fail(400, 'VALIDATION_ERROR', 'Choose vessel, event, closure, or hold.');
  }
  if (candidate.kind === 'vessel' && !candidate.vesselId) {
    return fail(400, 'VALIDATION_ERROR', 'Choose a vessel for this booking.');
  }
  if (candidate.kind !== 'vessel' && (candidate.vesselId || !candidate.title?.trim())) {
    return fail(400, 'VALIDATION_ERROR', 'Events, closures, and holds need a title and must not select a vessel.');
  }
  if (candidate.berthId === 'unassigned') {
    return fail(422, 'UNASSIGNED_TARGET', 'Choose a berth. Unassigned is only for records imported from legacy rows.');
  }
  const berth = context.berths.find((item) => item.id === candidate.berthId);
  if (!berth) return fail(404, 'NOT_FOUND', 'This berth no longer exists. Choose another berth.');
  const vessel = candidate.kind === 'vessel' ? context.vessels.find((item) => item.id === candidate.vesselId) : undefined;
  if (candidate.kind === 'vessel' && !vessel) {
    return fail(404, 'NOT_FOUND', 'This vessel no longer exists. Choose a vessel from the registry.');
  }
  const fit = fitStatus(candidate, berth, vessel);
  if (fit === 'violation') {
    const disputed = vessel!.lengthStatus === 'disputed' ? ' The larger disputed length is used.' : '';
    return fail(422, 'FIT_VIOLATION', `${vessel!.name} is ${vessel!.lengthFt} ft; ${berth.name} takes up to ${berth.lengthFt} ft.${disputed}`);
  }
  const conflicts = reservationConflicts(candidate, context);
  if (conflicts.berth.length) {
    const first = conflicts.berth[0];
    return fail(409, 'BERTH_CONFLICT', `${berth.name} is booked by ${conflictLabel(first, context.vessels)} from ${first.startDate} through ${first.endDate}.`, conflicts.berth);
  }
  if (conflicts.vessel.length) {
    const first = conflicts.vessel[0];
    const otherBerth = context.berths.find((item) => item.id === first.berthId)?.name ?? 'another berth';
    return fail(409, 'VESSEL_CONFLICT', `${vessel!.name} is already booked at ${otherBerth} from ${first.startDate} through ${first.endDate}. A berth change may share only one day.`, conflicts.vessel);
  }
  return { valid: true, fitStatus: fit };
}

export const validateReservation = validateCandidate;

/** All suggestions reapply O, F, and V; no suggested move depends on an AI model. */
export function suggestAlternatives<R extends ReservationLike>(candidate: Candidate, context: DomainContext<R>): Alternatives {
  const alternatives: Alternatives = { berths: [], dateShifts: [] };
  if (candidate.kind === 'closure' || candidate.kind === 'hold') return alternatives;
  if (!isValidDate(candidate.startDate) || !isValidDate(candidate.endDate)
    || candidate.endDate < candidate.startDate || diffDays(candidate.startDate, candidate.endDate) + 1 > 366) return alternatives;

  for (const berth of context.berths) {
    if (!berth.isExclusive || berth.id === candidate.berthId || berth.id === 'unassigned') continue;
    const check = validateCandidate({ ...candidate, berthId: berth.id }, context);
    if (check.valid) {
      alternatives.berths.push({
        berthId: berth.id, berthName: berth.name, lengthFt: berth.lengthFt,
        fit: check.fitStatus === 'unverified' ? 'unverified' : 'ok',
      });
    }
  }
  alternatives.berths.sort((a, b) => Number(a.fit === 'unverified') - Number(b.fit === 'unverified')
    || (a.lengthFt ?? Infinity) - (b.lengthFt ?? Infinity) || a.berthId.localeCompare(b.berthId));
  alternatives.berths = alternatives.berths.slice(0, 3);

  for (const direction of ['earlier', 'later'] as const) {
    for (let days = 1; days <= 60; days += 1) {
      const offset = direction === 'earlier' ? -days : days;
      let startDate: string, endDate: string;
      try {
        startDate = addDays(candidate.startDate, offset);
        endDate = addDays(candidate.endDate, offset);
      } catch {
        break; // A valid ISO date cannot move outside years 0001–9999.
      }
      if (validateCandidate({ ...candidate, startDate, endDate }, context).valid) {
        alternatives.dateShifts.push({ startDate, endDate, direction, days });
        break;
      }
    }
  }
  alternatives.dateShifts.sort((a, b) => a.days - b.days || a.startDate.localeCompare(b.startDate));
  return alternatives;
}

/** Detect legacy O/F/V issues. IDs need only be deterministic: parity compares type and booking pairs. */
export function detectIssues(
  reservations: readonly ReservationLike[], berths: readonly BerthDTO[], vessels: readonly VesselDTO[],
): DetectedIssue[] {
  const result: DetectedIssue[] = [];
  const berthMap = new Map(berths.map((berth) => [berth.id, berth]));
  const vesselMap = new Map(vessels.map((vessel) => [vessel.id, vessel]));
  const byBerth = new Map<string, ReservationLike[]>();
  const byVessel = new Map<string, ReservationLike[]>();
  const sorted = (rows: readonly ReservationLike[]) => [...rows].sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id));
  const add = (type: IssueType, a: ReservationLike, b: ReservationLike | null, berthId: string | null, details: Record<string, unknown>) => {
    result.push({
      id: `${type}:${encodeURIComponent(a.id)}:${encodeURIComponent(b?.id ?? '')}`,
      type, reservationId: a.id, otherReservationId: b?.id ?? null, berthId,
      startDate: b && b.startDate > a.startDate ? b.startDate : a.startDate,
      endDate: b && b.endDate < a.endDate ? b.endDate : a.endDate, details,
    });
  };

  for (const reservation of reservations) {
    const rows = byBerth.get(reservation.berthId) ?? [];
    rows.push(reservation);
    byBerth.set(reservation.berthId, rows);
    if (reservation.kind === 'vessel' && reservation.vesselId) {
      const vesselRows = byVessel.get(reservation.vesselId) ?? [];
      vesselRows.push(reservation);
      byVessel.set(reservation.vesselId, vesselRows);
      const vessel = vesselMap.get(reservation.vesselId), berth = berthMap.get(reservation.berthId);
      if (fitStatus(reservation, berth, vessel) === 'violation') {
        add('fit', reservation, null, reservation.berthId, {
          vessel_length_ft: vessel!.lengthFt, berth_length_ft: berth!.lengthFt, length_status: vessel!.lengthStatus,
        });
      }
    }
  }
  for (const [berthId, rows] of byBerth) {
    if (!berthMap.get(berthId)?.isExclusive) continue;
    let active: ReservationLike[] = [];
    for (const row of sorted(rows)) {
      active = active.filter((other) => other.endDate >= row.startDate);
      for (const other of active) add('overlap', other, row, berthId, { shared_days: sharedDays(other, row) });
      active.push(row);
    }
  }
  for (const rows of byVessel.values()) {
    let active: ReservationLike[] = [];
    for (const row of sorted(rows)) {
      active = active.filter((other) => other.endDate >= row.startDate);
      for (const other of active) {
        const days = sharedDays(other, row);
        if (other.berthId !== row.berthId && days >= 2) {
          add('vessel_double', other, row, null, { berths: [other.berthId, row.berthId], shared_days: days });
        }
      }
      active.push(row);
    }
  }
  return result.sort((a, b) => a.startDate.localeCompare(b.startDate) || a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
}
