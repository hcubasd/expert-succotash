import { matchColors, matchGrays } from 'miniature-waffle';
export type { RgbColor } from 'miniature-waffle';
import type { RgbColor } from 'miniature-waffle';

// The luminance every matchColors call in the app draws at, [0,1]. A single
// global knob per mode, not per-column: a stratum swatch and a value-gradient
// stop have to be directly comparable, which only holds if they sit on the
// same circle.
//
// LUMINANCE_DARK is the true (unrounded) peak of matchColors' 256-gon radius
// r(L) -- the widest palette the sRGB gamut allows, found by golden-section
// search over miniature-waffle's own radiusFinder. LUMINANCE_LIGHT is the
// unique L on the other side of that peak with the same r/ΔL ratio to its
// paper (ΔL = L - 0 for black paper, 100 - L for white paper) -- the palette
// subtends the same visual angle from the page in both modes, rather than
// matching absolute contrast (too costly in r) or absolute radius (no
// contrast margin against a light background). Both solved once by root-
// finding against radiusFinder and pinned here as constants; see
// conversation/commit history for the derivation, not worth re-deriving at
// runtime.
export const LUMINANCE_DARK = 0.73912;
export const LUMINANCE_LIGHT = 0.47665;
export const LUMINANCE = LUMINANCE_DARK;

// matchColors places its palette on a circle in CIELAB at fixed L, sampling
// 256 evenly spaced vertices and returning all 256 rotations of the n-gon
// inscribed in them. So every color the app can ever show is one of these
// 256 points, and "hue" is genuinely an angle -- which is what makes the
// circular-mean blending in the map renderer exact rather than approximate.
const WHEEL = 256;

export function rgbStr({ r, g, b }: RgbColor) {
  return `rgb(${r},${g},${b})`;
}

export function randomRotation(): number {
  return Math.floor(Math.random() * WHEEL);
}

// One rotation of the n-gon: n evenly spaced hues. n is clamped to the
// wheel's own size, so a column with more distinct values than that has to
// wrap its index back into the palette (see indexColor) rather than assume
// palette.length === n.
export function ngon(n: number, rotation: number, luminance: number = LUMINANCE): RgbColor[] {
  if (n <= 0) return [];
  const clamped = Math.max(1, Math.min(WHEEL, n));
  const palettes = matchColors(clamped, luminance * 100);
  return palettes[rotation % palettes.length];
}

// A value column reads as half the wheel -- 128 stops walked from `rotation`.
// Half rather than the full circle so the two ends of the ramp stay visually
// distinct; a full circle would put min and max at the same hue.
export function semicircle(rotation: number, luminance: number = LUMINANCE): RgbColor[] {
  const palettes = matchColors(WHEEL, luminance * 100);
  return palettes[rotation % palettes.length].slice(0, WHEEL / 2);
}

// Map normalized [0,1] onto a gradient: 0 lands on the first stop, 1 on the
// last.
export function gradientAt(t: number, gradient: RgbColor[]): RgbColor {
  const clamped = Math.max(0, Math.min(1, t));
  const index = Math.min(gradient.length - 1, Math.floor(clamped * (gradient.length - 1)));
  return gradient[index];
}

// The color for the i-th distinct value, wrapping once i runs past the
// palette's length. With more than 256 distinct values the 257th reuses the
// first color, and so on -- the palette itself can never be longer.
export function indexColor(palette: RgbColor[], i: number): RgbColor {
  return palette[i % palette.length];
}

// A neutral gray at a given lightness, [0,1]. Used where something needs to
// match a background without being painted by colorBg itself.
export function grayAt(lightness: number): RgbColor {
  const l = Math.max(0, Math.min(1, lightness)) * 100;
  return matchGrays(1, l, l)[0];
}

// The full 256-vertex wheel, in wheel order. Memoized: it never changes for
// a given luminance, and the map renderer uploads it as a lookup texture.
let wheelCache: { luminance: number; colors: RgbColor[] } | null = null;

export function wheel(luminance: number = LUMINANCE): RgbColor[] {
  if (wheelCache && wheelCache.luminance === luminance) return wheelCache.colors;
  // n = 256 makes every gap 1, so rotation 0 is the vertices in wheel order.
  const colors = matchColors(WHEEL, luminance * 100)[0];
  wheelCache = { luminance, colors };
  return colors;
}

// Which wheel vertex a color sits on, 0-255. Every color the app produces
// comes off the wheel, so this is an exact lookup rather than an
// approximation -- the nearest-match fallback only exists because two
// adjacent vertices can round to the same 8-bit RGB triple on a small
// enough circle.
let indexCache: { luminance: number; byRgb: Map<string, number> } | null = null;

export function hueIndexOf(color: RgbColor, luminance: number = LUMINANCE): number {
  if (!indexCache || indexCache.luminance !== luminance) {
    const byRgb = new Map<string, number>();
    wheel(luminance).forEach((c, i) => {
      const key = `${c.r},${c.g},${c.b}`;
      if (!byRgb.has(key)) byRgb.set(key, i);
    });
    indexCache = { luminance, byRgb };
  }
  const exact = indexCache.byRgb.get(`${color.r},${color.g},${color.b}`);
  if (exact !== undefined) return exact;

  let best = 0;
  let bestDistance = Infinity;
  wheel(luminance).forEach((c, i) => {
    const d = (c.r - color.r) ** 2 + (c.g - color.g) ** 2 + (c.b - color.b) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  });
  return best;
}

// First-seen-order distinct values -- the scan order that decides which
// palette entry each distinct value gets.
export function uniqueOrdered<T>(values: T[]): T[] {
  const seen = new Set<T>();
  return values.filter(v => (seen.has(v) ? false : (seen.add(v), true)));
}
