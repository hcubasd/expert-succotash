import { describe, expect, it } from 'vitest';
import {
  ZERO_ORIGIN, boundsForMode, boundsOf, makePoints, makePolygons, makeSegments, originOf, rawBounds,
} from '../src/lib/geometryMaker';
import type { RawGeometry } from '../src/lib/rawTable';

const point = (x: number, y: number): RawGeometry => ({ type: 'Point', coordinates: [x, y] });
const line = (coords: [number, number][]): RawGeometry => ({ type: 'LineString', coordinates: coords });
const squareRings: [number, number][][] = [[[0, 0], [1, 0], [1, 1], [0, 1]]];
const triangleRings: [number, number][][] = [[[10, 10], [11, 10], [11, 11]]];
const square = (): RawGeometry => ({ type: 'Polygon', coordinates: squareRings });

describe('makeSegments', () => {
  it('flattens a two-point line into one segment', () => {
    const g = makeSegments([line([[0, 0], [1, 1]])], ZERO_ORIGIN);
    // x1,y1,x2,y2 -- which doubles as the per-instance attribute layout,
    // start at byte 0 and end at byte 8 of one 16-byte stride.
    expect(Array.from(g.positions)).toEqual([0, 0, 1, 1]);
    expect(Array.from(g.rowIndex)).toEqual([0]);
  });

  it('decomposes a polyline into one segment per span, all tagged to its row', () => {
    const g = makeSegments([line([[0, 0], [1, 0], [2, 0]])], ZERO_ORIGIN);
    expect(g.positions.length / 4).toBe(2);
    expect(Array.from(g.rowIndex)).toEqual([0, 0]);
  });

  it('tags one row per segment, so a colour cannot vary along a line', () => {
    const g = makeSegments([line([[0, 0], [1, 0], [2, 0]])], ZERO_ORIGIN);
    const segments = g.positions.length / 4;
    expect(segments).toBe(2);
    expect(g.rowIndex.length).toBe(segments);
  });

  it('keeps row indices distinct across several lines', () => {
    const g = makeSegments([line([[0, 0], [1, 1]]), line([[2, 2], [3, 3]])], ZERO_ORIGIN);
    expect(Array.from(g.rowIndex)).toEqual([0, 1]);
  });

  it('decomposes every span of a MultiLineString under the same row', () => {
    const g = makeSegments(
      [{ type: 'MultiLineString', coordinates: [[[0, 0], [1, 0]], [[5, 5], [6, 5], [7, 5]]] }],
      ZERO_ORIGIN,
    );
    // one segment from the first span, two from the second
    expect(g.positions.length / 4).toBe(3);
    expect([...new Set(g.rowIndex)]).toEqual([0]);
  });
});

describe('makePolygons', () => {
  it('triangulates a square into two triangles', () => {
    const g = makePolygons([square()], ZERO_ORIGIN);
    expect(g.fillPositions.length / 2).toBe(6);
    expect(Array.from(g.fillRowIndex)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('closes the ring, so a four-sided polygon yields four border segments', () => {
    const g = makePolygons([square()], ZERO_ORIGIN);
    expect(g.borderPositions.length / 4).toBe(4);
  });

  it('ignores anything that is not a polygon', () => {
    const g = makePolygons([point(0, 0)], ZERO_ORIGIN);
    expect(g.fillPositions.length).toBe(0);
    expect(g.borderPositions.length).toBe(0);
  });

  it('triangulates every part of a MultiPolygon under the same row', () => {
    // A disjoint exclave under one zone_id -- two separate triangles, both
    // tagged to row 0, not treated as two features.
    const g = makePolygons(
      [{ type: 'MultiPolygon', coordinates: [squareRings, triangleRings] }],
      ZERO_ORIGIN,
    );
    expect(g.fillPositions.length / 2).toBe(9); // 2 triangles from the square + 1 from the triangle
    expect([...new Set(g.fillRowIndex)]).toEqual([0]);
    expect(g.borderPositions.length / 4).toBe(7); // 4 edges from the square + 3 from the triangle
  });

  it('keeps MultiPolygon rows distinct from each other', () => {
    const g = makePolygons(
      [
        { type: 'MultiPolygon', coordinates: [squareRings] },
        { type: 'MultiPolygon', coordinates: [triangleRings] },
      ],
      ZERO_ORIGIN,
    );
    expect([...new Set(g.fillRowIndex)]).toEqual([0, 1]);
  });
});

describe('makePoints', () => {
  it('keeps one vertex per row so a point index is its row index', () => {
    const g = makePoints([point(1, 2), null, point(3, 4)], ZERO_ORIGIN);
    expect(g.rowCount).toBe(3);
    expect(g.positions.length / 2).toBe(3);
    expect(g.positions[0]).toBe(1);
    expect(g.positions[4]).toBe(3);
    // the missing one is non-finite rather than silently shifting the rest
    expect(Number.isFinite(g.positions[2])).toBe(false);
  });

  it('takes the first part of a MultiPoint rather than growing many vertices per row', () => {
    const g = makePoints([{ type: 'MultiPoint', coordinates: [[1, 2], [9, 9]] }], ZERO_ORIGIN);
    expect(g.positions.length / 2).toBe(1);
    expect(Array.from(g.positions)).toEqual([1, 2]);
  });
});

describe('boundsOf', () => {
  it('spans every loaded bucket', () => {
    const bounds = boundsOf({
      zones: null,
      network: makeSegments([line([[0, 0], [4, 1]])], ZERO_ORIGIN),
      desireLines: null,
      agents: makePoints([point(-2, 6)], ZERO_ORIGIN),
    });
    expect(bounds).toEqual({ minX: -2, minY: 0, maxX: 4, maxY: 6 });
  });

  it('is null when nothing is loaded', () => {
    expect(boundsOf({ zones: null, network: null, desireLines: null, agents: null })).toBeNull();
  });

  it('skips non-finite coordinates rather than poisoning the span', () => {
    const bounds = boundsOf({
      zones: null,
      network: null,
      desireLines: null,
      agents: makePoints([point(1, 1), null, point(3, 3)], ZERO_ORIGIN),
    });
    expect(bounds).toEqual({ minX: 1, minY: 1, maxX: 3, maxY: 3 });
  });
});

describe('real projected coordinates', () => {
  // A UTM-scale easting/northing pair, 10 cm apart -- two agents on the same
  // street. Out at 4.6e6 the gap between representable float32 values is about
  // half a metre, so this separation is well under one step.
  const A: [number, number] = [500000, 4649776];
  const B: [number, number] = [500000.1, 4649776.1];

  it('rawBounds keeps full precision, measuring before anything is narrowed', () => {
    const bounds = rawBounds([point(...A), point(...B)])!;
    expect(bounds.minY).toBe(4649776);
    expect(bounds.maxY).toBe(4649776.1);
  });

  it('collapses two nearby points without an origin, and separates them with one', () => {
    // Straight into float32 the two land on the same vertex: the detail falls
    // between representable values and is simply gone.
    const naive = makePoints([point(...A), point(...B)], ZERO_ORIGIN);
    expect(naive.positions[3] - naive.positions[1]).toBe(0);

    const origin = originOf(rawBounds([point(...A), point(...B)])!);
    const offset = makePoints([point(...A), point(...B)], origin);
    expect(offset.positions[3] - offset.positions[1]).toBeCloseTo(0.1, 6);
  });

  it('places offset coordinates around zero, where float32 has digits to spare', () => {
    const geometries = [point(...A), point(...B)];
    const origin = originOf(rawBounds(geometries)!);
    const points = makePoints(geometries, origin);
    for (const value of points.positions) {
      expect(Math.abs(value)).toBeLessThan(1);
    }
  });

  it('keeps separate buckets in one frame when they share an origin', () => {
    const origin = originOf(rawBounds([point(...A), point(...B)])!);
    const asPoint = makePoints([point(...A)], origin);
    const asSegment = makeSegments([line([A, B])], origin);
    // the same world coordinate lands in the same place either way
    expect(asSegment.positions[0]).toBeCloseTo(asPoint.positions[0], 6);
    expect(asSegment.positions[1]).toBeCloseTo(asPoint.positions[1], 6);
  });
});

describe('boundsForMode', () => {
  const geometries = {
    zones: makePolygons([square()], ZERO_ORIGIN),
    network: makeSegments([line([[100, 100], [200, 200]])], ZERO_ORIGIN),
    desireLines: null,
    agents: makePoints([point(-50, -50)], ZERO_ORIGIN),
  };

  it('frames only the layer the mode draws, not everything loaded', () => {
    // The network reaches out to 200; framing zones against that would leave
    // the unit square a speck in the corner.
    expect(boundsForMode(geometries, 'zones')).toEqual({ minX: 0, minY: 0, maxX: 1, maxY: 1 });
    expect(boundsForMode(geometries, 'network')).toEqual({ minX: 100, minY: 100, maxX: 200, maxY: 200 });
    expect(boundsForMode(geometries, 'agents')).toEqual({ minX: -50, minY: -50, maxX: -50, maxY: -50 });
  });

  it('falls back to the zones basemap when no mode is chosen', () => {
    expect(boundsForMode(geometries, null)).toEqual({ minX: 0, minY: 0, maxX: 1, maxY: 1 });
  });

  it('falls back to the basemap when the mode has no geometry of its own', () => {
    expect(boundsForMode({ ...geometries, network: null }, 'network'))
      .toEqual({ minX: 0, minY: 0, maxX: 1, maxY: 1 });
  });

  it('falls back to everything when there is no basemap either', () => {
    const bounds = boundsForMode({ ...geometries, zones: null }, null);
    expect(bounds).toEqual({ minX: -50, minY: -50, maxX: 200, maxY: 200 });
  });
});
