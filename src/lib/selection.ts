import { gradientAt, indexColor, ngon, semicircle, rgbStr, uniqueOrdered } from './colors';
import type { LoadedFile } from './fileConfig';

// Exactly one column of exactly one table is ever lit at a time, app-wide.
// Just a pointer -- the palette recipe for painting it lives on the file
// itself (see fileConfig.ts's ColorRecipe), decided once at load time, not
// rebuilt here on every click.
export type Selection = { filename: string; column: string };

// The color a given cell should take under the current selection, or
// undefined if this cell isn't in the lit column. `luminance` is the one
// app-wide knob every matchColors call shares; nothing about it is stored
// per column.
export function cellColor(
  selection: Selection | null,
  file: LoadedFile,
  column: string,
  raw: unknown,
  luminance: number,
): string | undefined {
  if (!selection) return undefined;
  if (selection.filename !== file.filename || selection.column !== column) return undefined;

  const recipe = file.colorRecipes.get(column);
  if (!recipe) return undefined;

  if (recipe.kind === 'stratum') {
    const unique = uniqueOrdered(file.rows.map(r => String(r[column] ?? '')));
    const index = unique.indexOf(String(raw ?? ''));
    if (index < 0) return undefined;
    const palette = ngon(recipe.n, recipe.rotation, luminance);
    return rgbStr(indexColor(palette, index));
  }

  if (typeof raw !== 'number') return undefined;
  const nums = file.rows.map(r => r[column]).filter((v): v is number => typeof v === 'number');
  const min = nums.length ? Math.min(...nums) : 0;
  const max = nums.length ? Math.max(...nums) : 1;
  const t = max === min ? 0.5 : (raw - min) / (max - min);
  const gradient = semicircle(recipe.rotation, luminance);
  return rgbStr(gradientAt(t, gradient));
}
