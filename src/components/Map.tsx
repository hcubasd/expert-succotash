import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { colorBg, squeezeFg } from 'psychic-potato';
import { MapRenderer } from '../gl/renderer';
import type { View } from '../gl/renderer';
import { boundsOf } from '../lib/geometryMaker';
import type { Bounds, Geometries } from '../lib/geometryMaker';
import { LUMINANCE } from '../lib/colors';
import { DEFAULT_DETAIL, buildScene, legendFromFlow } from '../lib/mapScene';
import type { BuiltScene, Legend } from '../lib/mapScene';
import type { Draft, Tables } from '../lib/mapValues';
import MapPanel from './MapPanel';

type Props = {
  tables: Tables;
  geometries: Geometries;
  draft: Draft;
  onDraft: (draft: Draft) => void;
  onDiagram: () => void;
};

const FIT_PADDING = 0.92;
// Below this a drag reads as a click, not a zoom rectangle.
const MIN_DRAG_PX = 4;

// The slider's raw onChange fires on every intermediate value while
// dragging -- unlike pan/zoom, which only ever commits on release. Off for
// every mode, zones included: it was tried as a global constant, delayed
// modes that never needed it, and even scoped to zones alone it's not what
// was asked for here. The split between `detail` and `committedDetail` below
// stays regardless, so turning this into a real per-mode debounce later is
// still a one-line change, not a rewire.
function detailDebounceFor(): number {
  return 0;
}

type Drag = { x0: number; y0: number; x1: number; y1: number };

// Device pixels per world unit. The transform is (world - center) * scale,
// where scale already carries the 2/size clip conversion.
const pixelsPerUnit = (view: View, width: number) => (view.scaleX * width) / 2;

function fitView(bounds: Bounds | null, width: number, height: number): View {
  if (!bounds || width === 0 || height === 0) {
    return { centerX: 0, centerY: 0, scaleX: 1, scaleY: 1 };
  }
  const worldWidth = Math.max(bounds.maxX - bounds.minX, 1e-9);
  const worldHeight = Math.max(bounds.maxY - bounds.minY, 1e-9);
  // One scale for both axes so the map never distorts.
  const scale = Math.min(width / worldWidth, height / worldHeight) * FIT_PADDING;
  return {
    centerX: (bounds.minX + bounds.maxX) / 2,
    centerY: (bounds.minY + bounds.maxY) / 2,
    scaleX: (scale * 2) / width,
    scaleY: (scale * 2) / height,
  };
}

export default function Map({ tables, geometries, draft, onDraft, onDiagram }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<MapRenderer | null>(null);
  const viewRef = useRef<View>({ centerX: 0, centerY: 0, scaleX: 1, scaleY: 1 });

  const [size, setSize] = useState({ width: 0, height: 0, ratio: 1 });
  const [portrait, setPortrait] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // Zoom lives in a ref so the transform is never a render's worth of work
  // behind; this is what tells the draw effect the view moved.
  const [viewVersion, setViewVersion] = useState(0);
  // Every zoom-rectangle commit pushes the view it replaced, so Back walks
  // out exactly one step at a time, all the way to the fit it started from.
  const [history, setHistory] = useState<View[]>([]);
  const [flowLegend, setFlowLegend] = useState<Legend | null>(null);
  const [legends, setLegends] = useState<BuiltScene['legends']>({ zones: null, agents: null, network: null });
  // detail is what the slider shows and moves instantly; committedDetail is
  // what actually drives a recompute. Kept as two states even at zero delay,
  // so a real debounce is a constant to change, not new wiring to add.
  const [detail, setDetail] = useState(DEFAULT_DETAIL);
  const [committedDetail, setCommittedDetail] = useState(DEFAULT_DETAIL);

  useEffect(() => {
    const delay = detailDebounceFor();
    if (delay <= 0) {
      setCommittedDetail(detail);
      return;
    }
    const timer = setTimeout(() => setCommittedDetail(detail), delay);
    return () => clearTimeout(timer);
  }, [detail]);

  // Creation, measurement and draw are all layout effects in this order:
  // a passive effect for creation would run *after* the draw and leave the
  // mount commit painting nothing.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      rendererRef.current = new MapRenderer(canvas);
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error));
      return;
    }
    return () => {
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const root = rootRef.current;
    if (!canvas || !root) return;
    const measure = () => {
      const ratio = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.floor(canvas.clientWidth * ratio));
      const height = Math.max(1, Math.floor(canvas.clientHeight * ratio));
      canvas.width = width;
      canvas.height = height;
      setSize({ width, height, ratio });
      setPortrait(root.clientHeight > root.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  // The panel's own colors and shared font size. Both start from the map
  // root rather than the panel: the root is the outermost .bg, so it has to
  // be the depth the ramp counts from, and it starts at the palette's own
  // luminance exactly like the table view does. squeezeFg is bounded above
  // by the body font -- it happily grows text to fill a wide card, which at
  // a few short labels reads as a headline rather than a control.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const fit = () => {
      colorBg(root, { from: LUMINANCE, to: 1 });
      try {
        const fitted = squeezeFg(root, 0.98);
        const bodySize = parseFloat(getComputedStyle(document.body).fontSize);
        // Whole pixels only -- the panel's cells carry 1em padding, and a
        // fractional root font size makes squeezeFg's next fit throw against
        // its own subpixel rounding. See the long note in Table.tsx's
        // fitFont: same padding, same failure, same fix.
        const capped = Math.max(1, Math.floor(Math.min(fitted, bodySize)));
        root.style.fontSize = `${capped}px`;
        // squeezeFg writes its result as an inline style directly on every
        // fg it measured, which wins over the inherited size above -- so
        // the cap has to be reapplied to those same elements, not just to
        // root, or a wide panel with short labels keeps growing past body
        // size regardless of what root itself is set to.
        if (fitted > bodySize) {
          for (const bg of root.querySelectorAll<HTMLElement>('.bg')) {
            const fg = bg.querySelector<HTMLElement>(':scope > .fg');
            if (fg) fg.style.fontSize = `${capped}px`;
          }
        }
      } catch {
        // nothing measurable yet
      }
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(root);
    return () => observer.disconnect();
  }, [tables, draft, legends, flowLegend, portrait]);

  // Positions never change once loaded, but the buffers are keyed per
  // geometry object -- a reloaded file means new arrays and a new upload.
  // Fits to everything loaded, not just whichever layers are toggled on:
  // toggling a layer is a filter on what's already framed, not a reason to
  // move the camera, so only a real geometry change re-fits here.
  useLayoutEffect(() => {
    rendererRef.current?.invalidate();
    viewRef.current = fitView(boundsOf(geometries), size.width, size.height);
    setHistory([]);
    setViewVersion(v => v + 1);
  }, [geometries, size.width, size.height]);

  useLayoutEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || size.width === 0) return;

    const view = viewRef.current;
    const built = buildScene(
      tables,
      geometries,
      draft,
      view,
      pixelsPerUnit(view, size.width),
      size.ratio,
      committedDetail,
    );
    const stats = renderer.render(built.scene);

    setLegends(built.legends);
    // Desire lines can only be measured by drawing them, so their legend
    // arrives with the render's return value rather than ahead of it.
    setFlowLegend(built.pendingFlowRamp && stats ? legendFromFlow(stats, built.pendingFlowRamp) : null);
  }, [tables, geometries, draft, size, viewVersion, committedDetail]);

  function toWorld(clientX: number, clientY: number) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const view = viewRef.current;
    const scale = pixelsPerUnit(view, size.width);
    const px = (clientX - rect.left) * size.ratio - size.width / 2;
    const py = (clientY - rect.top) * size.ratio - size.height / 2;
    // Screen y grows downward, world y upward.
    return { x: view.centerX + px / scale, y: view.centerY - py / scale };
  }

  function onPointerDown(event: React.PointerEvent) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ x0: event.clientX, y0: event.clientY, x1: event.clientX, y1: event.clientY });
  }

  function onPointerMove(event: React.PointerEvent) {
    setDrag(current => (current ? { ...current, x1: event.clientX, y1: event.clientY } : null));
  }

  function onPointerUp(event: React.PointerEvent) {
    const current = drag;
    setDrag(null);
    if (!current) return;
    event.currentTarget.releasePointerCapture(event.pointerId);

    const dx = Math.abs(current.x1 - current.x0);
    const dy = Math.abs(current.y1 - current.y0);
    if (dx < MIN_DRAG_PX || dy < MIN_DRAG_PX) return;

    const a = toWorld(current.x0, current.y0);
    const b = toWorld(current.x1, current.y1);
    // Captured before the ref is overwritten, not read from inside the
    // setHistory updater: a functional updater runs lazily, during React's
    // batched commit, which is *after* every synchronous line below it --
    // by the time h => [...h, viewRef.current] actually ran, the very next
    // line had already mutated viewRef.current to the new view, so every
    // zoom was pushing the view it was zooming *into*. That shifted the
    // whole stack by one: the first Back click always popped the view
    // already on screen (a no-op that looked like nothing happened), and
    // only the second click reached the actually-previous one.
    const previous = viewRef.current;
    viewRef.current = fitView(
      { minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) },
      size.width,
      size.height,
    );
    setHistory(h => [...h, previous]);
    setViewVersion(v => v + 1);
  }

  // Reads the popped view straight from state rather than from inside a
  // setHistory updater: an updater has to be pure, and React calls it twice
  // in development, which meant the old version moved the camera two steps
  // per click and left the button fighting itself.
  const goBack = useCallback(() => {
    if (history.length === 0) return;
    viewRef.current = history[history.length - 1];
    setHistory(history.slice(0, -1));
    setViewVersion(v => v + 1);
  }, [history]);

  // Zooms all the way back out to everything loaded, the same fit the view
  // starts at. Pushes onto the same history stack a drag-zoom does, so Back
  // still undoes it one step at a time rather than the reset being a
  // separate, un-undoable jump.
  const resetView = useCallback(() => {
    const previous = viewRef.current;
    viewRef.current = fitView(boundsOf(geometries), size.width, size.height);
    setHistory(h => [...h, previous]);
    setViewVersion(v => v + 1);
  }, [geometries, size.width, size.height]);

  return (
    // The whole view is the colorBg root, so the 1px gap between canvas and
    // panel falls out of .bg's own gap rule rather than being drawn -- the
    // same way every other seam in the app is made. The canvas wrapper is
    // deliberately a plain div: it takes no color of its own and, not being
    // a .bg, never counts toward the nesting depth the panel's ramp is
    // measured against.
    <div
      ref={rootRef}
      className="bg"
      style={{ flexDirection: portrait ? 'column' : 'row', width: '100vw', height: '100vh', color: '#000' }}
    >
      {/* Square in both orientations, so the world never distorts and the
          zoom rectangle is read in the same units it was drawn in. */}
      <div
        style={{
          position: 'relative',
          flexShrink: 0,
          aspectRatio: '1 / 1',
          ...(portrait ? { width: '100%' } : { height: '100%' }),
        }}
      >
        <canvas
          ref={canvasRef}
          style={{ display: 'block', width: '100%', height: '100%', cursor: 'crosshair', touchAction: 'none' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />

        {drag && (
          <div
            style={{
              position: 'fixed',
              left: Math.min(drag.x0, drag.x1),
              top: Math.min(drag.y0, drag.y1),
              width: Math.abs(drag.x1 - drag.x0),
              height: Math.abs(drag.y1 - drag.y0),
              border: '1px solid #000',
              pointerEvents: 'none',
            }}
          />
        )}

        {/* Only a real failure says anything. An empty canvas with no files
            loaded is just an empty canvas. */}
        {failed && (
          <div
            style={{
              position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              pointerEvents: 'none', opacity: 0.5, textAlign: 'center', padding: 24,
            }}
          >
            {failed}
          </div>
        )}

        {history.length > 0 && (
          <button className="word-btn" style={{ position: 'absolute', bottom: '1em', left: '1em' }} onClick={goBack}>
            Back
          </button>
        )}

        <button className="word-btn" style={{ position: 'absolute', bottom: '1em', right: '1em' }} onClick={onDiagram}>
          Diagram
        </button>

        <button className="word-btn" style={{ position: 'absolute', top: '1em', right: '1em' }} onClick={resetView}>
          Reset
        </button>
      </div>

      <MapPanel
        tables={tables}
        draft={draft}
        onDraft={onDraft}
        legends={legends}
        flowLegend={flowLegend}
        detail={detail}
        onDetail={setDetail}
      />
    </div>
  );
}
