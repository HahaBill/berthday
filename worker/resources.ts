import type { BerthDTO } from '../shared/types';
import { resourceSlug, type ResourceCreate } from '../shared/resource-schemas';
import { ApiError } from './errors';

async function resourceId(name: string): Promise<string> {
  const slug = resourceSlug(name);
  if (slug) return slug;
  // A non-Latin name is valid even when the legacy ASCII slug is empty.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(name.toLowerCase()));
  return `resource-${Array.from(new Uint8Array(digest)).slice(0, 12).map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export async function createResource(db: D1Database, input: ResourceCreate): Promise<BerthDTO> {
  const id = await resourceId(input.name), exclusive = input.type === 'exclusive';
  const lengthFt = input.type === 'exclusive' ? input.lengthFt : null;
  const duplicate = () => new ApiError(409, 'RESOURCE_EXISTS', 'A resource with this name or a matching name already exists. Choose a different name.');
  let inserted: D1Result;
  try {
    inserted = await db.prepare(`INSERT INTO berths (id,name,length_ft,is_exclusive,sort_order,source)
      SELECT ?1, ?2, ?3, ?4,
        COALESCE((SELECT max(sort_order) FROM berths WHERE id <> 'unassigned'), -1) + 1, 'app'
      WHERE NOT EXISTS (SELECT 1 FROM berths WHERE id = ?1 OR name = ?2 COLLATE NOCASE)`)
      .bind(id, input.name, lengthFt, Number(exclusive)).run();
  } catch (error) {
    if (String(error).includes('UNIQUE')) throw duplicate();
    throw error;
  }
  if (!inserted.meta.changes) throw duplicate();
  const row = await db.prepare('SELECT sort_order FROM berths WHERE id = ?').bind(id).first<{ sort_order: number }>();
  return { id, name: input.name, lengthFt,
    isExclusive: exclusive, sortOrder: Number(row!.sort_order) };
}
