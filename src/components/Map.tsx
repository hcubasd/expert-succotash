import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MapRenderer } from '../gl/renderer';
import type { View } from '../gl/renderer';
import { LUMINANCE_DARK, LUMINANCE_LIGHT } from '../lib/colors';
import type { Bounds, Geometries } from '../lib/geometryMaker';

type Props = {
  dark: boolean;
  geometries: Geometries;
  bounds: Bounds | null;
  lineLayer: 'network' | 'desireLines' | null;
  blendDesireLines: boolean;
  // Bumped whenever the fill colors on `geometries` are rewritten in place;
  // the arrays themselves keep their identity, so this is what tells the
  // renderer to re-upload them.
  colorVersion: number;
  onToggleDark: () => void;
  onDiagram: () => void;
};

const FIT_PADDING = 0.92;
// Below this a drag reads as a click, not a zoom rectangle.
const MIN_DRAG_PX = 4;

type Drag = { x0: number; y0: number; x1: number; y1: number };

// Pixels per world unit, recovered from the view. The transform is
// (world - center) * scale, where scale carries the 2/size clip conversion.
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

export default function Map({
  dark, geometries, bounds, lineLayer, blendDesireLines, colorVersion, onToggleDark, onDiagram,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<MapRenderer | null>(null);
  const viewRef = useRef<View>({ centerX: 0, centerY: 0, scaleX: 1, scaleY: 1 });
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // Only used to force a redraw after an interaction; the view itself lives
  // in a ref so a drag doesn't rebuild the component tree on every frame.
  const [, setTick] = useState(0);
  const redraw = useCallback(() => setTick(t => t + 1), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      rendererRef.current = new MapRenderer(canvas, dark ? LUMINANCE_DARK : LUMINANCE_LIGHT);
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error));
      return;
    }
    return () => {
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, []);

  // Positions never change once loaded, but the buffers are keyed per
  // geometry object -- a reloaded file means new arrays and a new upload.
  useEffect(() => {
    rendererRef.current?.invalidate();
    viewRef.current = fitView(bounds, size.width, size.height);
    redraw();
  }, [geometries, bounds, size.width, size.height, redraw]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const measure = () => {
      const ratio = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.floor(canvas.clientWidth * ratio));
      const height = Math.max(1, Math.floor(canvas.clientHeight * ratio));
      canvas.width = width;
      canvas.height = height;
      setSize({ width, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || size.width === 0) return;
    const paper = dark ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
    renderer.setLuminance(dark ? LUMINANCE_DARK : LUMINANCE_LIGHT);
    renderer.render(geometries, viewRef.current, paper, lineLayer, blendDesireLines, colorVersion);
  });

  // Scrolling pans. Zoom stays on the drag-rectangle gesture, so the wheel is
  // free for this -- and panning only ever moves the translation half of a
  // transform that zooming already needs.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const ratio = window.devicePixelRatio || 1;
      const scale = pixelsPerUnit(viewRef.current, size.width);
      if (scale <= 0) return;
      viewRef.current = {
        ...viewRef.current,
        centerX: viewRef.current.centerX + (event.deltaX * ratio) / scale,
        centerY: viewRef.current.centerY - (event.deltaY * ratio) / scale,
      };
      redraw();
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [size.width, redraw]);

  function toWorld(clientX: number, clientY: number) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const view = viewRef.current;
    const scale = pixelsPerUnit(view, size.width);
    const px = (clientX - rect.left) * ratio - size.width / 2;
    const py = (clientY - rect.top) * ratio - size.height / 2;
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
    const rect: Bounds = {
      minX: Math.min(a.x, b.x),
      maxX: Math.max(a.x, b.x),
      minY: Math.min(a.y, b.y),
      maxY: Math.max(a.y, b.y),
    };
    viewRef.current = fitView(rect, size.width, size.height);
    redraw();
  }

  function reset() {
    viewRef.current = fitView(bounds, size.width, size.height);
    redraw();
  }

  const paper = dark ? '#000' : '#fff';
  const ink = dark ? '#fff' : '#000';
  const empty = !geometries.zones && !geometries.network && !geometries.desireLines && !geometries.agents;

  return (
    <div style={{ width: '100vw', height: '100vh', background: paper, color: ink, position: 'relative', overflow: 'hidden' }}>
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
            border: `1px solid ${ink}`,
            pointerEvents: 'none',
          }}
        />
      )}

      {(empty || failed) && (
        <div
          style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'none', opacity: 0.5, fontSize: 14,
          }}
        >
          {failed ?? 'load files in the diagram view to render the map'}
        </div>
      )}

      <button className="overlay-btn" style={{ top: 12, right: 12 }} onClick={reset}>reset view</button>
      <button className="overlay-btn" style={{ bottom: 12, left: 12 }} onClick={onToggleDark}>
        {dark ? 'light' : 'dark'}
      </button>
      <button className="overlay-btn" style={{ bottom: 12, right: 12 }} onClick={onDiagram}>diagram →</button>
    </div>
  );
}
