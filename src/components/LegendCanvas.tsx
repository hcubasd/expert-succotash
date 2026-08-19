import { useLayoutEffect, useRef } from 'react';
import type { Legend } from '../lib/mapScene';

// Bands come from the ramp itself rather than a constant: the map's ramps
// are a quarter of the wheel now that four layers divide it, and a legend
// that painted a fixed 128 would either repeat colours or run off the end
// of a shorter ramp.
const bandsOf = (ramp: Legend['ramp']) => ramp.length;
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

// Every pixel in the bar is one of the real ramp colors, never an RGB
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
// The canvas covers its own box exactly, at whatever position that box
// happens to sit -- deliberately *not* snapped to the device-pixel grid.
//
// Snapping was tried and is wrong here, for a reason worth recording: this
// canvas has siblings. The dropdowns stacked above it in the same column are
// plain .bg divs, and the browser antialiases their backgrounds across a
// fractional edge rather than snapping them. Snapping only the canvas
// therefore pulls it off its own column's edge by up to a device pixel,
// differently in each column since each sits at a different fraction --
// which reads exactly as one column's legend being shifted against the
// others. Matching the box exactly keeps the canvas edge wherever its
// siblings' edges are, whatever that is.
//
// Crispness is then a layout property, not this function's to fix: it comes
// from the columns landing on whole pixels in the first place (see
// MapPanel's own integer column widths), and when they do, the rounding
// below is exact and there is nothing to resample.
function paint(canvas: HTMLCanvasElement, box: DOMRect, ramp: Legend['ramp']) {
  const ratio = window.devicePixelRatio || 1;
  if (box.width <= 0 || box.height <= 0) return;

  const width = Math.max(1, Math.round(box.width * ratio));
  const height = Math.max(1, Math.round(box.height * ratio));
  canvas.width = width;
  canvas.height = height;
  // A canvas is a replaced element whose intrinsic size is its buffer, so an
  // absolutely positioned one with width:auto would draw at buffer size --
  // devicePixelRatio times too big. The CSS size has to be stated outright.
  canvas.style.width = `${box.width}px`;
  canvas.style.height = `${box.height}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const image = ctx.createImageData(width, height);
  const data = image.data;
  const rnd = rand(0x9e3779b9);

  // Band boundaries as rounded proportional positions rather than an
  // explicit per-band remainder split -- the two are equivalent (every band
  // gets its floor height or one more, evenly spread across the ramp), this
  // is just the simpler way to get there.
  const bands = bandsOf(ramp);
  const bandTop = (i: number) => Math.round((i / bands) * height); // pixels up from the bottom

  for (let i = 0; i < bands; i++) {
    const from = bandTop(i);
    const to = bandTop(i + 1);
    const bandHeight = to - from;
    if (bandHeight <= 0) continue;

    const sampleCount = Math.max(1, Math.round(Math.log(Math.max(Math.E, bandHeight * width))));
    const hi = Math.min(bands - 1, i + sampleCount - 1);

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
    // The whole rect, not just its width and height: paint() needs the
    // box's absolute position to know which device pixels its edges fall
    // on, and clientWidth/clientHeight are rounded to whole CSS pixels and
    // carry no position at all.
    const repaint = () => paint(canvas, wrapper.getBoundingClientRect(), legend.ramp);
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
