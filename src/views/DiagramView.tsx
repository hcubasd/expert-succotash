import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { colorBg, squeezeFg } from 'psychic-potato';
import { rgbStr } from '../lib/colors';
import type { RgbColor } from '../lib/colors';
import { EDGES, NODES } from '../diagram/layout';
import { FILE_TO_NODE, NODE_TO_FILE, parseFile } from '../lib/fileConfig';
import type { LoadedFile } from '../lib/fileConfig';

type Props = {
  dark: boolean;
  files: Map<string, LoadedFile>;
  nodeColors: Map<string, RgbColor>;
  onLoadFile: (filename: string, file: LoadedFile) => void;
  onBack: () => void;
  onOpenTable: (filename: string) => void;
};

// A measured edge: the path plus the horizontal span its gradient runs across.
type Edge = { d: string; x1: number; x2: number; from: string; to: string };

// Spacer: a plain flex:1 div that absorbs slack. Deliberately not a .bg — only
// the cards are bg/fg pairs, so squeezeFg sees exactly the 23 cards.
const Spacer = () => <div style={{ flex: 1 }} />;

export default function DiagramView({
  dark,
  files,
  nodeColors,
  onLoadFile,
  onBack,
  onOpenTable,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingNode = useRef<string | null>(null);
  const nodeRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [edges, setEdges] = useState<Edge[]>([]);
  const [loading, setLoading] = useState<Set<string>>(new Set());

  const columns = useMemo(() => {
    const byCol = new Map<number, typeof NODES>();
    for (const node of NODES) {
      const list = byCol.get(node.col) ?? [];
      list.push(node);
      byCol.set(node.col, list);
    }
    return [...byCol.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, list]) => list.sort((a, b) => a.order - b.order));
  }, []);

  // An unloaded card keeps whatever colorBg gave it: white in light mode,
  // black in dark. Edges fade to that same colour at an unloaded end.
  const blank = dark ? '#000' : '#fff';
  const colorOf = useCallback(
    (nodeId: string) => {
      const c = nodeColors.get(nodeId);
      return c ? rgbStr(c) : blank;
    },
    [nodeColors, blank],
  );

  const paintNodes = useCallback(() => {
    nodeRefs.current.forEach((el, id) => {
      const color = nodeColors.get(id);
      const fg = el.querySelector<HTMLElement>('div.fg');
      if (color) {
        el.style.backgroundColor = rgbStr(color);
        // black text on every coloured background, app-wide
        if (fg) fg.style.color = '#000';
      } else if (fg) {
        fg.style.color = dark ? '#fff' : '#000';
      }
    });
  }, [nodeColors, dark]);

  const measureEdges = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const origin = container.getBoundingClientRect();
    const measured: Edge[] = [];

    for (const edge of EDGES) {
      const a = nodeRefs.current.get(edge.from);
      const b = nodeRefs.current.get(edge.to);
      if (!a || !b) continue;
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const x1 = ra.right - origin.left;
      const y1 = ra.top + ra.height / 2 - origin.top;
      const x2 = rb.left - origin.left;
      const y2 = rb.top + rb.height / 2 - origin.top;
      const mid = (x1 + x2) / 2;
      measured.push({
        d: `M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`,
        x1,
        x2,
        from: edge.from,
        to: edge.to,
      });
    }
    setEdges(measured);
  }, []);

  // Repaint the depth grays and refit the labels. Only the theme can invalidate
  // these; loading a file changes one card's colour and nothing else, so
  // paintNodes is deliberately not a dependency here.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    colorBg(container, { from: 0.75, to: dark ? 0 : 1 });
    squeezeFg(container);
    measureEdges();
  }, [dark, measureEdges]);

  // Card colours go on top of colorBg's grays. Runs after the effect above on a
  // theme change (effects fire in order), and on its own when a file loads.
  useEffect(() => { paintNodes(); }, [paintNodes]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      squeezeFg(container);
      measureEdges();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [measureEdges]);

  async function readInto(file: File, name: string) {
    setLoading(prev => new Set(prev).add(name));
    try {
      const parsed = await parseFile(file);
      onLoadFile(name, { ...parsed, filename: name });
    } catch (err) {
      console.error(`failed to load ${name}`, err);
    } finally {
      setLoading(prev => {
        const next = new Set(prev);
        next.delete(name);
        return next;
      });
    }
  }

  function handleInput(event: React.ChangeEvent<HTMLInputElement>) {
    const picked = event.target.files?.[0];
    if (!picked) return;
    const target = pendingNode.current;
    pendingNode.current = null;
    event.target.value = '';

    if (target) {
      readInto(picked, NODE_TO_FILE[target]);
      return;
    }
    const matched = FILE_TO_NODE[picked.name];
    readInto(picked, matched ? NODE_TO_FILE[matched] : picked.name);
  }

  function handleClick(nodeId: string) {
    const name = NODE_TO_FILE[nodeId];
    if (!name) return;
    if (files.has(name)) {
      onOpenTable(name);
      return;
    }
    pendingNode.current = nodeId;
    inputRef.current?.click();
  }

  function handleDrop(nodeId: string, event: React.DragEvent) {
    event.preventDefault();
    const dropped = event.dataTransfer.files[0];
    const name = NODE_TO_FILE[nodeId];
    if (dropped && name) readInto(dropped, name);
  }

  return (
    <div
      ref={containerRef}
      className="bg"
      style={{ flexDirection: 'row', width: '100vw', height: '100vh', position: 'relative' }}
      onDragOver={e => e.preventDefault()}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".csv,.gpkg"
        style={{ display: 'none' }}
        onChange={handleInput}
      />

      {/* Edges sit at z-index 0; cards are lifted to 1 so lines pass behind them. */}
      <svg
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          zIndex: 0,
        }}
      >
        <defs>
          {edges.map((edge, i) => (
            <linearGradient
              key={i}
              id={`edge-${i}`}
              gradientUnits="userSpaceOnUse"
              x1={edge.x1}
              y1={0}
              x2={edge.x2}
              y2={0}
            >
              <stop offset="0%" stopColor={colorOf(edge.from)} />
              <stop offset="100%" stopColor={colorOf(edge.to)} />
            </linearGradient>
          ))}
        </defs>
        {edges.map((edge, i) => (
          <path key={i} d={edge.d} fill="none" stroke={`url(#edge-${i})`} strokeWidth={1} />
        ))}
      </svg>

      {/*
        Root row-flex holds 13 flex:1 children:
          pad, col0, gap, col1, gap, col2, gap, col3, gap, col4, gap, col5, pad

        Each column is a plain column-flex div with 2n+1 flex:1 children —
        spacers interleaved with card slots. Each card slot is a row-flex,
        so the card's .bg takes its width from the slot's main axis, which is
        the column width. That width is geometry-bound, which is what lets
        squeezeFg bracket a fit.
      */}
      <Spacer />

      {columns.map((colNodes, ci) => (
        <Fragment key={ci}>
          {ci > 0 && <Spacer />}

          <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
            <Spacer />

            {colNodes.map((node, ni) => {
              const name = NODE_TO_FILE[node.id];
              const busy = name ? loading.has(name) : false;

              return (
                <Fragment key={node.id}>
                  {ni > 0 && <Spacer />}

                  <div style={{ display: 'flex', flex: 1, alignItems: 'center', minWidth: 0 }}>
                    <div
                      ref={el => {
                        if (el) nodeRefs.current.set(node.id, el);
                        else nodeRefs.current.delete(node.id);
                      }}
                      className="bg"
                      style={{
                        flex: 1,
                        cursor: 'pointer',
                        opacity: busy ? 0.5 : 1,
                        position: 'relative',
                        zIndex: 1,
                      }}
                      onClick={() => handleClick(node.id)}
                      onDragOver={e => e.preventDefault()}
                      onDrop={e => handleDrop(node.id, e)}
                    >
                      <div className="fg">{busy ? '…' : node.label}</div>
                    </div>
                  </div>
                </Fragment>
              );
            })}

            <Spacer />
          </div>
        </Fragment>
      ))}

      <Spacer />

      <button className="overlay-btn" style={{ bottom: 12, left: 12 }} onClick={onBack}>
        ← map
      </button>
    </div>
  );
}
