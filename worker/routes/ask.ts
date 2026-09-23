import { Hono } from 'hono';
import { askIntentSchema, askRequestSchema } from '../../shared/schemas';
import type { AskIntent, AskResponse } from '../../shared/types';
import { getMeta, listVessels } from '../db';
import { groundCreation, parseDeterministic, parseFallback } from '../ask/fallback';
import { intentJsonSchema, systemPrompt } from '../ask/prompt';
import type { WorkerEnv } from '../types';
import { body } from '../validation';

function clampDate(date: string): string { return date < '1997-01-01' ? '1997-01-01' : date > '2100-12-31' ? '2100-12-31' : date; }
function normalizeModelOutput(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const normalized = { ...value } as Record<string, unknown>;
  if (typeof normalized.vesselQuery === 'string') {
    normalized.vesselQuery = normalized.vesselQuery.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return normalized;
}

export const askRoutes = new Hono<WorkerEnv>().post('/', async c => {
  const input = await body(c, askRequestSchema), meta = await getMeta(c.env.DB);
  let intent: AskIntent | undefined = parseDeterministic(input) ?? undefined;
  let source: 'ai' | 'fallback' = 'fallback';
  let vesselIds: string[] = [], message: string | undefined;
  const resolve = async (query?: string) => query ? (await listVessels(c.env.DB, { q: query, limit: 5 })).items.map(v => v.id) : [];
  if (!intent && c.env.AI) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        c.env.AI.run(c.env.NL_MODEL ?? '@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
          messages: [{ role: 'system', content: systemPrompt(input, meta.berths, meta.dataRange) }, { role: 'user', content: input.q }],
          response_format: { type: 'json_schema', json_schema: intentJsonSchema(meta.berths) }, max_tokens: 300,
        }),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Ask timeout')), 8000); }),
      ]);
      const response = result && typeof result === 'object' && 'response' in result ? result.response : result;
      let parsed = askIntentSchema.parse(normalizeModelOutput(typeof response === 'string' ? JSON.parse(response) : response));
      if (parsed.berthIds?.some(id => !meta.berths.some(b => b.id === id))) throw new Error('Unknown berth');
      if (parsed.intent === 'create_booking') {
        const grounded = groundCreation(input);
        if (!grounded || grounded.intent !== 'create_booking') throw new Error('No explicit creation request');
        parsed = grounded;
      }
      // Resolving a model-generated filter is part of the optional AI path.
      // A bad filter or failed lookup must still leave the deterministic path usable.
      vesselIds = await resolve(parsed.vesselQuery);
      intent = parsed; source = 'ai';
    } catch { /* The deterministic parser is the complete offline path. */ }
    finally { if (timeout !== undefined) clearTimeout(timeout); }
  }
  intent ??= parseFallback(input);
  if (source === 'fallback') {
    try { vesselIds = await resolve(intent.vesselQuery); } catch {
      vesselIds = [];
      message = 'The vessel filter is ready, but vessel matches could not be loaded. Try the request again.';
    }
  }
  if (intent.dateFrom) intent.dateFrom = clampDate(intent.dateFrom);
  if (intent.dateTo) intent.dateTo = clampDate(intent.dateTo);
  if (intent.dateFrom && intent.dateTo && intent.dateFrom > intent.dateTo) [intent.dateFrom, intent.dateTo] = [intent.dateTo, intent.dateFrom];
  const { intent: action, draft, ...filters } = intent;
  const missingFields: string[] = [];
  if (action === 'create_booking' && draft) {
    if (draft.berthId === 'unassigned' || (draft.berthId && !meta.berths.some(berth => berth.id === draft.berthId))) delete draft.berthId;
    if (draft.kind === 'vessel') {
      if (vesselIds.length === 1) draft.vesselId = vesselIds[0];
      else { delete draft.vesselId; missingFields.push('vesselId'); }
    } else if (!draft.title) missingFields.push('title');
    for (const field of ['berthId', 'startDate', 'endDate'] as const) if (!draft[field]) missingFields.push(field);
    message = filters.reason ?? (missingFields.length ? 'Complete the missing fields in the booking form, then save the booking.' : 'Review the booking details, then save the booking.');
  }
  const chips: AskResponse['chips'] = [];
  if (filters.berthIds?.length) chips.push({ key: 'berthIds', label: `Berth: ${filters.berthIds.map(id => meta.berths.find(b => b.id === id)?.name ?? id).join(', ')}` });
  if (filters.dateFrom) chips.push({ key: 'dates', label: `Dates: ${filters.dateFrom}${filters.dateTo && filters.dateTo !== filters.dateFrom ? ` – ${filters.dateTo}` : ''}` });
  if (filters.vesselQuery) chips.push({ key: 'vesselQuery', label: `Vessel: ${filters.vesselQuery}` });
  if (filters.lengthFt) chips.push({ key: 'lengthFt', label: `Length: ${filters.lengthFt} ft` });
  if (filters.kinds?.length) chips.push({ key: 'kinds', label: `Kind: ${filters.kinds.join(', ')}` });
  if (filters.issueTypes?.length) chips.push({ key: 'issueTypes', label: `Issues: ${filters.issueTypes.map(t => ({ overlap: 'double-bookings', fit: 'too long for berth', vessel_double: 'vessel in two places' })[t]).join(', ')}` });
  if (draft) {
    if (draft.title) chips.push({ key: 'title', label: `Title: ${draft.title}` });
    if (draft.berthId) chips.push({ key: 'berthIds', label: `Berth: ${meta.berths.find(berth => berth.id === draft.berthId)?.name ?? draft.berthId}` });
    if (draft.startDate || draft.endDate) chips.push({ key: 'dates', label: `Dates: ${draft.startDate ?? 'Choose start'} – ${draft.endDate ?? 'Choose last day'}` });
  }
  return c.json({ intent: action, filters: { ...filters, ...(filters.vesselQuery ? { vesselIds } : {}) }, chips, source,
    ...(action === 'create_booking' && draft ? { draft, missingFields } : {}),
    ...(action === 'unsupported' ? { message: filters.reason ?? 'Try asking about a berth, vessel, or date.' } : message ? { message } : {}) });
});
