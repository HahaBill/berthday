import type { Cell, Color, Workbook, Worksheet } from 'exceljs';
import { daysInMonth, diffDays } from './dates';
import type { ImportDiagnostic, ImportReservationRow, ImportVesselRow, ParsedImportFile } from './import-types';
import type { BerthDTO } from './types';

export const MAX_WORKBOOK_BYTES = 25 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 100 * 1024 * 1024;
const MAX_SHEETS = 500;
const MAX_CELLS = 1_000_000;
const MAX_ROWS = 100_000;
const MAX_COLUMNS = 512;
const MAX_RECORDS = 100_000;
const MAX_DIAGNOSTICS = 2_000;
const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
const WEEKDAYS = new Set(['M', 'T', 'W', 'TR', 'TH', 'F', 'S', 'SA', 'SU']);
const BERTH = /^(.+?)\s*-\s*(\d+)\s*'\s*$/;
const VESSEL = /^(R\/V|M\/V|S\/V|S\/Y|M\/Y|OSV|OS\/V|F\/V|TUG|BARGE)\s+(.+)$/i;
const ANNOTATION = /^(ETA|ETD|ARRIVAL|ARRIVES|DEPARTURE|DEPARTS|DELAYED|TOUCH AND GO|PROVISIONING|FUELING|FUEL TRUCK|BUNKERING|LOAD EQUIPMENT)\b/i;
const CLOSURE = /REPAIR|MAINTENANCE|REBUILD|NO DOCKING|NO USAGE|INSPECTION|\bTEST\b|REPLACEMENT|UTILITY WORK|PAVING|CONCRETE/i;
const POOLS = [
  ['NORTH FINGER PIERS', 'north-finger-piers', 'North Finger Piers'],
  ['SMALL CRAFT SLIPS', 'small-craft-slips', 'Small craft slips (institution boats)'],
];
const BACKGROUND = new Set(['FFFFFF', 'F2F2F2', 'D9D9D9']);
const THEME_ORDER = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
const INDEXED = ('000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF 000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF ' +
  '800000 008000 000080 808000 800080 008080 C0C0C0 808080 9999FF 993366 FFFFCC CCFFFF 660066 FF8080 0066CC CCCCCC ' +
  '000080 FF00FF FFFF00 00FFFF 800080 800000 008080 0000FF 00CCFF CCFFFF CCFFCC FFFF99 99CCFF FF99CC CC99FF FFCC99 ' +
  '3366FF 33CCCC 99CC00 FFCC00 FF9900 FF6600 666699 969696 003366 339966 003300 333300 993300 993366 333399 333333').split(' ');

export class WorkbookImportError extends Error {
  constructor(public readonly code: string, message: string, public readonly diagnostics: ImportDiagnostic[] = []) {
    super(message);
    this.name = 'WorkbookImportError';
  }
}

function fail(code: string, message: string): never { throw new WorkbookImportError(code, message); }
const norm = (value: string) => value.replace(/\s+/g, ' ').trim();
const key = (value: string) => norm(value).toUpperCase();
const slug = (value: string) => value.toLowerCase().replaceAll('/', '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const textValue = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && !value.startsWith('=');
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function colName(value: number): string {
  let result = '';
  while (value > 0) { value--; result = String.fromCharCode(65 + value % 26) + result; value = Math.floor(value / 26); }
  return result;
}
function coordinates(address: string): { row: number; col: number } | null {
  const m = /^\$?([A-Z]+)\$?(\d+)$/i.exec(address);
  if (!m) return null;
  return { row: Number(m[2]), col: [...m[1].toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) };
}
function bounds(ref: string) {
  const parts = ref.split(':');
  const first = coordinates(parts[0]), last = coordinates(parts[1] ?? parts[0]);
  if (!first || !last || first.row < 1 || first.col < 1 || last.row < first.row || last.col < first.col) {
    fail('INVALID_WORKBOOK', 'The workbook contains an invalid cell range.');
  }
  return { minRow: first.row, maxRow: last.row, minCol: first.col, maxCol: last.col };
}

/** Validate ZIP sizes before decompression; XLSX is never allowed to expand without a bound. */
function checkZip(buffer: ArrayBuffer): void {
  if (!buffer.byteLength || buffer.byteLength > MAX_WORKBOOK_BYTES) fail('FILE_TOO_LARGE', 'Choose an Excel workbook no larger than 25 MB.');
  const view = new DataView(buffer);
  if (view.byteLength < 22 || view.getUint32(0, true) !== 0x04034b50) fail('INVALID_WORKBOOK', 'This file is not a valid .xlsx workbook.');
  let end = -1;
  for (let i = view.byteLength - 22; i >= Math.max(0, view.byteLength - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === view.byteLength) { end = i; break; }
  }
  if (end < 0) fail('INVALID_WORKBOOK', 'The workbook ZIP directory is missing or damaged.');
  const entries = view.getUint16(end + 10, true);
  let pos = view.getUint32(end + 16, true), total = 0;
  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0 || entries === 0xffff || entries > 10_000 || pos === 0xffffffff) {
    fail('WORKBOOK_TOO_COMPLEX', 'This workbook uses an unsupported ZIP layout or contains too many parts.');
  }
  for (let i = 0; i < entries; i++) {
    if (pos + 46 > end || view.getUint32(pos, true) !== 0x02014b50) fail('INVALID_WORKBOOK', 'The workbook ZIP directory is damaged.');
    const size = view.getUint32(pos + 24, true);
    if (view.getUint16(pos + 8, true) & 1) fail('ENCRYPTED_WORKBOOK', 'Save an unencrypted .xlsx copy before importing.');
    total += size;
    if (size === 0xffffffff || total > MAX_EXPANDED_BYTES) fail('WORKBOOK_TOO_COMPLEX', 'This workbook expands beyond the 100 MB import limit.');
    pos += 46 + view.getUint16(pos + 28, true) + view.getUint16(pos + 30, true) + view.getUint16(pos + 32, true);
  }
  if (pos > end) fail('INVALID_WORKBOOK', 'The workbook ZIP directory is damaged.');
}

/** Check the XML before ExcelJS instantiates cells, especially huge sparse merges. */
async function preflight(buffer: ArrayBuffer): Promise<void> {
  checkZip(buffer);
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(buffer);
  if (!zip.file('xl/workbook.xml')) fail('INVALID_WORKBOOK', 'This file does not contain an Excel workbook.');
  const sheets = Object.keys(zip.files).filter(name => /^xl\/worksheets\/[^/]+\.xml$/i.test(name));
  if (sheets.length > MAX_SHEETS) fail('WORKBOOK_TOO_COMPLEX', 'A workbook can contain up to 500 worksheets.');
  let cellCount = 0, mergedCells = 0, scannedCells = 0;
  for (const name of sheets) {
    const xml = await zip.file(name)!.async('string');
    let maxRow = 0, maxCol = 0;
    for (const match of xml.matchAll(/<(?:\w+:)?c\b[^>]*\br=["']([^"']+)["']/g)) {
      const pos = coordinates(match[1]);
      if (!pos || pos.row > MAX_ROWS || pos.col > MAX_COLUMNS) fail('WORKBOOK_TOO_COMPLEX', 'Worksheet cells must be within 100,000 rows and 512 columns.');
      maxRow = Math.max(maxRow, pos.row); maxCol = Math.max(maxCol, pos.col);
      if (++cellCount > MAX_CELLS) fail('WORKBOOK_TOO_COMPLEX', 'The workbook contains more than one million cells.');
    }
    for (const match of xml.matchAll(/<(?:\w+:)?mergeCell\b[^>]*\bref=["']([^"']+)["']/g)) {
      const range = bounds(match[1]);
      if (range.maxRow > MAX_ROWS || range.maxCol > MAX_COLUMNS) fail('WORKBOOK_TOO_COMPLEX', 'A merged range extends beyond the supported worksheet size.');
      mergedCells += (range.maxRow - range.minRow + 1) * (range.maxCol - range.minCol + 1);
      if (mergedCells > MAX_CELLS) fail('WORKBOOK_TOO_COMPLEX', 'Merged ranges cover more than one million cells.');
      maxRow = Math.max(maxRow, range.maxRow); maxCol = Math.max(maxCol, range.maxCol);
    }
    scannedCells += maxRow * maxCol;
    if (scannedCells > 5_000_000) fail('WORKBOOK_TOO_COMPLEX', 'The workbook has too many widely spaced cells. Split it into smaller workbooks.');
  }
}

function ownValue(cell: Cell): unknown {
  if (cell.isMerged && cell.master.address !== cell.address) return null;
  const value = cell.value;
  if (value && typeof value === 'object') {
    if ('formula' in value || 'sharedFormula' in value) return '=' + ('formula' in value ? value.formula : value.sharedFormula);
    if ('richText' in value) return value.richText.map(part => part.text).join('');
    if ('text' in value) return value.text;
  }
  return value;
}
function titleCase(value: string): string {
  // Match Python str.title, including words following apostrophes, digits, and slashes.
  return value.toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (_, before: string, char: string) => before + char.toUpperCase());
}
function vesselDisplay(value: string): string {
  const match = VESSEL.exec(value);
  if (!match) return titleCase(value);
  const prefix = match[1].toUpperCase();
  return `${prefix === 'TUG' ? 'Tug' : prefix === 'BARGE' ? 'Barge' : prefix} ${titleCase(match[2])}`;
}
function tint(rgb: string, amount: number): string {
  if (!amount) return rgb;
  const [r, g, b] = [0, 2, 4].map(i => parseInt(rgb.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  let lum = (max + min) / 2, h = 0, s = 0;
  if (delta) {
    s = lum <= 0.5 ? delta / (max + min) : delta / (2 - max - min);
    h = (max === r ? (g - b) / delta : max === g ? 2 + (b - r) / delta : 4 + (r - g) / delta) / 6;
    h = (h + 1) % 1;
  }
  lum = Math.min(1, Math.max(0, amount < 0 ? lum * (1 + amount) : lum * (1 - amount) + amount));
  const m2 = lum <= 0.5 ? lum * (1 + s) : lum + s - lum * s, m1 = 2 * lum - m2;
  const channel = (hue: number) => {
    hue = (hue + 1) % 1;
    const n = s === 0 ? lum : hue < 1 / 6 ? m1 + (m2 - m1) * hue * 6 : hue < 0.5 ? m2 : hue < 2 / 3 ? m1 + (m2 - m1) * (2 / 3 - hue) * 6 : m1;
    const scaled = n * 255, floor = Math.floor(scaled);
    const rounded = scaled - floor === 0.5 ? floor + floor % 2 : Math.round(scaled);
    return rounded.toString(16).padStart(2, '0').toUpperCase();
  };
  return channel(h + 1 / 3) + channel(h) + channel(h - 1 / 3);
}
function paletteFor(workbook: Workbook): string[] {
  const themes = workbook.model.themes as unknown as Record<string, string> | undefined;
  const xml = themes?.theme1 ?? Object.values(themes ?? {})[0];
  if (!xml) return [];
  return THEME_ORDER.map(name => {
    const body = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`).exec(xml)?.[1] ?? '';
    return (/\blastClr=["']([0-9a-fA-F]{6})["']/.exec(body)?.[1] ?? /\bval=["']([0-9a-fA-F]{6})["']/.exec(body)?.[1] ?? '000000').toUpperCase();
  });
}
function fillFor(cell: Cell, palette: string[]): string | null {
  const fill = cell.fill;
  if (!fill || fill.type !== 'pattern' || fill.pattern !== 'solid') return null;
  const color = fill.fgColor as (Partial<Color> & { tint?: number; indexed?: number }) | undefined;
  if (!color) return null;
  let rgb: string | undefined;
  if (typeof color.argb === 'string') rgb = color.argb.slice(-6).toUpperCase();
  else if (typeof color.theme === 'number' && palette[color.theme]) rgb = tint(palette[color.theme], color.tint ?? 0);
  else if (typeof color.indexed === 'number' && color.indexed < 64) rgb = INDEXED[color.indexed];
  return !rgb || BACKGROUND.has(rgb) ? null : rgb;
}

interface Resource { name: string; length: number | null; exclusive: boolean }
interface Segment {
  berthId: string; lane: number; start: string; end: string; labelKey: string | null; rawLabel: string | null;
  fill: string | null; sources: string[]; notes: string[]; mergeId: string | null;
}
interface Anchor { row: number; col: number; id: string; minCol: number; maxCol: number }
interface VesselReference { length: number; status: 'known' | 'disputed'; note: string | null; source: string }

class Extractor {
  private diagnostics: ImportDiagnostic[] = [];
  private omittedDiagnostics = 0;
  private resources = new Map<string, Resource>();
  private segments: Segment[] = [];
  private carryovers = new Map<string, Segment[]>();
  private byMonth = new Map<string, Segment[]>();
  private palette: string[];
  private parsedSheets: string[] = [];
  private skippedSheets: string[] = [];
  private catalogue: Map<string, BerthDTO>;
  private unknownResources = new Set<string>();
  constructor(private workbook: Workbook, berths: readonly BerthDTO[], private progress?: (message: string) => void) {
    this.palette = paletteFor(workbook);
    this.catalogue = new Map(berths.filter(berth => berth.id !== 'unassigned').map(berth => [key(berth.name), berth]));
  }
  private issue(code: string, severity: ImportDiagnostic['severity'], message: string, sheet?: string, cell?: string) {
    if (this.diagnostics.length >= MAX_DIAGNOSTICS) { this.omittedDiagnostics++; return; }
    this.diagnostics.push({ code, severity, message, ...(sheet ? { sheet } : {}), ...(cell ? { cell } : {}) });
  }
  private isResource(value: unknown): value is string {
    return textValue(value) && (BERTH.test(norm(value)) || this.catalogue.has(key(value)) || POOLS.some(([prefix]) => key(value).startsWith(prefix)));
  }
  private resource(value: unknown, sheet: string, row: number): string | null {
    if (!this.isResource(value)) return null;
    const text = norm(value), match = BERTH.exec(text);
    if (match) {
      const name = match[1].trim(), length = Number(match[2]), catalogued = this.catalogue.get(key(name));
      const id = catalogued?.id ?? slug(name), known = this.resources.get(id);
      if (!known) this.resources.set(id, { name: catalogued?.name ?? name, length: catalogued ? catalogued.lengthFt : length, exclusive: catalogued?.isExclusive ?? true });
      else if (known.length !== length) this.issue('BERTH_LENGTH_CHANGED', 'warn', `${name} labelled ${length}' here but ${known.length}' earlier`, sheet, `A${row}`);
      if (catalogued?.isExclusive && catalogued.lengthFt !== length && !known) this.issue('BERTH_LENGTH_CHANGED', 'warn', `${name} is labelled ${length}' here; the app resource is ${catalogued.lengthFt}' and will be used for fit checks.`, sheet, `A${row}`);
      if (this.catalogue.size && !catalogued && !this.unknownResources.has(id)) {
        this.unknownResources.add(id);
        this.issue('RESOURCE_NOT_FOUND', 'error', `Resource '${name}' is not in the app. Add this resource before importing its bookings.`, sheet, `A${row}`);
      }
      return id;
    }
    const catalogued = this.catalogue.get(key(text));
    if (catalogued) {
      this.resources.set(catalogued.id, { name: catalogued.name, length: catalogued.lengthFt, exclusive: catalogued.isExclusive });
      return catalogued.id;
    }
    const pool = POOLS.find(([prefix]) => key(text).startsWith(prefix))!;
    this.resources.set(pool[1], { name: pool[2], length: null, exclusive: false });
    return pool[1];
  }
  private blockRows(ws: Worksheet, headerRow: number, lastRow: number, header: string): [number, string, number][] {
    const rows: [number, string, number][] = [], lanes = new Map<string, number>();
    const columns = ws.columnCount;
    let lastId: string | null = null;
    for (let row = headerRow + 1; row <= lastRow; row++) {
      const label = ownValue(ws.getCell(row, 1));
      let id = this.resource(label, ws.name, row);
      const texts: string[] = [];
      for (let col = 2; col <= columns; col++) { const value = ownValue(ws.getCell(row, col)); if (textValue(value)) texts.push(norm(value)); }
      if (id !== null) lastId = id;
      else if (textValue(label)) {
        // Unknown shared-resource names have no length suffix. Surface plausible bookings
        // rather than letting those rows disappear as ordinary notes or headings.
        if (this.catalogue.size && texts.some(text => !ANNOTATION.test(text))) {
          let hasBookingContent = texts.some(text => VESSEL.test(text) || CLOSURE.test(text));
          for (let col = 2; col <= columns && !hasBookingContent; col++) {
            const cell = ws.getCell(row, col), value = ownValue(cell);
            hasBookingContent = textValue(value) && !ANNOTATION.test(value) && (cell.isMerged || fillFor(cell, this.palette) !== null);
          }
          if (hasBookingContent) {
            // Following unlabelled lanes must not inherit a different resource above this one.
            lastId = null;
            if (!this.unknownResources.has(key(label))) {
              this.unknownResources.add(key(label));
              this.issue('RESOURCE_NOT_FOUND', 'error', `Row '${norm(label)}' contains booking content but is not a known resource. Add this resource before importing; this row and its unlabelled lanes were skipped.`, ws.name, `A${row}`);
            }
          }
        }
        continue;
      } else if (lastId === null) continue;
      else if (!texts.some(text => !ANNOTATION.test(text))) {
        if (texts.length) this.issue('NOTE_ROW', 'info', `Row of notes in '${header}' not tied to a berth: ${texts.join('; ').slice(0, 160)}`, ws.name, `A${row}`);
        continue;
      } else if (!this.resources.get(lastId)!.exclusive) {
        id = lastId;
        this.issue('UNLABELLED_POOL_ROW', 'info', `Unlabelled row under ${this.resources.get(id)!.name} in '${header}'; imported as part of that shared resource`, ws.name, `A${row}`);
      } else {
        id = 'unassigned';
        this.resources.set(id, { name: 'Unassigned (legacy rows)', length: null, exclusive: false });
        this.issue('UNLABELLED_ROW', 'warn', `Row with no berth label under ${this.resources.get(lastId)!.name} in '${header}' holds bookings (${texts.join('; ').slice(0, 120)}); imported to 'Unassigned (legacy rows)' for review.`, ws.name, `A${row}`);
      }
      const lane = lanes.get(id) ?? 0;
      lanes.set(id, lane + 1);
      if (lane > 0 && this.resources.get(id)!.exclusive) this.issue('DUPLICATE_BERTH_ROW', 'warn', `${this.resources.get(id)!.name} has ${lane + 1} rows in '${header}'; bookings on the extra row are imported as the same berth`, ws.name, `A${row}`);
      rows.push([row, id, lane]);
    }
    return rows;
  }
  private dayOne(ws: Worksheet, headerRow: number, firstRow: number, header: string, year: number, month: number): [number | null, number] {
    const votes = new Map<number, number>(), labels = new Map<number, number>();
    const columns = ws.columnCount;
    let junk = 0, formulas = 0;
    for (let row = Math.max(1, headerRow - 1); row < firstRow; row++) {
      if (row < headerRow && this.isResource(ownValue(ws.getCell(row, 1)))) continue;
      for (let col = 2; col <= columns; col++) {
        const value = ownValue(ws.getCell(row, col));
        const n = typeof value === 'number' ? Math.trunc(value) : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : null;
        if (typeof value === 'string' && value.startsWith('=')) formulas++;
        else if (n !== null && n >= 1 && n <= 31 && col - n + 1 >= 2 && col - n + 1 <= 12) {
          votes.set(col - n + 1, (votes.get(col - n + 1) ?? 0) + 1); labels.set(col, n);
        } else if (textValue(value) && !WEEKDAYS.has(key(value)) && (row === headerRow || row === headerRow + 1)) junk++;
      }
    }
    if (!votes.size) {
      this.issue('NO_DAY_HEADER', 'error', `No day numbers found for '${header}'; block skipped`, ws.name, `A${headerRow}`);
      return [null, formulas];
    }
    const ranked = [...votes].sort((a, b) => b[1] - a[1]), day1 = ranked[0][0];
    if (ranked.length > 1) this.issue('HEADER_DAY_CONFLICT', 'warn', `Day numbers around '${header}' disagree on where day 1 is (${ranked.map(([col, count]) => `column ${colName(col)} (${count} labels)`).join(', ')}); used column ${colName(day1)}`, ws.name, `A${headerRow}`);
    if (junk) this.issue('HEADER_ROW_TEXT', 'warn', `${junk} text cells sit in the day/weekday rows of '${header}'; ignored`, ws.name, `A${headerRow}`);
    const count = daysInMonth(year, month), agreed = [...labels].filter(([col, n]) => col - n + 1 === day1).map(([, n]) => n), invalid = agreed.filter(n => n > count).sort((a, b) => a - b);
    if (invalid.length) this.issue('HEADER_INVALID_DAY', 'warn', `'${header}' lists day(s) [${invalid.join(', ')}] but the month has ${count} days; cells under those columns are not imported`, ws.name, `A${headerRow}`);
    if (agreed.length >= 20 && Math.max(...agreed) < count) this.issue('HEADER_MISSING_DAY', 'warn', `'${header}' stops at day ${Math.max(...agreed)} of ${count}; dates derived from column position`, ws.name, `A${headerRow}`);
    return [day1, formulas];
  }
  private parseRow(ws: Worksheet, row: number, berthId: string, lane: number, year: number, month: number, day1: number, anchors: Map<string, Anchor>): Segment[] {
    const segments: Segment[] = [], count = daysInMonth(year, month);
    const columns = ws.columnCount;
    let current: Segment | null = null;
    const close = () => { if (current) segments.push(current); current = null; };
    for (let col = 2; col <= columns; col++) {
      const coord = `${colName(col)}${row}`, anchor = anchors.get(coord), source = ws.getCell(anchor?.row ?? row, anchor?.col ?? col);
      const value = ownValue(source), fill = fillFor(source, this.palette), mergeId = anchor?.id ?? null, day = col - day1 + 1;
      if (day < 1 || day > count) {
        const own = ownValue(ws.getCell(row, col));
        if (textValue(own) && !(anchor && anchor.minCol <= day1 + count - 1 && anchor.maxCol >= day1)) {
          this.issue(day < 1 ? 'PRE_GRID_LABEL' : 'OUT_OF_RANGE_TEXT', day < 1 ? 'info' : 'warn', `'${norm(own)}' sits ${day < 1 ? 'left of day 1' : 'past the last day'} of ${titleCase(MONTHS[month - 1])} ${year}; not imported as a booking`, ws.name, coord);
        }
        continue;
      }
      const date = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const text = textValue(value) ? norm(value) : null, adjacent = current !== null && diffDays(current.end, date) === 1;
      const sameMerge = adjacent && mergeId !== null && mergeId === current!.mergeId;
      if (text && ANNOTATION.test(text)) {
        const note = `${text} (${ws.name}!${coord})`;
        if (adjacent && (fill === null || fill === current!.fill || sameMerge)) { current!.end = date; current!.notes.push(note); }
        else if (fill !== null) { close(); current = { berthId, lane, start: date, end: date, labelKey: null, rawLabel: null, fill, sources: [`${ws.name}!${coord}`], notes: [note], mergeId }; }
        else { close(); this.issue('ORPHAN_NOTE', 'info', `Note '${text}' is not attached to any booking`, ws.name, coord); }
        continue;
      }
      if (text) {
        const labelKey = key(text);
        if (sameMerge || (adjacent && current!.labelKey === labelKey && (fill === current!.fill || fill === null || current!.fill === null))) {
          current!.end = date; current!.mergeId = mergeId ?? current!.mergeId;
        } else if (adjacent && current!.labelKey === null && current!.fill !== null && fill === current!.fill) {
          current!.labelKey = labelKey; current!.rawLabel = text; current!.end = date; current!.mergeId = mergeId ?? current!.mergeId; current!.sources.push(`${ws.name}!${coord}`);
        } else { close(); current = { berthId, lane, start: date, end: date, labelKey, rawLabel: text, fill, sources: [`${ws.name}!${coord}`], notes: [], mergeId }; }
        continue;
      }
      if (fill !== null) {
        if (adjacent && (fill === current!.fill || sameMerge)) current!.end = date;
        else { close(); current = { berthId, lane, start: date, end: date, labelKey: null, rawLabel: null, fill, sources: [`${ws.name}!${coord}`], notes: [], mergeId }; }
        continue;
      }
      if (sameMerge) { current!.end = date; continue; }
      close();
    }
    close();
    for (const segment of segments) {
      const first = segment.sources[0].split('!')[1], last = `${colName(day1 + Number(segment.end.slice(8)) - 1)}${row}`;
      if (first !== last) segment.sources[0] = `${ws.name}!${first}:${last}`;
    }
    return segments;
  }
  private parseSheet(ws: Worksheet): void {
    const year = Number(ws.name);
    if (year < 1 || year > 9999) { this.skippedSheets.push(ws.name); this.issue('INVALID_YEAR_SHEET', 'error', 'Annual sheet names must be years from 1 to 9999.', ws.name); return; }
    const anchors = new Map<string, Anchor>();
    for (const ref of ws.model.merges) {
      const b = bounds(ref), anchor = { row: b.minRow, col: b.minCol, id: `${ws.name}!${ref}`, minCol: b.minCol, maxCol: b.maxCol };
      for (let row = b.minRow; row <= b.maxRow; row++) for (let col = b.minCol; col <= b.maxCol; col++) anchors.set(`${colName(col)}${row}`, anchor);
    }
    const headers: { row: number; month: number; text: string }[] = [];
    for (let row = 1; row <= ws.rowCount; row++) {
      const value = ownValue(ws.getCell(row, 1));
      if (typeof value === 'string') { const i = MONTHS.findIndex(month => key(value).startsWith(month)); if (i >= 0) headers.push({ row, month: i + 1, text: norm(value) }); }
    }
    if (!headers.length) { this.skippedSheets.push(ws.name); this.issue('NO_MONTH_HEADERS', 'warn', 'No month headers were found in column A; sheet skipped.', ws.name); return; }
    this.parsedSheets.push(ws.name);
    let formulas = 0;
    for (const [index, header] of headers.entries()) {
      const endRow = headers[index + 1] ? headers[index + 1].row - 1 : ws.rowCount;
      const matchedYear = /\d{4}/.exec(header.text), headerYear = matchedYear ? Number(matchedYear[0]) : null;
      let carry = false, blockYear = year;
      if (headerYear !== null && headerYear !== year) {
        if (header.month === 12 && headerYear === year - 1 && index === 0 && year > 1) { carry = true; blockYear = year - 1; }
        else this.issue('HEADER_YEAR_MISMATCH', 'warn', `Header '${header.text}' in sheet ${ws.name}; used ${year} from the sheet name`, ws.name, `A${header.row}`);
      }
      const rows = this.blockRows(ws, header.row, endRow, header.text);
      if (!rows.length) continue;
      const [day1, nFormulas] = this.dayOne(ws, header.row, rows[0][0], header.text, blockYear, header.month);
      formulas += nFormulas;
      if (day1 === null) continue;
      const monthKey = `${blockYear}-${header.month}`;
      for (const [row, id, lane] of rows) {
        const segments = this.parseRow(ws, row, id, lane, blockYear, header.month, day1, anchors);
        if (carry) this.carryovers.set(monthKey, [...this.carryovers.get(monthKey) ?? [], ...segments]);
        else {
          this.segments.push(...segments);
          this.byMonth.set(monthKey, [...this.byMonth.get(monthKey) ?? [], ...segments]);
          if (this.segments.length > MAX_RECORDS) fail('TOO_MANY_RECORDS', 'The workbook contains more than 100,000 booking segments. Split it into smaller workbooks.');
        }
      }
    }
    if (formulas) this.issue('DAY_NUMBERS_ARE_FORMULAS', 'info', `${formulas} day-number cells are formulas; dates derived from column offsets`, ws.name);
  }
  private compareCarryovers(): void {
    const segmentKey = (s: Segment) => JSON.stringify([s.berthId, s.lane, s.start, s.end, s.labelKey]);
    for (const [month, copies] of this.carryovers) {
      const year = Number(month.split('-')[0]), sheet = String(year + 1);
      if (!this.byMonth.has(month)) {
        this.segments.push(...copies);
        if (this.segments.length > MAX_RECORDS) fail('TOO_MANY_RECORDS', 'The workbook contains more than 100,000 booking segments. Split it into smaller workbooks.');
        this.issue('CARRYOVER_ORIGINAL_MISSING', 'warn', `Sheet ${sheet} repeats December ${year}, but the original month is not present in this workbook. The copied bookings were retained with their source references.`, sheet);
        continue;
      }
      const originals = new Set((this.byMonth.get(month) ?? []).map(segmentKey)), duplicates = new Set(copies.map(segmentKey));
      const added = [...duplicates].filter(value => !originals.has(value)).length, removed = [...originals].filter(value => !duplicates.has(value)).length;
      if (!added && !removed) this.issue('CARRYOVER_DUPLICATE', 'info', `Sheet ${sheet} repeats December ${year}; identical copy skipped`, sheet);
      else this.issue('CARRYOVER_MISMATCH', 'warn', `Sheet ${sheet} repeats December ${year} but disagrees with sheet ${year} (${added} bookings only in the copy, ${removed} only in the original). Copy skipped; sheet ${year} is the source of truth.`, sheet);
    }
  }
  private stitch(): Segment[] {
    const result: Segment[] = [];
    for (const segment of this.segments.sort((a, b) => compare(a.berthId, b.berthId) || a.lane - b.lane || compare(a.start, b.start))) {
      const previous = result[result.length - 1];
      if (previous && previous.berthId === segment.berthId && previous.lane === segment.lane && diffDays(previous.end, segment.start) === 1) {
        const sameLabel = segment.labelKey !== null && segment.labelKey === previous.labelKey;
        const colorContinues = segment.labelKey === null && segment.fill !== null && segment.fill === previous.fill && segment.start.endsWith('-01');
        if (sameLabel || colorContinues) { previous.end = segment.end; previous.sources.push(...segment.sources); previous.notes.push(...segment.notes); continue; }
      }
      result.push(segment);
    }
    return result;
  }
  private references(): Map<string, VesselReference> {
    const found = new Map<string, { length: number; source: string }[]>();
    for (const name of ['Science', 'Yachts']) {
      const ws = this.workbook.worksheets.find(sheet => key(sheet.name) === name.toUpperCase());
      if (!ws) continue;
      const columns = ws.columnCount;
      for (let row = 1; row <= ws.rowCount; row++) {
        const value = ownValue(ws.getCell(row, 1));
        if (!textValue(value)) continue;
        const text = norm(value);
        if (key(text).startsWith('LOA:')) { this.issue('ORPHAN_SPEC_ROW', 'warn', `Specification '${text}' has no vessel name on its row; not attached`, ws.name, `A${row}`); continue; }
        const match = /^(.*?)\s+(\d+)\s*'$/.exec(text);
        if (!match || !VESSEL.test(match[1])) continue;
        const vesselKey = key(match[1]), candidates = found.get(vesselKey) ?? [];
        candidates.push({ length: Number(match[2]), source: `${ws.name}!A${row}` });
        for (let col = 2; col <= columns; col++) {
          const value = ownValue(ws.getCell(row, col)), loa = typeof value === 'string' ? /LOA:\s*(\d+)\s*'/.exec(value) : null;
          if (loa && Number(loa[1]) !== Number(match[2])) candidates.push({ length: Number(loa[1]), source: `${ws.name}!${colName(col)}${row}` });
        }
        found.set(vesselKey, candidates);
      }
    }
    const result = new Map<string, VesselReference>();
    for (const [vesselKey, candidates] of found) {
      const lengths = [...new Set(candidates.map(c => c.length))], listing = candidates.map(c => `${c.length}' (${c.source})`).join(', '), disputed = lengths.length > 1;
      if (disputed) { const [sheet, cell] = candidates[0].source.split('!'); this.issue('VESSEL_LENGTH_DISPUTED', 'warn', `${vesselDisplay(vesselKey)} has conflicting lengths: ${listing}; the larger value is used for fit checks`, sheet, cell); }
      result.set(vesselKey, { length: Math.max(...lengths), status: disputed ? 'disputed' : 'known', note: disputed ? `Disputed: ${listing}` : null, source: candidates.map(c => c.source).join(', ') });
    }
    return result;
  }
  build(): ParsedImportFile {
    const annual = this.workbook.worksheets.filter(ws => /^\d+$/.test(ws.name)).sort((a, b) => Number(a.name) - Number(b.name));
    for (const [index, sheet] of annual.entries()) { this.progress?.(`Reading annual sheet ${sheet.name} (${index + 1} of ${annual.length})`); this.parseSheet(sheet); }
    this.compareCarryovers();
    for (const ws of this.workbook.worksheets) if (!/^\d+$/.test(ws.name)) {
      this.skippedSheets.push(ws.name); this.issue('SHEET_NOT_IMPORTED', 'info', `Sheet '${ws.name}' is reference/reporting data`, ws.name);
    }
    const segments = this.stitch(), references = this.references(), vessels = new Map<string, ImportVesselRow>();
    const vesselFor = (vesselKey: string): ImportVesselRow => {
      let vessel = vessels.get(vesselKey);
      if (!vessel) {
        const reference = references.get(vesselKey);
        vessel = { recordType: 'vessel', vesselName: vesselDisplay(vesselKey), vesselLengthFt: reference?.length ?? null, vesselLengthStatus: reference?.status ?? 'unknown', vesselLengthNote: reference?.note ?? null, sourceRef: reference?.source ?? 'schedule only' };
        vessels.set(vesselKey, vessel);
      }
      return vessel;
    };
    for (const vesselKey of [...references.keys()].sort(compare)) vesselFor(vesselKey);
    const reservations: ImportReservationRow[] = segments.map(segment => {
      const kind = segment.labelKey === null ? 'hold' : VESSEL.test(segment.labelKey) ? 'vessel' : CLOSURE.test(segment.labelKey) ? 'closure' : 'event';
      const vessel = kind === 'vessel' ? vesselFor(segment.labelKey!) : null;
      const reservation: ImportReservationRow = {
        recordType: 'reservation', berthId: segment.berthId, kind,
        ...(vessel ? { vesselName: vessel.vesselName, vesselLengthFt: vessel.vesselLengthFt, vesselLengthStatus: vessel.vesselLengthStatus, vesselLengthNote: vessel.vesselLengthNote } : { title: kind === 'hold' ? 'Unlabelled block' : segment.rawLabel }),
        startDate: segment.start, endDate: segment.end, notes: segment.notes.join('; ') || null, sourceRef: segment.sources.join('; '),
      };
      if (kind === 'hold') { const [sheet, cell] = segment.sources[0].split('!'); this.issue('UNLABELLED_BLOCK', 'info', `Coloured cells with no name on ${this.resources.get(segment.berthId)!.name} ${segment.start}..${segment.end}; imported as a hold`, sheet, cell); }
      return reservation;
    });
    reservations.sort((a, b) => compare(a.startDate, b.startDate) || compare(a.berthId, b.berthId) || compare(a.sourceRef ?? '', b.sourceRef ?? ''));
    const registry = [...vessels].sort(([a], [b]) => compare(a, b)).map(([, vessel]) => vessel);
    if (registry.length + reservations.length > MAX_RECORDS) fail('TOO_MANY_RECORDS', 'The workbook contains more than 100,000 records. Split it into smaller workbooks.');
    const unknown = registry.filter(v => v.vesselLengthStatus === 'unknown').length;
    this.issue('VESSEL_LENGTH_UNKNOWN', 'info', `${unknown} vessels have no length in Science/Yachts; their bookings show 'fit unverified' until someone enters a length`);
    if (this.workbook.getWorksheet('8YR Dock Summary')) this.issue('SUMMARY_NOT_IMPORTED', 'info', 'Summary totals are not imported as bookings. Annual schedule rows are the source of booking dates.', '8YR Dock Summary');
    if (!reservations.length) this.issue('NO_BOOKINGS_FOUND', 'error', 'No bookings were found. Use annual sheets named by year, month headers in column A, numeric day headings, and labelled berth rows.');
    if (this.omittedDiagnostics) this.diagnostics.push({ code: 'DIAGNOSTICS_TRUNCATED', severity: 'warn', message: `${this.omittedDiagnostics} additional diagnostics were omitted; only the first ${MAX_DIAGNOSTICS} are shown.` });
    if (!reservations.length && !registry.length) throw new WorkbookImportError('NO_BOOKINGS_FOUND', 'No bookings or vessel reference records were found in this workbook.', this.diagnostics);
    return { rows: [...registry, ...reservations], diagnostics: this.diagnostics, metadata: { sheetsParsed: this.parsedSheets.length, skippedSheets: this.skippedSheets, reservationCount: reservations.length, vesselCount: registry.length } };
  }
}

/** Same-layout legacy workbook parser. Run in a disposable Web Worker, never on the UI thread. */
export async function parseWorkbook(buffer: ArrayBuffer, filename: string, berths: readonly BerthDTO[] = [], onProgress?: (message: string) => void): Promise<ParsedImportFile> {
  if (!/\.(xlsx|xlsm)$/i.test(filename)) fail('UNSUPPORTED_FILE_TYPE', 'Choose a .xlsx or .xlsm file. Save older .xls workbooks as .xlsx first.');
  try {
    onProgress?.('Checking workbook size and structure');
    await preflight(buffer);
    onProgress?.('Opening workbook');
    const { default: ExcelJS } = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    if (workbook.worksheets.length > MAX_SHEETS) fail('WORKBOOK_TOO_COMPLEX', 'A workbook can contain up to 500 worksheets.');
    return new Extractor(workbook, berths, onProgress).build();
  } catch (error) {
    if (error instanceof WorkbookImportError) throw error;
    throw new WorkbookImportError('INVALID_WORKBOOK', 'The workbook could not be read. Open it in Excel and save a new .xlsx copy, then try again.');
  }
}
