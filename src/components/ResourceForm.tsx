import { useId, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BerthDTO } from '../../shared/types';
import { resourceCreateSchema, type ResourceCreate } from '../../shared/resource-schemas';
import { api } from '../api';
import { useApp } from '../context';
import Icon from './Icon';
import '../styles/resources.css';

export default function ResourceForm({ onCreated, onCancel, variant = 'inline' }: {
  onCreated?: (resource: BerthDTO) => void;
  onCancel?: () => void;
  variant?: 'inline' | 'dialog';
}) {
  const { notify } = useApp();
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [type, setType] = useState<'exclusive' | 'shared'>('exclusive');
  const [length, setLength] = useState('');
  const [validation, setValidation] = useState('');
  const nameInput = useRef<HTMLInputElement>(null);
  const typeName = useId();
  const create = useMutation({
    mutationFn: (input: ResourceCreate) => api<BerthDTO>('/berths', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: async resource => {
      client.setQueryData<{ items: BerthDTO[] }>(['berths', 'resources'], previous => previous
        ? { items: [...previous.items.filter(item => item.id !== resource.id), resource] } : undefined);
      await client.invalidateQueries();
      setName(''); setLength(''); setValidation('');
      notify(`${resource.name} added to the schedule.`);
      onCreated?.(resource);
      if (variant === 'inline') nameInput.current?.focus();
    },
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    if (create.isPending) return;
    const parsed = resourceCreateSchema.safeParse({ name, type, lengthFt: type === 'exclusive' ? Number(length) : null });
    if (!parsed.success) {
      setValidation(!name.trim() ? 'Enter a resource name.' : type === 'exclusive' && (!/^\d+$/.test(length) || Number(length) < 1 || Number(length) > 1000)
        ? 'Enter a whole-number length from 1 to 1,000 ft.' : parsed.error.issues[0].message);
      return;
    }
    setValidation(''); create.mutate(parsed.data);
  }
  const clearError = () => { setValidation(''); create.reset(); };

  return <form className={`resource-form${variant === 'dialog' ? ' resource-form-dialog' : ' card'}`} onSubmit={submit} aria-busy={create.isPending}>
    {variant === 'inline' ? <div className="resource-form-heading"><span className="resource-form-icon"><Icon name="plus" size={21}/></span><div><h2>Add resource</h2><p>Use the same name in your workbook.</p></div></div>
      : <p className="resource-dialog-intro">Add a dedicated berth or a shared resource to the schedule. Use the same name in your workbook.</p>}
    <fieldset disabled={create.isPending} className="resource-form-fields"><legend className="sr-only">New resource details</legend>
      <label className="field"><span>Resource name</span><input ref={nameInput} autoFocus={variant === 'dialog'} value={name} required maxLength={120} onChange={event => { setName(event.target.value); clearError(); }} placeholder="e.g. West floating dock" autoComplete="off"/></label>
      <fieldset className="resource-type-field"><legend>Resource type</legend>
        <label className={`resource-type-option${type === 'exclusive' ? ' selected' : ''}`}><input type="radio" name={typeName} value="exclusive" checked={type === 'exclusive'} onChange={() => { setType('exclusive'); clearError(); }}/><span><strong>Dedicated berth</strong><span>One booking at a time, with a length limit.</span></span></label>
        <label className={`resource-type-option${type === 'shared' ? ' selected' : ''}`}><input type="radio" name={typeName} value="shared" checked={type === 'shared'} onChange={() => { setType('shared'); clearError(); }}/><span><strong>Shared resource</strong><span>Multiple bookings, with no length limit.</span></span></label>
      </fieldset>
      {type === 'exclusive' && <label className="field"><span>Maximum vessel length (ft)</span><input type="number" min={1} max={1000} step={1} required value={length} onChange={event => { setLength(event.target.value); clearError(); }} placeholder="120"/><span className="resource-field-help">Vessels longer than this cannot make a new booking.</span></label>}
      {(validation || create.isError) && <p className="inline-error" role="alert">{validation || create.error?.message}</p>}
      <div className={`resource-form-actions${variant === 'dialog' ? ' resource-dialog-actions' : ''}`}>
        {onCancel && <button type="button" className="button" onClick={onCancel} disabled={create.isPending}>Cancel</button>}
        <button type="submit" className={`button primary${variant === 'inline' ? ' resource-save' : ''}`} disabled={create.isPending}>{create.isPending ? <><span className="spinner"/>Adding…</> : <><Icon name="plus" size={16}/>Add resource</>}</button>
      </div>
    </fieldset>
  </form>;
}
