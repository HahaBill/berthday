import { Hono } from 'hono';
import { importIssueQuerySchema } from '../../shared/schemas';
import { importCodes, listImportIssues } from '../db';
import type { WorkerEnv } from '../types';
import { parse } from '../validation';
import { importJobRoutes } from './import-jobs';

export const importRoutes = new Hono<WorkerEnv>()
  .route('/jobs', importJobRoutes)
  .get('/issues', async c => c.json(await listImportIssues(c.env.DB, parse(importIssueQuerySchema, c.req.query()))))
  .get('/codes', async c => c.json(await importCodes(c.env.DB)));
