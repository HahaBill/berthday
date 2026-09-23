import type { Context } from 'hono';
import type { z } from 'zod';
import { ApiError } from './errors';

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', result.error.issues.map((issue) =>
      `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`).join('; '));
  }
  return result.data;
}

export async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let value: unknown;
  try { value = await c.req.json(); } catch {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Send a valid JSON request body.');
  }
  return parse(schema, value);
}
