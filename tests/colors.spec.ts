import { describe, expect, it } from 'vitest';
import {
  MAP_LAYERS, MAP_RAMP_LENGTH, SESSION_ROTATION, gradientAt, indexColor, mapRamp,
  ngon, ngonStarts, semicircle, uniqueOrdered,
  wheel,
} from '../src/lib/colors';

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

describe('mapRamp', () => {
  it('gives each layer a quarter of the wheel', () => {
    for (let layer = 0; layer < MAP_LAYERS; layer++) {
      expect(mapRamp(layer, 0, 3)).toHaveLength(MAP_RAMP_LENGTH);
    }
  });

  it('shares no colour between the four layers, which is the whole point', () => {
    // Four layers are on screen at once, so a hue has to name exactly one of
    // them. Tiling the wheel in quarters is what guarantees that outright
    // rather than merely making collisions unlikely.
    const seen = new Set<string>();
    for (let layer = 0; layer < MAP_LAYERS; layer++) {
      for (const c of mapRamp(layer, 1, 5)) seen.add(`${c.r},${c.g},${c.b}`);
    }
    expect(seen.size).toBe(MAP_LAYERS * MAP_RAMP_LENGTH);
  });

  it('stays disjoint whatever resource it is rotated to', () => {
    for (const resource of [0, 1, 2, 3]) {
      const seen = new Set<string>();
      for (let layer = 0; layer < MAP_LAYERS; layer++) {
        for (const c of mapRamp(layer, resource, 4)) seen.add(`${c.r},${c.g},${c.b}`);
      }
      expect(seen.size).toBe(MAP_LAYERS * MAP_RAMP_LENGTH);
    }
  });

  it('moves a layer\'s hues when the resource changes', () => {
    const first = mapRamp(0, 0, 4)[0];
    const second = mapRamp(0, 1, 4)[0];
    expect(first).not.toEqual(second);
  });

  it('draws every ramp color from the wheel itself -- no invented colors', () => {
    const onWheel = new Set(wheel().map(c => `${c.r},${c.g},${c.b}`));
    for (let layer = 0; layer < MAP_LAYERS; layer++) {
      for (const color of mapRamp(layer, 2, 5)) {
        expect(onWheel.has(`${color.r},${color.g},${color.b}`)).toBe(true);
      }
    }
  });
});

describe('uniqueOrdered', () => {
  it('keeps first-seen order and drops repeats', () => {
    expect(uniqueOrdered(['b', 'a', 'b', 'c'])).toEqual(['b', 'a', 'c']);
  });
});

describe('ngonStarts', () => {
  it('hands back wheel indices that can be fed straight back in as rotations', () => {
    // The whole two-level scheme rests on this: an n-gon's rotation index is
    // exactly its first vertex's wheel index, so a start can seed another
    // polygon.
    for (const start of ngonStarts(5)) {
      expect(wheel()[start]).toEqual(ngon(3, start)[0]);
    }
  });

  it('spaces its starts evenly around the wheel', () => {
    const starts = ngonStarts(4);
    const gaps = starts.map((s, i) => (starts[(i + 1) % 4] - s + 256) % 256);
    for (const gap of gaps) expect(gap).toBe(64);
  });

  it('is empty for a table with no strata at all', () => {
    expect(ngonStarts(0)).toEqual([]);
  });
});

describe('session rotation', () => {
  it('is shared, so every palette in a session is spaced off one origin', () => {
    // an n-gon's rotation index is its first vertex's wheel index, so a
    // wheel index can be handed straight back in as a rotation. Everything
    // built on top of ngonStarts depends on that holding.
    expect(ngonStarts(4).map(i => wheel()[i])).toEqual(ngon(4, SESSION_ROTATION));
  });

  it('offsets the whole wheel rather than reordering it', () => {
    // Whatever the rotation, the starts are still 256/n apart -- randomizing
    // it changes which hues appear, never how far apart they are.
    const starts = ngonStarts(8);
    expect(new Set(starts).size).toBe(8);
    for (const start of starts) expect(start).toBeGreaterThanOrEqual(0);
    for (const start of starts) expect(start).toBeLessThan(256);
  });
});
