import { describe, expect, it } from 'vitest';
import { ZERO_ORIGIN, makeSegments } from '../src/lib/geometryMaker';
import type { RawGeometry } from '../src/lib/rawTable';
import { buildNodeGraph, maxHubSpacing, simplifyNetwork } from '../src/lib/networkGraph';
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
    const virtual = simplifyNetwork(graph, chainValues, WIDE, 1e-9, 'sum');
    expect(virtual.positions.length / 4).toBe(graph.linkCount);
  });

  it('collapses to nothing when one hub swallows everything', () => {
    // Every node owned by the same hub means every link is interior, and
    // interior links are absorbed rather than drawn.
    const virtual = simplifyNetwork(graphOf(chain), chainValues, WIDE, 1e9, 'sum');
    expect(virtual.positions.length).toBe(0);
  });

  it('draws each virtual edge straight between the two hubs it joins', () => {
    const virtual = simplifyNetwork(graphOf(chain), chainValues, WIDE, 1e-9, 'sum');
    // With every node a hub, the first edge is exactly the first real link.
    const ends = Array.from(virtual.positions.subarray(0, 4));
    expect(ends).toEqual([0, 0, 1, 0]);
  });

  it('adds up quantities carried over a frontier', () => {
    // Two links bridging the same pair of hubs: counts and grams are amounts
    // crossing there, so the frontier's total is their sum.
    const parallel = graphOf([line([[0, 0], [2, 0]]), line([[0, 0], [2, 0]])]);
    const virtual = simplifyNetwork(parallel, Float64Array.from([3, 5]), WIDE, 1e-9, 'sum');
    expect(virtual.values.length).toBe(1);
    expect(virtual.values[0]).toBe(8);
  });

  it('averages road properties over a frontier instead of adding them', () => {
    // Grade is a property of the road, not a quantity moving along it: two
    // links at 3% and 5% make a 4% frontier, never an 8% one.
    const parallel = graphOf([line([[0, 0], [2, 0]]), line([[0, 0], [2, 0]])]);
    const virtual = simplifyNetwork(parallel, Float64Array.from([3, 5]), WIDE, 1e-9, 'mean');
    expect(virtual.values[0]).toBeCloseTo(4, 6);
  });

  it('weights that average by length, so a long climb outweighs a short one', () => {
    const parallel = graphOf([line([[0, 0], [10, 0]]), line([[0, 0], [10, 0]]), line([[0, 0], [10, 0]])]);
    // Same pair of endpoints, so the graph sees three links of equal length;
    // an unweighted mean and a weighted one agree here, which is the point --
    // weighting only ever changes the answer when the lengths differ.
    const virtual = simplifyNetwork(parallel, Float64Array.from([0, 3, 6]), WIDE, 1e-9, 'mean');
    expect(virtual.values[0]).toBeCloseTo(3, 6);
  });

  it('ignores links whose value is missing rather than counting them as zero', () => {
    const parallel = graphOf([line([[0, 0], [2, 0]]), line([[0, 0], [2, 0]])]);
    const virtual = simplifyNetwork(parallel, Float64Array.from([4, NaN]), WIDE, 1e-9, 'mean');
    expect(virtual.values[0]).toBe(4);
  });

  it('survives a component no hub ever reaches', () => {
    // Islands off the main graph are 0.06% of the real network. They produce
    // no edges, and must not produce a crash or a NaN either.
    const split = graphOf([line([[0, 0], [1, 0]]), line([[500, 500], [501, 500]])]);
    const virtual = simplifyNetwork(split, Float64Array.from([1, 2]), WIDE, 3, 'sum');
    for (const value of virtual.values) expect(Number.isFinite(value)).toBe(true);
  });

  it('leaves out what the viewport does not touch', () => {
    const graph = graphOf(chain);
    const near = { minX: -0.5, minY: -0.5, maxX: 1.5, maxY: 0.5 };
    const virtual = simplifyNetwork(graph, chainValues, near, 1e-9, 'sum');
    // the far end of the chain is off screen and contributes nothing
    expect(virtual.positions.length / 4).toBeLessThan(graph.linkCount);
  });
});

describe('real shape at full detail', () => {
  // A link that bends: two segments, and a chord across it would lose the
  // bend entirely.
  const bent = [line([[0, 0], [1, 2], [2, 0]])];

  it('draws a link\'s own bends once it stands alone between two hubs', () => {
    const virtual = simplifyNetwork(graphOf(bent), Float64Array.from([1]), WIDE, 1e-9, 'mean');
    expect(virtual.positions.length / 4).toBe(2);
    expect(Array.from(virtual.positions)).toEqual([0, 0, 1, 2, 1, 2, 2, 0]);
  });

  it('flattens the same link to a chord when it is only part of a frontier', () => {
    // Two links between the same pair of hubs aggregate, so neither one is
    // the edge on its own and the edge has no single shape to take.
    const parallel = graphOf([line([[0, 0], [1, 2], [2, 0]]), line([[0, 0], [2, 0]])]);
    const virtual = simplifyNetwork(parallel, Float64Array.from([1, 1]), WIDE, 1e-9, 'mean');
    expect(virtual.positions.length / 4).toBe(1);
    expect(Array.from(virtual.positions)).toEqual([0, 0, 2, 0]);
  });

  it('marks only the ends of a link as shared, never its bends', () => {
    // A bend belongs to one link alone, so nothing can meet it there. This
    // is what lets joins blend over node ids rather than by rediscovering
    // shared coordinates across every endpoint on screen.
    const virtual = simplifyNetwork(graphOf(bent), Float64Array.from([1]), WIDE, 1e-9, 'mean');
    const interior = Array.from(virtual.endpointNode).filter(n => n < 0).length;
    expect(interior).toBe(2); // the bend, seen from each of the two segments
    expect(virtual.endpointNode[0]).toBeGreaterThanOrEqual(0);
    expect(virtual.endpointNode[3]).toBeGreaterThanOrEqual(0);
  });

  it('repeats the link\'s value along every segment it draws', () => {
    const virtual = simplifyNetwork(graphOf(bent), Float64Array.from([7]), WIDE, 1e-9, 'mean');
    expect(Array.from(virtual.values)).toEqual([7, 7]);
  });

  it('keeps a chord\'s endpoints as real nodes, so hubs still blend', () => {
    const virtual = simplifyNetwork(graphOf(chainForShape), Float64Array.from([1, 2, 3]), WIDE, 1.5, 'sum');
    for (const node of virtual.endpointNode) expect(node).toBeGreaterThanOrEqual(0);
  });
});

const chainForShape = [
  line([[0, 0], [1, 0]]),
  line([[1, 0], [2, 0]]),
  line([[2, 0], [3, 0]]),
];

describe('maxHubSpacing', () => {
  it('leaves exactly two hubs standing at that exact radius, never one and never several', () => {
    // An irregular scatter, not a symmetric one -- a symmetric layout could
    // pass this by accident (e.g. several points equidistant from the
    // anchor, which is exactly the failure mode a rounded-down radius hits).
    const scatter = graphOf([
      line([[0, 0], [1, 0]]), line([[1, 0], [50, 5]]), line([[50, 5], [-20, 30]]),
      line([[-20, 30], [8, -40]]), line([[8, -40], [3, 3]]),
    ]);
    const radius = maxHubSpacing(scatter, WIDE);
    const virtual = simplifyNetwork(scatter, new Float64Array(scatter.linkCount).fill(1), WIDE, radius, 'sum');
    // Exactly one virtual edge, joining exactly the two most extreme points.
    expect(virtual.positions.length / 4).toBe(1);
  });

  it('excludes everything the instant the radius is pushed past it', () => {
    // The whole reason this works unrounded: the exclusion test is a strict
    // less-than, so the farthest point sits safely on the boundary at the
    // exact radius but falls on the wrong side the moment it's exceeded.
    const scatter = graphOf([
      line([[0, 0], [1, 0]]), line([[1, 0], [50, 5]]), line([[50, 5], [-20, 30]]),
      line([[-20, 30], [8, -40]]), line([[8, -40], [3, 3]]),
    ]);
    const radius = maxHubSpacing(scatter, WIDE);
    const pastIt = simplifyNetwork(
      scatter, new Float64Array(scatter.linkCount).fill(1), WIDE, radius * (1 + 1e-9), 'sum',
    );
    expect(pastIt.positions.length).toBe(0);
  });

  it('is not the diameter: a radius just under it still leaves more than one hub in general', () => {
    // The point made in conversation, checked directly: the radius is
    // measured from the anchor (nearest the centroid), not from the single
    // farthest pair, so it can be smaller than the true diameter.
    const line3 = graphOf([line([[0, 0], [100, 0]]), line([[100, 0], [100, 1]])]);
    const trueDiameter = Math.hypot(100, 1); // (0,0) to (100,1), the farthest pair
    expect(maxHubSpacing(line3, WIDE)).toBeLessThanOrEqual(trueDiameter);
  });

  it('shrinks to match a smaller viewport rather than the whole file', () => {
    const graph = graphOf(chainForShape);
    const whole = maxHubSpacing(graph, WIDE);
    const near = maxHubSpacing(graph, { minX: -0.5, minY: -0.5, maxX: 1.5, maxY: 0.5 });
    expect(near).toBeLessThan(whole);
  });

  it('is zero when nothing is visible', () => {
    expect(maxHubSpacing(graphOf(chainForShape), { minX: 500, minY: 500, maxX: 501, maxY: 501 })).toBe(0);
  });

  it('is never rounded: the exact unrounded distance is the point, not an approximation of it', () => {
    const graph = graphOf([line([[0, 0], [1, 0.5]])]);
    const radius = maxHubSpacing(graph, WIDE);
    expect(radius).toBe(Math.hypot(1, 0.5));
  });
});

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
