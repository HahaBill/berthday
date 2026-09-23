import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AskResponse } from '../../shared/types';
import { buildAskAction } from '../askActions';

const interpreted = (
  intent: AskResponse['intent'], filters: AskResponse['filters'] = {}, extra: Partial<AskResponse> = {},
): AskResponse => ({ intent, filters, chips: [], source: 'fallback', ...extra });

function actionParams(action: ReturnType<typeof buildAskAction>) {
  if (action.type !== 'schedule' && action.type !== 'availability') throw new Error(`Expected a schedule destination, received ${action.type}.`);
  return new URLSearchParams(action.search);
}

afterEach(() => vi.unstubAllGlobals());

describe('Ask commands open the schedule', () => {
  it('turns a January 2000 navigation response directly into a grid action', () => {
    const action = buildAskAction(interpreted('navigate', { dateFrom: '2000-01-01' }), '2019-12');
    expect(action.type).toBe('schedule');
    expect(actionParams(action).get('month')).toBe('2000-01');
  });

  it('preserves the whole requested year while opening its first month', () => {
    const action = buildAskAction(interpreted('search', { dateFrom: '2000-01-01', dateTo: '2000-12-31' }), '2019-12');
    expect(action.type).toBe('schedule');
    const params = actionParams(action);
    expect(params.get('month')).toBe('2000-01');
    expect(params.get('from')).toBe('2000-01-01');
    expect(params.get('to')).toBe('2000-12-31');
  });

  it('preserves multiple berth and booking-kind filters instead of picking the first', () => {
    const action = buildAskAction(interpreted('search', {
      dateFrom: '2010-07-01', dateTo: '2010-07-31',
      berthIds: ['north-pier-west', 'north-pier-east'], kinds: ['vessel', 'event'],
    }), '2019-12');
    const params = actionParams(action);
    expect(params.get('berthIds')).toBe('north-pier-west,north-pier-east');
    expect(params.get('kinds')).toBe('vessel,event');
  });

  it('uses free vessel text without silently restricting it to the first resolved matches', () => {
    const action = buildAskAction(interpreted('search', {
      vesselQuery: 'Clear Tern & friends', vesselIds: ['rv-clear-tern', 'mv-clear-tern'],
    }), '2019-12');
    const params = actionParams(action);
    expect(params.get('q')).toBe('Clear Tern & friends');
    expect(params.has('vesselIds')).toBe(false);
    expect(params.get('month')).toBe('2019-12');
  });

  it('preserves resolved vessel IDs when there is no free-text filter', () => {
    const action = buildAskAction(interpreted('search', { vesselIds: ['one', 'two'] }), '2019-12');
    expect(actionParams(action).get('vesselIds')).toBe('one,two');
  });

  it('keeps an undated search in the viewed grid context', () => {
    const action = buildAskAction(interpreted('search', { vesselQuery: 'Golden Compass' }), '2010-04');
    expect(action.type).toBe('schedule');
    expect(actionParams(action).get('month')).toBe('2010-04');
    expect(actionParams(action).has('history')).toBe(false);
  });

  it('maps issue requests and every requested issue type onto the grid', () => {
    const action = buildAskAction(interpreted('issues', {
      dateFrom: '2017-01-01', dateTo: '2017-12-31', issueTypes: ['overlap', 'vessel_double'],
    }), '2019-12');
    expect(action.type).toBe('schedule');
    const params = actionParams(action);
    expect(params.get('month')).toBe('2017-01');
    expect(params.get('issueTypes')).toBe('overlap,vessel_double');
  });

  it.each([{ label: 'omitted', issueTypes: undefined }, { label: 'empty array', issueTypes: [] }] as const)('keeps a general issue request restricted to bookings with any issue type ($label)', ({ issueTypes }) => {
    const action = buildAskAction(interpreted('issues', { dateFrom: '2017-07-01', issueTypes: issueTypes ? [...issueTypes] : undefined }), '2019-12');
    expect(action.type).toBe('schedule');
    expect(actionParams(action).get('issueTypes')?.split(',').sort()).toEqual(['fit', 'overlap', 'vessel_double']);
  });

  it('rejects the live malformed AI navigation response instead of silently staying in December', () => {
    const action = buildAskAction(interpreted('navigate', {
      vesselQuery: 'January 2000', vesselIds: [],
    }, { source: 'ai' }), '2019-12');
    expect(action.type).toBe('unsupported');
    expect(action.message).toBeTruthy();
  });

  it('rejects invalid navigation dates before formatting a grid month', () => {
    const action = buildAskAction(interpreted('navigate', { dateFrom: '2000-02-30' }), '2019-12');
    expect(action.type).toBe('unsupported');
  });
});

describe('Ask availability actions', () => {
  it('uses the uniquely resolved vessel and avoids sending a conflicting length', () => {
    const action = buildAskAction(interpreted('availability', {
      dateFrom: '2026-07-03', dateTo: '2026-07-10', vesselQuery: 'Wild Tern',
      vesselIds: ['my-wild-tern'], lengthFt: 145,
    }), '2019-12');
    expect(action.type).toBe('availability');
    if (action.type !== 'availability') return;
    expect(action.draft).toMatchObject({ start: '2026-07-03', end: '2026-07-10', vesselId: 'my-wild-tern' });
    expect(action.draft.lengthFt).toBeUndefined();
    expect(actionParams(action).get('month')).toBe('2026-07');
  });

  it('does not choose the first vessel when the name is ambiguous', () => {
    const action = buildAskAction(interpreted('availability', {
      dateFrom: '2026-07-03', dateTo: '2026-07-10', vesselQuery: 'Clear Tern', vesselIds: ['rv-clear-tern', 'mv-clear-tern'],
    }), '2019-12');
    expect(action.type).toBe('availability');
    if (action.type !== 'availability') return;
    expect(action.draft.vesselId).toBeFalsy();
  });

  it('keeps a requested numeric length for searches without a selected vessel', () => {
    const action = buildAskAction(interpreted('availability', {
      dateFrom: '2026-08-01', dateTo: '2026-08-07', lengthFt: 120,
    }), '2019-12');
    expect(action.type).toBe('availability');
    if (action.type !== 'availability') return;
    expect(action.draft).toMatchObject({ start: '2026-08-01', end: '2026-08-07', lengthFt: 120 });
    expect(action.draft.vesselId).toBeFalsy();
  });
});

describe('Ask creation opens a single editable preview', () => {
  it('returns an event draft without making a network write', () => {
    const fetch = vi.fn(() => { throw new Error('Interpreting a command must not save a booking.'); });
    vi.stubGlobal('fetch', fetch);
    const action = buildAskAction(interpreted('create_booking', {}, {
      draft: { kind: 'event', title: 'Community sail day', berthId: 'north-pier-face', startDate: '2026-07-10', endDate: '2026-07-10' },
      missingFields: [],
    }), '2019-12');
    expect(action.type).toBe('create');
    if (action.type !== 'create') return;
    expect(action.draft).toMatchObject({
      kind: 'event', title: 'Community sail day', berthId: 'north-pier-face',
      startDate: '2026-07-10', endDate: '2026-07-10', showOnSave: true, fromAsk: true,
    });
    expect(action.draft.id).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('leaves missing dates, berth, and title blank for explicit completion', () => {
    const action = buildAskAction(interpreted('create_booking', {}, {
      draft: { kind: 'event' }, missingFields: ['title', 'berthId', 'startDate', 'endDate'],
    }), '2019-12');
    expect(action.type).toBe('create');
    if (action.type !== 'create') return;
    expect(action.draft).toMatchObject({ title: '', berthId: '', startDate: '', endDate: '', fromAsk: true, showOnSave: true });
  });

  it('does not invent a last day for a request containing only an arrival date', () => {
    const action = buildAskAction(interpreted('create_booking', {}, {
      draft: { kind: 'event', title: 'Research visit', startDate: '2026-07-10' }, missingFields: ['berthId', 'endDate'],
    }), '2019-12');
    expect(action.type).toBe('create');
    if (action.type !== 'create') return;
    expect(action.draft.startDate).toBe('2026-07-10');
    expect(action.draft.endDate).toBe('');
  });

  it('does not silently choose a vessel from ambiguous registry matches', () => {
    const action = buildAskAction(interpreted('create_booking', {
      vesselQuery: 'Clear Tern', vesselIds: ['rv-clear-tern', 'mv-clear-tern'],
    }, {
      draft: { kind: 'vessel', berthId: 'north-pier-west', startDate: '2026-07-10', endDate: '2026-07-12' },
      missingFields: ['vesselId'],
    }), '2019-12');
    expect(action.type).toBe('create');
    if (action.type !== 'create') return;
    expect(action.draft.vesselId).toBeFalsy();
  });

  it('cannot open a creation preview when the interpretation lacks a draft', () => {
    const action = buildAskAction(interpreted('create_booking'), '2019-12');
    expect(action.type).toBe('unsupported');
  });

  it('does not mutate the interpreted response while preparing an editable preview', () => {
    const response = interpreted('create_booking', {}, { draft: { kind: 'hold', notes: 'For the coordinator' } });
    const before = JSON.stringify(response);
    buildAskAction(response, '2019-12');
    expect(JSON.stringify(response)).toBe(before);
  });
});
