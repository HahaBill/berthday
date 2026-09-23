import { useQuery } from '@tanstack/react-query';
import type { BerthDTO } from '../../shared/types';
import { api } from '../api';
import { useApp } from '../context';
import Icon from '../components/Icon';
import { ErrorState, Loading } from '../components/UI';
import ResourceForm from '../components/ResourceForm';
import '../styles/views.css';
import '../styles/resources.css';

function ResourceCard({ resource }: { resource: BerthDTO }) {
  const unassigned = resource.id === 'unassigned';
  return <article className={`resource-card${unassigned ? ' resource-unassigned' : ''}`}>
    <span className="resource-card-icon"><Icon name={unassigned ? 'import' : resource.isExclusive ? 'anchor' : 'ship'} size={20}/></span>
    <div className="resource-card-content"><h3>{resource.name}</h3><p>{unassigned ? 'Imported bookings only. Choose a named resource for new bookings.' : resource.isExclusive ? 'One booking at a time. Vessel length is checked.' : 'Overlapping bookings allowed. No fixed length limit.'}</p></div>
    <div className="resource-capacity">{unassigned ? <span className="badge">Read only</span> : resource.isExclusive ? <><strong>{resource.lengthFt ?? '—'}</strong><span>ft capacity</span></> : <span className="badge">Shared</span>}</div>
  </article>;
}

export default function ResourcesView() {
  const { meta } = useApp();
  const resources = useQuery({ queryKey: ['berths', 'resources'], queryFn: () => api<{ items: BerthDTO[] }>('/berths'), initialData: { items: meta.berths } });
  const rows = resources.data?.items ?? [];
  const dedicated = rows.filter(row => row.isExclusive && row.id !== 'unassigned');
  const shared = rows.filter(row => !row.isExclusive && row.id !== 'unassigned');
  const unassigned = rows.find(row => row.id === 'unassigned');

  return <section className="secondary-view resources-view">
    <div className="page-heading"><div><span className="eyebrow">Places to book</span><h1>Berths & resources</h1><p>Add dedicated berths or shared space to the schedule.</p></div><span className="resource-total">{dedicated.length} dedicated · {shared.length} shared</span></div>
    <div className="resources-layout"><div className="resource-catalogue">
      {resources.isPending ? <Loading label="Loading resources…"/> : resources.isError ? <ErrorState error={resources.error} retry={() => void resources.refetch()}/> : <>
        <section className="resource-group" aria-labelledby="dedicated-resources"><div className="resource-group-heading"><h2 id="dedicated-resources">Dedicated berths</h2><span>{dedicated.length}</span></div>{dedicated.length ? dedicated.map(row => <ResourceCard key={row.id} resource={row}/>) : <p className="resource-empty">No dedicated berths yet.</p>}</section>
        <section className="resource-group" aria-labelledby="shared-resources"><div className="resource-group-heading"><h2 id="shared-resources">Shared resources</h2><span>{shared.length}</span></div>{shared.length ? shared.map(row => <ResourceCard key={row.id} resource={row}/>) : <p className="resource-empty">No shared resources yet.</p>}</section>
        {unassigned && <ResourceCard resource={unassigned}/>}
      </>}
    </div>
    <ResourceForm/></div>
  </section>;
}
