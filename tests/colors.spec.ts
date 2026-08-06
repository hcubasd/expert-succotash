import { describe, expect, it } from 'vitest';
import { gradientAt, hueIndexOf, indexColor, ngon, semicircle, uniqueOrdered, wheel } from '../src/lib/colors';

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

describe('hueIndexOf', () => {
  it('recovers the wheel position of a wheel color exactly', () => {
    const colors = wheel();
    for (const i of [0, 1, 77, 128, 255]) {
      expect(hueIndexOf(colors[i])).toBe(i);
    }
  });

  it('places every palette color somewhere on the wheel', () => {
    for (const color of ngon(7, 42)) {
      const index = hueIndexOf(color);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(256);
    }
  });
});

describe('uniqueOrdered', () => {
  it('keeps first-seen order and drops repeats', () => {
    expect(uniqueOrdered(['b', 'a', 'b', 'c'])).toEqual(['b', 'a', 'c']);
  });
});
