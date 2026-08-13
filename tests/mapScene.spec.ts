import { describe, expect, it } from 'vitest';
import { ZERO_ORIGIN, makeDesireLineEdges } from '../src/lib/geometryMaker';
import type { RawGeometry } from '../src/lib/rawTable';
import { AGENT_DIAMETER_CSS_PX, thinAgents, viewportOf } from '../src/lib/mapScene';

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

  it('keeps everything when zoomed in enough that the fixed dot no longer touches its neighbours', () => {
    // 100 device pixels per world unit shrinks the fixed dot to a fraction
    // of the 1-unit spacing, so nothing excludes anything.
    const kept = thinAgents(positions, values, viewport, 100, 1);
    expect(kept.values.length).toBe(4);
  });

  it('drops the ones that would overlap when zoomed out', () => {
    // A tenth of a pixel per world unit blows the fixed dot up to 80 world
    // units across -- wider than the whole row, so only the first survives.
    const kept = thinAgents(positions, values, viewport, 0.1, 1);
    expect(kept.values.length).toBe(1);
  });

  it('skips agents with no value for the selected resource entirely', () => {
    const sparse = Float64Array.from([1, NaN, NaN, 4]);
    const kept = thinAgents(positions, sparse, viewport, 100, 1);
    expect(Array.from(kept.values)).toEqual([1, 4]);
  });

  it('ignores anything outside the viewport, so zooming re-thins what is left', () => {
    const kept = thinAgents(positions, values, { minX: -0.5, maxX: 1.5, minY: -1, maxY: 1 }, 100, 1);
    expect(Array.from(kept.values)).toEqual([1, 2]);
  });

  it('never draws two circles closer than one diameter apart', () => {
    const kept = thinAgents(positions, values, viewport, 0.4, 1);
    const diameter = kept.radiusCssPx * 2;
    for (let i = 0; i < kept.values.length; i++) {
      for (let j = i + 1; j < kept.values.length; j++) {
        const dx = kept.positions[i * 2] - kept.positions[j * 2];
        const dy = kept.positions[i * 2 + 1] - kept.positions[j * 2 + 1];
        // separation measured in device pixels, same units as the diameter
        expect(Math.hypot(dx, dy) * 0.4).toBeGreaterThanOrEqual(diameter - 1e-6);
      }
    }
  });

  it('keeps the exact same diameter at every zoom level, in or out', () => {
    const zoomedIn = thinAgents(positions, values, viewport, 100, 1);
    const zoomedOut = thinAgents(positions, values, viewport, 0.1, 1);
    expect(zoomedIn.radiusCssPx).toBe(AGENT_DIAMETER_CSS_PX / 2);
    expect(zoomedOut.radiusCssPx).toBe(zoomedIn.radiusCssPx);
  });

  it('has nothing to draw when no agent has a value', () => {
    const kept = thinAgents(positions, Float64Array.from([NaN, NaN, NaN, NaN]), viewport, 1, 1);
    expect(kept.values.length).toBe(0);
  });
});

describe('viewportOf', () => {
  it('is the world rectangle the transform maps onto clip space', () => {
    const viewport = viewportOf({ centerX: 10, centerY: -4, scaleX: 0.5, scaleY: 0.25 });
    expect(viewport).toEqual({ minX: 8, maxX: 12, minY: -8, maxY: 0 });
  });
});
