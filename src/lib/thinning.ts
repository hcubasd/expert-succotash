// Picking a spread-out subset of points, shared by every layer that thins
// because it is literally the same problem each time: start from the middle
// of what's on screen, work outward, and keep a point only if nothing already
// kept is too close to it.
//
// Walking outward from the centroid rather than in file order is what makes
// the result stable and centred -- the densest middle of the data decides the
// layout, and the sparse edges fill in around whatever survived, instead of
// the outcome depending on which row happened to be written first.

// The anchor is whichever candidate sits closest to their centroid: the
// first point the walk below keeps, since nothing has been kept yet to
// exclude it, and therefore what every other candidate is measured against
// once the walk begins.
export function anchorOf(
  candidates: number[],
  xOf: (i: number) => number,
  yOf: (i: number) => number,
): number {
  let sumX = 0;
  let sumY = 0;
  for (const i of candidates) {
    sumX += xOf(i);
    sumY += yOf(i);
  }
  const centroidX = sumX / candidates.length;
  const centroidY = sumY / candidates.length;

  let anchor = candidates[0];
  let best = Infinity;
  for (const i of candidates) {
    const d = (xOf(i) - centroidX) ** 2 + (yOf(i) - centroidY) ** 2;
    if (d < best) {
      best = d;
      anchor = i;
    }
  }
  return anchor;
}

// The exact exclusion distance that leaves a given number of points standing.
//
// At `survivors = 2` that is the distance from the anchor to the farthest
// candidate. That point is *the* farthest by construction, so at exactly this
// distance it sits precisely on the exclusion boundary -- and the boundary is
// safe, because the test below is a strict less-than: a kept point excludes a
// candidate only when the candidate is strictly closer than the exclusion,
// never when it is exactly on it. Every other candidate is strictly closer
// than this one by definition of "farthest", so every other candidate falls
// on the excluded side and this one alone survives beside the anchor.
//
// At `survivors = 3` it is the runner-up distance instead, which is what a
// layer made of areas needs: two points can only ever describe a line, so a
// polygon layer has to stop one step earlier to have a triangle left at all.
// Three is generic rather than guaranteed -- if the two farthest points
// happen to fall within this distance of *each other*, one still excludes the
// other -- but that takes a coincidence between two specific points rather
// than being the ordinary case.
//
// Never round this. Rounding up pushes the boundary past the deciding point
// and excludes it too; rounding down pulls the boundary in front of it
// without regard to what else lives in the gap, which lets an arbitrary,
// data-dependent handful through together.
//
// This is deliberately not the distance between the two most extreme points
// either. The walk never anchors on an extreme point, only on whichever is
// nearest the middle, so the diameter overshoots.
export function spanFromAnchor(
  candidates: number[],
  xOf: (i: number) => number,
  yOf: (i: number) => number,
  survivors = 2,
): number {
  if (candidates.length === 0) return 0;
  const anchor = anchorOf(candidates, xOf, yOf);
  const anchorX = xOf(anchor);
  const anchorY = yOf(anchor);

  let farthest = 0;
  let runnerUp = 0;
  for (const i of candidates) {
    const d = Math.hypot(xOf(i) - anchorX, yOf(i) - anchorY);
    if (d > farthest) {
      runnerUp = farthest;
      farthest = d;
    } else if (d > runnerUp) {
      runnerUp = d;
    }
  }
  return survivors >= 3 ? runnerUp : farthest;
}

export type Thinned = {
  // The points that survived, anchor first and then outward.
  kept: number[];
  // owners[k] is the candidate that absorbed candidates[k]; a kept candidate
  // owns itself. Aligned to the candidates array rather than keyed by id: on
  // a layer with a million points, filling a Map costs more than the whole
  // grid search it would sit beside.
  owners: Int32Array;
};

// A cell's key, packed into one integer rather than a string. Nine of these
// are built per candidate, so at a million points that is nearly ten million
// allocations if they are strings -- measured in seconds, and once the single
// largest cost in here. Hash collisions are harmless: two unrelated cells
// sharing a bucket only adds distance checks that then fail, and the nine
// lookups still reach every cell that could hold a real neighbour.
function cellKey(cx: number, cy: number): number {
  return (Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663)) | 0;
}

// How finely the outward ordering is resolved. A comparator sort costs about
// n log n comparisons -- a third of a second at a million points, measured --
// where bucketing by distance is two linear passes. Points that land in the
// same bucket come out in arbitrary order relative to each other, but they
// sit within one part in 65536 of the same radius, so nothing downstream can
// tell the difference. The anchor is placed first explicitly rather than left
// to its bucket, which is what keeps spanFromAnchor's exact guarantee intact.
const ORDER_BUCKETS = 65536;

// Any already-kept point within the exclusion distance blocks a candidate --
// not just the previously kept one, since a point can sit far from the last
// thing kept and still land on top of something kept several steps earlier.
// Checking that against every kept point directly would be quadratic, so
// points go into a uniform grid sized to the exclusion distance: anything
// close enough to conflict must be in the same cell or one of the eight
// around it. The grid changes nothing about which points survive, only how
// long it takes to find out.
//
// The scan finds the *nearest* blocking point rather than stopping at the
// first one found. Which point blocks is arbitrary when the answer is only
// "is it blocked", but it decides where an absorbed value goes, and that
// should be the circle actually covering the point rather than whichever
// cell the grid happened to visit first. The extra work is bounded: kept
// points are at least one exclusion apart by construction, so only a handful
// can ever sit in the nine cells being searched.
export function thinFromCentroid(
  candidates: number[],
  xOf: (i: number) => number,
  yOf: (i: number) => number,
  exclusion: number,
): Thinned {
  const count = candidates.length;
  const owners = new Int32Array(count);
  if (count === 0) return { kept: [], owners };

  // A radius of exactly zero excludes nothing, since d < 0 is never true, so
  // there is no grid to build and no neighbour worth searching for. Worth its
  // own path rather than falling through the general one: it is the entire
  // fine end of the detail control, and it is exactly where the general path
  // is slowest, because every point survives and so every point lands in the
  // grid.
  if (!(exclusion > 0)) {
    for (let k = 0; k < count; k++) owners[k] = candidates[k];
    return { kept: candidates.slice(), owners };
  }

  const anchor = anchorOf(candidates, xOf, yOf);
  const anchorX = xOf(anchor);
  const anchorY = yOf(anchor);

  let anchorAt = 0;
  const distances = new Float64Array(count);
  let farthest = 0;
  for (let k = 0; k < count; k++) {
    const i = candidates[k];
    if (i === anchor) anchorAt = k;
    const d = Math.hypot(xOf(i) - anchorX, yOf(i) - anchorY);
    distances[k] = d;
    if (d > farthest) farthest = d;
  }

  // Counting sort by distance: tally each bucket, turn the tallies into start
  // offsets, then place. Slot zero is reserved for the anchor.
  const scale = farthest > 0 ? (ORDER_BUCKETS - 1) / farthest : 0;
  const starts = new Uint32Array(ORDER_BUCKETS);
  for (let k = 0; k < count; k++) {
    if (k === anchorAt) continue;
    starts[(distances[k] * scale) | 0]++;
  }
  let running = 1;
  for (let b = 0; b < ORDER_BUCKETS; b++) {
    const size = starts[b];
    starts[b] = running;
    running += size;
  }
  const order = new Uint32Array(count);
  order[0] = anchorAt;
  for (let k = 0; k < count; k++) {
    if (k === anchorAt) continue;
    order[starts[(distances[k] * scale) | 0]++] = k;
  }

  const grid = new Map<number, number[]>();
  const kept: number[] = [];
  const exclusion2 = exclusion * exclusion;

  for (let s = 0; s < count; s++) {
    const k = order[s];
    const i = candidates[k];
    const x = xOf(i);
    const y = yOf(i);
    const cx = Math.floor(x / exclusion);
    const cy = Math.floor(y / exclusion);

    let nearest = -1;
    let nearestDistance = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(cellKey(cx + dx, cy + dy));
        if (bucket === undefined) continue;
        for (let b = 0; b < bucket.length; b++) {
          const j = bucket[b];
          const d = (xOf(j) - x) ** 2 + (yOf(j) - y) ** 2;
          if (d < exclusion2 && d < nearestDistance) {
            nearestDistance = d;
            nearest = j;
          }
        }
      }
    }

    if (nearest >= 0) {
      owners[k] = nearest;
      continue;
    }

    kept.push(i);
    owners[k] = i;
    const key = cellKey(cx, cy);
    const bucket = grid.get(key);
    if (bucket) bucket.push(i);
    else grid.set(key, [i]);
  }

  return { kept, owners };
}
