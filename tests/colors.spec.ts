import { describe, expect, it } from 'vitest';
import { gradientAt, indexColor, ngon, ramps, semicircle, uniqueOrdered, wheel } from '../src/lib/colors';

describe('ngon', () => {
  it('returns one color per distinct value', () => {
    expect(ngon(5, 0)).toHaveLength(5);
  });

  it('caps at the wheel size rather than growing past it', () => {
    expect(ngon(1000, 0).length).toBeLessThanOrEqual(256);
  });

  it('is stable for a given rotation and empty for no values', () => {
    expect(ngon(4, 7)).toEqual(ngon(4, 7));
    expect(ngon(0, 0)).toEqual([]);
  });
});

describe('indexColor', () => {
  it('wraps past the end of the palette instead of running off it', () => {
    const palette = ngon(4, 0);
    expect(indexColor(palette, 4)).toEqual(palette[0]);
    expect(indexColor(palette, 5)).toEqual(palette[1]);
  });

  it('never returns undefined for a column with more values than the wheel holds', () => {
    const palette = ngon(300, 0);
    for (const i of [0, 255, 256, 299, 1000]) {
      expect(indexColor(palette, i)).toBeDefined();
    }
  });
});

describe('semicircle', () => {
  it('walks half the wheel, so the two ends stay distinguishable', () => {
    expect(semicircle(0)).toHaveLength(128);
  });
});

describe('gradientAt', () => {
  it('puts the minimum on the first stop and the maximum on the last', () => {
    const gradient = semicircle(0);
    expect(gradientAt(0, gradient)).toEqual(gradient[0]);
    expect(gradientAt(1, gradient)).toEqual(gradient[gradient.length - 1]);
  });

  it('clamps out-of-range positions rather than reading past the ends', () => {
    const gradient = semicircle(3);
    expect(gradientAt(-5, gradient)).toEqual(gradient[0]);
    expect(gradientAt(5, gradient)).toEqual(gradient[gradient.length - 1]);
  });
});

describe('ramps', () => {
  it('gives one 128-color ramp per resource', () => {
    const built = ramps(3);
    expect(built).toHaveLength(3);
    for (const ramp of built) expect(ramp).toHaveLength(128);
  });

  it('starts each ramp on its own n-gon vertex, so resources start far apart', () => {
    const starts = ngon(4, 0);
    ramps(4).forEach((ramp, i) => expect(ramp[0]).toEqual(starts[i]));
  });

  it('draws every ramp color from the wheel itself -- no invented colors', () => {
    const onWheel = new Set(wheel().map(c => `${c.r},${c.g},${c.b}`));
    for (const ramp of ramps(5)) {
      for (const color of ramp) expect(onWheel.has(`${color.r},${color.g},${color.b}`)).toBe(true);
    }
  });
});

describe('uniqueOrdered', () => {
  it('keeps first-seen order and drops repeats', () => {
    expect(uniqueOrdered(['b', 'a', 'b', 'c'])).toEqual(['b', 'a', 'c']);
  });
});
