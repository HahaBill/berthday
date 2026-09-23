import type { BerthDTO } from '../../shared/types';
import { Modal } from './UI';
import ResourceForm from './ResourceForm';

export default function ResourceDialog({ onClose, onCreated }: {
  onClose: () => void;
  onCreated?: (resource: BerthDTO) => void;
}) {
  return <Modal title="Add resource" onClose={onClose} className="resource-dialog">
    <ResourceForm variant="dialog" onCancel={onClose} onCreated={resource => { onCreated?.(resource); onClose(); }}/>
  </Modal>;
}
