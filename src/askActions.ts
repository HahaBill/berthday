import { isValidDate, monthEnd, monthStart } from '../shared/dates';
import type { AskResponse } from '../shared/types';
import type { BookingDraft, FindDraft } from './context';
import { dateLabel, params } from './api';

export type AskAction =
  | { type: 'schedule'; search: string; message: string }
  | { type: 'availability'; search: string; draft: FindDraft; message: string }
  | { type: 'create'; draft: BookingDraft; message: string }
  | { type: 'unsupported'; message: string };

/** Convert an interpretation into one UI action. This function never writes a booking. */
export function buildAskAction(response: AskResponse, viewedMonth: string): AskAction {
  if (response.intent === 'unsupported') {
    return { type: 'unsupported', message: response.message || 'Try a date, vessel, berth, or an event to add.' };
  }
  if (response.intent === 'create_booking') {
    if (!response.draft) return { type: 'unsupported', message: 'Describe the event name, berth, and date to create a booking.' };
    const draft = response.draft;
    return {
      type: 'create',
      draft: {
        kind: draft.kind, title: draft.title ?? '', berthId: draft.berthId ?? '',
        startDate: draft.startDate ?? '', endDate: draft.endDate ?? '',
        vesselId: draft.vesselId ?? null, notes: draft.notes ?? '', fromAsk: true, showOnSave: true,
      },
      message: response.missingFields?.length ? 'Complete the missing details, then save the booking.' : 'Your booking is ready to review and save.',
    };
  }
  const filters = response.filters;
  if (response.intent === 'navigate' && !filters.dateFrom) {
    return { type: 'unsupported', message: 'I couldn’t identify the month. Try “Go to January 2000”.' };
  }
  if ((filters.dateFrom && !isValidDate(filters.dateFrom)) || (filters.dateTo && !isValidDate(filters.dateTo))) {
    return { type: 'unsupported', message: 'Those dates are invalid. Try a month and year, such as January 2000.' };
  }
  const month = (filters.dateFrom ?? filters.dateTo)?.slice(0, 7) ?? viewedMonth;
  const from = filters.dateFrom ?? (filters.dateTo ? monthStart(filters.dateTo) : undefined);
  const to = filters.dateTo;
  const search = params({
    month, ...(response.intent === 'navigate' && !to ? {} : { from, to }),
    berthIds: filters.berthIds?.join(','), q: filters.vesselQuery,
    // Text matching remains complete even when the API only resolves the first five names.
    vesselIds: !filters.vesselQuery ? filters.vesselIds?.join(',') : undefined,
    kinds: filters.kinds?.join(','), issueTypes: (filters.issueTypes?.length ? filters.issueTypes : response.intent === 'issues' ? ['overlap', 'fit', 'vessel_double'] : undefined)?.join(','),
  });
  if (response.intent === 'availability') {
    const vesselId = filters.vesselIds?.length === 1 ? filters.vesselIds[0] : undefined;
    return {
      type: 'availability', search,
      draft: { start: from ?? monthStart(month), end: to ?? monthEnd(month), vesselId, lengthFt: vesselId ? undefined : filters.lengthFt },
      message: 'Checking berth availability for your dates.',
    };
  }
  const label = dateLabel(`${month}-01`, { month: 'long', year: 'numeric' });
  return {
    type: 'schedule', search,
    message: from && to && from.slice(0, 7) !== to.slice(0, 7)
      ? `Showing ${label}. Use the month arrows to explore the selected date range.`
      : `Showing ${label}${response.intent === 'navigate' ? '.' : ' with your filters.'}`,
  };
}
