import { describe, expect, it } from 'vitest';
import { ZERO_ORIGIN, makeSegments } from '../src/lib/geometryMaker';
import type { RawGeometry } from '../src/lib/rawTable';
import { buildNodeGraph, simplifyNetwork } from '../src/lib/networkGraph';
import { thinFromCentroid } from '../src/lib/thinning';

const line = (coords: [number, number][]): RawGeometry => ({ type: 'LineString', coordinates: coords });
const graphOf = (lines: RawGeometry[]) => buildNodeGraph(makeSegments(lines, ZERO_ORIGIN));
const WIDE = { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 };

describe('buildNodeGraph', () => {
  it('joins two links that share an endpoint into one node', () => {
    const graph = graphOf([line([[0, 0], [1, 0]]), line([[1, 0], [2, 0]])]);
    expect(graph.nodeCount).toBe(3);
    expect(graph.linkCount).toBe(2);
  });

  it('treats a link\'s interior vertices as shape, not as nodes', () => {
    // A road that bends twice is still one link between two junctions. Taking
    // its bends for nodes is what would grow the real network from 73k nodes
    // to 1.6M without describing any extra connectivity.
    const graph = graphOf([line([[0, 0], [1, 1], [2, 0]])]);
    expect(graph.nodeCount).toBe(2);
    expect(graph.linkCount).toBe(1);
  });

  it('measures a link along its bends, not across them', () => {
    // The flood spreads at road distance, so a winding road has to cost what
    // driving it costs rather than what the crow flies.
    const graph = graphOf([line([[0, 0], [1, 1], [2, 0]])]);
    expect(graph.linkLength[0]).toBeCloseTo(2 * Math.SQRT2, 6);
  });

  it('drops a link that closes back on its own node', () => {
    // Both ends owned by the same hub whatever happens, so it could only ever
    // be absorbed -- it can never become a boundary.
    const graph = graphOf([line([[0, 0], [1, 1], [0, 0]])]);
    expect(graph.linkCount).toBe(0);
  });

  it('lists both directions of every link in the adjacency', () => {
    const graph = graphOf([line([[0, 0], [1, 0]]), line([[1, 0], [2, 0]])]);
    const degree = (n: number) => graph.adjStart[n + 1] - graph.adjStart[n];
    // the shared middle node is reachable from both ends
    const degrees = [0, 1, 2].map(degree).sort();
    expect(degrees).toEqual([1, 1, 2]);
  });
});

describe('simplifyNetwork', () => {
  const chain = [
    line([[0, 0], [1, 0]]),
    line([[1, 0], [2, 0]]),
    line([[2, 0], [3, 0]]),
  ];
  const chainValues = Float64Array.from([1, 2, 3]);

  it('falls back to the whole network once every node clears the spacing', () => {
    // This is what makes the detail control's fine end mean something exact:
    // the exclusion shrinks until nothing excludes anything, every link is a
    // boundary between two hubs, and the original network is back.
    const graph = graphOf(chain);
    const virtual = simplifyNetwork(graph, chainValues, WIDE, 1e-9);
    expect(virtual.positions.length / 4).toBe(graph.linkCount);
  });

  it('collapses to nothing when one hub swallows everything', () => {
    // Every node owned by the same hub means every link is interior, and
    // interior links are absorbed rather than drawn.
    const virtual = simplifyNetwork(graphOf(chain), chainValues, WIDE, 1e9);
    expect(virtual.positions.length).toBe(0);
  });

  it('draws each virtual edge straight between the two hubs it joins', () => {
    const virtual = simplifyNetwork(graphOf(chain), chainValues, WIDE, 1e-9);
    // With every node a hub, the first edge is exactly the first real link.
    const ends = Array.from(virtual.positions.subarray(0, 4));
    expect(ends).toEqual([0, 0, 1, 0]);
  });

  it('never folds two links into one value, however they overlap', () => {
    // Two links bridging the same pair of points. Collapsing eliminates
    // links, it never adds their values together: each survivor keeps the
    // count it actually carries, so the pair stays 3 and 5 rather than
    // becoming an 8 that no road in the data has.
    const parallel = graphOf([line([[0, 0], [2, 0]]), line([[0, 0], [2, 0]])]);
    const virtual = simplifyNetwork(parallel, Float64Array.from([3, 5]), WIDE, 1e-9);
    expect(virtual.values.length).toBe(2);
    expect(Array.from(virtual.values).sort((a, b) => a - b)).toEqual([3, 5]);
  });

  it('leaves road properties alone too, averaging nothing', () => {
    // Grade took a length-weighted mean under the old aggregating version.
    // There is no frontier left to hold an averaged grade: two links at 3%
    // and 5% stay a 3% link and a 5% link.
    const parallel = graphOf([line([[0, 0], [2, 0]]), line([[0, 0], [2, 0]])]);
    const virtual = simplifyNetwork(parallel, Float64Array.from([3, 5]), WIDE, 1e-9);
    expect(Array.from(virtual.values).sort((a, b) => a - b)).toEqual([3, 5]);
  });

  it('keeps a missing value missing rather than borrowing a neighbour\'s', () => {
    // The survivor with no value stays NaN -- the caller paints that as
    // structure. It never inherits the 4 drawn beside it.
    const parallel = graphOf([line([[0, 0], [2, 0]]), line([[0, 0], [2, 0]])]);
    const virtual = simplifyNetwork(parallel, Float64Array.from([4, NaN]), WIDE, 1e-9);
    expect(virtual.values.length).toBe(2);
    expect(Array.from(virtual.values).filter(Number.isFinite)).toEqual([4]);
  });

  it('leaves out what the viewport does not touch', () => {
    const graph = graphOf(chain);
    const near = { minX: -0.5, minY: -0.5, maxX: 1.5, maxY: 0.5 };
    const virtual = simplifyNetwork(graph, chainValues, near, 1e-9);
    // the far end of the chain is off screen and contributes nothing
    expect(virtual.positions.length / 4).toBeLessThan(graph.linkCount);
  });
});

describe('real shape at full detail', () => {
  // A link that bends: two segments, and a chord across it would lose the
  // bend entirely.
  const bent = [line([[0, 0], [1, 2], [2, 0]])];

  it('draws a link\'s own bends once it stands alone between two hubs', () => {
    const virtual = simplifyNetwork(graphOf(bent), Float64Array.from([1]), WIDE, 1e-9);
    expect(virtual.positions.length / 4).toBe(2);
    expect(Array.from(virtual.positions)).toEqual([0, 0, 1, 2, 1, 2, 2, 0]);
  });

  it('still draws each link\'s own bends when two share a pair of endpoints', () => {
    // These two used to aggregate into one shapeless chord. Nothing merges
    // any more, so the bent one keeps its bend and the straight one stays
    // straight: three segments in total, both roads still themselves.
    const parallel = graphOf([line([[0, 0], [1, 2], [2, 0]]), line([[0, 0], [2, 0]])]);
    const virtual = simplifyNetwork(parallel, Float64Array.from([1, 1]), WIDE, 1e-9);
    expect(virtual.positions.length / 4).toBe(3);
    expect(Array.from(virtual.positions)).toEqual([0, 0, 1, 2, 1, 2, 2, 0, 0, 0, 2, 0]);
  });

  it('marks only the ends of a link as shared, never its bends', () => {
    // A bend belongs to one link alone, so nothing can meet it there. This
    // is what lets joins blend over node ids rather than by rediscovering
    // shared coordinates across every endpoint on screen.
    const virtual = simplifyNetwork(graphOf(bent), Float64Array.from([1]), WIDE, 1e-9);
    const interior = Array.from(virtual.endpointNode).filter(n => n < 0).length;
    expect(interior).toBe(2); // the bend, seen from each of the two segments
    expect(virtual.endpointNode[0]).toBeGreaterThanOrEqual(0);
    expect(virtual.endpointNode[3]).toBeGreaterThanOrEqual(0);
  });

  it('repeats the link\'s value along every segment it draws', () => {
    const virtual = simplifyNetwork(graphOf(bent), Float64Array.from([7]), WIDE, 1e-9);
    expect(Array.from(virtual.values)).toEqual([7, 7]);
  });

  it('keeps a chord\'s endpoints as real nodes, so hubs still blend', () => {
    const virtual = simplifyNetwork(graphOf(chainForShape), Float64Array.from([1, 2, 3]), WIDE, 1.5);
    for (const node of virtual.endpointNode) expect(node).toBeGreaterThanOrEqual(0);
  });
});

const chainForShape = [
  line([[0, 0], [1, 0]]),
  line([[1, 0], [2, 0]]),
  line([[2, 0], [3, 0]]),
];

describe('thinFromCentroid', () => {
  const xs = [0, 1, 2, 3, 10];
  const ys = [0, 0, 0, 0, 0];
  const all = [0, 1, 2, 3, 4];
  const thin = (exclusion: number) => thinFromCentroid(all, i => xs[i], i => ys[i], exclusion);

  it('never keeps two points closer than the exclusion distance', () => {
    const { kept } = thin(2);
    for (const a of kept) {
      for (const b of kept) {
        if (a === b) continue;
        expect(Math.abs(xs[a] - xs[b])).toBeGreaterThanOrEqual(2 - 1e-9);
      }
    }
  });

  it('keeps an isolated point, however far out it sits', () => {
    // The sparse outskirts survive for free: nothing is near enough to
    // exclude them, which is why lone connecting roads do not vanish.
    expect(thin(2).kept).toContain(4);
  });

  it('keeps everything when the exclusion is small enough', () => {
    expect(thin(1e-9).kept.length).toBe(5);
  });

  it('keeps everything at exactly zero, since nothing can be strictly nearer', () => {
    // The exact fine end of the detail control: d < 0 is never true, so the
    // walk excludes nothing at all rather than merely almost nothing.
    expect(thin(0).kept.length).toBe(5);
  });

  it('starts from the middle, so the densest part decides the layout', () => {
    // The anchor -- nearest the centroid at x=3.2 -- is the only survivor.
    expect(thin(1e9).kept).toEqual([3]);
  });

  it('has nothing to do with an empty set', () => {
    const { kept, owners } = thinFromCentroid([], () => 0, () => 0, 1);
    expect(kept).toEqual([]);
    expect(owners.length).toBe(0);
  });

  it('accounts for every candidate exactly once, kept or absorbed', () => {
    // What lets agents sum rather than drop: nothing falls through.
    const { owners } = thin(2);
    expect(owners.length).toBe(all.length);
    for (const owner of owners) expect(all).toContain(owner);
  });

  it('says a kept point owns itself', () => {
    const { kept, owners } = thin(2);
    for (const i of kept) expect(owners[all.indexOf(i)]).toBe(i);
  });

  it('absorbs a point into the nearest kept point, not whichever was found first', () => {
    // Point 0 sits within reach of the anchor; it must go to the one actually
    // nearest it, since that is the circle drawn over it.
    const line = [0, 1, 2];
    const px = [0, 2.6, 10];
    const { kept, owners } = thinFromCentroid(line, i => px[i], () => 0, 3);
    // the anchor is 1 (nearest the centroid at 4.2); 0 is 2.6 away, so absorbed
    expect(kept).toContain(1);
    expect(owners[0]).toBe(1);
  });
});
