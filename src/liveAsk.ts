import type { AskRequest, AskResponse } from '../shared/types';

export type LiveAskInput = AskRequest & { explicit: boolean };
interface Callbacks {
  result: (response: AskResponse, input: LiveAskInput) => void;
  error: (error: unknown, input: LiveAskInput) => void;
  busy: (busy: boolean) => void;
}

/** Only the most recent text may change the schedule, even if a canceled request completes. */
export function createLiveAsk(request: (input: LiveAskInput, signal: AbortSignal) => Promise<AskResponse>, callbacks: Callbacks, delay = 400) {
  let revision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  function cancel() {
    revision++;
    clearTimeout(timer); timer = undefined;
    controller?.abort(); controller = undefined;
    callbacks.busy(false);
  }
  async function run(input: LiveAskInput) {
    cancel();
    const current = revision;
    const active = new AbortController(); controller = active;
    callbacks.busy(true);
    try {
      const response = await request(input, active.signal);
      if (current === revision) callbacks.result(response, input);
    } catch (error) {
      if (current === revision && !active.signal.aborted) callbacks.error(error, input);
    } finally {
      if (current === revision) { controller = undefined; callbacks.busy(false); }
    }
  }
  return {
    cancel, run,
    schedule(input: LiveAskInput) { cancel(); timer = setTimeout(() => { timer = undefined; void run(input); }, delay); },
  };
}
