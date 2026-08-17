import { useLayoutEffect, useRef } from 'react';
import type { Legend } from '../lib/mapScene';

const BANDS = 128;
// The label band's own height, in em so it tracks whatever font size the
// panel settled on. The tick track is inset by half of this at each end so
// the top and bottom labels sit fully inside the bar rather than hanging
// off it.
const LABEL_EM = 1.4;

// Deterministic per repaint rather than reseeded from Math.random -- a
// resize shouldn't make the dithering look like a different image, just a
// differently-sized one.
function rand(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

// Every pixel in the bar is one of the 128 real ramp colors, never an RGB
// interpolation between two of them -- band i (0 at the bottom, the ramp's
// lowest value) covers a run of rows, and each pixel in it is sampled from a
// window starting at i and reaching up toward the top of the bar, rather
// than painted flat. The window's width is ln(band area): a taller or wider
// band samples from more colors above it, which is what keeps the dithering
// looking proportionate at any panel size rather than fixed grain regardless
// of how big the bar actually is. Sampling is weighted toward the *top* of
// that window (a right-triangular distribution -- zero density at i, rising
// to a peak at the window's far end) so adjacent bands bleed into each
// other instead of meeting at a hard edge. The exact direction of that lean
// is the one part of this technique that could easily be backwards from
// what was actually meant -- worth a real look before trusting it.
//
// Sized from one measurement of the wrapper, used for both the CSS box and
// the drawing buffer: resolving "the same" size twice (once as a percentage,
// once in device pixels) is what leaves a one-pixel seam at an edge.
function paint(canvas: HTMLCanvasElement, cssWidth: number, cssHeight: number, ramp: Legend['ramp']) {
  const ratio = window.devicePixelRatio || 1;
  if (cssWidth <= 0 || cssHeight <= 0) return;
  const width = Math.max(1, Math.round(cssWidth * ratio));
  const height = Math.max(1, Math.round(cssHeight * ratio));
  canvas.width = width;
  canvas.height = height;
  // The CSS size has to be stated outright, in the same measured pixels the
  // buffer was sized from. A canvas is a replaced element with intrinsic
  // dimensions -- its buffer size -- and an absolutely positioned replaced
  // element with `width: auto` takes those intrinsic dimensions rather than
  // stretching to its offsets, so inset: 0 alone leaves it drawn at
  // devicePixelRatio times its slot: exactly twice too big on a 2x display,
  // in both directions, with the overflow running off the bottom.
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const image = ctx.createImageData(width, height);
  const data = image.data;
  const rnd = rand(0x9e3779b9);

  // Band boundaries as rounded proportional positions rather than an
  // explicit per-band remainder split -- the two are equivalent (every band
  // gets its floor height or one more, evenly spread across the 128), this
  // is just the simpler way to get there.
  const bandTop = (i: number) => Math.round((i / BANDS) * height); // pixels up from the bottom

  for (let i = 0; i < BANDS; i++) {
    const from = bandTop(i);
    const to = bandTop(i + 1);
    const bandHeight = to - from;
    if (bandHeight <= 0) continue;

    const sampleCount = Math.max(1, Math.round(Math.log(Math.max(Math.E, bandHeight * width))));
    const hi = Math.min(BANDS - 1, i + sampleCount - 1);

    for (let fromBottom = from; fromBottom < to; fromBottom++) {
      const row = height - 1 - fromBottom;
      for (let px = 0; px < width; px++) {
        const index = hi > i ? Math.round(i + (hi - i) * Math.sqrt(rnd())) : i;
        const color = ramp[index];
        const at = (row * width + px) * 4;
        data[at] = color.r;
        data[at + 1] = color.g;
        data[at + 2] = color.b;
        data[at + 3] = 255;
      }
    }
  }

  ctx.putImageData(image, 0, 0);
}

function formatValue(value: number): string {
  if (!Number.isFinite(value)) return '';
  return value.toFixed(2).replace(/\.?0+$/, '');
}

type Props = { legend: Legend };

// One bg for the whole legend area, with the painted bar behind and the tick
// labels over it. Neither the canvas nor the labels are bg or fg elements:
// colorBg would otherwise count each label as its own nesting depth (and
// paint a background behind it), and squeezeFg would try to size the panel's
// shared font against nine stacked numbers. They inherit the font size the
// panel already settled on instead, which is what keeps them the same size
// as every other label on screen without participating in the fit.
// The gap kept between the top/bottom tick labels and the bar's own edges.
// Only the labels move in by this -- the painted bar still runs the full
// height behind them, uninterrupted, since a tick's exact pixel row was
// never meant to line up with its value's exact band in the first place.
const EDGE_PAD_EM = 1;

export default function LegendCanvas({ legend }: Props) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Watches the wrapper, not the canvas -- the canvas's size is derived from
  // the wrapper's, so observing the canvas would be watching an effect for
  // its own cause.
  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    const canvas = canvasRef.current;
    if (!wrapper || !canvas) return;
    const repaint = () => paint(canvas, wrapper.clientWidth, wrapper.clientHeight, legend.ramp);
    repaint();
    const observer = new ResizeObserver(repaint);
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [legend.ramp]);

  return (
    <div ref={wrapperRef} className="bg" style={{ position: 'relative', flex: 1, minHeight: 0, minWidth: 0 }}>
      {/* No width/height here on purpose: paint() sets them in real pixels
          alongside the drawing buffer, so the two can never be resolved
          from two different numbers. */}
      <canvas ref={canvasRef} style={{ position: 'absolute', top: 0, left: 0, display: 'block' }} />
      {legend.ticks.map(({ t, value }) => (
        <div
          key={t}
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            // The track runs from EDGE_PAD_EM to (height - one label -
            // EDGE_PAD_EM), so the label's own box lands inside the bar with
            // room to spare at either end: at t=0 it sits just above the
            // floor, at t=1 its top edge sits just below the ceiling.
            bottom: `calc(${t} * (100% - ${LABEL_EM}em - ${2 * EDGE_PAD_EM}em) + ${EDGE_PAD_EM}em)`,
            height: `${LABEL_EM}em`,
            lineHeight: `${LABEL_EM}em`,
            textAlign: 'center',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            // Black over the palette luminance, which is bright enough that
            // black is always the readable ink.
            color: '#000',
          }}
        >
          {formatValue(value)}
        </div>
      ))}
    </div>
  );
}
