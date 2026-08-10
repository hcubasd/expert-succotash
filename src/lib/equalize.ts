// Histogram equalization: place a value by its percentile rank in the
// observed distribution rather than by its linear position between the
// minimum and the maximum.
//
// The ramp has a fixed number of colors, and spending them evenly across the
// value range wastes almost all of them whenever the data is skewed -- which
// accumulated flow always is, since most of any scene is lightly crossed and
// a thin tail is heavily crossed. Ranking by percentile spends the colors
// where the data actually is: a crowded band of values gets proportionally
// more of the ramp, a sparse one gets less.
//
// The cost is that the middle of the ramp stops meaning "the middle of the
// range" and starts meaning "the median observation", so a legend can no
// longer place its ticks at even intervals -- see valueAt, which is what
// lets a legend label its ticks with the values they actually stand for.

export type Equalizer = {
  // value -> [0,1] percentile rank
  at: (value: number) => number;
  // [0,1] -> the value at that percentile, for legend ticks
  valueAt: (t: number) => number;
  min: number;
  max: number;
  count: number;
};

// Index of the first element >= value ("searchsorted left"). Ties therefore
// all resolve to the same rank, which matters: equal data must never be
// split across different colors just because it appears more than once.
function lowerBound(sorted: Float64Array, value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function equalize(values: ArrayLike<number>): Equalizer {
  const finite: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isFinite(v)) finite.push(v);
  }

  if (finite.length === 0) {
    return { at: () => 0, valueAt: () => 0, min: 0, max: 0, count: 0 };
  }

  const sorted = Float64Array.from(finite).sort();
  const n = sorted.length;
  const min = sorted[0];
  const max = sorted[n - 1];

  // A single distinct value has no distribution to equalize against; putting
  // it at the bottom of the ramp rather than an arbitrary middle keeps the
  // legend honest about there being nothing to compare.
  if (n === 1 || min === max) {
    return { at: () => 0, valueAt: () => min, min, max, count: n };
  }

  return {
    at: (value: number) => (Number.isFinite(value) ? lowerBound(sorted, value) / (n - 1) : 0),
    valueAt: (t: number) => sorted[Math.min(n - 1, Math.max(0, Math.round(t * (n - 1))))],
    min,
    max,
    count: n,
  };
}

// The GPU counterpart. Pixel accumulations run to millions of samples, far
// too many to sort per frame, and the ramp only has 128 stops so resolution
// much past that buys nothing -- so this bins instead, in one linear pass
// with no comparisons, and hands back a CDF the resolve shader can sample as
// a lookup texture.
//
// Only covered pixels (value > 0) are counted: the empty background is not
// an observation of "zero flow", it's an absence of observation, and letting
// it into the distribution would push every real value into the top of the
// ramp.
export function binnedCdf(values: ArrayLike<number>, max: number, bins = 256): Float32Array {
  const counts = new Float64Array(bins);
  let covered = 0;

  if (max > 0) {
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (!(v > 0) || !Number.isFinite(v)) continue;
      const bin = Math.min(bins - 1, Math.floor((v / max) * bins));
      counts[bin] += 1;
      covered += 1;
    }
  }

  const cdf = new Float32Array(bins);
  if (covered === 0) return cdf;

  let running = 0;
  for (let i = 0; i < bins; i++) {
    running += counts[i];
    cdf[i] = running / covered;
  }
  return cdf;
}

// Inverse of a binned CDF, for legend ticks: the value whose percentile is
// closest to t. Approximate by construction -- bin resolution is the floor
// on precision -- which is fine for tick labels but is why the CPU-side
// equalize keeps exact ranks for everything that can afford them.
export function valueAtPercentile(cdf: Float32Array, max: number, t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  for (let i = 0; i < cdf.length; i++) {
    if (cdf[i] >= clamped) return ((i + 1) / cdf.length) * max;
  }
  return max;
}
