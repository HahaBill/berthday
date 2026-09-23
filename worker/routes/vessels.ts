import { Hono } from 'hono';
import { idSchema, vesselCreateSchema, vesselPatchSchema, vesselQuerySchema } from '../../shared/schemas';
import { createVessel, listVessels, updateVessel } from '../db';
import type { WorkerEnv } from '../types';
import { body, parse } from '../validation';

export const vesselRoutes = new Hono<WorkerEnv>()
  .get('/', async c => c.json(await listVessels(c.env.DB, parse(vesselQuerySchema, c.req.query()))))
  .post('/', async c => c.json(await createVessel(c.env.DB, await body(c, vesselCreateSchema)), 201))
  .patch('/:id', async c => c.json(await updateVessel(c.env.DB, parse(idSchema, c.req.param('id')), await body(c, vesselPatchSchema))));
