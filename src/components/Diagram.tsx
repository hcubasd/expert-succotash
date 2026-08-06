import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { squeezeFg } from 'psychic-potato';
import { LUMINANCE_DARK, LUMINANCE_LIGHT, grayAt, ngon, randomRotation, rgbStr } from '../lib/colors';
import { EDGES, NODES, labelOf } from './diagramLayout';
import type { TableName } from '../lib/schema';

type Props = {
  dark: boolean;
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

const UNLOADED_LIGHTNESS = { dark: 0.28, light: 0.78 };

export default function Diagram({ dark, loaded, onOpenTable, onPickFile, onBack, onClearAll }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<Map<TableName, HTMLDivElement>>(new Map());
  const [edges, setEdges] = useState<Edge[]>([]);

  // The diagram owns its own palette: nothing outside it needs to know which
  // card got which hue. One rotation for the session, colors handed out as
  // files arrive so the set of used hues always matches what's loaded.
  const [rotation] = useState(randomRotation);
  const luminance = dark ? LUMINANCE_DARK : LUMINANCE_LIGHT;
  const palette = useMemo(() => ngon(NODES.length, rotation, luminance), [rotation, luminance]);
  // Which palette index each loaded table drew -- not the resolved color.
  // Storing the index is what lets a dark/light toggle repaint every
  // already-assigned card at the new luminance for free: the index stays
  // put, palette[index] just points at a different point on the new circle.
  const [nodeIndices, setNodeIndices] = useState<Map<TableName, number>>(new Map());

  useEffect(() => {
    setNodeIndices(previous => {
      let next: Map<TableName, number> | null = null;
      for (const id of loaded) {
        if (previous.has(id)) continue;
        const used = new Set((next ?? previous).values());
        const free: number[] = [];
        for (let i = 0; i < palette.length; i++) if (!used.has(i)) free.push(i);
        if (free.length === 0) break;
        next = next ?? new Map(previous);
        next.set(id, free[Math.floor(Math.random() * free.length)]);
      }
      // Drop indices for anything no longer loaded, so a cleared file frees
      // its hue back to the palette.
      for (const id of previous.keys()) {
        if (!loaded.has(id)) {
          next = next ?? new Map(previous);
          next.delete(id);
        }
      }
      return next ?? previous;
    });
  }, [loaded, palette]);

  const blank = useMemo(
    () => grayAt(dark ? UNLOADED_LIGHTNESS.dark : UNLOADED_LIGHTNESS.light),
    [dark],
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

  const colorOf = useCallback(
    (id: TableName) => {
      const index = nodeIndices.get(id);
      return rgbStr(index !== undefined ? palette[index] : blank);
    },
    [nodeIndices, palette, blank],
  );

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
        squeezeFg(container);
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
        backgroundColor: dark ? '#000' : '#fff',
        color: dark ? '#fff' : '#000',
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
          <path key={i} d={edge.d} fill="none" stroke={`url(#edge-${i})`} strokeWidth={1} />
        ))}
      </svg>

      <Spacer weight={GAP_WEIGHT} />

      {columns.map((nodes, ci) => (
        <Fragment key={ci}>
          {ci > 0 && <Spacer weight={GAP_WEIGHT} />}
          <div style={{ display: 'flex', flexDirection: 'column', flex: CARD_WEIGHT, minWidth: 0 }}>
            <Spacer weight={GAP_WEIGHT} />
            {nodes.map((node, ni) => {
              const index = nodeIndices.get(node.id);
              const color = index !== undefined ? palette[index] : undefined;
              return (
                <Fragment key={node.id}>
                  {ni > 0 && <Spacer weight={GAP_WEIGHT} />}
                  <div style={{ display: 'flex', flex: CARD_WEIGHT, alignItems: 'center', minWidth: 0 }}>
                    <div
                      ref={el => {
                        if (el) nodeRefs.current.set(node.id, el);
                        else nodeRefs.current.delete(node.id);
                      }}
                      className="bg"
                      style={{
                        flex: 1,
                        alignSelf: 'stretch',
                        cursor: 'pointer',
                        position: 'relative',
                        zIndex: 1,
                        backgroundColor: rgbStr(color ?? blank),
                        // Black on a real palette color; on the neutral card
                        // the readable choice is whatever contrasts with the
                        // gray, which is the opposite of the page's ink.
                        color: color ? '#000' : dark ? '#fff' : '#000',
                      }}
                      onClick={() => handleClick(node.id)}
                    >
                      <div className="fg">{labelOf(node.id)}</div>
                    </div>
                  </div>
                </Fragment>
              );
            })}
            <Spacer weight={GAP_WEIGHT} />
          </div>
        </Fragment>
      ))}

      <Spacer weight={GAP_WEIGHT} />

      <button className="overlay-btn" style={{ bottom: 12, left: 12 }} onClick={onBack}>
        ← map
      </button>
      {loaded.size > 0 && (
        <button className="overlay-btn" style={{ bottom: 12, right: 12 }} onClick={handleClearAll}>
          clear all
        </button>
      )}
    </div>
  );
}
