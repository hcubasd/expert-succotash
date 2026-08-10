import { describe, expect, it } from 'vitest';
import { markSize } from '../src/gl/renderer';

// markSize is pure arithmetic and imports nothing that needs a GL context,
// so the sizing law can be pinned without a canvas.
const LINE_INITIAL = 2;
const AGENT_INITIAL = 32;
const baseline = (count: number, initial: number) =>
  1 + 1 / Math.log(count + Math.exp(1 / (initial - 1)));

describe('markSize', () => {
  it('is exactly `initial` at count 0, by construction of the e^(1/(initial-1)) term', () => {
    expect(markSize(0, LINE_INITIAL, 1)).toBeCloseTo(2, 10);
    expect(markSize(0, AGENT_INITIAL, 1)).toBeCloseTo(32, 10);
  });

  it('is exactly the count-driven baseline at the fitted view', () => {
    for (const count of [10, 1300, 18_598]) {
      expect(markSize(count, LINE_INITIAL, 1)).toBeCloseTo(baseline(count, LINE_INITIAL), 10);
      expect(markSize(count, AGENT_INITIAL, 1)).toBeCloseTo(baseline(count, AGENT_INITIAL), 10);
    }
  });

  it('shrinks toward 1 as count grows, but never reaches it', () => {
    const small = markSize(10, LINE_INITIAL, 1);
    const large = markSize(18_598, LINE_INITIAL, 1);
    expect(small).toBeGreaterThan(large);
    expect(large).toBeGreaterThan(1);
    expect(large).toBeLessThan(1.15); // close, not equal -- ln grows slowly
  });

  it('closes 1 - 1/zoom of the gap to `initial`, at a rate independent of count', () => {
    // the whole point of interpolating rather than multiplying: crowding
    // decides where the walk starts, never how fast it travels
    for (const count of [10, 1300, 18_598, 250_000]) {
      for (const zoom of [2, 5, 10, 100]) {
        const base = baseline(count, AGENT_INITIAL);
        const closed = (markSize(count, AGENT_INITIAL, zoom) - base) / (AGENT_INITIAL - base);
        expect(closed).toBeCloseTo(1 - 1 / zoom, 10);
      }
    }
  });

  it('converges on `initial` from below without ever overshooting it', () => {
    // epsilon only for float rounding at absurd zoom: the interpolation
    // approaches `initial` from below and cannot exceed it algebraically,
    // which is exactly what multiplying by a 1 -> initial factor could not
    // promise.
    const EPS = 1e-9;
    for (const count of [0, 10, 1300, 250_000]) {
      for (const zoom of [1, 2, 10, 1000, 1e9]) {
        expect(markSize(count, LINE_INITIAL, zoom)).toBeLessThanOrEqual(LINE_INITIAL + EPS);
        expect(markSize(count, AGENT_INITIAL, zoom)).toBeLessThanOrEqual(AGENT_INITIAL + EPS);
      }
      expect(markSize(count, AGENT_INITIAL, 1e9)).toBeCloseTo(AGENT_INITIAL, 6);
    }
  });

  it('grows monotonically with zoom for a fixed count', () => {
    const sizes = [1, 2, 5, 10, 50].map(z => markSize(13_393, AGENT_INITIAL, z));
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]).toBeGreaterThan(sizes[i - 1]);
    }
  });

  it('never drops below the fitted size, even if zoom is reported under 1', () => {
    // the view cannot zoom out past the fit, but the guard keeps a stray
    // value from inverting the interpolation
    expect(markSize(1300, LINE_INITIAL, 0.25)).toBeCloseTo(markSize(1300, LINE_INITIAL, 1), 10);
  });

  it('gives agents their own initial size, since a standalone dot and a hairline are not comparable', () => {
    expect(markSize(0, AGENT_INITIAL, 1)).toBeGreaterThan(markSize(0, LINE_INITIAL, 1));
  });
});
