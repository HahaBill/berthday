import { z } from 'zod';
import { dateSchema, idSchema, kindSchema, lengthStatusSchema } from '../shared/schemas';

export const jobCreateSchema = z.object({ name: z.string().trim().min(1).max(200).optional() }).strict();
export const jobListSchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().max(1000).optional() }).strict();
export const fileListSchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(100), offset: z.coerce.number().int().min(0).default(0) }).strict();
export const diagnosticSchema = z.object({ code: z.string().min(1).max(100), message: z.string().max(2000), severity: z.enum(['info', 'warn', 'error']).optional(), sheet: z.string().max(200).optional(), cell: z.string().max(200).optional() }).strict();
export const fileRegisterSchema = z.object({ name: z.string().trim().min(1).max(255), sha256: z.string().regex(/^[a-f0-9]{64}$/i).transform(value => value.toLowerCase()), rowCount: z.number().int().min(0).max(1_000_000), diagnostics: z.array(diagnosticSchema).max(5000).optional() }).strict();
export const stageRowsSchema = z.object({ offset: z.number().int().min(0), rows: z.array(z.unknown()).min(1).max(100) }).strict();
export const commitSchema = z.object({ limit: z.number().int().min(1).max(50).default(10) }).strict();
const vesselFields = {
  vesselName: z.string().trim().min(1).max(200),
  vesselLengthFt: z.number().int().min(1).max(1000).nullable().optional(),
  vesselLengthStatus: lengthStatusSchema.optional(),
  vesselLengthNote: z.string().max(5000).nullable().optional(),
  sourceRef: z.string().max(10_000).optional(),
};
const vesselRow = z.object({ recordType: z.literal('vessel'), ...vesselFields }).strict();
const reservationRow = z.object({
  recordType: z.literal('reservation').optional(),
  kind: kindSchema, berthId: idSchema, vesselName: vesselFields.vesselName.optional(),
  vesselLengthFt: vesselFields.vesselLengthFt, vesselLengthStatus: vesselFields.vesselLengthStatus,
  vesselLengthNote: vesselFields.vesselLengthNote, sourceRef: vesselFields.sourceRef,
  title: z.string().trim().max(300).nullable().optional(), startDate: dateSchema, endDate: dateSchema,
  notes: z.string().max(10_000).nullable().optional(),
}).strict().superRefine((row, context) => {
  if (row.endDate < row.startDate) context.addIssue({ code: 'custom', message: 'The last day must be on or after the start date.' });
  if (row.kind === 'vessel' && !row.vesselName) context.addIssue({ code: 'custom', message: 'A vessel booking requires a vessel name.' });
  if (row.kind !== 'vessel' && !row.title) context.addIssue({ code: 'custom', message: 'Events, closures, and holds require a title.' });
  if (row.kind !== 'vessel' && row.vesselName) context.addIssue({ code: 'custom', message: 'Only vessel bookings can include a vessel name.' });
});
export const importRowSchema = z.union([vesselRow, reservationRow]);
