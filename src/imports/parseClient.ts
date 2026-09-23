import type { ImportDiagnostic, ParsedImportFile } from '../../shared/import-types';
import type { BerthDTO } from '../../shared/types';

const MAX_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 90_000;
export interface ParseWorkbookOptions {
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  berths?: readonly BerthDTO[];
}
export class WorkbookParseError extends Error {
  constructor(public readonly code: string, message: string, public readonly diagnostics: ImportDiagnostic[] = []) {
    super(message); this.name = 'WorkbookParseError';
  }
}
type WorkerReply = { type: 'progress'; message: string } | { type: 'result'; result: ParsedImportFile } |
  { type: 'error'; code: string; message: string; diagnostics?: ImportDiagnostic[] };

/** The main thread never loads ExcelJS. Cancellation terminates parsing, including decompression. */
export function parseWorkbookFile(file: File, options: ParseWorkbookOptions = {}): Promise<ParsedImportFile> {
  return new Promise((resolve, reject) => {
    const { signal, onProgress } = options;
    if (signal?.aborted) { reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); return; }
    if (!/\.(xlsx|xlsm)$/i.test(file.name)) { reject(new WorkbookParseError('UNSUPPORTED_FILE_TYPE', 'Choose a .xlsx or .xlsm workbook.')); return; }
    if (!file.size || file.size > MAX_BYTES) { reject(new WorkbookParseError('FILE_TOO_LARGE', 'Choose a nonempty workbook no larger than 25 MB.')); return; }
    let worker: Worker | undefined, settled = false;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); worker?.terminate(); };
    const finish = (result: ParsedImportFile) => { if (!settled) { settled = true; cleanup(); resolve(result); } };
    const fail = (error: unknown) => { if (!settled) { settled = true; cleanup(); reject(error); } };
    const abort = () => fail(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => fail(new WorkbookParseError('PARSE_TIMEOUT', 'This workbook took more than 90 seconds to read. Split it into smaller workbooks and try again.')), TIMEOUT_MS);
    signal?.addEventListener('abort', abort, { once: true });
    onProgress?.('Reading workbook file');
    void file.arrayBuffer().then(buffer => {
      if (settled) return;
      worker = new Worker(new URL('../workers/workbook.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<WorkerReply>) => {
        if (settled) return;
        if (event.data.type === 'progress') onProgress?.(event.data.message);
        else if (event.data.type === 'result') finish(event.data.result);
        else fail(new WorkbookParseError(event.data.code, event.data.message, event.data.diagnostics));
      };
      worker.onerror = event => { event.preventDefault(); fail(new WorkbookParseError('WORKER_ERROR', 'The workbook reader stopped unexpectedly. Try again, or split the workbook into smaller files.')); };
      worker.onmessageerror = () => fail(new WorkbookParseError('WORKER_ERROR', 'The workbook reader returned an unreadable result.'));
      worker.postMessage({ buffer, filename: file.name, berths: options.berths ?? [] }, [buffer]);
    }).catch(error => fail(error instanceof WorkbookParseError ? error : new WorkbookParseError('READ_ERROR', 'The workbook file could not be read. Choose the file again.')));
  });
}
