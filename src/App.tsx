import { useCallback, useMemo, useRef, useState } from 'react';
import Diagram from './components/Diagram';
import Map from './components/Map';
import Table from './components/Table';
import { loadCsv } from './lib/csvLoader';
import { loadGpkg } from './lib/gpkgLoader';
import {
  emptyGeometries, makeDesireLineEdges, makePoints, makePolygons, makeSegments,
  originOf, rawBounds,
} from './lib/geometryMaker';
import type { Geometries, Origin } from './lib/geometryMaker';
import type { View as MapView } from './gl/renderer';
import { rerollMapPalette } from './lib/colors';
import { DEFAULT_DETAIL_BY_MODE, LINE_WIDTH_CSS_PX } from './lib/mapScene';
import { DEFAULT_ACTIVE, stratumValues, valueNumbers } from './lib/mapValues';
import type { Draft, MapMode } from './lib/mapValues';
import type { RawGeometry, RawTable } from './lib/rawTable';
import { FILENAME, REQUIRED_COLUMNS } from './lib/schema';
import type { TableName } from './lib/schema';
import { makeTable } from './lib/tableMaker';
import type { Table as TableData } from './lib/tableMaker';

type View =
  | { kind: 'map' }
  | { kind: 'diagram' }
  | { kind: 'table'; table: TableName };

// Which column is lit in the table view. Purely a table concern now -- the
// map has its own explicit selection, because "whichever column happens to
// be clicked" was never expressive enough to say things like "supply of
// pallets, joined onto zones".
type ActiveColumn = { table: TableName; column: string };

export default function App() {
  const [view, setView] = useState<View>({ kind: 'map' });
  const [tables, setTables] = useState<Partial<Record<TableName, TableData>>>({});
  const [activeColumn, setActiveColumn] = useState<ActiveColumn | null>(null);
  const [geometries, setGeometries] = useState<Geometries>(emptyGeometries);
  const [draft, setDraft] = useState<Draft>({ active: DEFAULT_ACTIVE });
  // How the map is being *looked at*, kept here rather than inside Map so it
  // survives the trip to a table and back. The draft already lived here, so
  // the panel's own selections always persisted; the camera and the detail
  // sliders did not, and coming back to a reset view was losing your place.
  const [detail, setDetail] = useState<Record<MapMode, number>>(DEFAULT_DETAIL_BY_MODE);
  // Same reasoning, same persistence: a line-width slider only reads as a
  // real control if it stays put across a trip to the diagram or a table,
  // the same as the camera and the detail sliders beside it.
  const [lineWidth, setLineWidth] = useState(LINE_WIDTH_CSS_PX);
  // A ref, not state: nothing here re-renders App, and the camera changes on
  // every pan and zoom. Tagged with the geometries it was framed against, so
  // loading a new file still refits instead of restoring a view of data that
  // is no longer on screen.
  const cameraRef = useRef<{ geometries: Geometries; view: MapView; history: MapView[] } | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const pendingTable = useRef<TableName | null>(null);
  // Fixed by whichever geometry file arrives first and reused by every file
  // after it, so all buckets share one frame. See geometryMaker: this is what
  // keeps float32 vertex buffers precise for real projected coordinates.
  const originRef = useRef<Origin | null>(null);
  // The first geometry file's own gpkg_contents.srs_id, kept only to compare
  // against -- never resolved into a real projection or converted into
  // anything. This app has no way to reconcile two files in different real
  // units (that needs the CRS-and-reprojection machinery urban-dollop's own
  // synth pipeline now requires at the source), so the only thing worth
  // doing here is refusing to silently overlay files that don't even claim
  // to agree, and pointing at the file that broke agreement.
  const srsRef = useRef<{ id: number | null; file: string } | null>(null);

  const loaded = useMemo(() => new Set(Object.keys(tables) as TableName[]), [tables]);

  const ingest = useCallback(
    async (target: TableName, file: File) => {
      // Cheap and first: the picker never enforces which file goes with
      // which card, so nothing stops the wrong one being chosen by mistake.
      // Extra columns in a real match are always fine and silently ignored
      // elsewhere -- this only ever catches the file being some other table
      // entirely, or missing something that table can't do without.
      if (file.name !== FILENAME[target]) {
        window.alert(`Expected ${FILENAME[target]} for this card, but got ${file.name}.`);
        return;
      }

      let raw: RawTable;
      let rawGeometries: RawGeometry[] | null = null;
      let srsId: number | null = null;

      if (FILENAME[target].endsWith('.gpkg')) {
        const parsed = await loadGpkg(await file.arrayBuffer());
        raw = parsed;
        rawGeometries = parsed.geometries;
        srsId = parsed.srsId;
      } else {
        raw = loadCsv(await file.text());
      }

      const missing = REQUIRED_COLUMNS[target].filter(column => !raw.headers.includes(column));
      if (missing.length > 0) {
        window.alert(`${file.name} is missing required column(s): ${missing.join(', ')}.`);
        return;
      }

      // Every geometry file has to agree on the same srs_id as the first one
      // loaded, or overlaying them is meaningless -- there is no reprojection
      // here to reconcile two that don't. Two files can both carry the exact
      // same id and still not be in real, meaningful units (an "undefined"
      // placeholder id matching itself is not a real CRS agreeing with
      // itself), so this can't promise the map is *correct* -- only that it
      // refuses to silently draw two files that don't even claim to match.
      if (rawGeometries) {
        if (!srsRef.current) {
          srsRef.current = { id: srsId, file: FILENAME[target] };
        } else if (srsRef.current.id !== srsId) {
          window.alert(
            `${file.name}'s coordinate reference (srs_id ${srsId ?? 'none'}) doesn't match `
            + `${srsRef.current.file}'s (srs_id ${srsRef.current.id ?? 'none'}). `
            + 'Loading it anyway would overlay two files that are not known to share the same units.',
          );
          return;
        }
      }

      const table = makeTable(target, raw);
      const nextTables = { ...tables, [target]: table };

      // Geometry is rebuilt only for the four tables that carry any. The
      // expensive part -- triangulating polygons, decomposing polylines,
      // collapsing desire lines per resource -- happens here, once, so
      // mounting the map later is only a buffer upload.
      const nextGeometries: Geometries = { ...geometries };
      if (rawGeometries) {
        if (!originRef.current) {
          const bounds = rawBounds(rawGeometries);
          if (bounds) originRef.current = originOf(bounds);
        }
        const origin = originRef.current ?? { x: 0, y: 0 };
        if (target === 'zones') nextGeometries.zones = makePolygons(rawGeometries, origin);
        else if (target === 'agents') nextGeometries.agents = makePoints(rawGeometries, origin);
        else if (target === 'network') nextGeometries.network = makeSegments(rawGeometries, origin);
        else if (target === 'desire_lines') {
          const resources = stratumValues(table, 'resource');
          const quantities = valueNumbers(table, 'quantity');
          nextGeometries.desireLines = resources && quantities
            ? makeDesireLineEdges(rawGeometries, resources, quantities, origin)
            : null;
        }
      }

      // A replaced file may not have the column that was driving the table
      // highlight, so the selection can't survive it.
      const nextSelection = activeColumn?.table === target ? null : activeColumn;

      // A new file can change how many resources exist, and the resource
      // n-gon that spaces every map ramp is built from that count -- so the
      // ramps are being respaced regardless. Redrawing which vertex counts
      // as first here rather than leaving it fixed for the page's life is
      // what makes the palette vary between sessions instead of being
      // decided once, and this is the only moment it can change anything.
      rerollMapPalette();

      setTables(nextTables);
      setGeometries(nextGeometries);
      setActiveColumn(nextSelection);
    },
    [tables, geometries, activeColumn],
  );

  function pickFile(target: TableName) {
    pendingTable.current = target;
    inputRef.current?.click();
  }

  function onFileChosen(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    const target = pendingTable.current;
    pendingTable.current = null;
    event.target.value = '';
    if (file && target) {
      ingest(target, file).catch(error => console.error(`failed to load ${FILENAME[target]}`, error));
    }
  }

  function clearAll() {
    originRef.current = null;
    srsRef.current = null;
    setTables({});
    setGeometries(emptyGeometries());
    setActiveColumn(null);
    setDraft({ active: DEFAULT_ACTIVE });
  }

  function selectColumn(table: TableName, column: string) {
    setActiveColumn(current =>
      current && current.table === table && current.column === column ? null : { table, column },
    );
  }

  // Removes one file, not everything -- the table-view Clear button. Only
  // four tables carry geometry at all, so only those four have a matching
  // field to null out; the rest just drop out of `tables`.
  function clearTable(target: TableName) {
    setTables(current => {
      const next = { ...current };
      delete next[target];
      return next;
    });
    if (target === 'zones' || target === 'agents' || target === 'network' || target === 'desire_lines') {
      const key = target === 'desire_lines' ? 'desireLines' : target;
      setGeometries(current => ({ ...current, [key]: null }));
    }
    setActiveColumn(current => (current?.table === target ? null : current));
    setView({ kind: 'diagram' });
  }

  const picker = (
    <input ref={inputRef} type="file" accept=".csv,.gpkg" style={{ display: 'none' }} onChange={onFileChosen} />
  );

  if (view.kind === 'map') {
    return (
      <>
        {picker}
        <Map
          tables={tables}
          geometries={geometries}
          draft={draft}
          onDraft={setDraft}
          detail={detail}
          onDetail={setDetail}
          lineWidth={lineWidth}
          onLineWidth={setLineWidth}
          camera={cameraRef}
          onDiagram={() => setView({ kind: 'diagram' })}
        />
      </>
    );
  }

  if (view.kind === 'diagram') {
    return (
      <>
        {picker}
        <Diagram
          loaded={loaded}
          onOpenTable={table => setView({ kind: 'table', table })}
          onPickFile={pickFile}
          onBack={() => setView({ kind: 'map' })}
          onClearAll={clearAll}
        />
      </>
    );
  }

  const table = tables[view.table];
  if (!table) {
    return (
      <div style={{ padding: 24 }}>
        {FILENAME[view.table]} is not loaded.
        <br />
        <button onClick={() => setView({ kind: 'diagram' })}>← diagram</button>
      </div>
    );
  }

  return (
    <>
      {picker}
      <Table
        table={table}
        activeColumn={activeColumn}
        onSelectColumn={column => selectColumn(view.table, column)}
        onBack={() => setView({ kind: 'diagram' })}
        onClear={() => clearTable(view.table)}
      />
    </>
  );
}
