import { describe, expect, it } from 'vitest';
import { binnedCdf, equalize, valueAtPercentile } from '../src/lib/equalize';

describe('equalize', () => {
  it('places a value by its rank, not by where it sits between min and max', () => {
    // Heavily skewed: nine small values and one huge one. Linearly the nines
    // would all crowd into the bottom 1% of the ramp; by rank they spread
    // across nine tenths of it.
    const eq = equalize([1, 1, 2, 2, 3, 3, 4, 4, 5, 1000]);
    expect(eq.at(1000)).toBe(1);
    expect(eq.at(5)).toBeCloseTo(8 / 9, 10);
    expect(eq.at(1)).toBe(0);
  });

  it('gives equal values equal color, never splitting a tie', () => {
    const eq = equalize([5, 5, 5, 9]);
    expect(eq.at(5)).toBe(eq.at(5));
    expect(eq.at(5)).toBe(0);
  });

  it('is monotonic: a larger value never lands lower on the ramp', () => {
    const values = [3, 1, 4, 1, 5, 9, 2, 6];
    const eq = equalize(values);
    const sorted = [...values].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect(eq.at(sorted[i])).toBeGreaterThanOrEqual(eq.at(sorted[i - 1]));
    }
  });

  it('valueAt inverts at, which is what lets a legend label its ticks', () => {
    const eq = equalize([10, 20, 30, 40, 50]);
    expect(eq.valueAt(0)).toBe(10);
    expect(eq.valueAt(1)).toBe(50);
    expect(eq.valueAt(0.5)).toBe(30);
  });

  it('survives an empty set and a single distinct value without dividing by zero', () => {
    const none = equalize([]);
    expect(none.count).toBe(0);
    expect(Number.isFinite(none.at(1))).toBe(true);

    const flat = equalize([7, 7, 7]);
    expect(flat.at(7)).toBe(0);
    expect(flat.valueAt(1)).toBe(7);
  });

  it('ignores non-finite values rather than poisoning the distribution', () => {
    const eq = equalize([1, NaN, 2, Infinity, 3]);
    expect(eq.count).toBe(3);
    expect(eq.min).toBe(1);
    expect(eq.max).toBe(3);
  });
});

describe('binnedCdf', () => {
  it('rises to 1 and never falls', () => {
    const cdf = binnedCdf([1, 2, 3, 4, 5, 6, 7, 8], 8, 8);
    expect(cdf[cdf.length - 1]).toBeCloseTo(1, 6);
    for (let i = 1; i < cdf.length; i++) expect(cdf[i]).toBeGreaterThanOrEqual(cdf[i - 1]);
  });

  it('counts only covered pixels, so empty background cannot skew the ramp', () => {
    // Half the buffer is untouched. If zeroes counted, every real value
    // would be pushed into the top half of the ramp.
    const withEmpty = binnedCdf([0, 0, 0, 0, 1, 2, 3, 4], 4, 4);
    const withoutEmpty = binnedCdf([1, 2, 3, 4], 4, 4);
    expect(Array.from(withEmpty)).toEqual(Array.from(withoutEmpty));
  });

  it('is all zero when nothing was drawn', () => {
    const cdf = binnedCdf([0, 0, 0], 0, 4);
    expect(Array.from(cdf)).toEqual([0, 0, 0, 0]);
  });

  it('valueAtPercentile walks back out to a labellable value', () => {
    const cdf = binnedCdf([1, 2, 3, 4], 4, 4);
    expect(valueAtPercentile(cdf, 4, 0)).toBeGreaterThan(0);
    expect(valueAtPercentile(cdf, 4, 1)).toBeLessThanOrEqual(4);
  });
});
