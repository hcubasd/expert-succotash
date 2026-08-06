import { randomRotation, uniqueOrdered } from './colors';
import type { RawCell, RawTable } from './rawTable';
import { classifyColumns } from './schema';
import type { TableName } from './schema';

// A stratum column is stored dictionary-encoded: the distinct values once, in
// the order they were first seen, plus one integer code per row indexing into
// them. That single representation does three jobs at once -- it's compact
// (4 bytes a row regardless of whether the underlying value is a long string),
// it *is* the palette index the coloring model needs, so painting a cell is a
// lookup rather than a scan, and it's already numeric if a column ever has to
// drive a GPU attribute directly.
export type StratumColumn = {
  name: string;
  codes: Uint32Array;
  // Distinct values in first-seen order; codes index into this.
  dictionary: RawCell[];
  // Rolled once, here, so a column's hues stay put for as long as the file is
  // loaded instead of reshuffling every time it's clicked.
  rotation: number;
};

export type ValueColumn = {
  name: string;
  data: Float32Array;
  // NaN marks an absent cell -- a resource a stratum doesn't participate in
  // is permanently empty, which is not the same as zero.
  present: Uint8Array;
  min: number;
  max: number;
  rotation: number;
};

export type Table = {
  name: TableName;
  rowCount: number;
  strata: StratumColumn[];
  values: ValueColumn[];
};

function isNumericColumn(cells: RawCell[]): boolean {
  return cells.every(c => c === null || typeof c === 'number');
}

function makeStratum(name: string, cells: RawCell[]): StratumColumn {
  const dictionary = uniqueOrdered(cells.map(c => (c === null ? '' : c)));
  const index = new Map<RawCell, number>();
  dictionary.forEach((v, i) => index.set(v, i));

  const codes = new Uint32Array(cells.length);
  for (let i = 0; i < cells.length; i++) {
    codes[i] = index.get(cells[i] === null ? '' : cells[i]) ?? 0;
  }
  return { name, codes, dictionary, rotation: randomRotation() };
}

function makeValue(name: string, cells: RawCell[]): ValueColumn {
  const data = new Float32Array(cells.length);
  const present = new Uint8Array(cells.length);
  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (typeof cell === 'number' && Number.isFinite(cell)) {
      data[i] = cell;
      present[i] = 1;
      if (cell < min) min = cell;
      if (cell > max) max = cell;
    } else {
      data[i] = NaN;
      present[i] = 0;
    }
  }

  if (min > max) {
    min = 0;
    max = 1;
  }
  return { name, data, present, min, max, rotation: randomRotation() };
}

export function makeTable(name: TableName, raw: RawTable): Table {
  const byHeader = new Map(raw.headers.map((h, i) => [h, raw.columns[i]]));
  const isNumeric = (col: string) => isNumericColumn(byHeader.get(col) ?? []);
  const { strata, values } = classifyColumns(name, raw.headers, isNumeric);

  return {
    name,
    rowCount: raw.rowCount,
    strata: strata.map(col => makeStratum(col, byHeader.get(col) ?? [])),
    values: values.map(col => makeValue(col, byHeader.get(col) ?? [])),
  };
}

// The display text for one cell, by column kind. Strata read back through the
// dictionary; values print the number, or nothing where the cell is absent.
export function stratumText(column: StratumColumn, row: number): string {
  const value = column.dictionary[column.codes[row]];
  return value === null || value === undefined ? '' : String(value);
}

export function valueText(column: ValueColumn, row: number): string {
  if (!column.present[row]) return '';
  return String(column.data[row]);
}
