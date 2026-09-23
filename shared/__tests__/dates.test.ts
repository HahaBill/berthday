import { afterEach, describe, expect, it, vi } from 'vitest';
import { addDays, daysInMonth, diffDays, eachDay, isValidDate, monthEnd, monthStart, sharedDays, todayIn } from '../dates';

describe('ISO civil dates', () => {
  it.each([
    ['2000-02-29', true], ['2019-02-29', false], ['2020-02-29', true], ['1900-02-29', false],
    ['2019-12-31', true], ['2008-06-31', false], ['2019-13-01', false], ['2019-00-01', false],
    ['2019-01-00', false], ['2019-1-01', false], ['2019-01-01T00:00:00Z', false],
    ['0001-01-01', true], ['0000-01-01', false], ['0096-02-29', true], ['9999-12-31', true],
  ])('validates %s as %s', (value, valid) => expect(isValidDate(value)).toBe(valid));

  it('rejects values that are not strings', () => {
    expect(isValidDate(null)).toBe(false);
    expect(isValidDate(20191201)).toBe(false);
  });

  it.each([[2000, 29], [2019, 28], [2020, 29], [1900, 28], [2100, 28]])('counts February in %i', (year, days) => {
    expect(daysInMonth(year, 2)).toBe(days);
    expect(monthEnd(`${year}-02`)).toBe(`${year}-02-${days}`);
  });

  it('accepts a month, date, or year/month for calendar bounds', () => {
    expect(daysInMonth('2019-12')).toBe(31);
    expect(daysInMonth('2019-04-14')).toBe(30);
    expect(monthStart('2019-12-15')).toBe('2019-12-01');
    expect(monthStart(2019, 12)).toBe('2019-12-01');
    expect(monthEnd('2019-12')).toBe('2019-12-31');
    expect(() => monthStart('2019-13')).toThrow(RangeError);
    expect(() => monthEnd('2019-02-29')).toThrow(RangeError);
  });

  it('moves across month, leap-day, and year ends using UTC', () => {
    expect(addDays('2019-12-31', 1)).toBe('2020-01-01');
    expect(addDays('2020-03-01', -1)).toBe('2020-02-29');
    expect(addDays('2019-03-01', -1)).toBe('2019-02-28');
    expect(addDays('2019-01-01', -1)).toBe('2018-12-31');
    expect(addDays('2019-12-01', 0)).toBe('2019-12-01');
    expect(() => addDays('2019-02-29', 1)).toThrow(RangeError);
    expect(() => addDays('2019-12-01', 0.5)).toThrow(RangeError);
  });

  it('does not introduce local daylight-saving gaps', () => {
    expect(diffDays('2026-03-07', '2026-03-09')).toBe(2);
    expect(diffDays('2026-10-31', '2026-11-02')).toBe(2);
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(diffDays('2026-03-09', '2026-03-07')).toBe(-2);
    expect(eachDay('2019-12-01', '2019-12-03')).toEqual(['2019-12-01', '2019-12-02', '2019-12-03']);
  });

  it('enumerates inclusive ranges and returns no days for a reversed range', () => {
    expect(eachDay('2020-02-28', '2020-03-01')).toEqual(['2020-02-28', '2020-02-29', '2020-03-01']);
    expect(eachDay('2019-12-01', '2019-12-01')).toEqual(['2019-12-01']);
    expect(eachDay('2019-12-02', '2019-12-01')).toEqual([]);
  });

  it('counts disjoint, touching, and contained ranges', () => {
    const first = { startDate: '2026-01-01', endDate: '2026-01-05' };
    expect(sharedDays(first, { startDate: '2026-01-06', endDate: '2026-01-09' })).toBe(0);
    expect(sharedDays(first, { startDate: '2026-01-05', endDate: '2026-01-09' })).toBe(1);
    expect(sharedDays(first, { startDate: '2026-01-02', endDate: '2026-01-04' })).toBe(3);
    expect(sharedDays(first, first)).toBe(5);
  });

  it('preserves the ISO years below 100 without the Date.UTC 1900 offset', () => {
    expect(addDays('0099-12-31', 1)).toBe('0100-01-01');
    expect(diffDays('0001-01-01', '0001-01-02')).toBe(1);
  });
});

describe('client today', () => {
  afterEach(() => vi.useRealTimers());

  it('uses an explicit timezone when supplied', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-23T01:00:00Z'));
    expect(todayIn('America/New_York')).toBe('2026-09-22');
    expect(todayIn('UTC')).toBe('2026-09-23');
  });
});
