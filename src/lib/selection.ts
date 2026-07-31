import { gradientAt, ngon, randomRotation, rgbStr, semicircle } from './colors';
import type { RgbColor } from './colors';
import type { LoadedFile } from './fileConfig';

// Exactly one column of exactly one table is ever lit at a time, app-wide.
// Everything needed to paint it — and later to paint the map from it — lives
// here; nothing colour-related is stored per file.
export type Selection =
  | {
      filename: string;
      column: string;
      kind: 'stratum';
      // one hue per distinct value, from a single rotation of the n-gon
      colors: Map<string, RgbColor>;
    }
  | {
      filename: string;
      column: string;
      kind: 'value';
      min: number;
      max: number;
      gradient: RgbColor[];
    };

export function uniqueOrdered(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter(v => (seen.has(v) ? false : (seen.add(v), true)));
}

// Build the palette for a column at click time. Rotation is rolled per
// selection, so re-selecting a column reshuffles its hues — the n-gon shape is
// what carries meaning, not which hue landed on which value.
export function buildSelection(file: LoadedFile, column: string): Selection | null {
  if (file.strata.includes(column)) {
    const unique = uniqueOrdered(file.rows.map(r => String(r[column] ?? '')));
    const palette = ngon(unique.length, randomRotation());
    return {
      filename: file.filename,
      column,
      kind: 'stratum',
      colors: new Map(unique.map((v, i) => [v, palette[i]])),
    };
  }

  if (file.values.includes(column)) {
    const nums = file.rows.map(r => r[column]).filter((v): v is number => typeof v === 'number');
    return {
      filename: file.filename,
      column,
      kind: 'value',
      min: nums.length ? Math.min(...nums) : 0,
      max: nums.length ? Math.max(...nums) : 1,
      gradient: semicircle(randomRotation()),
    };
  }

  return null;
}

// The colour a given cell should take under the current selection, or undefined
// if this cell isn't in the lit column.
export function cellColor(
  selection: Selection | null,
  filename: string,
  column: string,
  raw: unknown,
): string | undefined {
  if (!selection) return undefined;
  if (selection.filename !== filename || selection.column !== column) return undefined;

  if (selection.kind === 'stratum') {
    const c = selection.colors.get(String(raw ?? ''));
    return c ? rgbStr(c) : undefined;
  }

  if (typeof raw !== 'number') return undefined;
  const { min, max, gradient } = selection;
  const t = max === min ? 0.5 : (raw - min) / (max - min);
  return rgbStr(gradientAt(t, gradient));
}
