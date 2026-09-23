import { parseWorkbook, WorkbookImportError } from '../../shared/import-workbook';
import type { BerthDTO } from '../../shared/types';

// This worker receives exactly one workbook and is discarded after completion or cancellation.
self.onmessage = async (event: MessageEvent<{ buffer: ArrayBuffer; filename: string; berths?: BerthDTO[] }>) => {
  try {
    const result = await parseWorkbook(event.data.buffer, event.data.filename, event.data.berths, message => self.postMessage({ type: 'progress', message }));
    self.postMessage({ type: 'result', result });
  } catch (error) {
    self.postMessage({
      type: 'error',
      code: error instanceof WorkbookImportError ? error.code : 'INVALID_WORKBOOK',
      message: error instanceof Error ? error.message : 'The workbook could not be read.',
      diagnostics: error instanceof WorkbookImportError ? error.diagnostics : [],
    });
  }
};
