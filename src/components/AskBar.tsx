import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { AskResponse } from '../../shared/types';
import { todayIn } from '../../shared/dates';
import { api } from '../api';
import { buildAskAction } from '../askActions';
import { createLiveAsk, type LiveAskInput } from '../liveAsk';
import { clearScheduleFilters } from '../scheduleFilters';
import { useApp } from '../context';
import Icon from './Icon';

export default function AskBar({ viewedMonth }: { viewedMonth: string }) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [messageSearch, setMessageSearch] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const location = useLocation();
  const { findBerth, newBooking } = useApp();
  const composing = useRef(false);

  const handlers = useRef({ result: (response: AskResponse, input: LiveAskInput) => {}, error: (failure: unknown, input: LiveAskInput) => {} });
  handlers.current = {
    result(response, input) {
      const action = buildAskAction(response, input.viewedMonth);
      if (action.type === 'unsupported') { if (input.explicit) setError(action.message); return; }
      if (action.type === 'create') {
        if (input.explicit) newBooking(action.draft);
        else { setMessageSearch(location.search); setMessage('Press Enter to review the booking, then save it.'); }
        return;
      }
      navigate(`/?${action.search}`, { replace: !input.explicit });
      if (action.type === 'availability' && input.explicit) findBerth(action.draft);
      setMessageSearch(`?${action.search}`);
      setMessage(action.type === 'availability' && !input.explicit ? 'Dates updated. Press Enter to see available berths.' : action.message);
    },
    error(failure, input) {
      if (input.explicit) setError(failure instanceof Error ? failure.message : 'The request could not be completed. Please try again.');
      else { setMessageSearch(location.search); setMessage('Could not update the schedule. Press Enter to retry.'); }
    },
  };
  const [live] = useState(() => createLiveAsk(
    ({ explicit: _explicit, ...input }, signal) => api<AskResponse>('/ask', { method: 'POST', body: JSON.stringify(input), signal }),
    { result: (...args) => handlers.current.result(...args), error: (...args) => handlers.current.error(...args), busy: setBusy },
  ));
  // Changing a month/chip or using browser history must cancel pending interpretations.
  // Scheduling happens only on input edits, so our own URL changes never rerun a query.
  useEffect(() => { live.cancel(); }, [location.key, live]);
  useEffect(() => () => live.cancel(), [live]);
  function input(value: string, explicit: boolean): LiveAskInput { return { q: value.trim(), today: todayIn(), viewedMonth, explicit }; }
  function change(value: string, isComposing = false) {
    setQ(value); setMessage(''); setError(''); live.cancel();
    if (!value.trim()) {
      const search = clearScheduleFilters(new URLSearchParams(location.search));
      search.set('month', viewedMonth);
      navigate(`/?${search}`, { replace: true });
    } else if (!isComposing && !composing.current) live.schedule(input(value, false));
  }
  function ask(event: FormEvent) {
    event.preventDefault();
    if (!q.trim() || composing.current) return;
    setError(''); setMessage(''); void live.run(input(q, true));
  }

  return <div className="ask-container">
    <form className="ask-bar" onSubmit={ask} aria-busy={busy}>
      <span className="ask-symbol"><Icon name="sparkles" size={19}/></span>
      <input aria-label="Ask about the schedule" aria-describedby="ask-help" value={q} maxLength={300}
        onChange={event => change(event.target.value, (event.nativeEvent as InputEvent).isComposing)}
        onCompositionStart={() => { composing.current = true; live.cancel(); }}
        onCompositionEnd={event => { composing.current = false; change(event.currentTarget.value); }}
        placeholder="Find bookings, go to a date, or create an event…"/>
      <span className="ask-example">Try “Go to January 2000”</span>
      <button type="submit" className="ask-submit" disabled={!q.trim()}
        aria-label={busy ? 'Working on your request' : 'Run schedule request'}>
        {busy ? <span className="spinner"/> : <Icon name="arrow" size={18}/>}
      </button>
    </form>
    <p id="ask-help" className="ask-help">Filters update as you type. To create an event, describe its name, berth, and dates, then press Enter to review.</p>
    {message && location.search === messageSearch && <p className="ask-feedback" role="status"><Icon name="check" size={14}/>{message}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </div>;
}
