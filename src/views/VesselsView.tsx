import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { PaginatedResponse, VesselDTO, VesselUpdateResponse } from '../../shared/types';
import { api, params } from '../api';
import { useApp } from '../context';
import Icon from '../components/Icon';
import { EmptyState, ErrorState, Loading, Modal, Status } from '../components/UI';
import '../styles/views.css';

function VesselRow({ vessel }: { vessel: VesselDTO }) {
  const { newBooking, notify } = useApp();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(vessel.name);
  const [length, setLength] = useState(vessel.lengthFt?.toString() ?? '');
  const [validation, setValidation] = useState('');
  const save = useMutation({
    mutationFn: (body: { name?: string; lengthFt?: number }) => api<VesselUpdateResponse>(`/vessels/${vessel.id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: result => {
      setEditing(false);
      const changes = result.newFitIssues ? `${result.newFitIssues} new fit ${result.newFitIssues === 1 ? 'issue' : 'issues'}` : result.clearedFitIssues ? `${result.clearedFitIssues} fit ${result.clearedFitIssues === 1 ? 'issue' : 'issues'} cleared` : 'No new fit issues';
      notify(`${result.vessel.name} updated. ${changes}.`);
      void queryClient.invalidateQueries();
    },
  });
  const startEdit = () => { setName(vessel.name); setLength(vessel.lengthFt?.toString() ?? ''); setValidation(''); save.reset(); setEditing(true); };
  const submit = () => {
    setValidation('');
    if (!name.trim()) { setValidation('Enter a vessel name.'); return; }
    if ((length || vessel.lengthFt != null) && (!/^\d+$/.test(length) || Number(length) < 1 || Number(length) > 1000)) { setValidation('Enter a whole-number length from 1 to 1,000 ft.'); return; }
    const body: { name?: string; lengthFt?: number } = {};
    if (name.trim() !== vessel.name) body.name = name.trim();
    if (length && (Number(length) !== vessel.lengthFt || vessel.lengthStatus !== 'known')) body.lengthFt = Number(length);
    if (!Object.keys(body).length) { setEditing(false); return; }
    save.mutate(body);
  };
  return <><tr className={editing ? 'editing-row' : ''}><td>{editing ? <input className="inline-name-input" aria-label={`Name for ${vessel.name}`} value={name} maxLength={200} onChange={e => setName(e.target.value)} form={`vessel-${vessel.id}`}/> : <div className="vessel-name-cell"><span className="vessel-mark"><Icon name="ship" size={19}/></span><strong>{vessel.name}</strong></div>}</td><td>{editing ? <div className="length-input"><input aria-label={`Length in feet for ${vessel.name}`} type="number" min={1} max={1000} step={1} value={length} onChange={e => setLength(e.target.value)} form={`vessel-${vessel.id}`} placeholder="Unknown"/><span>ft</span></div> : <button className={`editable-length${vessel.lengthFt == null ? ' missing' : ''}`} onClick={startEdit} aria-label={`Edit length for ${vessel.name}`}>{vessel.lengthFt == null ? 'Add length' : <>{vessel.lengthFt}<span>ft</span></>}<Icon name="edit" size={12}/></button>}</td><td><Status value={vessel.lengthStatus}/>{vessel.lengthNote && <p className="vessel-length-note">{vessel.lengthNote}</p>}</td><td className="number-cell">{vessel.bookingCount ?? 0}</td><td className="row-actions-cell">{editing ? <form id={`vessel-${vessel.id}`} className="inline-edit-actions" onSubmit={e => { e.preventDefault(); submit(); }}><button type="button" className="button small text-button" onClick={() => setEditing(false)} disabled={save.isPending}>Cancel</button><button className="button primary small" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</button></form> : <div className="inline-edit-actions"><button className="button small text-button" onClick={startEdit}><Icon name="edit" size={13}/>Edit</button><button className="button small" onClick={() => newBooking({ vesselId: vessel.id, kind: 'vessel' })}>Book<Icon name="plus" size={13}/></button></div>}</td></tr>{editing && (validation || save.isError) && <tr className="inline-error-row"><td colSpan={5}><p className="inline-error" role="alert">{validation || save.error?.message}</p></td></tr>}</>;
}

function AddVessel({ onClose }: { onClose: () => void }) {
  const { notify } = useApp();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [length, setLength] = useState('');
  const create = useMutation({ mutationFn: () => api<VesselDTO>('/vessels', { method: 'POST', body: JSON.stringify({ name: name.trim(), lengthFt: Number(length) }) }), onSuccess: vessel => { notify(`${vessel.name} added to the registry.`); void queryClient.invalidateQueries({ queryKey: ['vessels'] }); onClose(); } });
  return <Modal title="Add vessel" onClose={onClose} className="add-vessel-modal"><form onSubmit={e => { e.preventDefault(); create.mutate(); }}><p className="muted">Record the vessel’s length so every new booking can be checked against the berth.</p><label className="field"><span>Vessel name</span><input autoFocus required maxLength={200} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. R/V Clear Tern"/></label><label className="field"><span>Length overall (ft)</span><input type="number" required min={1} max={1000} step={1} value={length} onChange={e => setLength(e.target.value)} placeholder="120"/></label>{create.isError && <p className="inline-error" role="alert">{create.error.message}</p>}<div className="form-actions"><button className="button" type="button" onClick={onClose}>Cancel</button><button className="button primary" disabled={create.isPending}>{create.isPending ? 'Saving…' : 'Add vessel'}</button></div></form></Modal>;
}

export default function VesselsView() {
  const { meta } = useApp();
  const [search, setSearch] = useSearchParams();
  const [adding, setAdding] = useState(false);
  const filters = { q: search.get('q'), lengthStatus: search.get('lengthStatus') };
  const query = useInfiniteQuery({ queryKey: ['vessels', 'registry', filters], queryFn: ({ pageParam }) => api<PaginatedResponse<VesselDTO>>(`/vessels?${params({ ...filters, limit: 50, cursor: pageParam })}`), initialPageParam: null as string | null, getNextPageParam: last => last.nextCursor ?? undefined });
  const rows = query.data?.pages.flatMap(page => page.items) ?? [];
  const change = (key: string, value: string) => setSearch(current => { const next = new URLSearchParams(current); if (value) next.set(key, value); else next.delete(key); return next; }, { replace: true });
  return <section className="secondary-view vessels-view"><div className="page-heading"><div><span className="eyebrow">Know your fleet</span><h1>Vessel registry</h1><p>Keep vessel details up to date. A length change rechecks every booking.</p></div><button className="button primary" onClick={() => setAdding(true)}><Icon name="plus"/>Add vessel</button></div>
    <div className="registry-note"><span className="registry-note-icon"><Icon name="ship" size={21}/></span><div><strong>Good measurements make better bookings.</strong><p>The original import included {meta.importSummary.vessels_by_length_status.unknown ?? 0} vessels without a recorded length. Add a length to confirm fit or surface a booking that needs attention.</p></div></div>
    <div className="filter-bar vessel-filters"><label className="field search-field"><span>Search vessels</span><div className="input-with-icon"><Icon name="search"/><input type="search" maxLength={300} value={filters.q ?? ''} onChange={e => change('q', e.target.value)} placeholder="Search by vessel name"/></div></label><label className="field"><span>Length status</span><select value={filters.lengthStatus ?? ''} onChange={e => change('lengthStatus', e.target.value)}><option value="">All vessels</option><option value="unknown">Missing length</option><option value="known">Known length</option><option value="disputed">Disputed length</option></select></label><button className={`button small missing-length-filter${filters.lengthStatus === 'unknown' ? ' selected' : ''}`} onClick={() => change('lengthStatus', filters.lengthStatus === 'unknown' ? '' : 'unknown')} aria-pressed={filters.lengthStatus === 'unknown'}><Icon name="filter" size={14}/>Missing length</button></div>
    <div className="table-card"><div className="table-caption"><div><strong>{rows.length.toLocaleString()} {query.hasNextPage ? 'vessels loaded' : 'vessels'}</strong><span className="muted">Lengths in feet · Click a length to edit</span></div>{(filters.q || filters.lengthStatus) && <button className="button small text-button" onClick={() => setSearch({})}>Clear filters<Icon name="x" size={13}/></button>}</div>{query.isPending ? <Loading label="Loading vessels…"/> : query.isError ? <ErrorState error={query.error} retry={() => void query.refetch()}/> : !rows.length ? <EmptyState icon="ship" title="No matching vessels">Try another name or clear the length filter.</EmptyState> : <div className="table-scroll"><table className="data-table vessels-table"><thead><tr><th>Vessel</th><th>Length overall</th><th>Length status</th><th>Bookings</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{rows.map(vessel => <VesselRow key={vessel.id} vessel={vessel}/>)}</tbody></table></div>}{!!rows.length && <div className="pagination"><span className="muted">{query.hasNextPage ? 'Vessels are listed alphabetically.' : 'You’re viewing all matching vessels.'}</span>{query.hasNextPage && <button className="button small" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? 'Loading…' : 'Load more vessels'}<Icon name="down" size={14}/></button>}</div>}</div>{adding && <AddVessel onClose={() => setAdding(false)}/>}</section>;
}
