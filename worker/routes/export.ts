import { Hono } from 'hono';
import { exportQuerySchema } from '../../shared/schemas';
import { exportReservations } from '../db';
import type { WorkerEnv } from '../types';
import { parse } from '../validation';

/** Prevent spreadsheet formulas while retaining RFC 4180 quoting and line endings. */
function cell(value: unknown): string {
  let rendered = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(rendered)) rendered = `'${rendered}`;
  return `"${rendered.replace(/"/g, '""')}"`;
}

export const exportRoutes = new Hono<WorkerEnv>().get('/', async c => {
  const query = parse(exportQuerySchema, c.req.query());
  const headers = ['id', 'berthId', 'kind', 'vesselId', 'vessel', 'title', 'startDate', 'endDate', 'notes', 'origin', 'sourceRef', 'fitStatus', 'issues', 'createdAt', 'updatedAt'] as const;
  const rows = [headers.map(cell).join(',')];
  // A complete CSV uses one indexed window query, so a large export cannot
  // exhaust the Worker's 50-query budget by fetching pages in a loop.
  const bookings = await exportReservations(c.env.DB, query);
  rows.push(...bookings.map(row => headers.map(key => cell(row[key])).join(',')));
  return c.body(`\uFEFF${rows.join('\r\n')}\r\n`, 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="berthday-${query.from}-${query.to}.csv"`,
  });
});
