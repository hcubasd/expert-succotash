import { matchColors, matchGrays } from 'miniature-waffle';
export type { RgbColor } from 'miniature-waffle';
import type { RgbColor } from 'miniature-waffle';

// The one luminance the whole app draws at.
//
// This is the true, unrounded peak of matchColors' 256-gon radius r(L) --
// the widest palette the sRGB gamut allows, found by golden-section search
// over miniature-waffle's own radiusFinder. r(L) is not a symmetric funnel:
// it climbs almost exactly linearly from L~15 to the peak (slope 0.447) and
// falls three to four times faster past it, so this point is worth naming
// precisely rather than rounding to 75.
//
// There is no second mode, so there is no second luminance -- every color in
// the app sits on this one circle and is therefore directly comparable to
// every other.
export const LUMINANCE = 0.73912;

const WHEEL = 256;

// A ramp walks half the wheel. Half rather than the full circle so a ramp's
// two ends stay distinguishable: all the way round would put the minimum and
// maximum on the same hue.
export const RAMP_LENGTH = WHEEL / 2;

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
export function ngon(n: number, rotation: number): RgbColor[] {
  if (n <= 0) return [];
  const clamped = Math.max(1, Math.min(WHEEL, n));
  const palettes = matchColors(clamped, LUMINANCE * 100);
  return palettes[rotation % palettes.length];
}

// The full 256-vertex wheel, in wheel order. Memoized: it never changes now
// that luminance is fixed.
let wheelCache: RgbColor[] | null = null;

export function wheel(): RgbColor[] {
  // n = 256 makes every gap 1, so rotation 0 is the vertices in wheel order.
  if (!wheelCache) wheelCache = matchColors(WHEEL, LUMINANCE * 100)[0];
  return wheelCache;
}

// A 128-color ramp starting at a given wheel vertex.
export function semicircle(rotation: number): RgbColor[] {
  const w = wheel();
  const start = ((rotation % WHEEL) + WHEEL) % WHEEL;
  const ramp: RgbColor[] = [];
  for (let k = 0; k < RAMP_LENGTH; k++) ramp.push(w[(start + k) % WHEEL]);
  return ramp;
}

// Which rotation of the top-level n-gon this session uses. Rolled once per
// page load: the choice is arbitrary, so it may as well vary, but it's
// shared rather than rolled per palette so that everything in a session is
// spaced off one common starting point.
export const SESSION_ROTATION = randomRotation();

let indexCache: Map<string, number> | null = null;

// Which of the 256 wheel vertices a color sits on. Every color the app
// produces comes off the wheel, so this is an exact lookup rather than a
// nearest match.
export function wheelIndexOf(color: RgbColor): number {
  if (!indexCache) {
    const built = new Map<string, number>();
    wheel().forEach((c, i) => {
      const key = rgbStr(c);
      if (!built.has(key)) built.set(key, i);
    });
    indexCache = built;
  }
  return indexCache.get(rgbStr(color)) ?? 0;
}

// The wheel positions of an n-gon's vertices at this session's rotation.
//
// These are the starting points everything else is built from, two levels
// deep: a resource's ramp walks half the wheel from one of them, and a
// stratum column's palette is a k-gon *beginning* at one of them. That works
// because an n-gon's rotation index is exactly its first vertex's wheel
// index -- checked against matchColors directly -- so a wheel index can be
// handed straight back in as a rotation.
export function ngonStarts(n: number): number[] {
  return ngon(n, SESSION_ROTATION).map(wheelIndexOf);
}

// One ramp per resource: n evenly spaced starting hues from the n-gon, each
// walked half way round the wheel. Two resources therefore start as far
// apart as the wheel allows and their ramps stay tellable apart along their
// whole length, which is what lets a per-resource view be read on its own
// terms without a shared legend.
let rampsCache: { n: number; ramps: RgbColor[][] } | null = null;

export function ramps(n: number): RgbColor[][] {
  if (rampsCache && rampsCache.n === n) return rampsCache.ramps;
  // Cached on n alone: the session rotation is fixed for the page's life.
  const built = ngonStarts(n).map(semicircle);
  rampsCache = { n, ramps: built };
  return built;
}

// Map normalized [0,1] onto a ramp: 0 lands on the first stop, 1 on the last.
export function gradientAt(t: number, gradient: RgbColor[]): RgbColor {
  const clamped = Math.max(0, Math.min(1, t));
  const index = Math.min(gradient.length - 1, Math.floor(clamped * (gradient.length - 1)));
  return gradient[index];
}

// The color for the i-th distinct value, wrapping once i runs past the
// palette's length.
export function indexColor(palette: RgbColor[], i: number): RgbColor {
  return palette[i % palette.length];
}

// A neutral gray at a given lightness, [0,1].
export function grayAt(lightness: number): RgbColor {
  const l = Math.max(0, Math.min(1, lightness)) * 100;
  return matchGrays(1, l, l)[0];
}

// First-seen-order distinct values -- the scan order that decides which
// palette entry each distinct value gets.
export function uniqueOrdered<T>(values: T[]): T[] {
  const seen = new Set<T>();
  return values.filter(v => (seen.has(v) ? false : (seen.add(v), true)));
}
