import type { Kind, LengthStatus } from './types';

export interface ImportVesselFields {
  vesselName: string;
  vesselLengthFt?: number | null;
  vesselLengthStatus?: LengthStatus;
  vesselLengthNote?: string | null;
  sourceRef?: string;
}
export interface ImportReservationRow extends Partial<ImportVesselFields> {
  recordType?: 'reservation';
  kind: Kind;
  berthId: string;
  title?: string | null;
  startDate: string;
  endDate: string;
  notes?: string | null;
  sourceRef?: string;
}
export interface ImportVesselRow extends ImportVesselFields { recordType: 'vessel' }
export type ParsedImportRow = ImportReservationRow | ImportVesselRow;
export interface ImportDiagnostic {
  code: string;
  message: string;
  severity?: 'info' | 'warn' | 'error';
  sheet?: string;
  cell?: string;
}
export interface ParsedImportFile {
  rows: ParsedImportRow[];
  diagnostics: ImportDiagnostic[];
  metadata?: { sheetsParsed?: number; skippedSheets?: string[]; reservationCount?: number; vesselCount?: number };
}
export type ImportJobStatus = 'staging' | 'ready' | 'importing' | 'completed' | 'cancelled';
export type ImportFileStatus = 'staging' | 'staged' | 'importing' | 'completed' | 'duplicate' | 'cancelled';
export interface ImportJobDTO {
  id: string;
  name: string;
  status: ImportJobStatus;
  createdAt: string;
  updatedAt: string;
  fileCount: number;
  totalRows: number;
  stagedRows: number;
  processedRows: number;
  importedReservations: number;
  importedVessels: number;
  duplicateRows: number;
  invalidRows: number;
  issueCount: number;
  dateFrom: string | null;
  dateTo: string | null;
}
export interface ImportFileDTO {
  id: string;
  jobId: string;
  name: string;
  sha256: string;
  rowCount: number;
  stagedRows: number;
  processedRows: number;
  importedReservations: number;
  importedVessels: number;
  duplicateRows: number;
  invalidRows: number;
  status: ImportFileStatus;
  diagnostics: ImportDiagnostic[];
  duplicateOfFileId: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface ImportRowPreview {
  fileId: string;
  fileName: string;
  index: number;
  row: ParsedImportRow | null;
  error: string | null;
  status: 'staged' | 'imported' | 'duplicate' | 'invalid';
}
export interface ImportPreviewDTO {
  job: ImportJobDTO;
  rows: ImportRowPreview[];
  diagnostics: ImportDiagnostic[];
  message: string;
}
export interface ImportFilesPage { items: ImportFileDTO[]; total: number; offset: number; limit: number }
export interface ImportJobsPage { items: ImportJobDTO[]; nextCursor: string | null }
export interface ImportFileRegistration extends ImportFileDTO { duplicate: boolean }
export interface ImportStageResponse { job: ImportJobDTO; file: ImportFileDTO }
