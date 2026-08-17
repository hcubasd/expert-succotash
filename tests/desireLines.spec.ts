import { describe, expect, it } from 'vitest';
import { consolidateDesireLines, endpointsOf } from '../src/lib/desireLines';

const WIDE = { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 };

// x1,y1,x2,y2 per line, the layout makeDesireLineEdges already produces.
const lines = (...coords: number[]) => Float32Array.from(coords);
const flows = (...values: number[]) => Float32Array.from(values);

describe('endpointsOf', () => {
  it('pools origins and destinations into one set', () => {
    // The same place is one endpoint whether a line leaves it or arrives
    // there, which is what lets a single partition serve both ends.
    const pool = endpointsOf(lines(0, 0, 1, 0, 1, 0, 2, 0));
    expect(pool.count).toBe(3);
    expect(pool.edgeCount).toBe(2);
  });

  it('keeps genuinely distinct endpoints apart', () => {
    const pool = endpointsOf(lines(0, 0, 1, 0, 5, 5, 6, 6));
    expect(pool.count).toBe(4);
  });

  it('is cached per positions array, since it never depends on the view', () => {
    const positions = lines(0, 0, 1, 0);
    expect(endpointsOf(positions)).toBe(endpointsOf(positions));
  });
});

describe('consolidateDesireLines', () => {
  // Three collinear points: two lines, sharing the middle endpoint.
  const chain = lines(0, 0, 1, 0, 1, 0, 2, 0);
  const chainFlows = flows(3, 4);

  it('changes nothing at full detail, where no two endpoints merge', () => {
    // The fine end has to be exact, not merely close: the accumulator must
    // receive the raw edge set unchanged.
    const flow = consolidateDesireLines(chain, chainFlows, WIDE, 0);
    expect(flow.positions.length / 4).toBe(2);
    expect(Array.from(flow.quantities)).toEqual([3, 4]);
  });

  it('sums lines that end up between the same pair of buckets', () => {
    // Two parallel lines between the same two places, merged by a radius
    // big enough to pull each pair of ends together.
    const parallel = lines(0, 0, 100, 0, 1, 1, 101, 1);
    const flow = consolidateDesireLines(parallel, flows(2, 5), WIDE, 10);
    expect(flow.quantities.length).toBe(1);
    expect(flow.quantities[0]).toBe(7);
  });

  it('drops a line whose two ends land in the same bucket', () => {
    // Flow internal to one cluster: there are no longer two places to draw
    // between, so it leaves the picture rather than becoming a dot.
    const flow = consolidateDesireLines(chain, chainFlows, WIDE, 1e9);
    expect(flow.positions.length).toBe(0);
  });

  it('draws each surviving line straight between the two buckets it joins', () => {
    const flow = consolidateDesireLines(chain, chainFlows, WIDE, 0);
    expect(Array.from(flow.positions.subarray(0, 4))).toEqual([0, 0, 1, 0]);
  });

  it('leaves exactly one line at the exact distance guaranteeing two buckets', () => {
    // Deliberately not evenly spaced: pooled endpoints are (0,0), (1,0),
    // (5,0), centroid (2,0). Anchor is (1,0), nearest at distance 1; farthest
    // from it is (5,0) at distance 4. At exclusion 4, exactly those two
    // survive, so the single line between them is all that is left.
    const spread = lines(0, 0, 1, 0, 1, 0, 5, 0);
    const flow = consolidateDesireLines(spread, flows(1, 1), WIDE, 4);
    expect(flow.positions.length / 4).toBe(1);
  });

  it('keeps every tied endpoint when several are equally far from the anchor', () => {
    // The one exception to "exactly two survive at the ceiling": the
    // guarantee rests on a single farthest point sitting alone on the strict
    // exclusion boundary, so an exactly symmetric layout keeps all of the
    // tied points instead. Pooled endpoints (0,0), (1,0), (2,0), centroid
    // exactly (1,0) -- which is itself the anchor, tied 1 away from both
    // neighbours. Real projected coordinates essentially never tie to the
    // last bit, but the behaviour is worth pinning rather than discovering.
    const symmetric = lines(0, 0, 1, 0, 1, 0, 2, 0);
    const flow = consolidateDesireLines(symmetric, flows(1, 1), WIDE, 1);
    expect(flow.positions.length / 4).toBe(2);
  });

  it('ignores a line whose quantity is missing rather than counting it as zero', () => {
    const parallel = lines(0, 0, 100, 0, 1, 1, 101, 1);
    const flow = consolidateDesireLines(parallel, flows(6, NaN), WIDE, 10);
    expect(flow.quantities[0]).toBe(6);
  });

  it('keeps a line with either end on screen, so flow is not cut at the frame', () => {
    const far = lines(0, 0, 900, 900);
    const near = { minX: -1, minY: -1, maxX: 1, maxY: 1 };
    expect(consolidateDesireLines(far, flows(1), near, 0).positions.length / 4).toBe(1);
  });

  it('leaves out lines with neither end on screen', () => {
    const far = lines(900, 900, 950, 950);
    const near = { minX: -1, minY: -1, maxX: 1, maxY: 1 };
    expect(consolidateDesireLines(far, flows(1), near, 0).positions.length).toBe(0);
  });

  it('survives a line carrying a non-finite endpoint', () => {
    const broken = lines(0, 0, NaN, 0, 5, 5, 6, 6);
    const flow = consolidateDesireLines(broken, flows(1, 2), WIDE, 0);
    for (const value of flow.positions) expect(Number.isFinite(value)).toBe(true);
  });

  it('has nothing to draw when nothing is on screen', () => {
    const flow = consolidateDesireLines(chain, chainFlows, { minX: 500, minY: 500, maxX: 501, maxY: 501 }, 0);
    expect(flow.positions.length).toBe(0);
  });
});
