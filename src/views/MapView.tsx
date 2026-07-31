import { useEffect, useMemo, useState } from 'react';
import type { LoadedFile } from '../lib/fileConfig';
import type { Selection } from '../lib/selection';
import type { ParsedGeometry } from '../lib/gpkg';

type Props = {
  dark: boolean;
  onToggleDark: () => void;
  onDiagram: () => void;
  files: Map<string, LoadedFile>;
  // Which table-column is lit. Nothing is coloured from it yet — that lands
  // after the urban-dollop pass — but the map needs to know what's selected.
  selection: Selection | null;
};

type BBox = { minX: number; minY: number; maxX: number; maxY: number };
type Proj = { minX: number; maxY: number; scale: number; padX: number; padY: number };

// Placeholder until agent styling is driven by the selection.
const AGENT_R = 3;

function expand(bbox: BBox | null, x: number, y: number): BBox {
  if (!bbox) return { minX: x, minY: y, maxX: x, maxY: y };
  return {
    minX: Math.min(bbox.minX, x),
    minY: Math.min(bbox.minY, y),
    maxX: Math.max(bbox.maxX, x),
    maxY: Math.max(bbox.maxY, y),
  };
}

function collect(geom: ParsedGeometry, bbox: BBox | null): BBox | null {
  if (!geom) return bbox;
  if (geom.type === 'Point') return expand(bbox, geom.coordinates[0], geom.coordinates[1]);
  if (geom.type === 'LineString') {
    for (const [x, y] of geom.coordinates) bbox = expand(bbox, x, y);
    return bbox;
  }
  if (geom.type === 'Polygon') {
    for (const ring of geom.coordinates) for (const [x, y] of ring) bbox = expand(bbox, x, y);
    return bbox;
  }
  return bbox;
}

function makeProj(bbox: BBox, width: number, height: number, pad = 24): Proj {
  const w = bbox.maxX - bbox.minX || 1;
  const h = bbox.maxY - bbox.minY || 1;
  const scale = Math.min((width - pad * 2) / w, (height - pad * 2) / h);
  return {
    minX: bbox.minX,
    maxY: bbox.maxY,
    scale,
    padX: (width - w * scale) / 2,
    padY: (height - h * scale) / 2,
  };
}

function project(x: number, y: number, proj: Proj): [number, number] {
  // y is flipped: geographic north is up, screen y grows downward.
  return [proj.padX + (x - proj.minX) * proj.scale, proj.padY + (proj.maxY - y) * proj.scale];
}

function toPath(rings: [number, number][][], proj: Proj, close: boolean): string {
  return rings
    .map(ring =>
      ring
        .map(([x, y], i) => {
          const [px, py] = project(x, y, proj);
          return `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`;
        })
        .join(' ') + (close ? 'Z' : '')
    )
    .join(' ');
}

function useViewport() {
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return size;
}

export default function MapView({ dark, onToggleDark, onDiagram, files }: Props) {
  const { w, h } = useViewport();

  const zones = files.get('zones.gpkg');
  const network = files.get('network.gpkg');
  const agents = files.get('agents.gpkg');
  const desireLines = files.get('desire_lines.gpkg');
  const anyLoaded = zones || network || agents || desireLines;

  const bbox = useMemo<BBox | null>(() => {
    let box: BBox | null = null;
    for (const f of [zones, network, agents, desireLines]) {
      for (const g of f?.geometries ?? []) box = collect(g, box);
    }
    return box;
  }, [zones, network, agents, desireLines]);

  // Default map is line art: ink on paper, no fills, nothing lit.
  const paper = dark ? '#000' : '#fff';
  const ink = dark ? '#fff' : '#000';
  const proj = bbox ? makeProj(bbox, w, h) : null;

  return (
    <div style={{ width: '100vw', height: '100vh', background: paper, color: ink, overflow: 'hidden' }}>
      <svg width="100%" height="100%" style={{ display: 'block' }}>
        {!anyLoaded && (
          <text
            x="50%"
            y="50%"
            textAnchor="middle"
            dominantBaseline="middle"
            fill={dark ? '#444' : '#bbb'}
            fontSize={14}
          >
            upload files in the diagram view to render the map
          </text>
        )}

        {proj && (
          <>
            {/* backmost: zone outlines, no fill */}
            {zones?.geometries?.map((geom, i) =>
              geom?.type !== 'Polygon' ? null : (
                <path
                  key={`zone-${i}`}
                  d={toPath(geom.coordinates, proj, true)}
                  fill="none"
                  stroke={ink}
                  strokeWidth={1}
                />
              )
            )}

            {network?.geometries?.map((geom, i) =>
              geom?.type !== 'LineString' ? null : (
                <path
                  key={`net-${i}`}
                  d={toPath([geom.coordinates], proj, false)}
                  fill="none"
                  stroke={ink}
                  strokeWidth={1}
                />
              )
            )}

            {desireLines?.geometries?.map((geom, i) =>
              geom?.type !== 'LineString' ? null : (
                <path
                  key={`desire-${i}`}
                  d={toPath([geom.coordinates], proj, false)}
                  fill="none"
                  stroke={ink}
                  strokeWidth={1}
                />
              )
            )}

            {/* frontmost: agents */}
            {agents?.geometries?.map((geom, i) => {
              if (geom?.type !== 'Point') return null;
              const [cx, cy] = project(geom.coordinates[0], geom.coordinates[1], proj);
              return (
                <circle
                  key={`agent-${i}`}
                  cx={cx}
                  cy={cy}
                  r={AGENT_R}
                  fill={paper}
                  stroke={ink}
                  strokeWidth={1}
                />
              );
            })}
          </>
        )}
      </svg>

      <button className="overlay-btn" style={{ top: 12, right: 12 }} onClick={onToggleDark}>
        {dark ? 'light' : 'dark'}
      </button>

      <button className="overlay-btn" style={{ bottom: 12, right: 12 }} onClick={onDiagram}>
        diagram →
      </button>
    </div>
  );
}
