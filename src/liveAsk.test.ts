import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AskResponse } from '../shared/types';
import { createLiveAsk, type LiveAskInput } from './liveAsk';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((fulfill, fail) => { resolve = fulfill; reject = fail; });
  return { promise, resolve, reject };
}
const input = (q: string, explicit = false): LiveAskInput => ({ q, explicit, today: '2026-09-22', viewedMonth: '2019-12' });
const response = (dateFrom: string): AskResponse => ({ intent: 'navigate', filters: { dateFrom }, chips: [], source: 'fallback' });
const callbacks = () => ({ result: vi.fn(), error: vi.fn(), busy: vi.fn() });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('live Ask request coordination', () => {
  it('debounces typing and requests only the latest text with its captured context', async () => {
    const pending = deferred<AskResponse>();
    const request = vi.fn(() => pending.promise), events = callbacks();
    const live = createLiveAsk(request, events);
    live.schedule(input('Go to Jan'));
    await vi.advanceTimersByTimeAsync(399);
    expect(request).not.toHaveBeenCalled();
    const latest = input('Go to January 2000');
    live.schedule(latest);
    await vi.advanceTimersByTimeAsync(399);
    expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(latest, expect.any(AbortSignal));
    pending.resolve(response('2000-01-01'));
    await vi.advanceTimersByTimeAsync(0);
    expect(events.result).toHaveBeenCalledExactlyOnceWith(response('2000-01-01'), latest);
    expect(events.busy).toHaveBeenLastCalledWith(false);
  });

  it('runs Enter immediately and cancels the scheduled request instead of sending twice', async () => {
    const pending = deferred<AskResponse>();
    const request = vi.fn(() => pending.promise), events = callbacks();
    const live = createLiveAsk(request, events);
    live.schedule(input('Go to January 2000'));
    await vi.advanceTimersByTimeAsync(150);
    const explicit = input('Go to January 2000', true);
    const done = live.run(explicit);
    expect(request).toHaveBeenCalledExactlyOnceWith(explicit, expect.any(AbortSignal));
    await vi.advanceTimersByTimeAsync(1000);
    expect(request).toHaveBeenCalledTimes(1);
    pending.resolve(response('2000-01-01'));
    await done;
    expect(events.result).toHaveBeenCalledExactlyOnceWith(response('2000-01-01'), explicit);
  });

  it('ignores a stale success and its finally block while the new request is busy', async () => {
    const old = deferred<AskResponse>(), latest = deferred<AskResponse>();
    const request = vi.fn<(value: LiveAskInput, signal: AbortSignal) => Promise<AskResponse>>()
      .mockImplementationOnce(() => old.promise).mockImplementationOnce(() => latest.promise);
    const events = callbacks(), live = createLiveAsk(request, events);
    const oldDone = live.run(input('January 2000'));
    const oldSignal = request.mock.calls[0][1];
    const latestInput = input('February 2000');
    const latestDone = live.run(latestInput);
    expect(oldSignal.aborted).toBe(true);
    expect(events.busy).toHaveBeenLastCalledWith(true);
    const busyCalls = events.busy.mock.calls.length;
    old.resolve(response('2000-01-01'));
    await oldDone;
    expect(events.result).not.toHaveBeenCalled();
    expect(events.error).not.toHaveBeenCalled();
    expect(events.busy).toHaveBeenCalledTimes(busyCalls);
    latest.resolve(response('2000-02-01'));
    await latestDone;
    expect(events.result).toHaveBeenCalledExactlyOnceWith(response('2000-02-01'), latestInput);
    expect(events.busy).toHaveBeenLastCalledWith(false);
  });

  it('ignores a stale rejection without clearing the latest request state', async () => {
    const old = deferred<AskResponse>(), latest = deferred<AskResponse>();
    const request = vi.fn<(value: LiveAskInput, signal: AbortSignal) => Promise<AskResponse>>()
      .mockImplementationOnce(() => old.promise).mockImplementationOnce(() => latest.promise);
    const events = callbacks(), live = createLiveAsk(request, events);
    const oldDone = live.run(input('January 2000'));
    const latestDone = live.run(input('February 2000'));
    const busyCalls = events.busy.mock.calls.length;
    old.reject(new Error('Old network failure'));
    await oldDone;
    expect(events.error).not.toHaveBeenCalled();
    expect(events.busy).toHaveBeenCalledTimes(busyCalls);
    expect(events.busy).toHaveBeenLastCalledWith(true);
    latest.resolve(response('2000-02-01'));
    await latestDone;
    expect(events.result).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending timer before clear or manual navigation can be overwritten', async () => {
    const request = vi.fn(() => Promise.resolve(response('2000-01-01'))), events = callbacks();
    const live = createLiveAsk(request, events);
    live.schedule(input('January 2000'));
    await vi.advanceTimersByTimeAsync(200);
    live.cancel();
    await vi.advanceTimersByTimeAsync(1000);
    expect(request).not.toHaveBeenCalled();
    expect(events.result).not.toHaveBeenCalled();
    expect(events.busy).toHaveBeenLastCalledWith(false);
  });

  it('aborts in-flight work and ignores a late success after clear, navigation, or unmount', async () => {
    const pending = deferred<AskResponse>();
    const request = vi.fn<(value: LiveAskInput, signal: AbortSignal) => Promise<AskResponse>>(() => pending.promise);
    const events = callbacks(), live = createLiveAsk(request, events);
    const done = live.run(input('January 2000'));
    const signal = request.mock.calls[0][1];
    live.cancel();
    expect(signal.aborted).toBe(true);
    const busyCalls = events.busy.mock.calls.length;
    // This deliberately simulates a transport that completes despite being aborted.
    pending.resolve(response('2000-01-01'));
    await done;
    expect(events.result).not.toHaveBeenCalled();
    expect(events.error).not.toHaveBeenCalled();
    expect(events.busy).toHaveBeenCalledTimes(busyCalls);
    expect(events.busy).toHaveBeenLastCalledWith(false);
  });

  it('does not surface cancellation as a user-visible request error', async () => {
    const pending = deferred<AskResponse>();
    const events = callbacks(), live = createLiveAsk(() => pending.promise, events);
    const done = live.run(input('January 2000', true));
    live.cancel();
    pending.reject(new DOMException('The operation was aborted.', 'AbortError'));
    await done;
    expect(events.error).not.toHaveBeenCalled();
    expect(events.result).not.toHaveBeenCalled();
    expect(events.busy).toHaveBeenLastCalledWith(false);
  });

  it('surfaces the latest real error and always ends its busy state', async () => {
    const failure = new Error('The network is unavailable.');
    const events = callbacks(), live = createLiveAsk(() => Promise.reject(failure), events);
    const current = input('January 2000', true);
    await live.run(current);
    expect(events.error).toHaveBeenCalledExactlyOnceWith(failure, current);
    expect(events.result).not.toHaveBeenCalled();
    expect(events.busy).toHaveBeenLastCalledWith(false);
  });
});
