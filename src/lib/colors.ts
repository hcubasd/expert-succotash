import { matchColors, matchGrays } from 'miniature-waffle';
export type { RgbColor } from 'miniature-waffle';
import type { RgbColor } from 'miniature-waffle';

// Every matchColors call in the app is drawn at this one shared luminance by
// default, [0,1], so a stratum swatch and a value-gradient stop are directly
// comparable. It's a single global knob, not per-column -- callers may pass
// their own, but there is deliberately only one value in play app-wide.
export const DEFAULT_LUMINANCE = 0.75;

// matchColors(n, L) returns all 256 rotations of the n-gon; a palette can
// never have more than this many entries.
const ROTATIONS = 256;

export function rgbStr({ r, g, b }: RgbColor) {
  return `rgb(${r},${g},${b})`;
}

export function randomRotation(): number {
  return Math.floor(Math.random() * ROTATIONS);
}

// First-seen-order distinct values -- the scan order a stratum column's
// palette indices are assigned in.
export function uniqueOrdered(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter(v => (seen.has(v) ? false : (seen.add(v), true)));
}

// One rotation of the n-gon: n evenly spaced hues. The rotation is supplied by
// the caller so a palette stays stable for the lifetime of whatever owns it.
// n is clamped to 256, matchColors' own ceiling -- a stratum column with more
// distinct values than that has to wrap its index into this same palette
// (see indexColor below), not assume palette.length === n.
export function ngon(n: number, rotation: number, luminance: number = DEFAULT_LUMINANCE): RgbColor[] {
  if (n <= 0) return [];
  const clamped = Math.max(1, Math.min(ROTATIONS, n));
  const palettes = matchColors(clamped, luminance * 100);
  return palettes[rotation % palettes.length];
}

// A value column reads as a semicircle of the 256-gon: half the hue wheel,
// walked from `rotation`.
export function semicircle(rotation: number, luminance: number = DEFAULT_LUMINANCE): RgbColor[] {
  const palettes = matchColors(ROTATIONS, luminance * 100);
  return palettes[rotation % palettes.length].slice(0, ROTATIONS / 2);
}

// The color for the i-th distinct value of an n-gon palette, wrapping once i
// runs past the palette's own length (which may be smaller than n if n > 256
// -- palette.length is what actually bounds the available colors). The
// (palette.length + 1)-th distinct value reuses color 0, and so on.
export function indexColor(palette: RgbColor[], i: number): RgbColor {
  return palette[i % palette.length];
}

// A color from `palette` not already in `used`, or null if every entry is
// already taken (more nodes than palette entries).
export function pickNodeColor(palette: RgbColor[], used: Iterable<RgbColor>): RgbColor | null {
  const usedSet = new Set([...used].map(rgbStr));
  const free = palette.filter(c => !usedSet.has(rgbStr(c)));
  if (free.length === 0) return null;
  return free[Math.floor(Math.random() * free.length)];
}

// Map normalized [0,1] onto a gradient.
export function gradientAt(t: number, gradient: RgbColor[]): RgbColor {
  const clamped = Math.max(0, Math.min(1, t));
  const idx = Math.min(gradient.length - 1, Math.floor(clamped * (gradient.length - 1)));
  return gradient[idx];
}

// A plain neutral gray at a given lightness, [0,1] where 0 = black, 1 = white.
// Used wherever something needs to match colorBg's output without itself
// being a .bg div walked by colorBg (e.g. an edge endpoint that fades to the
// same color as an unloaded card).
export function grayAt(lightness: number): RgbColor {
  const l = Math.max(0, Math.min(1, lightness)) * 100;
  return matchGrays(1, l, l)[0];
}
