import earcut from 'earcut';
import type { RawGeometry } from './rawTable';

// Everything expensive happens here, once, when a file loads: triangulating
// polygons, decomposing polylines into segments, flattening coordinates into
// the exact interleaved layout a GPU vertex buffer wants. Mounting the map is
// then only an upload -- no per-mount computation, no per-frame conversion.
//
// Every bucket carries a rowIndex per vertex so recoloring can scatter a
// per-row color array back onto vertices without re-deriving the mapping.

export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

// Vertex buffers are float32, which carries about seven significant digits.
// Real projected coordinates spend nearly all of them on magnitude: at a UTM
// northing around 4,600,000 m consecutive float32 values are half a metre
// apart, so two agents on the same street would land on the same vertex and
// the whole scene would snap to a coarse grid once zoomed in.
//
// So every coordinate is stored relative to an origin, subtracted in float64
// while the full precision is still there. Offsets are small, which puts the
// float32 digits back onto detail instead of magnitude. The origin is chosen
// once for a session and shared by every file, so buckets stay in a common
// frame; nothing downstream ever needs absolute coordinates, since the map
// only draws them.
export type Origin = { x: number; y: number };

export const ZERO_ORIGIN: Origin = { x: 0, y: 0 };

// Bounds of the untouched input, in full double precision -- this is what the
// origin is picked from, before anything is narrowed to float32.
export function rawBounds(geometries: RawGeometry[]): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const visit = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  const visitLine = (line: [number, number][]) => {
    for (const [x, y] of line) visit(x, y);
  };
  const visitPolygon = (rings: [number, number][][]) => {
    for (const ring of rings) visitLine(ring);
  };

  for (const geometry of geometries) {
    if (!geometry) continue;
    if (geometry.type === 'Point') visit(geometry.coordinates[0], geometry.coordinates[1]);
    else if (geometry.type === 'LineString') visitLine(geometry.coordinates);
    else if (geometry.type === 'Polygon') visitPolygon(geometry.coordinates);
    else if (geometry.type === 'MultiPoint') for (const [x, y] of geometry.coordinates) visit(x, y);
    else if (geometry.type === 'MultiLineString') for (const line of geometry.coordinates) visitLine(line);
    else for (const polygon of geometry.coordinates) visitPolygon(polygon);
  }

  if (minX > maxX || minY > maxY) return null;
  return { minX, minY, maxX, maxY };
}

export function originOf(bounds: Bounds): Origin {
  return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
}

export type PolygonGeometry = {
  rowCount: number;
  // Triangulated interiors, every polygon in one buffer: x,y interleaved.
  fillPositions: Float32Array;
  fillRowIndex: Uint32Array;
  fillColors: Uint8Array;
  // Ring edges as explicit vertex pairs, so every polygon's border batches
  // into a single draw call (LINE_LOOP would need one call per ring).
  borderPositions: Float32Array;
  borderRowIndex: Uint32Array;
  borderColors: Uint8Array;
};

export type SegmentGeometry = {
  rowCount: number;
  // Two vertices per segment. A polyline is decomposed into its segments here
  // rather than at render time: gl.LINES only ever wants segments, and doing
  // it once means the renderer never needs polyline-aware logic.
  positions: Float32Array;
  rowIndex: Uint32Array;
  colors: Uint8Array;
  // Wheel index per vertex, for the hue-averaging blend path. Kept alongside
  // rgb rather than instead of it because the two render paths want different
  // things: opaque drawing wants color, accumulation wants an angle.
  hues: Uint8Array;
};

export type PointGeometry = {
  rowCount: number;
  positions: Float32Array;
  colors: Uint8Array;
};

export type Geometries = {
  zones: PolygonGeometry | null;
  network: SegmentGeometry | null;
  desireLines: SegmentGeometry | null;
  agents: PointGeometry | null;
};

export function emptyGeometries(): Geometries {
  return { zones: null, network: null, desireLines: null, agents: null };
}

// One row's worth of polygon parts -- a plain Polygon is one part, a
// MultiPolygon is however many the file gave it. A disjoint exclave under
// one zone_id is more geometry for that row, not a second row.
function polygonParts(geometry: RawGeometry): [number, number][][][] {
  if (geometry?.type === 'Polygon') return [geometry.coordinates];
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

export function makePolygons(geometries: RawGeometry[], origin: Origin): PolygonGeometry {
  const fill: number[] = [];
  const fillRow: number[] = [];
  const border: number[] = [];
  const borderRow: number[] = [];

  geometries.forEach((geometry, row) => {
    for (const rings of polygonParts(geometry)) {
      if (rings.length === 0) continue;

      // earcut wants one flat coordinate array plus the start index of each
      // hole; rings past the first are holes.
      const flat: number[] = [];
      const holes: number[] = [];
      rings.forEach((ring, r) => {
        if (r > 0) holes.push(flat.length / 2);
        for (const [x, y] of ring) flat.push(x - origin.x, y - origin.y);
      });

      for (const index of earcut(flat, holes.length ? holes : undefined, 2)) {
        fill.push(flat[index * 2], flat[index * 2 + 1]);
        fillRow.push(row);
      }

      for (const ring of rings) {
        for (let i = 0; i < ring.length; i++) {
          const [x1, y1] = ring[i];
          const [x2, y2] = ring[(i + 1) % ring.length];
          border.push(x1 - origin.x, y1 - origin.y, x2 - origin.x, y2 - origin.y);
          borderRow.push(row, row);
        }
      }
    }
  });

  return {
    rowCount: geometries.length,
    fillPositions: new Float32Array(fill),
    fillRowIndex: new Uint32Array(fillRow),
    fillColors: new Uint8Array((fill.length / 2) * 3),
    borderPositions: new Float32Array(border),
    borderRowIndex: new Uint32Array(borderRow),
    borderColors: new Uint8Array((border.length / 2) * 3),
  };
}

// A plain LineString is one span, a MultiLineString is however many the
// file gave it -- all decomposed into segments belonging to the same row.
function lineStrings(geometry: RawGeometry): [number, number][][] {
  if (geometry?.type === 'LineString') return [geometry.coordinates];
  if (geometry?.type === 'MultiLineString') return geometry.coordinates;
  return [];
}

export function makeSegments(geometries: RawGeometry[], origin: Origin): SegmentGeometry {
  const positions: number[] = [];
  const rowIndex: number[] = [];

  geometries.forEach((geometry, row) => {
    for (const coords of lineStrings(geometry)) {
      for (let i = 0; i + 1 < coords.length; i++) {
        const [x1, y1] = coords[i];
        const [x2, y2] = coords[i + 1];
        positions.push(x1 - origin.x, y1 - origin.y, x2 - origin.x, y2 - origin.y);
        rowIndex.push(row, row);
      }
    }
  });

  const vertexCount = positions.length / 2;
  return {
    rowCount: geometries.length,
    positions: new Float32Array(positions),
    rowIndex: new Uint32Array(rowIndex),
    colors: new Uint8Array(vertexCount * 3),
    hues: new Uint8Array(vertexCount),
  };
}

export function makePoints(geometries: RawGeometry[], origin: Origin): PointGeometry {
  const positions: number[] = [];

  for (const geometry of geometries) {
    // An agent is inherently one place, so unlike segments/polygons this
    // doesn't grow into a many-vertices-per-row model for MultiPoint -- the
    // first part is used and any further ones are dropped. Keeps the
    // row/vertex correspondence 1:1 even for a missing geometry, so a
    // point's index is always its row index.
    const point =
      geometry?.type === 'Point' ? geometry.coordinates
      : geometry?.type === 'MultiPoint' ? geometry.coordinates[0]
      : null;
    if (!point) {
      positions.push(NaN, NaN);
      continue;
    }
    positions.push(point[0] - origin.x, point[1] - origin.y);
  }

  return {
    rowCount: geometries.length,
    positions: new Float32Array(positions),
    colors: new Uint8Array(geometries.length * 3),
  };
}

export function boundsOf(geometries: Geometries): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const scan = (positions: Float32Array) => {
    for (let i = 0; i + 1 < positions.length; i += 2) {
      const x = positions[i];
      const y = positions[i + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  };

  if (geometries.zones) scan(geometries.zones.fillPositions);
  if (geometries.zones) scan(geometries.zones.borderPositions);
  if (geometries.network) scan(geometries.network.positions);
  if (geometries.desireLines) scan(geometries.desireLines.positions);
  if (geometries.agents) scan(geometries.agents.positions);

  if (minX > maxX || minY > maxY) return null;
  return { minX, minY, maxX, maxY };
}
