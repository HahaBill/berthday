import { Hono } from 'hono';
import type { WorkerEnv } from '../types';
import { getBerths } from '../db';
import { resourceCreateSchema } from '../../shared/resource-schemas';
import { createResource } from '../resources';
import { body } from '../validation';

export const berthRoutes = new Hono<WorkerEnv>()
  .get('/', async c => c.json({ items: await getBerths(c.env.DB) }))
  .post('/', async c => c.json(await createResource(c.env.DB, await body(c, resourceCreateSchema)), 201));
