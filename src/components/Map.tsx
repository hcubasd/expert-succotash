import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MapRenderer } from '../gl/renderer';
import type { View } from '../gl/renderer';
import { boundsForMode } from '../lib/geometryMaker';
import type { Bounds, Geometries } from '../lib/geometryMaker';
import { DEFAULT_DETAIL, buildScene, legendFromFlow } from '../lib/mapScene';
import type { Legend } from '../lib/mapScene';
import { toSelection } from '../lib/mapValues';
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
// dragging -- unlike pan/zoom, which only ever commits on release. Left at
// 0 for now so that behaviour is visible and feelable rather than guessed
// at; the wiring below is real debounce, not a stand-in, so turning it on
// later is a one-line change to this constant.
const DETAIL_DEBOUNCE_MS = 0;

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
  const [flowLegend, setFlowLegend] = useState<Legend | null>(null);
  const [staticLegend, setStaticLegend] = useState<Legend | null>(null);
  // detail is what the slider shows and moves instantly; committedDetail is
  // what actually drives a recompute, released after DETAIL_DEBOUNCE_MS of
  // no further movement. Splitting them is what makes the debounce meaning-
  // ful rather than cosmetic -- the thumb never waits on the network graph.
  const [detail, setDetail] = useState(DEFAULT_DETAIL);
  const [committedDetail, setCommittedDetail] = useState(DEFAULT_DETAIL);

  useEffect(() => {
    if (DETAIL_DEBOUNCE_MS <= 0) {
      setCommittedDetail(detail);
      return;
    }
    const timer = setTimeout(() => setCommittedDetail(detail), DETAIL_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [detail]);

  const selection = useMemo(() => toSelection(draft), [draft]);
  // The fit follows the mode, so changing mode reframes onto that layer.
  const bounds = useMemo(() => boundsForMode(geometries, draft.mode), [geometries, draft.mode]);

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

  // Positions never change once loaded, but the buffers are keyed per
  // geometry object -- a reloaded file means new arrays and a new upload.
  useLayoutEffect(() => {
    rendererRef.current?.invalidate();
    viewRef.current = fitView(bounds, size.width, size.height);
    setViewVersion(v => v + 1);
  }, [geometries, bounds, size.width, size.height]);

  useLayoutEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || size.width === 0) return;

    const view = viewRef.current;
    const built = buildScene(
      tables,
      geometries,
      selection,
      view,
      pixelsPerUnit(view, size.width),
      size.ratio,
      committedDetail,
    );
    const stats = renderer.render(built.scene);

    setStaticLegend(built.legend);
    // Desire lines can only be measured by drawing them, so their legend
    // arrives with the render's return value rather than ahead of it.
    setFlowLegend(built.pendingFlowRamp && stats ? legendFromFlow(stats, built.pendingFlowRamp) : null);
  }, [tables, geometries, selection, size, viewVersion, committedDetail]);

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
    viewRef.current = fitView(
      { minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) },
      size.width,
      size.height,
    );
    setViewVersion(v => v + 1);
  }

  const reset = useCallback(() => {
    viewRef.current = fitView(bounds, size.width, size.height);
    setViewVersion(v => v + 1);
  }, [bounds, size.width, size.height]);

  const empty = !geometries.zones && !geometries.network && !geometries.desireLines && !geometries.agents;

  return (
    <div
      ref={rootRef}
      style={{
        display: 'flex',
        flexDirection: portrait ? 'column' : 'row',
        width: '100vw',
        height: '100vh',
        background: '#fff',
        color: '#000',
      }}
    >
      {/* The canvas is square in both orientations, so the world never
          distorts and the zoom rectangle is read in the same units it was
          drawn in. */}
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

        {(empty || failed) && (
          <div
            style={{
              position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              pointerEvents: 'none', opacity: 0.5, fontSize: 14, textAlign: 'center', padding: 24,
            }}
          >
            {failed ?? 'load files in the diagram view to render the map'}
          </div>
        )}

        <button className="overlay-btn" style={{ position: 'absolute', top: 12, right: 12 }} onClick={reset}>
          reset view
        </button>
      </div>

      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}>
        <MapPanel
          tables={tables}
          draft={draft}
          onDraft={onDraft}
          legend={flowLegend ?? staticLegend}
          detail={detail}
          onDetail={setDetail}
          onDiagram={onDiagram}
        />
      </div>
    </div>
  );
}
