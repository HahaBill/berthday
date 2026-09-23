import { z } from 'zod';

export const normalizeResourceName = (name: string) => name.trim().replace(/\s+/g, ' ');
/** Matches the workbook extractor's slug for names containing ASCII letters or numbers. */
export const resourceSlug = (name: string) => normalizeResourceName(name).toLowerCase()
  .replaceAll('/', '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const name = z.string().transform(normalizeResourceName).pipe(z.string()
  .min(1, 'Enter a resource name.').max(120, 'Use a name of at most 120 characters.'))
  .refine(value => resourceSlug(value) !== 'unassigned', 'Unassigned is reserved for imported history. Choose another name.');

export const resourceCreateSchema = z.discriminatedUnion('type', [
  z.object({
    name, type: z.literal('exclusive'),
    lengthFt: z.number().int('Enter a whole-number length.').min(1).max(1000),
  }).strict(),
  z.object({ name, type: z.literal('shared'), lengthFt: z.null().optional() }).strict(),
]);

export type ResourceCreate = z.infer<typeof resourceCreateSchema>;
