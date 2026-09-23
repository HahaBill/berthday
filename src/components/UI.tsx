import { useEffect, useRef, type ReactNode } from 'react';
import Icon from './Icon';
export function Modal({ children, onClose, title, className = '' }: { children: ReactNode; onClose: () => void; title: string; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog ref={ref} className={`dialog ${className}`} onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => { if (e.target === e.currentTarget) onClose(); }} aria-label={title}>
    <div className="dialog-inner"><div className="dialog-heading"><div><span className="eyebrow">Berthday · Harborview</span><h2>{title}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close"><Icon name="x" /></button></div>{children}</div>
  </dialog>;
}
export function EmptyState({ icon = 'anchor', title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon"><Icon name={icon} size={28} /></div><h3>{title}</h3><p>{children}</p></div>;
}
export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) { return <div className="error-state" role="alert"><Icon name="alert" /><div><strong>We couldn’t load this information.</strong><p>{error instanceof Error ? error.message : 'Please try again.'}</p></div>{retry && <button className="button" onClick={retry}>Try again</button>}</div>; }
export function Loading({ label = 'Loading schedule…' }: { label?: string }) { return <div className="loading" role="status"><span className="spinner" />{label}</div>; }
export function Status({ value }: { value: string }) { return <span className={`status status-${value}`}>{({ ok: 'Fit confirmed', violation: 'Too long', unverified: 'Fit unverified', 'n/a': 'Not applicable', known: 'Known length', unknown: 'Missing length', disputed: 'Disputed length', available: 'Available', too_short: 'Too short', busy: 'Busy', shared: 'Shared pool' } as Record<string, string>)[value] ?? value}</span>; }
