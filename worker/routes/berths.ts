import { Hono } from 'hono';
import type { WorkerEnv } from '../types';
import { getBerths } from '../db';

export const berthRoutes = new Hono<WorkerEnv>().get('/', async c => c.json({ items: await getBerths(c.env.DB) }));
