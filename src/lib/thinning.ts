// Picking a spread-out subset of points, shared by agent dots and network
// hubs because it is literally the same problem twice: start from the middle
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

// The exact exclusion distance that leaves exactly two points standing: the
// anchor, and whichever point is farthest from it.
//
// That farthest point is *the* farthest by construction, so at exactly this
// distance it sits precisely on the exclusion boundary -- and the boundary
// is safe, because the test below is a strict less-than: a kept point
// excludes a candidate only when the candidate is strictly closer than the
// exclusion, never when it is exactly on it. Every other candidate is
// strictly closer than this one by definition of "farthest", so every other
// candidate falls on the excluded side and this one alone survives.
//
// Never round this. Rounding up pushes the boundary past that point and
// excludes it too, collapsing to a single point; rounding down pulls the
// boundary in front of it without regard to what else lives in the gap,
// which lets an arbitrary, data-dependent handful through together rather
// than the one this is built to isolate.
//
// This is deliberately not the distance between the two most extreme points
// either. The walk never anchors on an extreme point, only on whichever is
// nearest the middle, so the diameter overshoots.
export function spanFromAnchor(
  candidates: number[],
  xOf: (i: number) => number,
  yOf: (i: number) => number,
): number {
  if (candidates.length === 0) return 0;
  const anchor = anchorOf(candidates, xOf, yOf);
  let farthest = 0;
  for (const i of candidates) {
    const d = Math.hypot(xOf(i) - xOf(anchor), yOf(i) - yOf(anchor));
    if (d > farthest) farthest = d;
  }
  return farthest;
}

export type Thinned = {
  // The points that survived, in centroid-outward order.
  kept: number[];
  // Which kept point absorbed each candidate; a kept point owns itself. The
  // network only needs `kept` and ignores this, but agents merge rather than
  // drop what they exclude, so they need to know where each one went.
  owner: Map<number, number>;
};

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
// points are at least one exclusion apart by construction, so only a
// handful can ever sit in the nine cells being searched.
export function thinFromCentroid(
  candidates: number[],
  xOf: (i: number) => number,
  yOf: (i: number) => number,
  exclusion: number,
): Thinned {
  const owner = new Map<number, number>();
  if (candidates.length === 0) return { kept: [], owner };

  const anchor = anchorOf(candidates, xOf, yOf);
  const anchorX = xOf(anchor);
  const anchorY = yOf(anchor);

  // Ordered outward from the anchor rather than from the centroid itself:
  // the anchor is a real point and is what actually gets kept first, so
  // ordering by distance to it makes the walk's own starting point exact.
  const ordered = [...candidates].sort(
    (a, b) =>
      (xOf(a) - anchorX) ** 2 + (yOf(a) - anchorY) ** 2 -
      ((xOf(b) - anchorX) ** 2 + (yOf(b) - anchorY) ** 2),
  );

  const cell = Math.max(exclusion, 1e-12);
  const grid = new Map<string, number[]>();
  const kept: number[] = [];

  for (const i of ordered) {
    const x = xOf(i);
    const y = yOf(i);
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);

    let nearest = -1;
    let nearestDistance = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(`${cx + dx},${cy + dy}`);
        if (!bucket) continue;
        for (const j of bucket) {
          const d = (xOf(j) - x) ** 2 + (yOf(j) - y) ** 2;
          if (d < exclusion * exclusion && d < nearestDistance) {
            nearestDistance = d;
            nearest = j;
          }
        }
      }
    }

    if (nearest >= 0) {
      owner.set(i, nearest);
      continue;
    }

    kept.push(i);
    owner.set(i, i);
    const key = `${cx},${cy}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(i);
    else grid.set(key, [i]);
  }

  return { kept, owner };
}
