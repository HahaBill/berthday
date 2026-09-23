import { Hono } from 'hono';
import { getFitStatus, reservationConflicts } from '../../shared/domain';
import { availabilityQuerySchema } from '../../shared/schemas';
import type { AvailabilityResult } from '../../shared/types';
import { getBerths, getVessel, windowReservations } from '../db';
import { missing } from '../errors';
import type { WorkerEnv } from '../types';
import { parse } from '../validation';

export const availabilityRoutes = new Hono<WorkerEnv>().get('/', async c => {
  const query = parse(availabilityQuerySchema, c.req.query());
  const [berths, reservations, vessel] = await Promise.all([
    getBerths(c.env.DB), windowReservations(c.env.DB, query.start, query.end),
    query.vesselId ? getVessel(c.env.DB, query.vesselId) : Promise.resolve(null),
  ]);
  if (query.vesselId && !vessel) throw missing('Vessel');
  // A selected vessel's registry length always wins over a client-supplied length.
  const lengthFt = vessel ? vessel.lengthFt : query.lengthFt ?? null;
  const items: AvailabilityResult[] = berths.filter(b => b.id !== 'unassigned').map(berth => {
    const found = reservationConflicts({ berthId: berth.id, kind: query.vesselId ? 'vessel' : 'event',
      vesselId: query.vesselId, startDate: query.start, endDate: query.end },
    { berths, vessels: vessel ? [vessel] : [], reservations, excludeId: query.excludeId });
    const conflicts = [...found.berth, ...found.vessel];
    const fit = getFitStatus({ kind: 'vessel' }, berth, { lengthFt });
    const status = fit === 'violation' ? 'too_short'
      : conflicts.length ? 'busy' : !berth.isExclusive ? 'shared'
        : fit === 'unverified' ? 'unverified' : 'available';
    return { berth, status, conflicts };
  });
  const rank = { available: 0, unverified: 1, shared: 2, busy: 3, too_short: 4 };
  items.sort((a, b) => rank[a.status] - rank[b.status] || (a.berth.lengthFt ?? Infinity) - (b.berth.lengthFt ?? Infinity) || a.berth.sortOrder - b.berth.sortOrder);
  return c.json({ items });
});
