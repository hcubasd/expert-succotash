import type { Bounds } from './geometryMaker';
import { spanFromAnchor, thinFromCentroid } from './thinning';

// Desire lines consolidate the way the network does, with one thing removed:
// there is no flood. A road's ownership has to respect what is reachable
// along real links, which is why the network needs Dijkstra. A desire line is
// already a straight abstraction between two places with no path in between,
// so ownership is just "nearest kept endpoint" -- which the thinning walk
// hands back for free, since its grid search already finds the nearest kept
// point rather than the first one it happens to see.
//
// Origins and destinations pool into a single set of candidates. An agent's
// location is the same point whether it is sending or receiving, so one
// partition serves both ends of every line rather than one per direction.

const NONE = 0xffffffff;

export type EndpointPool = {
  x: Float64Array;
  y: Float64Array;
  count: number;
  // Which pooled endpoint each edge runs between; NONE if the edge had a
  // coordinate that wasn't finite.
  edgeA: Uint32Array;
  edgeB: Uint32Array;
  edgeCount: number;
};

// The pool depends only on the geometry, never on the view, so it survives
// every zoom and every move of the detail control. Keyed weakly off the
// positions array, so a reloaded file drops the old one.
const pools = new WeakMap<Float32Array, EndpointPool>();

export function endpointsOf(positions: Float32Array): EndpointPool {
  const cached = pools.get(positions);
  if (cached) return cached;

  const edgeCount = positions.length / 4;
  const ids = new Map<string, number>();
  const xs: number[] = [];
  const ys: number[] = [];
  const edgeA = new Uint32Array(edgeCount);
  const edgeB = new Uint32Array(edgeCount);

  // Endpoints come off a Float32Array, and a desire line's endpoints are
  // exactly an agent's coordinates, so two lines touching the same agent
  // really do carry bit-identical values -- an exact key is enough, with no
  // distance tolerance.
  const idOf = (x: number, y: number): number => {
    const key = `${x},${y}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = xs.length;
      ids.set(key, id);
      xs.push(x);
      ys.push(y);
    }
    return id;
  };

  for (let e = 0; e < edgeCount; e++) {
    const ax = positions[e * 4];
    const ay = positions[e * 4 + 1];
    const bx = positions[e * 4 + 2];
    const by = positions[e * 4 + 3];
    if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(bx) || !Number.isFinite(by)) {
      edgeA[e] = NONE;
      edgeB[e] = NONE;
      continue;
    }
    edgeA[e] = idOf(ax, ay);
    edgeB[e] = idOf(bx, by);
  }

  const pool: EndpointPool = {
    x: Float64Array.from(xs),
    y: Float64Array.from(ys),
    count: xs.length,
    edgeA,
    edgeB,
    edgeCount,
  };
  pools.set(positions, pool);
  return pool;
}

// An edge counts as visible if either end is on screen, so a line running off
// the edge of the view still draws rather than being cut at the frame -- the
// same rule the network uses.
function visibleIn(pool: EndpointPool, viewport: Bounds) {
  const onScreen = (i: number) =>
    pool.x[i] >= viewport.minX && pool.x[i] <= viewport.maxX &&
    pool.y[i] >= viewport.minY && pool.y[i] <= viewport.maxY;

  const visibleEdge = new Uint8Array(pool.edgeCount);
  const visibleEndpoint = new Uint8Array(pool.count);
  for (let e = 0; e < pool.edgeCount; e++) {
    const a = pool.edgeA[e];
    const b = pool.edgeB[e];
    if (a === NONE || b === NONE) continue;
    if (!onScreen(a) && !onScreen(b)) continue;
    visibleEdge[e] = 1;
    visibleEndpoint[a] = 1;
    visibleEndpoint[b] = 1;
  }

  const candidates: number[] = [];
  for (let i = 0; i < pool.count; i++) if (visibleEndpoint[i]) candidates.push(i);
  return { candidates, visibleEdge };
}

// The coarsest useful exclusion for this view: the exact distance leaving the
// anchor and the single endpoint farthest from it. See spanFromAnchor.
export function maxDesireSpacing(positions: Float32Array, viewport: Bounds): number {
  const pool = endpointsOf(positions);
  const { candidates } = visibleIn(pool, viewport);
  return spanFromAnchor(candidates, i => pool.x[i], i => pool.y[i]);
}

export type ConsolidatedFlow = {
  // x1,y1,x2,y2 per surviving edge -- straight, bucket to bucket. Doubles as
  // the endpoint list for the joins, since it is already a list of x,y pairs.
  positions: Float32Array;
  // One summed quantity per edge, fed to the GPU accumulator exactly as the
  // unconsolidated quantities are.
  quantities: Float32Array;
};

// Every line's two endpoints are replaced by whichever bucket absorbed them,
// and lines that end up between the same pair of buckets sum together.
//
// A line whose two ends land in the *same* bucket is dropped: that is flow
// entirely internal to one cluster, with no two places left to draw between.
// So unlike the agents, the total here is not preserved as the view coarsens
// -- internal flow leaves the picture, exactly as the network's interior
// links do.
export function consolidateDesireLines(
  positions: Float32Array,
  quantities: Float32Array,
  viewport: Bounds,
  exclusion: number,
): ConsolidatedFlow {
  const pool = endpointsOf(positions);
  const { candidates, visibleEdge } = visibleIn(pool, viewport);
  if (candidates.length === 0) {
    return { positions: new Float32Array(0), quantities: new Float32Array(0) };
  }

  const { owners } = thinFromCentroid(candidates, i => pool.x[i], i => pool.y[i], exclusion);

  // owners is aligned to the candidate list; edges reference pooled endpoint
  // ids, so this indexes it the other way round once rather than searching
  // per edge. -1 marks an endpoint that was never a candidate.
  const ownerOf = new Int32Array(pool.count).fill(-1);
  for (let k = 0; k < candidates.length; k++) ownerOf[candidates[k]] = owners[k];

  const totals = new Map<number, { sum: number; a: number; b: number }>();
  for (let e = 0; e < pool.edgeCount; e++) {
    if (!visibleEdge[e]) continue;
    const ownerA = ownerOf[pool.edgeA[e]];
    const ownerB = ownerOf[pool.edgeB[e]];
    if (ownerA < 0 || ownerB < 0 || ownerA === ownerB) continue;

    const quantity = quantities[e];
    if (!Number.isFinite(quantity)) continue;

    const low = Math.min(ownerA, ownerB);
    const high = Math.max(ownerA, ownerB);
    const key = low * pool.count + high;
    const entry = totals.get(key);
    if (entry) entry.sum += quantity;
    else totals.set(key, { sum: quantity, a: low, b: high });
  }

  const out = new Float32Array(totals.size * 4);
  const sums = new Float32Array(totals.size);
  let at = 0;
  for (const { sum, a, b } of totals.values()) {
    out[at * 4] = pool.x[a];
    out[at * 4 + 1] = pool.y[a];
    out[at * 4 + 2] = pool.x[b];
    out[at * 4 + 3] = pool.y[b];
    sums[at] = sum;
    at++;
  }

  return { positions: out, quantities: sums };
}
