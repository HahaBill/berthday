import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { AskResponse } from '../../shared/types';
import { todayIn } from '../../shared/dates';
import { api } from '../api';
import { buildAskAction } from '../askActions';
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

  async function ask(event: FormEvent) {
    event.preventDefault();
    if (!q.trim() || busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await api<AskResponse>('/ask', {
        method: 'POST', body: JSON.stringify({ q, today: todayIn(), viewedMonth }),
      });
      const action = buildAskAction(response, viewedMonth);
      if (action.type === 'unsupported') { setError(action.message); return; }
      if (action.type === 'create') newBooking(action.draft);
      else {
        navigate(`/?${action.search}`);
        if (action.type === 'availability') findBerth(action.draft);
        setMessageSearch(`?${action.search}`);
        setMessage(action.message);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The request could not be completed. Please try again.');
    } finally { setBusy(false); }
  }

  return <div className="ask-container">
    <form className="ask-bar" onSubmit={ask} aria-busy={busy}>
      <span className="ask-symbol"><Icon name="sparkles" size={19}/></span>
      <input aria-label="Ask about the schedule" aria-describedby="ask-help" value={q} maxLength={300} disabled={busy}
        onChange={event => { setQ(event.target.value); setMessage(''); setError(''); }}
        placeholder="Find bookings, go to a date, or create an event…"/>
      <span className="ask-example">Try “Go to January 2000”</span>
      <button type="submit" className="ask-submit" disabled={busy || !q.trim()}
        aria-label={busy ? 'Working on your request' : 'Run schedule request'}>
        {busy ? <span className="spinner"/> : <Icon name="arrow" size={18}/>}
      </button>
    </form>
    <p id="ask-help" className="ask-help">Press Enter to update the schedule. To add an event, try “Create a community sail day at North Pier Face on July 10, 2026”.</p>
    {message && location.search === messageSearch && <p className="ask-feedback" role="status"><Icon name="check" size={14}/>{message}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </div>;
}
