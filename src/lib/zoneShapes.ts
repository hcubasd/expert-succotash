import earcut from 'earcut';
import type { Bounds, PolygonGeometry, PolygonRings } from './geometryMaker';
import { thinFromCentroid } from './thinning';

// Zones thin by moving their *points*, not by merging their areas.
//
// The earlier attempt tried to build a shared topology first -- work out which
// zones border which, dissolve the seams between merged ones, then simplify
// what was left. It rested on neighbouring polygons carrying bit-identical
// coordinates along their shared edge, which the real file does not reliably
// do, and what came out was a scatter of stray segments and floating shards.
//
// This drops the idea of a map-wide structure entirely. Every vertex of every
// ring is treated as its own point, all of them thinned together by the same
// walk every other layer uses, and each one then stands where its owner
// stands. Shapes are a consequence of where their points ended up: neighbours
// that shared a border approximately still collapse onto the same owners, so
// they still come out flush, without anyone having to prove they were
// adjacent. No coordinate is ever invented -- a point only ever moves to some
// other point's existing position.
//
// A ring that ends up with fewer than three distinct points has no area left
// to draw and simply goes. Nothing is merged into a neighbour, so a zone's
// value disappears with it; carrying that value somewhere else is a separate
// question from the geometry, and is not answered here.

// Coordinates the ring points actually stand on, deduplicated -- not to
// reconstruct any topology, just so two rings that happen to touch don't pay
// to thin the same point twice. Two ring vertices at the exact same
// coordinate are indistinguishable to the exclusion test (same distance to
// everything else, always), so merging them into one candidate changes
// nothing about the result and only removes redundant work. On the real
// file this is a real 2x: every interior boundary point is referenced by two
// zones. This is exact-key matching, the same as buildNodeGraph does for the
// road network, and it carries the same guarantee: it never guesses which
// points are "close enough", only merges points that are bit-identical.
type ZonePoints = {
  nodeX: Float64Array;
  nodeY: Float64Array;
  nodeCount: number;
  // Which node each raw ring vertex (by its position in rings.points) maps to.
  pointNode: Uint32Array;
};

// Depends only on the geometry, never the view, so it is built once per file
// load and reused for every zoom and every move of the detail control.
const pointsCache = new WeakMap<Float32Array, ZonePoints>();

function zonePointsOf(rings: PolygonRings): ZonePoints {
  const cached = pointsCache.get(rings.points);
  if (cached) return cached;

  const count = rings.points.length / 2;
  const ids = new Map<string, number>();
  const nodeX: number[] = [];
  const nodeY: number[] = [];
  const pointNode = new Uint32Array(count);

  for (let v = 0; v < count; v++) {
    const x = rings.points[v * 2];
    const y = rings.points[v * 2 + 1];
    const key = `${x},${y}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = nodeX.length;
      ids.set(key, id);
      nodeX.push(x);
      nodeY.push(y);
    }
    pointNode[v] = id;
  }

  const result: ZonePoints = {
    nodeX: Float64Array.from(nodeX),
    nodeY: Float64Array.from(nodeY),
    nodeCount: nodeX.length,
    pointNode,
  };
  pointsCache.set(rings.points, result);
  return result;
}

// Which nodes belong to rows the view can see. A row is taken whole: half of
// a ring thinned and half left where it was would tear the shape apart.
function visibleIn(geometry: PolygonGeometry, viewport: Bounds) {
  const { rings } = geometry;
  const points = zonePointsOf(rings);
  const parts: number[] = [];
  const visibleNode = new Uint8Array(points.nodeCount);

  for (let part = 0; part < rings.partCount; part++) {
    const row = rings.partRow[part];
    const minX = geometry.rowBounds[row * 4];
    const minY = geometry.rowBounds[row * 4 + 1];
    const maxX = geometry.rowBounds[row * 4 + 2];
    const maxY = geometry.rowBounds[row * 4 + 3];
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) continue;
    if (maxX < viewport.minX || minX > viewport.maxX) continue;
    if (maxY < viewport.minY || minY > viewport.maxY) continue;

    parts.push(part);
    const from = rings.ringStart[rings.partStart[part]];
    const to = rings.ringStart[rings.partStart[part + 1]];
    for (let v = from; v < to; v++) visibleNode[points.pointNode[v]] = 1;
  }

  const candidates: number[] = [];
  for (let n = 0; n < points.nodeCount; n++) if (visibleNode[n]) candidates.push(n);

  return { parts, candidates, points };
}

export type CollapsedZones = {
  // Triangles, x,y interleaved, retriangulated from the collapsed rings.
  fillPositions: Float32Array;
  // The table row each fill vertex came from, for colouring.
  fillRow: Uint32Array;
  // x1,y1,x2,y2 per surviving ring edge.
  borderPositions: Float32Array;
};

// Rewrite a ring in terms of which node each of its points now belongs to,
// and strip whatever that leaves behind that has no area.
//
// Two things have to go. Consecutive points that landed on the same owner are
// one point now, so they fold together. And a run that leaves a point and
// comes straight back -- A, B, A -- is a spike: the boundary walks out and
// returns along itself, enclosing nothing. Spikes are not a rare edge case
// here; a ring whose middle collapses but whose ends survive produces them
// constantly, and left in they draw as loose strokes standing off the shapes
// with no interior, which is exactly what a stray-segment mess looks like.
//
// Both fall out of one stack pass: fold when the top repeats, and pop when
// the point below the top is where we are heading, because that is the
// out-and-back. Owner *node ids* are compared rather than coordinates, since
// two points with the same owner are by definition in exactly the same place.
function collapseRing(
  rings: PolygonRings,
  pointNode: Uint32Array,
  ownerOfNode: Int32Array,
  ring: number,
  out: number[],
): number {
  out.length = 0;
  const from = rings.ringStart[ring];
  const to = rings.ringStart[ring + 1];
  if (to <= from) return 0;

  for (let v = from; v < to; v++) {
    const owner = ownerOfNode[pointNode[v]];
    if (owner < 0) continue;
    const depth = out.length;
    if (depth > 0 && out[depth - 1] === owner) continue;
    if (depth > 1 && out[depth - 2] === owner) {
      out.pop();
      continue;
    }
    out.push(owner);
  }

  // The ring closes, so the same two cases can straddle the join.
  for (;;) {
    const n = out.length;
    if (n < 3) break;
    if (out[0] === out[n - 1]) { out.pop(); continue; }
    if (out[n - 2] === out[0]) { out.pop(); continue; }
    if (out[1] === out[n - 1]) { out.shift(); continue; }
    break;
  }

  return out.length;
}

export function collapseZones(
  geometry: PolygonGeometry,
  viewport: Bounds,
  exclusion: number,
): CollapsedZones {
  // Nothing collapses at the exact floor -- d < 0 is never true -- so the
  // geometry is identical, point for point, to what makePolygons already
  // triangulated once at file load. Reusing that skips the thinning walk and
  // skips running earcut again over every one of the 6,600-odd parts, which
  // measured as the single most expensive thing this does: 423ms of the
  // 423ms it took at full detail was retriangulating shapes that hadn't
  // changed at all.
  if (!(exclusion > 0)) {
    return {
      fillPositions: geometry.fillPositions,
      fillRow: geometry.fillRowIndex,
      borderPositions: geometry.borderPositions,
    };
  }

  const { rings } = geometry;
  const { parts, candidates, points } = visibleIn(geometry, viewport);
  if (candidates.length === 0) {
    return {
      fillPositions: new Float32Array(0),
      fillRow: new Uint32Array(0),
      borderPositions: new Float32Array(0),
    };
  }

  const { owners } = thinFromCentroid(
    candidates,
    n => points.nodeX[n],
    n => points.nodeY[n],
    exclusion,
  );

  // owners is aligned to the candidate list; rings reach nodes through
  // pointNode, so this turns it round once rather than searching per vertex.
  const ownerOfNode = new Int32Array(points.nodeCount).fill(-1);
  for (let k = 0; k < candidates.length; k++) ownerOfNode[candidates[k]] = owners[k];

  const fill: number[] = [];
  const fillRow: number[] = [];
  const border: number[] = [];

  const collapsed: number[] = [];
  const flat: number[] = [];
  const holes: number[] = [];

  const emitBorder = (nodes: number[]) => {
    for (let i = 0; i < nodes.length; i++) {
      const owner = nodes[i];
      const next = nodes[(i + 1) % nodes.length];
      border.push(
        points.nodeX[owner], points.nodeY[owner],
        points.nodeX[next], points.nodeY[next],
      );
    }
  };

  for (const part of parts) {
    const firstRing = rings.partStart[part];
    const lastRing = rings.partStart[part + 1];
    const row = rings.partRow[part];

    // The shell decides whether the part survives at all; its holes are
    // optional and simply drop if they collapse.
    if (collapseRing(rings, points.pointNode, ownerOfNode, firstRing, collapsed) < 3) continue;
    emitBorder(collapsed);

    // A triangle with no holes needs no triangulating: there is exactly one
    // way to fill three points, and earcut's own setup -- building its
    // internal ring, walking it looking for ears -- costs more than just
    // emitting the three points directly. Holes are rare enough in the real
    // data (seven rings total, out of 6,661) that it isn't worth folding
    // them into this path rather than falling through to the general one.
    if (collapsed.length === 3 && lastRing === firstRing + 1) {
      fill.push(
        points.nodeX[collapsed[0]], points.nodeY[collapsed[0]],
        points.nodeX[collapsed[1]], points.nodeY[collapsed[1]],
        points.nodeX[collapsed[2]], points.nodeY[collapsed[2]],
      );
      fillRow.push(row, row, row);
      continue;
    }

    flat.length = 0;
    holes.length = 0;
    for (const owner of collapsed) flat.push(points.nodeX[owner], points.nodeY[owner]);

    for (let ring = firstRing + 1; ring < lastRing; ring++) {
      if (collapseRing(rings, points.pointNode, ownerOfNode, ring, collapsed) < 3) continue;
      emitBorder(collapsed);
      holes.push(flat.length / 2);
      for (const owner of collapsed) flat.push(points.nodeX[owner], points.nodeY[owner]);
    }

    for (const index of earcut(flat, holes.length ? holes : undefined, 2)) {
      fill.push(flat[index * 2], flat[index * 2 + 1]);
      fillRow.push(row);
    }
  }

  return {
    fillPositions: new Float32Array(fill),
    fillRow: new Uint32Array(fillRow),
    borderPositions: new Float32Array(border),
  };
}
