import { Hono } from 'hono';
import { addDays } from '../../shared/dates';
import { suggestAlternatives, validateCandidate } from '../../shared/domain';
import type { Candidate, ReservationDTO, VesselDTO } from '../../shared/types';
import { idSchema, reservationCreateSchema, reservationPatchSchema, reservationQuerySchema } from '../../shared/schemas';
import { deleteReservation, getBerths, getReservation, getVessel, insertReservation, listReservations, updateReservation, windowReservations } from '../db';
import { ApiError, missing } from '../errors';
import type { WorkerEnv } from '../types';
import { body, parse } from '../validation';

async function contextFor(db: D1Database, candidate: Candidate) {
  let from = '0001-01-01', to = '9999-12-31';
  try { from = addDays(candidate.startDate, -60); } catch { /* Clamp at civil-date boundary. */ }
  try { to = addDays(candidate.endDate, 60); } catch { /* Clamp at civil-date boundary. */ }
  const [berths, reservations, selectedVessel] = await Promise.all([
    getBerths(db), windowReservations(db, from, to),
    candidate.vesselId ? getVessel(db, candidate.vesselId) : Promise.resolve(null),
  ]);
  const vessels = new Map<string, VesselDTO>();
  for (const row of reservations) if (row.vessel) vessels.set(row.vessel.id, { ...row.vessel, lengthStatus: row.vessel.lengthStatus as VesselDTO['lengthStatus'], lengthNote: null });
  if (selectedVessel) vessels.set(selectedVessel.id, selectedVessel);
  return { berths, reservations, vessels: [...vessels.values()], excludeId: candidate.id };
}
async function assertAllowed(db: D1Database, candidate: Candidate) {
  const context = await contextFor(db, candidate);
  const result = validateCandidate<ReservationDTO>(candidate, context);
  if (!result.valid) throw new ApiError(result.status, result.code, result.message, result.conflicts, suggestAlternatives(candidate, context));
}

export const reservationRoutes = new Hono<WorkerEnv>()
  .get('/', async c => c.json(await listReservations(c.env.DB, parse(reservationQuerySchema, c.req.query()))))
  .get('/:id', async c => {
    const row = await getReservation(c.env.DB, parse(idSchema, c.req.param('id')));
    if (!row) throw missing('Booking');
    return c.json(row);
  })
  .post('/', async c => {
    const input = await body(c, reservationCreateSchema), id = crypto.randomUUID();
    await assertAllowed(c.env.DB, input);
    if (!await insertReservation(c.env.DB, id, input)) {
      await assertAllowed(c.env.DB, input);
      // A racing edit may have changed between the failed write and this read.
      // Retry the atomic statement once; it still enforces every rule.
      if (!await insertReservation(c.env.DB, id, input)) {
        await assertAllowed(c.env.DB, input);
        throw new ApiError(409, 'BERTH_CONFLICT', 'The schedule changed while saving this booking. Refresh availability and try again.');
      }
    }
    return c.json((await getReservation(c.env.DB, id))!, 201);
  })
  .patch('/:id', async c => {
    const id = parse(idSchema, c.req.param('id')), patch = await body(c, reservationPatchSchema);
    const existing = await getReservation(c.env.DB, id); if (!existing) throw missing('Booking');
    const candidate: Candidate = { ...existing, ...patch, id };
    const keys = ['berthId', 'startDate', 'endDate', 'kind', 'vesselId'] as const;
    const keyChanged = keys.some(key => candidate[key] !== existing[key]);
    // A title/notes edit does not invalidate a historical long stay or remove its issues.
    if (keyChanged) await assertAllowed(c.env.DB, candidate);
    if (candidate.kind !== 'vessel' && !candidate.title?.trim()) throw new ApiError(400, 'VALIDATION_ERROR', 'Events, closures, and holds require a title.');
    if (!await updateReservation(c.env.DB, id, candidate, keyChanged)) {
      if (!await getReservation(c.env.DB, id)) throw missing('Booking');
      await assertAllowed(c.env.DB, candidate);
      throw new ApiError(409, 'BERTH_CONFLICT', 'The schedule changed while saving this booking. Refresh availability and try again.');
    }
    return c.json((await getReservation(c.env.DB, id))!);
  })
  .delete('/:id', async c => {
    if (!await deleteReservation(c.env.DB, parse(idSchema, c.req.param('id')))) throw missing('Booking');
    return c.body(null, 204);
  });
