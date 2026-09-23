import { useEffect, useState } from 'react';
import { NavLink, Route, Routes } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { IssueDTO, MetaResponse } from '../shared/types';
import { allPages, api } from './api';
import { AppContext, type BookingDraft, type FindDraft } from './context';
import Icon from './components/Icon';
import { ErrorState, Loading } from './components/UI';
import BookingForm from './components/BookingForm';
import BookingDrawer from './components/BookingDrawer';
import FindBerthPanel from './components/FindBerthPanel';
import AskBar from './components/AskBar';
import ScheduleView from './views/ScheduleView';
import BookingsView from './views/BookingsView';
import IssuesView from './views/IssuesView';
import VesselsView from './views/VesselsView';
import ImportView from './views/ImportView';

export default function App() {
  const meta = useQuery({ queryKey: ['meta'], queryFn: () => api<MetaResponse>('/meta') });
  const openIssues = useQuery({ queryKey: ['issues', 'all-open'], queryFn: () => allPages<IssueDTO>('/issues'), enabled: !!meta.data });
  const [booking, setBooking] = useState<BookingDraft | null>(null);
  const [drawer, setDrawer] = useState<string | null>(null);
  const [find, setFind] = useState<FindDraft | null>(null);
  const [toast, setToast] = useState('');
  const [selectedLength, setSelectedLength] = useState<number | null>(null);
  useEffect(() => { if (toast) { const id = setTimeout(() => setToast(''), 8000); return () => clearTimeout(id); } }, [toast]);
  const issueCount = openIssues.data?.length ?? 0;
  return <>
    <div className="facility-bar"><span><span className="live-dot"/>Harborview Marine Research Center</span><span>Dock operations <span className="utility-separator">/</span>Berth scheduling</span></div>
    <header className="site-header"><a className="brand" href="/" aria-label="Berthday home"><span className="brand-mark"><Icon name="anchor" size={27}/></span><div><span className="brand-name">Berthday<span className="brand-dot">.</span></span><span className="tagline">Every vessel, the right berth, on the right day.</span></div></a><div className="header-actions"><button className="button" onClick={() => setFind({})}><Icon name="search"/>Find a berth</button><button className="button primary" onClick={() => setBooking({})}><Icon name="plus"/>New booking</button></div></header>
    <div className="navigation-bar"><nav aria-label="Main navigation">{[['/', 'calendar', 'Schedule'], ['/bookings', 'list', 'Bookings'], ['/issues', 'alert', 'Issues'], ['/vessels', 'ship', 'Vessels'], ['/import', 'import', 'Migration']].map(([to, icon, title]) => <NavLink key={to} to={to} end={to === '/'}><Icon name={icon}/>{title}{to === '/issues' && issueCount > 0 && <span className="nav-count">{issueCount}</span>}</NavLink>)}</nav><div className="workspace-label"><span className="live-dot"/>Harborview workspace</div></div>
    {meta.isPending ? <Loading/> : meta.isError ? <main className="page"><ErrorState error={meta.error} retry={() => void meta.refetch()}/></main> : <AppContext.Provider value={{ meta: meta.data, newBooking: (draft = {}) => setBooking(draft), showBooking: setDrawer, editBooking: r => { setDrawer(null); setBooking(r); }, findBerth: (draft = {}) => setFind(draft), notify: setToast, selectedLength, setSelectedLength }}>
      <main className="page"><Routes><Route path="/" element={<ScheduleView/>}/><Route path="/bookings" element={<BookingsView/>}/><Route path="/issues" element={<IssuesView/>}/><Route path="/vessels" element={<VesselsView/>}/><Route path="/import" element={<ImportView/>}/><Route path="*" element={<ScheduleView/>}/></Routes></main>
      {booking && <BookingForm draft={booking} onClose={() => { setBooking(null); setSelectedLength(null); }}/ >}
      {drawer && <BookingDrawer id={drawer} onClose={() => setDrawer(null)}/>}
      {find && <FindBerthPanel draft={find} onClose={() => { setFind(null); setSelectedLength(null); }}/>}
    </AppContext.Provider>}
    <footer className="site-footer"><span><Icon name="anchor" size={14}/>Built for the days ahead.</span><span>Harborview Marine Research Center <span>·</span> Berthday</span></footer>
    {toast && <div className="toast" role="status"><Icon name="check"/><span>{toast}</span><button className="icon-button" aria-label="Dismiss notification" onClick={() => setToast('')}><Icon name="x" size={16}/></button></div>}
  </>;
}
