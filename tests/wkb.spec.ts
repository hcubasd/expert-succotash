import { describe, expect, it } from 'vitest';
import { parseWkb } from '../src/lib/gpkgLoader';

// Hand-built little-endian WKB, byte for byte, so these tests don't need a
// real SQLite/GeoPackage file on disk -- exactly the encoding sql.js hands
// back from a geom blob, minus the GeoPackage envelope header.
function u32(n: number): number[] {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return [...b];
}
function f64(n: number): number[] {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, n, true);
  return [...b];
}
function point(x: number, y: number, type = 1): number[] {
  return [1, ...u32(type), ...f64(x), ...f64(y)];
}
function lineString(coords: [number, number][], type = 2): number[] {
  const bytes = [1, ...u32(type), ...u32(coords.length)];
  for (const [x, y] of coords) bytes.push(...f64(x), ...f64(y));
  return bytes;
}
function polygon(rings: [number, number][][], type = 3): number[] {
  const bytes = [1, ...u32(type), ...u32(rings.length)];
  for (const ring of rings) {
    bytes.push(...u32(ring.length));
    for (const [x, y] of ring) bytes.push(...f64(x), ...f64(y));
  }
  return bytes;
}
function multi(type: number, parts: number[][]): number[] {
  const bytes = [1, ...u32(type), ...u32(parts.length)];
  for (const part of parts) bytes.push(...part);
  return bytes;
}
const bytesOf = (wkb: number[]) => new Uint8Array(wkb);

describe('parseWkb', () => {
  it('reads a Point', () => {
    const { geometry, end } = parseWkb(bytesOf(point(1.5, -2.5)), 0);
    expect(geometry).toEqual({ type: 'Point', coordinates: [1.5, -2.5] });
    expect(end).toBe(21); // 1 byte order + 4 type + 8 + 8
  });

  it('reads a LineString', () => {
    const { geometry } = parseWkb(bytesOf(lineString([[0, 0], [1, 1], [2, 4]])), 0);
    expect(geometry).toEqual({ type: 'LineString', coordinates: [[0, 0], [1, 1], [2, 4]] });
  });

  it('reads a Polygon with a hole', () => {
    const outer: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const hole: [number, number][] = [[2, 2], [4, 2], [4, 4]];
    const { geometry } = parseWkb(bytesOf(polygon([outer, hole])), 0);
    expect(geometry).toEqual({ type: 'Polygon', coordinates: [outer, hole] });
  });

  it('reads a MultiPolygon -- the exact shape that broke on a real zones.gpkg', () => {
    // A zone with a disjoint exclave: two separate polygon parts, one value.
    const main: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const exclave: [number, number][] = [[20, 20], [21, 20], [21, 21]];
    const wkb = multi(6, [polygon([main]), polygon([exclave])]);
    const { geometry } = parseWkb(bytesOf(wkb), 0);
    expect(geometry).toEqual({ type: 'MultiPolygon', coordinates: [[main], [exclave]] });
  });

  it('reads a MultiLineString', () => {
    const a: [number, number][] = [[0, 0], [1, 0]];
    const b: [number, number][] = [[5, 5], [6, 5], [7, 5]];
    const { geometry } = parseWkb(bytesOf(multi(5, [lineString(a), lineString(b)])), 0);
    expect(geometry).toEqual({ type: 'MultiLineString', coordinates: [a, b] });
  });

  it('reads a MultiPoint', () => {
    const { geometry } = parseWkb(bytesOf(multi(4, [point(1, 2), point(3, 4)])), 0);
    expect(geometry).toEqual({ type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] });
  });

  it('returns null for an unrecognized geometry type rather than throwing', () => {
    const { geometry } = parseWkb(bytesOf([1, ...u32(99)]), 0);
    expect(geometry).toBeNull();
  });

  it('big-endian WKB (byte order 0) reads the same as little-endian', () => {
    const be = [0, 0, 0, 0, 1]; // byte order 0, type 1 big-endian
    const coords = new Uint8Array(16);
    new DataView(coords.buffer).setFloat64(0, 7.5, false);
    new DataView(coords.buffer).setFloat64(8, -3.5, false);
    const { geometry } = parseWkb(new Uint8Array([...be, ...coords]), 0);
    expect(geometry).toEqual({ type: 'Point', coordinates: [7.5, -3.5] });
  });

  it("consumes exactly the parent's declared part count, ignoring trailing bytes", () => {
    // Two points worth of data, but the multipoint only claims one -- `end`
    // must stop after the first, which is what lets a Multi* parser inside a
    // GeoPackageBlob know where the next sibling geometry begins.
    const wkb = [1, ...u32(4), ...u32(1), ...point(1, 1), ...point(9, 9)];
    const { geometry, end } = parseWkb(bytesOf(wkb), 0);
    expect(geometry).toEqual({ type: 'MultiPoint', coordinates: [[1, 1]] });
    expect(end).toBe(1 + 4 + 4 + 21); // header + count + one consumed point
  });
});
