import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ImportFilesPage, ImportJobDTO, ImportJobsPage, ImportPreviewDTO, ParsedImportRow } from '../../shared/import-types';
import type { BerthDTO } from '../../shared/types';
import { diffDays } from '../../shared/dates';
import { api, dateLabel, params, rangeLabel } from '../api';
import { useApp } from '../context';
import { canPrepareWorkbook, importRequest, prepareFiles, stageWorkbook, type QueuedWorkbook } from '../imports/uploadQueue';
import Icon from '../components/Icon';
import { ErrorState, Loading } from '../components/UI';
import '../styles/uploads.css';

const count = (value: number) => value.toLocaleString();
const jobLabels = { staging: 'Preparing files', ready: 'Ready to import', importing: 'Import in progress', completed: 'Complete', cancelled: 'Stopped' };
const rowName = (row: ParsedImportRow | null) => row ? row.vesselName ?? ('title' in row ? row.title : null) ?? 'Untitled record' : 'Invalid record';
const rowBerth = (row: ParsedImportRow | null, berths: BerthDTO[]) => !row ? '—' : row.recordType === 'vessel' ? 'Vessel registry' : berths.find(berth => berth.id === row.berthId)?.name ?? row.berthId;
const exportCell = (value: unknown) => `"${String(value ?? '').replace(/^[=+@\-]/, "'$&").replaceAll('"', '""')}"`;

export default function UploadView() {
  const { meta, notify } = useApp();
  const client = useQueryClient();
  const [search, setSearch] = useSearchParams();
  const jobId = search.get('job') ?? '';
  const [queue, setQueue] = useState<QueuedWorkbook[]>([]);
  const [queuePage, setQueuePage] = useState(0);
  const [filePage, setFilePage] = useState(0);
  const [busy, setBusy] = useState<'reading' | 'importing' | 'preview' | 'stopping' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState<ImportPreviewDTO | null>(null);
  const [dragging, setDragging] = useState(false);
  const [name, setName] = useState('Excel schedule import');
  const filesInput = useRef<HTMLInputElement>(null), folderInput = useRef<HTMLInputElement>(null);
  const active = useRef<AbortController | null>(null);
  const ownedJob = useRef(jobId);
  const jobs = useQuery({ queryKey: ['upload-jobs'], queryFn: () => api<ImportJobsPage>('/import/jobs') });
  const current = useQuery({ queryKey: ['upload-job', jobId], queryFn: () => api<ImportJobDTO>(`/import/jobs/${jobId}`), enabled: !!jobId });
  const files = useQuery({ queryKey: ['upload-files', jobId, filePage], queryFn: () => api<ImportFilesPage>(`/import/jobs/${jobId}/files?offset=${filePage * 50}&limit=50`), enabled: !!jobId && !busy });
  const job = current.data;
  const setJob = (value: ImportJobDTO) => client.setQueryData(['upload-job', value.id], value);
  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => {
    if (ownedJob.current === jobId) return;
    active.current?.abort(); active.current = null; ownedJob.current = jobId;
    setBusy(null); setQueue([]); setPreview(null); setError(''); setNotice(''); setFilePage(0); setQueuePage(0);
  }, [jobId]);
  useEffect(() => {
    if (!busy) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [busy]);
  const update = (id: string, patch: Partial<QueuedWorkbook>) => setQueue(items => items.map(item => item.id === id ? { ...item, ...patch } : item));
  const refresh = async () => { await Promise.all([client.invalidateQueries({ queryKey: ['upload-jobs'] }), client.invalidateQueries({ queryKey: ['upload-files', jobId] })]); };
  const refreshSchedule = async () => { await client.invalidateQueries({ predicate: query => ['meta', 'reservations', 'issues', 'vessels'].includes(String(query.queryKey[0])) }); };
  function selectJob(id: string) {
    active.current?.abort(); setQueue([]); setPreview(null); setError(''); setNotice(''); setFilePage(0); setQueuePage(0);
    setSearch(id ? { job: id } : {});
  }
  function addFiles(incoming: File[]) {
    if (busy || (job && job.status !== 'staging')) return;
    setError(''); setNotice('');
    try { const added = prepareFiles(incoming, queue); setQueue(items => [...items, ...added]); setPreview(null); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Files could not be selected.'); }
  }
  async function prepare() {
    const candidates = queue.filter(canPrepareWorkbook);
    if (!candidates.length) return;
    setError(''); setNotice(''); setPreview(null); setBusy('reading');
    const controller = new AbortController(); active.current = controller;
    let selectedId = jobId;
    try {
      if (!selectedId) {
        const created = await api<ImportJobDTO>('/import/jobs', { method: 'POST', body: JSON.stringify({ name: name.trim() || 'Excel schedule import' }), signal: controller.signal });
        controller.signal.throwIfAborted();
        selectedId = created.id; ownedJob.current = selectedId; setJob(created); setSearch({ job: selectedId }, { replace: true });
      }
      let failures = 0;
      for (const item of candidates) {
        controller.signal.throwIfAborted();
        try { await stageWorkbook(selectedId, item, controller.signal, patch => update(item.id, patch), setJob, meta.berths); }
        catch (failure) {
          if (controller.signal.aborted) { update(item.id, { status: 'queued', detail: 'Paused. Select Prepare files to continue.' }); throw failure; }
          failures++; update(item.id, { status: 'error', detail: failure instanceof Error ? failure.message : 'This file could not be read.' });
        }
      }
      setJob(await api<ImportJobDTO>(`/import/jobs/${selectedId}`));
      controller.signal.throwIfAborted();
      setNotice(failures ? `${failures} file${failures === 1 ? ' needs' : 's need'} attention. You can review the files that were prepared successfully.` : 'Files are prepared. Review the preview before adding records to the schedule.');
    } catch (failure) {
      if (active.current !== controller) return;
      if (controller.signal.aborted) setNotice('Preparation paused. Completed batches are saved; continue here or reselect the same files after reopening.');
      else setError(failure instanceof Error ? failure.message : 'The import could not be prepared.');
    } finally { if (active.current === controller) { active.current = null; setBusy(null); await refresh(); } }
  }
  async function review() {
    setError(''); setBusy('preview');
    const controller = new AbortController(); active.current = controller;
    try { const result = await importRequest<ImportPreviewDTO>(`/import/jobs/${jobId}/preview`, {}, controller.signal); controller.signal.throwIfAborted(); setJob(result.job); setPreview(result); setNotice(''); }
    catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'The preview could not be loaded.'); }
    finally { if (active.current === controller) { active.current = null; setBusy(null); await refresh(); } }
  }
  async function commit() {
    setError(''); setNotice(''); setBusy('importing');
    const controller = new AbortController(); active.current = controller;
    try {
      let latest = job!;
      while (latest.status !== 'completed' && latest.status !== 'cancelled') {
        controller.signal.throwIfAborted();
        const before = latest.processedRows;
        latest = await importRequest<ImportJobDTO>(`/import/jobs/${jobId}/commit`, { limit: 10 }, controller.signal);
        setJob(latest);
        if (latest.status === 'completed') { notify(`Imported ${count(latest.importedReservations)} bookings and ${count(latest.importedVessels)} vessels.`); break; }
        if (latest.processedRows === before && latest.status === 'importing') throw new Error('The import made no further progress. Your completed records are saved; select Resume import to retry.');
      }
    } catch (failure) {
      if (active.current !== controller) return;
      if (controller.signal.aborted) setNotice('Import paused. Completed bookings remain saved. Select Resume import to continue without duplicates.');
      else setError(failure instanceof Error ? failure.message : 'Import paused. Select Resume import to continue.');
    } finally { if (active.current === controller) { active.current = null; setBusy(null); await refresh(); await refreshSchedule(); void current.refetch(); } }
  }
  async function stop() {
    setBusy('stopping'); setError('');
    try { setJob(await importRequest<ImportJobDTO>(`/import/jobs/${jobId}/cancel`, {})); setNotice('Import stopped. Any bookings already added remain in the schedule.'); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'The import could not be stopped.'); }
    finally { setBusy(null); await refresh(); await refreshSchedule(); }
  }
  async function downloadReport() {
    setError('');
    try {
      const lines = [['File', 'Status', 'Records', 'Imported bookings', 'Imported vessels', 'Duplicates', 'Invalid rows', 'Notes']];
      for (let offset = 0; ; offset += 100) {
        const page = await api<ImportFilesPage>(`/import/jobs/${jobId}/files?offset=${offset}&limit=100`);
        for (const file of page.items) lines.push([file.name, file.status, String(file.rowCount), String(file.importedReservations), String(file.importedVessels), String(file.duplicateRows), String(file.invalidRows), file.diagnostics.map(d => `${d.code}: ${d.message}`).join('; ')]);
        if (offset + page.items.length >= page.total || !page.items.length) break;
      }
      for (const item of queue.filter(item => item.status === 'error')) lines.push([item.name, 'error', '', '', '', '', '', item.detail]);
      const url = URL.createObjectURL(new Blob(['\uFEFF' + lines.map(line => line.map(exportCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = `berthday-import-${jobId}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'The report could not be downloaded.'); }
  }
  function drop(event: DragEvent) { event.preventDefault(); setDragging(false); addFiles(Array.from(event.dataTransfer.files)); }
  const canChoose = !busy && (!job || job.status === 'staging');
  const pending = queue.filter(canPrepareWorkbook).length;
  const finished = queue.filter(item => ['ready', 'duplicate', 'error'].includes(item.status)).length;
  const percent = busy === 'reading' ? queue.length ? Math.round(finished / queue.length * 100) : 0 : job?.totalRows ? Math.round(job.processedRows / job.totalRows * 100) : 0;
  const terminal = job && ['completed', 'cancelled'].includes(job.status);
  const bookingSearch = job?.dateFrom && job.dateTo && diffDays(job.dateFrom, job.dateTo) <= 400 ? params({ from: job.dateFrom, to: job.dateTo }) : 'history=true';
  return <section className="upload-view secondary-view">
    <div className="page-heading"><div><span className="eyebrow">From workbook to working schedule</span><h1>Import Excel schedules</h1><p>Add bookings from one workbook or a whole folder of dock schedules.</p></div><Link className="button" to="/resources"><Icon name="anchor"/>Manage resources</Link></div>
    <div className="upload-layout"><div className="upload-main">
      <section className="card upload-intro"><div className="upload-step"><span>1</span><div><h2>Choose your workbooks</h2><p>Use the annual dock-schedule layout, including merged cells and coloured bars. Add any new berths or shared resources before importing.</p></div></div>
        {!job && <label className="field">Import name<input value={name} maxLength={120} onChange={event => setName(event.target.value)} placeholder="e.g. Harbor schedules 2020–2026" disabled={!!busy}/></label>}
        <div className={`upload-dropzone${dragging ? ' dragging' : ''}${!canChoose ? ' inactive' : ''}`} onDragOver={event => { event.preventDefault(); if (canChoose) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop}>
          <span className="upload-emblem"><Icon name="import" size={30}/></span><strong>Drop Excel workbooks here</strong><p>.xlsx or .xlsm · Up to 5,000 files per import · 25 MB per file</p>
          <div className="upload-choose"><button className="button primary" disabled={!canChoose} onClick={() => filesInput.current?.click()}>Choose files</button><button className="button" disabled={!canChoose} onClick={() => folderInput.current?.click()}>Choose folder</button></div>
          <input className="sr-only" type="file" multiple accept=".xlsx,.xlsm" aria-label="Choose Excel workbooks" ref={filesInput} onChange={event => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }}/>
          <input className="sr-only" type="file" multiple accept=".xlsx,.xlsm" aria-label="Choose a folder of Excel workbooks" ref={node => { folderInput.current = node; node?.setAttribute('webkitdirectory', ''); }} onChange={event => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }}/>
        </div><p className="upload-help">Files are read one at a time in the background. Only extracted records are sent to Berthday. Old .xls files need to be saved as .xlsx first.</p>
        {!!queue.length && <><div className="upload-queue-caption"><strong>{count(queue.length)} {queue.length === 1 ? 'file' : 'files'} selected</strong><span>{count(finished)} prepared or reviewed</span></div><div className="upload-queue" aria-label="Selected workbooks">{queue.slice(queuePage * 25, queuePage * 25 + 25).map(item => <article className={`upload-file ${item.status}`} key={item.id}><Icon name={item.status === 'error' ? 'alert' : ['ready', 'duplicate'].includes(item.status) ? 'check' : 'import'} size={19}/><div><strong>{item.name}</strong><span>{item.detail}{item.warnings ? ` · ${count(item.warnings)} source notes to review` : ''}</span></div><small>{item.status}</small></article>)}</div>{queue.length > 25 && <div className="pagination"><span>Files {queuePage * 25 + 1}–{Math.min(queue.length, queuePage * 25 + 25)} of {count(queue.length)}</span><div><button className="button small" disabled={!queuePage} onClick={() => setQueuePage(page => page - 1)}>Previous</button><button className="button small" disabled={(queuePage + 1) * 25 >= queue.length} onClick={() => setQueuePage(page => page + 1)}>Next</button></div></div>}</>}
        {canChoose && pending > 0 && <button className="button primary prepare-files" onClick={() => void prepare()}><Icon name="import"/>Prepare files</button>}
        {job?.status === 'staging' && !queue.length && <p className="upload-help">To continue a previous preparation, reselect the same files. Records already received will be skipped.</p>}
      </section>
      {!!busy && <div className="upload-progress card" role="status"><div><span className="spinner"/><strong>{busy === 'reading' ? 'Reading and preparing workbooks…' : busy === 'importing' ? 'Adding records to the schedule…' : busy === 'preview' ? 'Preparing your preview…' : 'Stopping import…'}</strong>{['reading', 'importing'].includes(busy) && <button className="button small" onClick={() => active.current?.abort()}>Pause</button>}</div>{['reading', 'importing'].includes(busy) && <><progress max={100} value={percent} aria-label="Import progress"/><p>{busy === 'reading' ? `${finished} of ${count(queue.length)} files processed` : `${count(job?.processedRows ?? 0)} of ${count(job?.totalRows ?? 0)} records processed`}. Keep this page open while work is running.</p></>}</div>}
      {error && <p className="upload-notice error" role="alert"><Icon name="alert"/>{error}</p>}{notice && <p className="upload-notice" role="status"><Icon name="help"/>{notice}</p>}
      {job && <section className="card upload-review"><div className="upload-step"><span>2</span><div><h2>{terminal ? 'Import results' : 'Review and import'}</h2><p>{job.name} <span className={`import-job-status ${job.status}`}>{jobLabels[job.status]}</span></p></div></div>
        <div className="upload-totals"><div><strong>{count(job.fileCount)}</strong><span>workbooks</span></div><div><strong>{count(job.stagedRows)}</strong><span>records prepared</span></div><div><strong>{count(job.importedReservations)}</strong><span>bookings added</span></div><div><strong>{count(job.duplicateRows)}</strong><span>duplicate records skipped</span></div></div>
        <p className="upload-help">{count(job.importedVessels)} vessels added · {count(job.invalidRows)} invalid records · {count(job.issueCount)} schedule {job.issueCount === 1 ? 'issue' : 'issues'}{job.dateFrom && job.dateTo ? ` · ${rangeLabel(job.dateFrom, job.dateTo)}` : ''}</p>
        {!terminal && <p className="upload-policy">Existing bookings and vessel details are preserved. Exact duplicates are skipped. Imported overlaps and fit problems remain visible in the issues list.</p>}
        <div className="upload-actions">{job.status === 'staging' && <button className="button primary" disabled={!!busy || !job.fileCount} onClick={() => void review()}>Review prepared records<Icon name="right"/></button>}{job.status === 'ready' && <button className="button primary" disabled={!!busy} onClick={() => void commit()}>Import records<Icon name="arrow"/></button>}{job.status === 'importing' && !busy && <button className="button primary" onClick={() => void commit()}>Resume import<Icon name="arrow"/></button>}{['ready', 'importing', 'completed'].includes(job.status) && !preview && <button className="button" disabled={!!busy} onClick={() => void review()}>View preview</button>}{!busy && !terminal && <button className="button text-button" onClick={() => void stop()}>Stop import</button>}{!!job.fileCount && <button className="button" disabled={!!busy} onClick={() => void downloadReport()}><Icon name="download"/>Download report</button>}{terminal && <button className="button" onClick={() => selectJob('')}>Start another import</button>}</div>
        {job.status === 'importing' && <p className="upload-help">Pause keeps completed records and lets you resume after a connection or service-limit interruption. Stop ends this import permanently; bookings already added remain saved.</p>}
        {job.importedReservations > 0 && <div className="upload-destinations"><Link className="button" to={`/?month=${job.dateFrom?.slice(0, 7) ?? meta.dataRange.to.slice(0, 7)}`}>View schedule<Icon name="arrow"/></Link><Link className="button" to={`/bookings?${bookingSearch}`}>View bookings<Icon name="arrow"/></Link>{job.issueCount > 0 && <Link className="button" to="/issues">Review issues<Icon name="alert"/></Link>}</div>}
        {preview && <div className="upload-preview"><h3>Record preview</h3><p className="upload-help">{preview.message} Showing up to 20 records.</p><div className="table-scroll"><table className="data-table"><thead><tr><th>Vessel / booking</th><th>Berth / type</th><th>Dates</th><th>Source</th></tr></thead><tbody>{preview.rows.map(entry => <tr key={`${entry.fileId}:${entry.index}`}><td>{rowName(entry.row)}{entry.error && <small className="upload-row-error">{entry.error}</small>}</td><td>{rowBerth(entry.row, meta.berths)}</td><td>{entry.row && entry.row.recordType !== 'vessel' ? rangeLabel(entry.row.startDate, entry.row.endDate) : '—'}</td><td><strong>{entry.fileName}</strong><small>{entry.row?.sourceRef ?? `Record ${entry.index + 1}`}</small></td></tr>)}</tbody></table></div>{preview.diagnostics.length > 0 && <details className="upload-diagnostics"><summary>{count(preview.diagnostics.length)} source notes in this preview</summary>{preview.diagnostics.slice(0, 100).map((diagnostic, index) => <p key={index}><strong>{diagnostic.code}</strong> {diagnostic.message}<small>{[diagnostic.sheet, diagnostic.cell].filter(Boolean).join('!')}</small></p>)}</details>}</div>}
        {!busy && !!files.data?.items.length && <details className="upload-server-files"><summary>Saved workbooks ({count(files.data.total)})</summary>{files.data.items.map(file => <article className="upload-file" key={file.id}><Icon name={file.status === 'completed' || file.status === 'duplicate' ? 'check' : 'import'}/><div><strong>{file.name}</strong><span>{count(file.stagedRows)} / {count(file.rowCount)} records prepared · {count(file.importedReservations)} bookings added · {file.status}</span>{file.diagnostics.filter(d => d.severity !== 'info').slice(0, 2).map((d, i) => <small key={i}>{d.code}: {d.message}</small>)}</div></article>)}{files.data.total > 50 && <div className="pagination"><button className="button small" disabled={!filePage} onClick={() => setFilePage(page => page - 1)}>Previous files</button><button className="button small" disabled={(filePage + 1) * 50 >= files.data.total} onClick={() => setFilePage(page => page + 1)}>Next files</button></div>}</details>}
      </section>}
      {current.isError && <ErrorState error={current.error} retry={() => void current.refetch()}/>}
    </div><aside className="upload-sidebar"><section className="card"><h2>How imports work</h2><ol><li>Choose files or a folder. Each workbook is read separately.</li><li>Review extracted bookings, vessels, and source notes.</li><li>Import in small batches. New bookings appear in both schedule views.</li></ol><p>Preparation and import progress are saved. If you leave during preparation, reselect the same files to continue. Once prepared, importing can resume without the originals.</p><Link to="/import?view=migration" className="subtle-link">View the original migration report<Icon name="right" size={14}/></Link></section>
      <section className="card upload-history"><div className="upload-history-heading"><h2>Recent imports</h2>{jobId && <button className="text-button button small" disabled={!!busy} onClick={() => selectJob('')}>New</button>}</div>{jobs.isPending ? <Loading label="Loading imports…"/> : jobs.isError ? <ErrorState error={jobs.error} retry={() => void jobs.refetch()}/> : jobs.data?.items.length ? jobs.data.items.slice(0, 20).map(item => <button className={`upload-history-item${item.id === jobId ? ' selected' : ''}`} disabled={!!busy} key={item.id} onClick={() => selectJob(item.id)}><strong>{item.name}</strong><span>{dateLabel(item.createdAt.slice(0, 10), { month: 'short', day: 'numeric', year: 'numeric' })} · {jobLabels[item.status]}</span><small>{count(item.fileCount)} {item.fileCount === 1 ? 'file' : 'files'} · {count(item.importedReservations)} bookings added</small></button>) : <p>No imports yet. Choose a workbook to get started.</p>}</section>
    </aside></div>
  </section>;
}
