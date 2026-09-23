import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { idSchema } from '../../shared/schemas';
import { ApiError } from '../errors';
import { cancelImport, commitImport, createImportJob, getImportJob, listImportFiles, listImportJobs, previewImport, registerImportFile, stageImportRows } from '../import-db';
import { commitSchema, fileListSchema, fileRegisterSchema, jobCreateSchema, jobListSchema, stageRowsSchema } from '../import-validation';
import type { WorkerEnv } from '../types';
import { body, parse } from '../validation';

export const importJobRoutes = new Hono<WorkerEnv>()
  .use('*', bodyLimit({ maxSize: 3_000_000, onError: () => { throw new ApiError(413, 'IMPORT_BATCH_TOO_LARGE', 'This batch is too large. Send at most 100 records and 3 MB per request.'); } }))
  .post('/', async c => c.json(await createImportJob(c.env.DB, (await body(c, jobCreateSchema)).name), 201))
  .get('/', async c => { const query = parse(jobListSchema, c.req.query()); return c.json(await listImportJobs(c.env.DB, query.limit, query.cursor)); })
  .get('/:id', async c => c.json(await getImportJob(c.env.DB, parse(idSchema, c.req.param('id')))))
  .get('/:id/files', async c => {
    const query = parse(fileListSchema, c.req.query());
    return c.json(await listImportFiles(c.env.DB, parse(idSchema, c.req.param('id')), query.limit, query.offset));
  })
  .post('/:id/files', async c => c.json(await registerImportFile(c.env.DB, parse(idSchema, c.req.param('id')), await body(c, fileRegisterSchema)), 201))
  .post('/:id/files/:fileId/rows', async c => {
    const input = await body(c, stageRowsSchema);
    return c.json(await stageImportRows(c.env.DB, parse(idSchema, c.req.param('id')), parse(idSchema, c.req.param('fileId')), input.offset, input.rows));
  })
  .post('/:id/preview', async c => c.json(await previewImport(c.env.DB, parse(idSchema, c.req.param('id')))))
  .post('/:id/commit', async c => c.json(await commitImport(c.env.DB, parse(idSchema, c.req.param('id')), (await body(c, commitSchema)).limit)))
  .post('/:id/cancel', async c => c.json(await cancelImport(c.env.DB, parse(idSchema, c.req.param('id')))));
