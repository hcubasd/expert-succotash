import { describe, expect, it } from 'vitest';
import { ZERO_ORIGIN, makeDesireLineEdges } from '../src/lib/geometryMaker';
import type { RawGeometry } from '../src/lib/rawTable';
import { exclusionFor, jointColors, thinAgents, viewportOf } from '../src/lib/mapScene';
import { RAMP_LENGTH, semicircle } from '../src/lib/colors';

const line = (a: [number, number], b: [number, number]): RawGeometry => ({
  type: 'LineString',
  coordinates: [a, b],
});

describe('makeDesireLineEdges', () => {
  it('folds A->B and B->A into one edge with their flows summed', () => {
    const edges = makeDesireLineEdges(
      [line([0, 0], [1, 1]), line([1, 1], [0, 0])],
      ['pallets', 'pallets'],
      Float64Array.from([3, 4]),
      ZERO_ORIGIN,
    );
    const pallets = edges.get('pallets')!;
    expect(pallets.quantities.length).toBe(1);
    expect(pallets.quantities[0]).toBe(7);
  });

  it('keeps resources apart, so each gets its own edge set', () => {
    const edges = makeDesireLineEdges(
      [line([0, 0], [1, 1]), line([1, 1], [0, 0])],
      ['pallets', 'parcels'],
      Float64Array.from([3, 4]),
      ZERO_ORIGIN,
    );
    expect(edges.get('pallets')!.quantities.length).toBe(1);
    expect(edges.get('parcels')!.quantities.length).toBe(1);
    expect(edges.get('pallets')!.quantities[0]).toBe(3);
  });

  it('keeps genuinely different pairs separate', () => {
    const edges = makeDesireLineEdges(
      [line([0, 0], [1, 1]), line([0, 0], [2, 2])],
      ['pallets', 'pallets'],
      Float64Array.from([1, 1]),
      ZERO_ORIGIN,
    );
    expect(edges.get('pallets')!.quantities.length).toBe(2);
  });

  it('lays endpoints out as x1,y1,x2,y2 and subtracts the origin', () => {
    const edges = makeDesireLineEdges(
      [line([10, 20], [11, 21])],
      ['pallets'],
      Float64Array.from([1]),
      { x: 10, y: 20 },
    );
    expect(Array.from(edges.get('pallets')!.positions)).toEqual([0, 0, 1, 1]);
  });
});

describe('thinAgents', () => {
  const viewport = { minX: -100, maxX: 100, minY: -100, maxY: 100 };

  // Four agents in a row, one world unit apart.
  const positions = Float32Array.from([0, 0, 1, 0, 2, 0, 3, 0]);
  const values = Float64Array.from([1, 2, 3, 4]);

  // detail 1 is the fine end: the exclusion is exactly zero, so nothing
  // merges at all.
  const finest = (ppu: number, ratio = 1, vals = values, vp = viewport) =>
    thinAgents(positions, vals, vp, ppu, ratio, 1);

  it('keeps every agent that has a pixel of its own', () => {
    expect(finest(100).values.length).toBe(4);
  });

  it('merges nothing at all at full detail, however close two agents sit', () => {
    // The fine end is an exact zero now, the same as every other layer: the
    // exclusion test is a strict less-than, so not even a separation of zero
    // falls inside it. Two agents stacked on one spot both survive.
    const together = Float32Array.from([0, 0, 0, 0, 5, 0, 9, 0]);
    expect(thinAgents(together, values, viewport, 100, 1, 1).values.length).toBe(4);
  });

  it('still puts a circle on screen when the merge radius is exactly zero', () => {
    // A radius-zero circle would put no fragment down at all, so the drawn
    // size keeps a floor of its own -- downstream of the thinning, and never
    // fed back into what merges with what.
    const kept = thinAgents(positions, values, viewport, 1, 1, 1);
    expect(kept.values.length).toBe(4);
    expect(kept.radiusCssPx * 2).toBeGreaterThanOrEqual(1);
  });

  it('sums what it merges, so the total on screen is the true total', () => {
    const merged = thinAgents(positions, values, viewport, 1, 1, 0.1);
    expect(merged.values.length).toBeLessThan(4);
    expect(Array.from(merged.values).reduce((a, b) => a + b, 0)).toBe(1 + 2 + 3 + 4);
  });

  it('keeps the total intact at every level of detail', () => {
    // The property that makes aggregation trustworthy: coarsening changes
    // how many circles there are, never how much they add up to.
    const total = 1 + 2 + 3 + 4;
    for (const detail of [0, 0.25, 0.5, 0.75, 1]) {
      const thinned = thinAgents(positions, values, viewport, 1, 1, detail);
      const sum = Array.from(thinned.values).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(total, 9);
    }
  });

  it('leaves exactly two circles at the coarse end', () => {
    // The anchor and the single agent farthest from it -- the exact
    // geometric limit of the control, not a padded approximation.
    expect(thinAgents(positions, values, viewport, 1, 1, 0).values.length).toBe(2);
  });

  it('skips agents with no value for the selected resource entirely', () => {
    const sparse = Float64Array.from([1, NaN, NaN, 4]);
    expect(Array.from(finest(100, 1, sparse).values)).toEqual([1, 4]);
  });

  it('ignores anything outside the viewport, so zooming re-thins what is left', () => {
    const near = { minX: -0.5, maxX: 1.5, minY: -1, maxY: 1 };
    expect(Array.from(finest(100, 1, values, near).values)).toEqual([1, 2]);
  });

  it('never draws two circles closer than one diameter apart, once the radius clears a pixel', () => {
    // Only once it clears a pixel: below that the drawn circle is floored
    // while the merge radius keeps going to zero, so circles can overlap
    // down there. That is the price of an exact zero, and it is confined to
    // the very fine end of the control.
    const kept = thinAgents(positions, values, viewport, 1, 1, 0.1);
    const diameter = kept.radiusCssPx * 2;
    for (let i = 0; i < kept.values.length; i++) {
      for (let j = i + 1; j < kept.values.length; j++) {
        const dx = kept.positions[i * 2] - kept.positions[j * 2];
        const dy = kept.positions[i * 2 + 1] - kept.positions[j * 2 + 1];
        // one device pixel per world unit here, so these are the same units
        expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(diameter - 1e-6);
      }
    }
  });

  it('draws circles that grow with the control, since the circle is the merge area', () => {
    const fine = thinAgents(positions, values, viewport, 10, 1, 0.5);
    const coarse = thinAgents(positions, values, viewport, 10, 1, 0.2);
    expect(coarse.radiusCssPx).toBeGreaterThan(fine.radiusCssPx);
  });

  it('never draws a circle under one device pixel across, on any screen', () => {
    for (const ratio of [1, 2, 3]) {
      const kept = thinAgents(positions, values, viewport, 1e-9, ratio, 1);
      // radiusCssPx * ratio * 2 is the diameter in device pixels
      expect(kept.radiusCssPx * ratio * 2).toBeGreaterThanOrEqual(1 - 1e-9);
    }
  });

  it('has nothing to draw when no agent has a value', () => {
    const kept = thinAgents(positions, Float64Array.from([NaN, NaN, NaN, NaN]), viewport, 1, 1, 1);
    expect(kept.values.length).toBe(0);
  });
});

describe('exclusionFor', () => {
  it('reaches exactly zero at full detail, not merely close to it', () => {
    // This exact zero is what makes "the original geometry" reachable
    // rather than only approached -- simplifyNetwork returns every link's
    // own shape only when the radius truly excludes nothing.
    expect(exclusionFor(1, 12345)).toBe(0);
  });

  it('reaches exactly the ceiling at zero detail', () => {
    expect(exclusionFor(0, 12345)).toBe(12345);
  });

  it('spends most of its travel in the fine half', () => {
    // Cubic easing: the midpoint of the slider should sit well below the
    // midpoint of the radius range, not at it.
    const mid = exclusionFor(0.5, 1000);
    expect(mid).toBeLessThan(200);
  });

  it('clamps detail outside 0..1 rather than extrapolating past the true limits', () => {
    expect(exclusionFor(-1, 1000)).toBe(1000);
    expect(exclusionFor(2, 1000)).toBe(0);
  });

  it('bottoms out on the floor instead of zero when one is given', () => {
    // Agents draw a real circle and cannot go under a device pixel of it,
    // unlike the network whose fine end is a true zero.
    expect(exclusionFor(1, 1000, 4)).toBe(4);
    expect(exclusionFor(0, 1000, 4)).toBe(1000);
  });

  it('collapses to the floor when the ceiling is below it', () => {
    // Every point already inside one pixel: there is no range left to span,
    // and the result must stay the floor rather than going negative.
    expect(exclusionFor(0, 2, 10)).toBe(10);
    expect(exclusionFor(1, 2, 10)).toBe(10);
  });
});

describe('viewportOf', () => {
  it('is the world rectangle the transform maps onto clip space', () => {
    const viewport = viewportOf({ centerX: 10, centerY: -4, scaleX: 0.5, scaleY: 0.25 });
    expect(viewport).toEqual({ minX: 8, maxX: 12, minY: -8, maxY: 0 });
  });
});
