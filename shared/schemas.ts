import { z } from 'zod';
import { diffDays, isValidDate } from './dates';

export const idSchema = z.string().trim().min(1).max(200);
export const dateSchema = z.string().refine(isValidDate, 'Enter a valid date in YYYY-MM-DD format.');
export const monthSchema = z.string().regex(/^\d{4}-\d{2}$/).refine((month) => isValidDate(`${month}-01`), 'Enter a valid month.');
export const kindSchema = z.enum(['vessel', 'event', 'closure', 'hold']);
export const issueTypeSchema = z.enum(['overlap', 'fit', 'vessel_double']);
export const lengthStatusSchema = z.enum(['known', 'unknown', 'disputed']);
export const lengthSchema = z.number().int().min(1).max(1000);
const titleSchema = z.string().trim().max(300).nullable().optional();
const notesSchema = z.string().max(5000).nullable().optional();
const cursorSchema = z.string().min(1).max(1000).optional();
const limitSchema = z.coerce.number().int().min(1).max(200).default(100);
const queryBoolean = z.enum(['true', 'false', '1', '0']).transform((value) => value === 'true' || value === '1');

function checkRange(from: string | undefined, to: string | undefined, context: z.RefinementCtx, maxDays: number, field: string, inclusive = false) {
  if (!from || !to || !isValidDate(from) || !isValidDate(to)) return;
  if (to < from) {
    context.addIssue({ code: 'custom', path: [field], message: 'The last date must be on or after the start date.' });
  } else if (diffDays(from, to) + Number(inclusive) > maxDays) {
    context.addIssue({ code: 'custom', path: [field], message: `Choose a range of at most ${maxDays} days.` });
  }
}

const reservationFields = z.object({
  berthId: idSchema,
  kind: kindSchema,
  vesselId: idSchema.nullable().optional(),
  title: titleSchema,
  startDate: dateSchema,
  endDate: dateSchema,
  notes: notesSchema,
}).strict();

export const reservationCreateSchema = reservationFields.superRefine((value, context) => {
  checkRange(value.startDate, value.endDate, context, 366, 'endDate', true);
  if (value.kind === 'vessel' && !value.vesselId) {
    context.addIssue({ code: 'custom', path: ['vesselId'], message: 'Choose a vessel for this booking.' });
  }
  if (value.kind !== 'vessel') {
    if (value.vesselId) context.addIssue({ code: 'custom', path: ['vesselId'], message: 'Only vessel bookings can select a vessel.' });
    if (!value.title?.trim()) context.addIssue({ code: 'custom', path: ['title'], message: 'Enter a title for this booking.' });
  }
});

// A partial request cannot establish cross-field consistency; the Worker validates the merged booking.
export const reservationPatchSchema = reservationFields.partial().superRefine((value, context) => {
  if (Object.keys(value).length === 0) context.addIssue({ code: 'custom', message: 'Provide at least one field to update.' });
  checkRange(value.startDate, value.endDate, context, 366, 'endDate', true);
});

export const reservationQuerySchema = z.object({
  from: dateSchema,
  to: dateSchema,
  berthId: idSchema.optional(),
  vesselId: idSchema.optional(),
  kind: kindSchema.optional(),
  q: z.string().trim().max(300).optional(),
  hasIssues: queryBoolean.optional(),
  limit: limitSchema,
  cursor: cursorSchema,
}).strict().superRefine((value, context) => checkRange(value.from, value.to, context, 400, 'to'));

export const availabilityQuerySchema = z.object({
  start: dateSchema,
  end: dateSchema,
  lengthFt: z.coerce.number().int().min(1).max(1000).optional(),
  vesselId: idSchema.optional(),
  excludeId: idSchema.optional(),
}).strict().superRefine((value, context) => {
  checkRange(value.start, value.end, context, 366, 'end', true);
  if (value.lengthFt !== undefined && value.vesselId !== undefined) {
    context.addIssue({ code: 'custom', path: ['lengthFt'], message: 'Choose a vessel or enter a length, not both.' });
  }
});

export const vesselCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  lengthFt: lengthSchema,
}).strict();

export const vesselPatchSchema = vesselCreateSchema.partial().refine((value) => Object.keys(value).length > 0, 'Provide a name or length to update.');

export const vesselQuerySchema = z.object({
  q: z.string().trim().max(300).optional(),
  lengthStatus: lengthStatusSchema.optional(),
  limit: limitSchema,
  cursor: cursorSchema,
}).strict();

export const issueQuerySchema = z.object({
  type: issueTypeSchema.optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  berthId: idSchema.optional(),
  includeReviewed: queryBoolean.optional().transform((value) => value ?? false),
  limit: limitSchema,
  cursor: cursorSchema,
}).strict().superRefine((value, context) => {
  if (value.from && value.to && value.to < value.from) {
    context.addIssue({ code: 'custom', path: ['to'], message: 'The last date must be on or after the start date.' });
  }
});

export const reviewIssueSchema = z.object({ note: z.string().trim().max(2000).optional() }).strict();

export const importIssueQuerySchema = z.object({
  code: z.string().trim().min(1).max(100).optional(),
  severity: z.enum(['info', 'warn', 'error']).optional(),
  limit: limitSchema,
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
}).strict();

export const askRequestSchema = z.object({
  q: z.string().trim().min(1).max(300),
  today: dateSchema,
  viewedMonth: monthSchema,
}).strict();

export const askIntentSchema = z.object({
  intent: z.enum(['search', 'availability', 'issues', 'navigate', 'unsupported']),
  dateFrom: dateSchema.optional(),
  dateTo: dateSchema.optional(),
  berthIds: z.array(idSchema).max(9).optional(),
  vesselQuery: z.string().trim().min(1).max(200).optional(),
  kinds: z.array(kindSchema).max(4).optional(),
  lengthFt: lengthSchema.optional(),
  issueTypes: z.array(issueTypeSchema).max(3).optional(),
  reason: z.string().max(500).optional(),
}).strict();

export const exportQuerySchema = z.object({
  from: dateSchema,
  to: dateSchema,
  berthId: idSchema.optional(),
  vesselId: idSchema.optional(),
  kind: kindSchema.optional(),
  q: z.string().trim().max(300).optional(),
  hasIssues: queryBoolean.optional(),
}).strict().superRefine((value, context) => checkRange(value.from, value.to, context, 400, 'to'));

export type ReservationCreate = z.infer<typeof reservationCreateSchema>;
export type ReservationPatch = z.infer<typeof reservationPatchSchema>;
export type ReservationQuery = z.infer<typeof reservationQuerySchema>;
export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;
export type VesselQuery = z.infer<typeof vesselQuerySchema>;
export type IssueQuery = z.infer<typeof issueQuerySchema>;
export type ImportIssueQuery = z.infer<typeof importIssueQuerySchema>;
