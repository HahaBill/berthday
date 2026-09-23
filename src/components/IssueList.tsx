import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { IssueDTO, ReservationDTO } from '../../shared/types';
import { api, bookingName, dateLabel, issueLabel, rangeLabel } from '../api';
import { useApp } from '../context';
import Icon from './Icon';
import { Status } from './UI';

function IssueBooking({ booking, issue }: { booking: ReservationDTO; issue: IssueDTO }) {
  const { meta, showBooking } = useApp();
  const berth = meta.berths.find(item => item.id === booking.berthId);
  return <div className="issue-booking"><div className={`issue-booking-icon kind-${booking.kind}`}><Icon name={booking.kind === 'vessel' ? 'ship' : 'calendar'} size={20}/></div><div className="issue-booking-body"><button className="text-link booking-link" onClick={() => showBooking(booking.id)}>{bookingName(booking)}</button><div className="issue-booking-meta"><span>{berth?.name ?? booking.berthId}</span><span>{rangeLabel(booking.startDate, booking.endDate)}</span></div>{booking.kind === 'vessel' && <div className="issue-lengths"><span>Vessel <strong>{booking.vessel?.lengthFt != null ? `${booking.vessel.lengthFt} ft` : 'unknown'}</strong></span><span>Berth <strong>{berth?.lengthFt != null ? `${berth.lengthFt} ft` : 'unknown'}</strong></span>{booking.vessel?.lengthStatus === 'disputed' && <Status value="disputed"/>}</div>}{booking.sourceRef && <p className="source-reference" title={booking.sourceRef}><Icon name="import" size={12}/>{booking.sourceRef}</p>}<Link className="subtle-link" to={`/?month=${issue.startDate.slice(0, 7)}&focus=${booking.id}`}>Show on schedule<Icon name="arrow" size={13}/></Link></div></div>;
}

function IssueCard({ issue }: { issue: IssueDTO }) {
  const { editBooking, notify } = useApp();
  const queryClient = useQueryClient();
  const [reviewOpen, setReviewOpen] = useState(false);
  const [note, setNote] = useState('');
  const review = useMutation({ mutationFn: () => api<IssueDTO>(`/issues/${issue.id}/review`, { method: 'POST', body: JSON.stringify({ note: note.trim() || undefined }) }), onSuccess: () => { notify('Issue marked reviewed.'); setReviewOpen(false); void queryClient.invalidateQueries(); } });
  return <article className={`issue-card review-card issue-${issue.type}${issue.reviewedAt ? ' is-reviewed' : ''}`}>
    <div className="review-card-heading"><div><span className={`issue-category ${issue.type}`}><Icon name={issue.reviewedAt ? 'check' : 'alert'} size={14}/>{issueLabel(issue.type)}</span><span className="review-date">{rangeLabel(issue.startDate, issue.endDate)}</span></div>{issue.reviewedAt ? <span className="status status-reviewed">Reviewed</span> : <span className="badge">Needs review</span>}</div>
    <div className={`issue-booking-pair${issue.other ? ' has-pair' : ''}`}><IssueBooking booking={issue.reservation} issue={issue}/>{issue.other && <IssueBooking booking={issue.other} issue={issue}/>}</div>
    {issue.reviewedAt && <div className="reviewed-note"><Icon name="check" size={15}/><div>Reviewed {dateLabel(issue.reviewedAt.slice(0, 10), { month: 'short', day: 'numeric', year: 'numeric' })}{issue.reviewNote && <p>{issue.reviewNote}</p>}</div></div>}
    <div className="review-card-actions"><div><button className="button small" onClick={() => editBooking(issue.reservation)}><Icon name="edit" size={14}/>Edit booking</button>{issue.other && <button className="button small text-button" onClick={() => editBooking(issue.other!)}>Edit other booking</button>}</div>{!issue.reviewedAt && <button className="button small" onClick={() => setReviewOpen(!reviewOpen)} aria-expanded={reviewOpen}><Icon name="check" size={15}/>Mark reviewed</button>}</div>
    {reviewOpen && <form className="review-note-form" onSubmit={event => { event.preventDefault(); review.mutate(); }}><label className="field"><span>Review note <span className="muted">(optional)</span></span><textarea rows={2} maxLength={2000} value={note} onChange={e => setNote(e.target.value)} placeholder="Record what you checked or what needs follow-up."/></label><p className="muted">Reviewing acknowledges this issue. The booking remains on the schedule.</p>{review.isError && <p className="inline-error" role="alert">{review.error.message}</p>}<div className="form-actions"><button className="button small" type="button" onClick={() => setReviewOpen(false)}>Cancel</button><button className="button primary small" disabled={review.isPending}>{review.isPending ? 'Saving…' : 'Mark reviewed'}</button></div></form>}
  </article>;
}

export default function IssueList({ issues }: { issues: IssueDTO[] }) {
  return <div className="review-list">{issues.map(issue => <IssueCard key={issue.id} issue={issue}/>)}</div>;
}
