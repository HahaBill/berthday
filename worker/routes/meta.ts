import { Hono } from 'hono';
import type { WorkerEnv } from '../types';
import { getMeta } from '../db';

export const metaRoutes = new Hono<WorkerEnv>().get('/', async c => c.json(await getMeta(c.env.DB)));
