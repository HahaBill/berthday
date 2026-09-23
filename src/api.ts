import type { Alternatives, ReservationDTO } from '../shared/types';
import { isValidDate } from '../shared/dates';

export class ApiError extends Error {
  code: string;
  conflicts: ReservationDTO[];
  alternatives: Alternatives;
  constructor(error: { message: string; code: string; conflicts?: ReservationDTO[]; alternatives?: Alternatives }) {
    super(error.message); this.code = error.code; this.conflicts = error.conflicts ?? [];
    this.alternatives = error.alternatives ?? { berths: [], dateShifts: [] };
  }
}
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  if (response.status === 204) return undefined as T;
  const body = await response.json();
  if (!response.ok) throw new ApiError(body.error ?? { code: 'INTERNAL', message: 'The request could not be completed. Please try again.' });
  return body;
}
export function params(values: Record<string, string | number | boolean | null | undefined>) {
  const p = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => { if (value !== '' && value != null) p.set(key, String(value)); });
  return p.toString();
}
export async function allPages<T>(path: string): Promise<T[]> {
  const items: T[] = []; let cursor: string | null = null;
  do {
    const page: { items: T[]; nextCursor: string | null } = await api(`${path}${path.includes('?') ? '&' : '?'}limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    items.push(...page.items); cursor = page.nextCursor;
  } while (cursor);
  return items;
}
export const dateLabel = (date: string, options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }) => isValidDate(date) ? new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`)) : 'Invalid date';
export const rangeLabel = (start: string, end: string) => `${dateLabel(start, { month: 'short', day: 'numeric', ...(start.slice(0, 4) !== end.slice(0, 4) ? { year: 'numeric' as const } : {}) })} – ${dateLabel(end, { month: 'short', day: 'numeric', year: 'numeric' })}`;
export const bookingName = (r: ReservationDTO) => r.vessel?.name ?? r.title ?? 'Untitled booking';
export const issueLabel = (type: string) => ({ overlap: 'Double-booking', fit: 'Too long for berth', vessel_double: 'Vessel in two places' })[type] ?? type;
