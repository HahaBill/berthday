import { Hono } from 'hono';
import { idSchema, issueQuerySchema, reviewIssueSchema } from '../../shared/schemas';
import { listIssues, reviewIssue } from '../db';
import type { WorkerEnv } from '../types';
import { body, parse } from '../validation';

export const issueRoutes = new Hono<WorkerEnv>()
  .get('/', async c => c.json(await listIssues(c.env.DB, parse(issueQuerySchema, c.req.query()))))
  .post('/:id/review', async c => {
    const input = await body(c, reviewIssueSchema);
    return c.json(await reviewIssue(c.env.DB, parse(idSchema, c.req.param('id')), input.note));
  });
