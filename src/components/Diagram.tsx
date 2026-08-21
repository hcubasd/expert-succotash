import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { squeezeFg } from 'psychic-potato';
import { LUMINANCE, SESSION_ROTATION, grayAt, ngon, rgbStr } from '../lib/colors';
import { LINE_WIDTH_CSS_PX } from '../lib/mapScene';
import { EDGES, NODES, POSITIONS, labelOf } from './diagramLayout';
import type { TableName } from '../lib/schema';

type Props = {
  loaded: Set<TableName>;
  onOpenTable: (table: TableName) => void;
  onPickFile: (table: TableName) => void;
  onBack: () => void;
  onClearAll: () => void;
};

type Edge = { d: string; x1: number; x2: number; from: TableName; to: TableName };

// A plain flex spacer, deliberately not a .bg -- squeezeFg only measures
// bg/fg pairs, so the cards stay the only thing it sizes text against.
const Spacer = ({ weight }: { weight: number }) => <div style={{ flex: weight }} />;

// Gaps between cards run half the width and height of the cards themselves.
const CARD_WEIGHT = 2;
const GAP_WEIGHT = 1;

// The floor is the view this diagram already opens at -- scrolling out never
// goes past the layout actually fitting the screen. No ceiling: scrolling in
// is unbounded, since there's no "too close" for a flat diagram the way
// there is for real map geometry.
const MIN_SCALE = 1;
// exp(-deltaY * ZOOM_SPEED) turns a wheel tick into a multiplicative zoom
// step rather than an additive one, so the same physical scroll always
// changes the view by the same *proportion* regardless of the current scale
// -- zoomed in or out, a tick feels the same size. Exponential also
// guarantees the factor is always positive, so scroll direction can never
// flip the zoom direction no matter how large deltaY gets.
const ZOOM_SPEED = 0.0015;
// Below this a drag reads as a click (open the card, or pick a file for an
// unloaded one), not a pan -- same threshold and reasoning Table.tsx's own
// column drag uses.
const MIN_DRAG_PX = 4;

type Camera = { scale: number; tx: number; ty: number };

// tx/ty are bounded so the zoomed layer always fully covers the viewport,
// on both axes, at any scale -- panning can slide which part of it shows,
// never reveal empty space past an edge. At MIN_SCALE this collapses both
// ranges to exactly [0, 0], which is what makes the zoom floor and the pan
// bounds agree on the same one default view without needing to special-case
// it separately in two places.
function clampCamera(camera: Camera, viewport: { width: number; height: number }): Camera {
  const minTx = viewport.width * (1 - camera.scale);
  const minTy = viewport.height * (1 - camera.scale);
  return {
    scale: camera.scale,
    tx: Math.min(0, Math.max(minTx, camera.tx)),
    ty: Math.min(0, Math.max(minTy, camera.ty)),
  };
}

export default function Diagram({ loaded, onOpenTable, onPickFile, onBack, onClearAll }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  // The SVG and every card sit inside this layer, not containerRef itself,
  // and it alone carries the zoom transform. The Map/Clear buttons stay
  // direct children of containerRef, outside it: a transformed ancestor
  // becomes the containing block for its own position:fixed descendants, so
  // transforming containerRef itself would drag those buttons around with
  // the zoom instead of leaving them pinned to the viewport.
  const zoomLayerRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<Map<TableName, HTMLDivElement>>(new Map());
  const [edges, setEdges] = useState<Edge[]>([]);
  const [camera, setCamera] = useState({ scale: MIN_SCALE, tx: 0, ty: 0 });

  // Which hue lands at slot 0 varies session to session, purely for visual
  // variety -- POSITIONS (the slot *each node* draws from) is what actually
  // matters for readability, and that's fixed data, solved once offline.
  // The session rotation is a module constant, so it survives navigating
  // away and back within one page load and only rerolls on a real reload.
  const palette = useMemo(() => ngon(NODES.length, SESSION_ROTATION), []);

  // Unloaded cards sit at the same luminance as loaded ones, so the two
  // read as one consistent surface rather than the blanks looking like a
  // different kind of thing.
  const blank = useMemo(() => grayAt(LUMINANCE), []);

  // Every card's slot is a fixed lookup now (POSITIONS), not something
  // assigned as files load -- so there's no state, and no "different
  // arrangement on every mount" bug left to have. Only whether it's loaded
  // still varies, which is what picks real color vs. the neutral blank.
  const colorOf = useCallback(
    (id: TableName) => rgbStr(loaded.has(id) ? palette[POSITIONS[id]] : blank),
    [loaded, palette, blank],
  );

  const columns = useMemo(() => {
    const byColumn = new Map<number, typeof NODES>();
    for (const node of NODES) {
      const list = byColumn.get(node.col) ?? [];
      list.push(node);
      byColumn.set(node.col, list);
    }
    return [...byColumn.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, list]) => list.sort((a, b) => a.order - b.order));
  }, []);

  // offsetLeft/offsetTop/offsetWidth/offsetHeight, not getBoundingClientRect:
  // those report a card's position against its offsetParent (the zoom
  // layer, the nearest positioned ancestor -- the Spacers and column
  // wrappers between a card and it aren't positioned, so they're
  // transparent to offsetParent resolution) in *layout* space, unaffected by
  // the zoom layer's own transform. That means these coordinates -- and the
  // edges built from them -- never need recomputing when the zoom changes,
  // only when the layout actually does: the SVG lives inside the same
  // transformed layer as the cards, so it's carried along by the identical
  // transform and stays correctly registered against them at any scale.
  const measureEdges = useCallback(() => {
    const measured: Edge[] = [];

    for (const edge of EDGES) {
      const from = nodeRefs.current.get(edge.from);
      const to = nodeRefs.current.get(edge.to);
      if (!from || !to) continue;
      const x1 = from.offsetLeft + from.offsetWidth;
      const y1 = from.offsetTop + from.offsetHeight / 2;
      const x2 = to.offsetLeft;
      const y2 = to.offsetTop + to.offsetHeight / 2;
      const mid = (x1 + x2) / 2;
      measured.push({ d: `M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`, x1, x2, from: edge.from, to: edge.to });
    }
    setEdges(measured);
  }, []);

  // Plain wheel zooms, re-centering on whatever point is under the cursor
  // so that point stays fixed on screen -- the standard "zoom to point"
  // solve, done in containerRef's own viewport rect (never transformed
  // itself, so this is stable regardless of the current zoom). Panning is a
  // separate gesture, a drag, handled below by onPointerDown/Move/Up -- the
  // two don't collide since one is a wheel and the other a held button.
  //
  // A native, non-passive listener rather than JSX's onWheel: React attaches
  // its delegated wheel listener as passive (matching the browser's own
  // scroll-perf default), and preventDefault does nothing -- silently, with
  // just a console warning -- inside a passive listener. Passive has to be
  // opted out of explicitly to actually stop the browser's native
  // ctrl-wheel/pinch page zoom from firing alongside this one.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = container.getBoundingClientRect();
      const cursorX = event.clientX - rect.left;
      const cursorY = event.clientY - rect.top;
      setCamera(current => {
        const factor = Math.exp(-event.deltaY * ZOOM_SPEED);
        const nextScale = Math.max(MIN_SCALE, current.scale * factor);
        // Reaching the floor always lands on the one canonical default view
        // -- not wherever the cursor-preserving formula below would
        // otherwise leave tx/ty, which depends on where the cursor happened
        // to be on the way there. "Zoomed all the way out" has to mean the
        // same view every time, the same way it did before zoom existed.
        if (nextScale <= MIN_SCALE) {
          if (current.scale === MIN_SCALE && current.tx === 0 && current.ty === 0) return current;
          return { scale: MIN_SCALE, tx: 0, ty: 0 };
        }
        if (nextScale === current.scale) return current;
        const worldX = (cursorX - current.tx) / current.scale;
        const worldY = (cursorY - current.ty) / current.scale;
        return clampCamera(
          { scale: nextScale, tx: cursorX - worldX * nextScale, ty: cursorY - worldY * nextScale },
          rect,
        );
      });
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, []);

  // Drag-to-pan. x0/y0 and the camera are snapshotted once at pointerdown,
  // not accumulated tick over tick, so a jittery pointermove stream can't
  // drift from rounding the way repeatedly adding small deltas could.
  const dragRef = useRef<{ x0: number; y0: number; camera: Camera; dragging: boolean } | null>(null);
  // Separate from dragRef, and deliberately not cleared until the click
  // that follows a real drag has been swallowed: pointerup and the click it
  // triggers are two entirely separate browser events firing back to back,
  // so if this lived on dragRef (cleared the moment the pointer lifts) the
  // capture-phase click handler below would find nothing there by the time
  // it ran -- same click/drag disambiguation problem, solved by not losing
  // the fact that a drag happened before the click that needs to check it.
  const justDraggedRef = useRef(false);

  // Cleans up if this view unmounts mid-drag (e.g. Map/Clear navigates away
  // while a pointer is still down) -- otherwise the class, and the forced
  // cursor it carries, would stick around on whatever view comes next.
  useEffect(() => () => { document.body.classList.remove('dragging-pointer'); }, []);

  function onPointerDown(event: React.PointerEvent) {
    if (event.button !== 0) return;
    justDraggedRef.current = false;
    dragRef.current = { x0: event.clientX, y0: event.clientY, camera, dragging: false };
    // Not captured yet -- see onPointerMove. Capturing unconditionally here
    // would retarget the click that follows a plain press-and-release (no
    // real drag at all) to this outer container instead of wherever it
    // actually landed, which is exactly what broke every button and card:
    // the click stopped reaching their own onClick entirely.
    //
    // Also stops the browser's own text-selection drag from starting: a
    // card's label is plain text, and panning across one is otherwise
    // indistinguishable from "select this text" until the drag threshold is
    // crossed and dragging-pointer's user-select:none (styles.css) takes
    // over.
    event.preventDefault();
  }

  function onPointerMove(event: React.PointerEvent) {
    const state = dragRef.current;
    if (!state) return;
    const dx = event.clientX - state.x0;
    const dy = event.clientY - state.y0;
    if (!state.dragging) {
      if (Math.abs(dx) < MIN_DRAG_PX && Math.abs(dy) < MIN_DRAG_PX) return;
      state.dragging = true;
      // Captured only once a real drag is confirmed, and the forced
      // grabbing cursor only applies from here too -- a plain click never
      // reaches either. Without capture from this point on, dragging off
      // whatever element pointerdown started on would hand pointermove and
      // pointerup to whatever the cursor is over instead.
      event.currentTarget.setPointerCapture(event.pointerId);
      document.body.classList.add('dragging-pointer');
    }
    const container = containerRef.current;
    if (!container) return;
    setCamera(clampCamera(
      { scale: state.camera.scale, tx: state.camera.tx + dx, ty: state.camera.ty + dy },
      container.getBoundingClientRect(),
    ));
  }

  function onPointerUp() {
    const state = dragRef.current;
    dragRef.current = null;
    if (state?.dragging) justDraggedRef.current = true;
    document.body.classList.remove('dragging-pointer');
  }

  // Capture phase, so this runs -- and can swallow the event -- before it
  // ever reaches a card's own onClick. Consumes the flag on the way out
  // rather than leaving it set, so a later, unrelated click is never
  // mistakenly caught by a drag that already finished.
  function onClickCapture(event: React.MouseEvent) {
    if (!justDraggedRef.current) return;
    justDraggedRef.current = false;
    event.stopPropagation();
    event.preventDefault();
  }

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const fit = () => {
      try {
        squeezeFg(container, 0.98);
      } catch {
        // nothing measurable yet
      }
      measureEdges();
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(container);
    return () => observer.disconnect();
  }, [measureEdges]);

  function handleClick(id: TableName) {
    if (loaded.has(id)) onOpenTable(id);
    else onPickFile(id);
  }

  function handleClearAll() {
    if (window.confirm('Clear every loaded file? This cannot be undone.')) onClearAll();
  }

  return (
    <div
      ref={containerRef}
      style={{
        display: 'flex',
        flexDirection: 'row',
        width: '100vw',
        height: '100vh',
        position: 'relative',
        backgroundColor: '#fff',
        color: '#000',
        // No cursor override here: the default arrow is the idle state,
        // cards keep their own cursor:pointer on hover, and dragging-pointer
        // (toggled in onPointerMove/onPointerUp above) forces grabbing only
        // while an actual drag is in progress.
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClickCapture={onClickCapture}
    >
      {/* Everything that zooms lives in this one layer, transformed as a
          whole -- the SVG included, so its edges are carried along by the
          exact same transform as the cards they connect rather than needing
          to be recomputed as the scale changes (see measureEdges). Origin
          pinned to its own top-left: containerRef's rect (what the wheel
          handler measures the cursor against) never moves, so 0 0 is what
          keeps tx/ty meaning "offset from that fixed corner" at every
          scale. */}
      <div
        ref={zoomLayerRef}
        style={{
          display: 'flex',
          flexDirection: 'row',
          width: '100%',
          height: '100%',
          position: 'relative',
          transformOrigin: '0 0',
          transform: `translate(${camera.tx}px, ${camera.ty}px) scale(${camera.scale})`,
        }}
      >
        {/* Edges sit behind the cards, which are lifted to z-index 1. */}
        <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 0 }}>
          <defs>
            {edges.map((edge, i) => (
              <linearGradient key={i} id={`edge-${i}`} gradientUnits="userSpaceOnUse" x1={edge.x1} y1={0} x2={edge.x2} y2={0}>
                <stop offset="0%" stopColor={colorOf(edge.from)} />
                <stop offset="100%" stopColor={colorOf(edge.to)} />
              </linearGradient>
            ))}
          </defs>
          {edges.map((edge, i) => (
            <path key={i} d={edge.d} fill="none" stroke={`url(#edge-${i})`} strokeWidth={LINE_WIDTH_CSS_PX} />
          ))}
        </svg>

        <Spacer weight={GAP_WEIGHT} />

        {columns.map((nodes, ci) => (
          <Fragment key={ci}>
            {ci > 0 && <Spacer weight={GAP_WEIGHT} />}
            <div style={{ display: 'flex', flexDirection: 'column', flex: CARD_WEIGHT, minWidth: 0 }}>
              {/* Vertically, every slot -- gap or card -- is flex:1. Only the
                  horizontal column/gap ratio uses CARD_WEIGHT/GAP_WEIGHT. */}
              <Spacer weight={1} />
              {nodes.map((node, ni) => (
                <Fragment key={node.id}>
                  {ni > 0 && <Spacer weight={1} />}
                  <div style={{ display: 'flex', flex: 1, alignItems: 'center', minWidth: 0 }}>
                    <div
                      ref={el => {
                        if (el) nodeRefs.current.set(node.id, el);
                        else nodeRefs.current.delete(node.id);
                      }}
                      className="bg"
                      style={{
                        // flex:1 sizes the width (the wrapper is row-direction);
                        // height stays auto, so it's the label plus this padding
                        // and nothing else. Deliberately NOT alignSelf:stretch --
                        // the wrapper's alignItems:center then centers this box
                        // in its slot, and since squeezeFg gives every label one
                        // shared font size, every card in every column ends up
                        // exactly the same height.
                        flex: 1,
                        padding: '1em 0',
                        borderRadius: '1em',
                        cursor: 'pointer',
                        position: 'relative',
                        zIndex: 1,
                        backgroundColor: colorOf(node.id),
                        // Palette colors and the neutral blank both draw at
                        // the one palette luminance, which is bright, so black
                        // is the readable ink over either.
                        color: '#000',
                      }}
                      onClick={() => handleClick(node.id)}
                    >
                      <div className="fg">{labelOf(node.id)}</div>
                    </div>
                  </div>
                </Fragment>
              ))}
              <Spacer weight={1} />
            </div>
          </Fragment>
        ))}

        <Spacer weight={GAP_WEIGHT} />
      </div>

      <button className="word-btn" style={{ bottom: '1em', left: '1em' }} onClick={onBack}>
        Map
      </button>
      {loaded.size > 0 && (
        <button className="word-btn" style={{ bottom: '1em', right: '1em' }} onClick={handleClearAll}>
          Clear
        </button>
      )}
    </div>
  );
}
