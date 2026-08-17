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

export default function Diagram({ loaded, onOpenTable, onPickFile, onBack, onClearAll }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<Map<TableName, HTMLDivElement>>(new Map());
  const [edges, setEdges] = useState<Edge[]>([]);

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

  const measureEdges = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const origin = container.getBoundingClientRect();
    const measured: Edge[] = [];

    for (const edge of EDGES) {
      const from = nodeRefs.current.get(edge.from);
      const to = nodeRefs.current.get(edge.to);
      if (!from || !to) continue;
      const a = from.getBoundingClientRect();
      const b = to.getBoundingClientRect();
      const x1 = a.right - origin.left;
      const y1 = a.top + a.height / 2 - origin.top;
      const x2 = b.left - origin.left;
      const y2 = b.top + b.height / 2 - origin.top;
      const mid = (x1 + x2) / 2;
      measured.push({ d: `M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`, x1, x2, from: edge.from, to: edge.to });
    }
    setEdges(measured);
  }, []);

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
