import { matchColors, matchGrays } from 'miniature-waffle';
export type { RgbColor } from 'miniature-waffle';
import type { RgbColor } from 'miniature-waffle';

// Every palette in the app is drawn at this one lightness, so a stratum swatch
// and a value-gradient stop are directly comparable.
export const LIGHTNESS = 75;

// matchColors(n, L) returns all 256 rotations of the n-gon.
const ROTATIONS = 256;

export function rgbStr({ r, g, b }: RgbColor) {
  return `rgb(${r},${g},${b})`;
}

export function randomRotation(): number {
  return Math.floor(Math.random() * ROTATIONS);
}

// One rotation of the n-gon: n evenly spaced hues. The rotation is supplied by
// the caller so a palette stays stable for the lifetime of whatever owns it.
export function ngon(n: number, rotation: number): RgbColor[] {
  if (n <= 0) return [];
  const clamped = Math.max(1, Math.min(ROTATIONS, n));
  const palettes = matchColors(clamped, LIGHTNESS);
  return palettes[rotation % palettes.length];
}

// A value column reads as a semicircle of the 256-gon: half the hue wheel,
// walked from `rotation`.
export function semicircle(rotation: number): RgbColor[] {
  const palettes = matchColors(ROTATIONS, LIGHTNESS);
  return palettes[rotation % palettes.length].slice(0, ROTATIONS / 2);
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
