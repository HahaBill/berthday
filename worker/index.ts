import { Hono } from 'hono';
import { ApiError } from './errors';
import type { WorkerEnv } from './types';
import { metaRoutes } from './routes/meta';
import { berthRoutes } from './routes/berths';
import { reservationRoutes } from './routes/reservations';
import { vesselRoutes } from './routes/vessels';
import { availabilityRoutes } from './routes/availability';
import { issueRoutes } from './routes/issues';
import { importRoutes } from './routes/imports';
import { askRoutes } from './routes/ask';
import { exportRoutes } from './routes/export';

const app = new Hono<WorkerEnv>();
app.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  await next();
});
app.get('/api/health', c => c.json({ ok: true, version: c.env.APP_VERSION ?? 'dev' }));
app.route('/api/meta', metaRoutes);
app.route('/api/berths', berthRoutes);
app.route('/api/reservations', reservationRoutes);
app.route('/api/vessels', vesselRoutes);
app.route('/api/availability', availabilityRoutes);
app.route('/api/issues', issueRoutes);
app.route('/api/import', importRoutes);
app.route('/api/ask', askRoutes);
app.route('/api/export.csv', exportRoutes);
app.notFound(async c => {
  if (c.req.path === '/api' || c.req.path.startsWith('/api/')) throw new ApiError(404, 'NOT_FOUND', `No API route matches ${c.req.method} ${c.req.path}.`);
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
  return c.text('Build the Berthday web application before starting the Worker.', 404);
});
app.onError((error, c) => {
  if (error instanceof ApiError) return c.json({ error: { code: error.code, message: error.message, conflicts: error.conflicts, alternatives: error.alternatives } }, error.status);
  console.error('Berthday request failed', { path: c.req.path, error: error.message });
  return c.json({ error: { code: 'INTERNAL', message: 'The request could not be completed. Please try again.', conflicts: [], alternatives: { berths: [], dateShifts: [] } } }, 500);
});

export default app;
