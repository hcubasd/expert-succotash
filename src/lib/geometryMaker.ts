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

// minX, minY, maxX, maxY per row. What lets a view decide which features are
// on screen without touching their geometry again -- the ramps are equalized
// over what's visible, so this is read on every zoom.
export type RowBounds = Float32Array;

export type PolygonGeometry = {
  rowCount: number;
  // Triangulated interiors, every polygon in one buffer: x,y interleaved.
  fillPositions: Float32Array;
  fillRowIndex: Uint32Array;
  fillColors: Uint8Array;
  // Ring edges as explicit vertex pairs, so every polygon's border batches
  // into a single draw call (LINE_LOOP would need one call per ring).
  borderPositions: Float32Array;
  // Per segment, not per vertex -- see SegmentGeometry.
  borderRowIndex: Uint32Array;
  borderColors: Uint8Array;
  rowBounds: RowBounds;
};

export type SegmentGeometry = {
  rowCount: number;
  // Endpoint pairs, x1,y1,x2,y2 per segment. A polyline is decomposed into
  // its segments here rather than at render time, which also means this
  // doubles as the per-instance attribute layout: start reads at offset 0
  // and end at offset 8 of the same 16-byte stride.
  positions: Float32Array;
  // One entry per segment -- the segment is the instance, so a color can't
  // vary along a line even in principle.
  rowIndex: Uint32Array;
  colors: Uint8Array;
  rowBounds: RowBounds;
};

// Desire lines, collapsed per resource. A->B and B->A are the same flow seen
// from two ends, so they fold into one edge with their quantities summed --
// and since a coordinate pair identifies an agent pair exactly (agent
// positions are unique, verified across both real datasets), this needs
// nothing but the desire-lines file itself: no agent ids, no join.
export type EdgeGeometry = {
  // x1,y1,x2,y2 per edge, same layout the segment buffers use.
  positions: Float32Array;
  // One summed quantity per edge; the GPU accumulates these per pixel.
  quantities: Float32Array;
};

export type PointGeometry = {
  rowCount: number;
  positions: Float32Array;
  colors: Uint8Array;
};

export type Geometries = {
  zones: PolygonGeometry | null;
  network: SegmentGeometry | null;
  // Keyed by resource: only ever one is drawn at a time, and each is already
  // collapsed and summed, so switching resource is a lookup rather than a
  // rebuild.
  desireLines: Map<string, EdgeGeometry> | null;
  agents: PointGeometry | null;
};

export function emptyGeometries(): Geometries {
  return { zones: null, network: null, desireLines: null, agents: null };
}

function boundsPerRow(rowCount: number, elements: number, rowIndex: Uint32Array, read: (element: number, corner: number) => [number, number]): RowBounds {
  const out = new Float32Array(rowCount * 4);
  for (let row = 0; row < rowCount; row++) {
    out[row * 4] = Infinity;
    out[row * 4 + 1] = Infinity;
    out[row * 4 + 2] = -Infinity;
    out[row * 4 + 3] = -Infinity;
  }
  for (let element = 0; element < elements; element++) {
    const row = rowIndex[element];
    for (let corner = 0; corner < 2; corner++) {
      const [x, y] = read(element, corner);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < out[row * 4]) out[row * 4] = x;
      if (y < out[row * 4 + 1]) out[row * 4 + 1] = y;
      if (x > out[row * 4 + 2]) out[row * 4 + 2] = x;
      if (y > out[row * 4 + 3]) out[row * 4 + 3] = y;
    }
  }
  return out;
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
          borderRow.push(row);
        }
      }
    }
  });

  const fillPositions = new Float32Array(fill);
  const fillRowIndex = new Uint32Array(fillRow);
  return {
    rowCount: geometries.length,
    fillPositions,
    fillRowIndex,
    fillColors: new Uint8Array((fill.length / 2) * 3),
    borderPositions: new Float32Array(border),
    borderRowIndex: new Uint32Array(borderRow),
    borderColors: new Uint8Array((border.length / 4) * 3),
    // Measured off the fill triangles: they cover the polygon's interior, so
    // their extent is the row's extent, and the border traces the same rings.
    rowBounds: boundsPerRow(
      geometries.length,
      fillPositions.length / 2,
      fillRowIndex,
      (vertex) => [fillPositions[vertex * 2], fillPositions[vertex * 2 + 1]],
    ),
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
        rowIndex.push(row);
      }
    }
  });

  const segmentCount = positions.length / 4;
  const flat = new Float32Array(positions);
  const rows = new Uint32Array(rowIndex);
  return {
    rowCount: geometries.length,
    positions: flat,
    rowIndex: rows,
    colors: new Uint8Array(segmentCount * 3),
    rowBounds: boundsPerRow(
      geometries.length,
      segmentCount,
      rows,
      (segment, corner) => [flat[segment * 4 + corner * 2], flat[segment * 4 + corner * 2 + 1]],
    ),
  };
}

// Collapse a resource's desire lines into unique undirected edges. The key is
// the coordinate pair itself rather than an agent id pair: agent positions
// are unique, and a line's endpoints are exactly an agent's coordinates, so
// the two are equivalent -- checked against both the synthetic fixture and a
// whole-country dataset, identical edge counts for every resource.
export function makeDesireLineEdges(
  geometries: RawGeometry[],
  resources: string[],
  quantities: Float64Array,
  origin: Origin,
): Map<string, EdgeGeometry> {
  type Edge = { x1: number; y1: number; x2: number; y2: number; quantity: number };
  const byResource = new Map<string, Map<string, Edge>>();

  geometries.forEach((geometry, row) => {
    const spans = lineStrings(geometry);
    if (spans.length === 0) return;
    const coords = spans[0];
    if (coords.length < 2) return;

    const [x1, y1] = coords[0];
    const [x2, y2] = coords[coords.length - 1];
    const quantity = quantities[row];
    if (!Number.isFinite(quantity)) return;

    const resource = resources[row];
    let edges = byResource.get(resource);
    if (!edges) {
      edges = new Map<string, Edge>();
      byResource.set(resource, edges);
    }

    // Order-independent key, so A->B and B->A land on the same entry.
    const a = `${x1},${y1}`;
    const b = `${x2},${y2}`;
    const key = a <= b ? `${a}|${b}` : `${b}|${a}`;

    const existing = edges.get(key);
    if (existing) existing.quantity += quantity;
    else edges.set(key, { x1, y1, x2, y2, quantity });
  });

  const out = new Map<string, EdgeGeometry>();
  for (const [resource, edges] of byResource) {
    const positions = new Float32Array(edges.size * 4);
    const quantityOf = new Float32Array(edges.size);
    let i = 0;
    for (const edge of edges.values()) {
      positions[i * 4] = edge.x1 - origin.x;
      positions[i * 4 + 1] = edge.y1 - origin.y;
      positions[i * 4 + 2] = edge.x2 - origin.x;
      positions[i * 4 + 3] = edge.y2 - origin.y;
      quantityOf[i] = edge.quantity;
      i++;
    }
    out.set(resource, { positions, quantities: quantityOf });
  }
  return out;
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
  if (geometries.agents) scan(geometries.agents.positions);
  if (geometries.desireLines) {
    for (const edges of geometries.desireLines.values()) scan(edges.positions);
  }

  if (minX > maxX || minY > maxY) return null;
  return { minX, minY, maxX, maxY };
}
