import { describe, expect, it } from 'vitest';
import { ZERO_ORIGIN, makePolygons } from '../src/lib/geometryMaker';
import type { RawGeometry } from '../src/lib/rawTable';
import { collapseZones } from '../src/lib/zoneShapes';

const WIDE = { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 };
const polygon = (...rings: [number, number][][]): RawGeometry => ({ type: 'Polygon', coordinates: rings });
const square: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
const geometryOf = (...parts: RawGeometry[]) => makePolygons(parts, ZERO_ORIGIN);

const triangles = (c: { fillPositions: Float32Array }) => c.fillPositions.length / 6;
const edges = (c: { borderPositions: Float32Array }) => c.borderPositions.length / 4;

describe('collapseZones', () => {
  it('leaves the shape exactly as it was at exclusion zero', () => {
    // The fine end has to be the original geometry, the same as every other
    // layer: nothing merges, so nothing about the outline can change.
    const collapsed = collapseZones(geometryOf(polygon(square)), WIDE, 0);
    expect(triangles(collapsed)).toBe(2);
    expect(edges(collapsed)).toBe(4);
  });

  it('folds points that landed on the same owner into one', () => {
    // Two corners close enough to collapse together leave a triangle, not a
    // square with a doubled corner.
    const nearlyTriangular: [number, number][] = [[0, 0], [0.1, 0.1], [10, 0], [0, 10]];
    const collapsed = collapseZones(geometryOf(polygon(nearlyTriangular)), WIDE, 1);
    expect(triangles(collapsed)).toBe(1);
    expect(edges(collapsed)).toBe(3);
  });

  it('strips a spike rather than drawing a stroke enclosing nothing', () => {
    // The middle point collapses back onto the first, so the boundary walks
    // out to (10,0) and straight back. Left in, that draws as a loose stroke
    // standing off the shape -- the stray-segment mess. It should simply go,
    // leaving the triangle that is actually there.
    const spiky: [number, number][] = [[0, 0], [10, 0], [0.1, 0.1], [0, 10], [10, 10]];
    const collapsed = collapseZones(geometryOf(polygon(spiky)), WIDE, 1);
    expect(triangles(collapsed)).toBe(1);
    expect(edges(collapsed)).toBe(3);
  });

  it('drops a ring left with fewer than three distinct points', () => {
    // A line or a point has no area to draw, so the zone goes rather than
    // being merged into anyone.
    const collapsed = collapseZones(geometryOf(polygon(square)), WIDE, 1e9);
    expect(triangles(collapsed)).toBe(0);
    expect(edges(collapsed)).toBe(0);
  });

  it('keeps a hole only while it still has area of its own', () => {
    const shell: [number, number][] = [[0, 0], [100, 0], [100, 100], [0, 100]];
    const pinhole: [number, number][] = [[40, 40], [41, 40], [41, 41], [40, 41]];
    const withHole = geometryOf(polygon(shell, pinhole));

    // Intact at full detail: the hole is really there.
    expect(edges(collapseZones(withHole, WIDE, 0))).toBe(8);

    // Once the hole collapses the shell is still a square, and its outline
    // must not carry the hole's leftovers.
    const coarse = collapseZones(withHole, WIDE, 5);
    expect(edges(coarse)).toBe(4);
    expect(triangles(coarse)).toBe(2);
  });

  it('leaves out parts the viewport does not reach, once anything actually collapses', () => {
    const far: [number, number][] = [[900, 900], [910, 900], [910, 910], [900, 910]];
    const both = geometryOf(polygon(square), polygon(far));
    const near = { minX: -1, minY: -1, maxX: 20, maxY: 20 };
    expect(triangles(collapseZones(both, near, 1))).toBe(2);
    expect(triangles(collapseZones(both, WIDE, 1))).toBe(4);
  });

  it('has nothing to draw when the viewport is empty, once anything actually collapses', () => {
    const collapsed = collapseZones(geometryOf(polygon(square)), { minX: 500, minY: 500, maxX: 501, maxY: 501 }, 1);
    expect(triangles(collapsed)).toBe(0);
  });

  it('ignores the viewport at the exact floor, the same way the rest of the app lets the GPU clip', () => {
    // Nothing to collapse means nothing to filter either -- this is the fast
    // path that reuses makePolygons' own triangulation untouched, and that
    // triangulation was never viewport-dependent to begin with.
    const far: [number, number][] = [[900, 900], [910, 900], [910, 910], [900, 910]];
    const both = geometryOf(polygon(square), polygon(far));
    const empty = { minX: 500, minY: 500, maxX: 501, maxY: 501 };
    expect(triangles(collapseZones(both, empty, 0))).toBe(4);
  });

  it('reuses the geometry\'s own triangulation exactly at the floor, not a recomputed copy', () => {
    const geometry = geometryOf(polygon(square));
    const collapsed = collapseZones(geometry, WIDE, 0);
    expect(collapsed.fillPositions).toBe(geometry.fillPositions);
    expect(collapsed.fillRow).toBe(geometry.fillRowIndex);
    expect(collapsed.borderPositions).toBe(geometry.borderPositions);
  });
});
