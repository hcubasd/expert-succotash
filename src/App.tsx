import { useCallback, useMemo, useRef, useState } from 'react';
import Diagram from './components/Diagram';
import Map from './components/Map';
import Table from './components/Table';
import { loadCsv } from './lib/csvLoader';
import { loadGpkg } from './lib/gpkgLoader';
import {
  boundsOf, emptyGeometries, makePoints, makePolygons, makeSegments, originOf, rawBounds,
} from './lib/geometryMaker';
import type { Bounds, Geometries, Origin } from './lib/geometryMaker';
import { activeLineLayer, applyMapColors, desireLinesAreColored } from './lib/mapColors';
import type { RawGeometry, RawTable } from './lib/rawTable';
import { FILENAME } from './lib/schema';
import type { TableName } from './lib/schema';
import { makeTable } from './lib/tableMaker';
import type { Table as TableData } from './lib/tableMaker';

type View =
  | { kind: 'map' }
  | { kind: 'diagram' }
  | { kind: 'table'; table: TableName };

// Which column is lit, app-wide. Table uses it to highlight its own header;
// the map checks it against its own registry and colors accordingly. One
// piece of state, two readers with different interpretations -- clicking a
// column the map knows nothing about simply returns the map to monochrome.
type ActiveColumn = { table: TableName; column: string };

const INK = { dark: { r: 255, g: 255, b: 255 }, light: { r: 0, g: 0, b: 0 } };
const PAPER = { dark: { r: 0, g: 0, b: 0 }, light: { r: 255, g: 255, b: 255 } };

export default function App() {
  const [view, setView] = useState<View>({ kind: 'map' });
  const [dark, setDark] = useState(false);
  const [tables, setTables] = useState<Partial<Record<TableName, TableData>>>({});
  const [activeColumn, setActiveColumn] = useState<ActiveColumn | null>(null);
  const [geometries, setGeometries] = useState<Geometries>(emptyGeometries);
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const [colorVersion, setColorVersion] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const pendingTable = useRef<TableName | null>(null);
  // Fixed by whichever geometry file arrives first and reused by every file
  // after it, so all four buckets share one frame. See geometryMaker: this is
  // what keeps float32 vertex buffers precise for real projected coordinates.
  const originRef = useRef<Origin | null>(null);

  const loaded = useMemo(() => new Set(Object.keys(tables) as TableName[]), [tables]);

  // Colors are written straight into the geometry buffers rather than passed
  // to the map as props: the map's job is to draw what it's given, and these
  // arrays are large enough that copying them per selection would be wasted
  // work. colorVersion is what tells the map they changed underneath it.
  const repaint = useCallback(
    (
      nextGeometries: Geometries,
      nextTables: Partial<Record<TableName, TableData>>,
      selection: ActiveColumn | null,
      isDark: boolean,
    ) => {
      applyMapColors(
        nextGeometries,
        nextTables,
        selection,
        isDark ? INK.dark : INK.light,
        isDark ? PAPER.dark : PAPER.light,
        isDark,
      );
      setColorVersion(v => v + 1);
    },
    [],
  );

  const selectColumn = useCallback(
    (table: TableName, column: string) => {
      const next =
        activeColumn && activeColumn.table === table && activeColumn.column === column
          ? null
          : { table, column };
      setActiveColumn(next);
      repaint(geometries, tables, next, dark);
    },
    [activeColumn, geometries, tables, dark, repaint],
  );

  const ingest = useCallback(
    async (target: TableName, file: File) => {
      let raw: RawTable;
      let rawGeometries: RawGeometry[] | null = null;

      if (FILENAME[target].endsWith('.gpkg')) {
        const parsed = await loadGpkg(await file.arrayBuffer());
        raw = parsed;
        rawGeometries = parsed.geometries;
      } else {
        raw = loadCsv(await file.text());
      }

      const table = makeTable(target, raw);
      const nextTables = { ...tables, [target]: table };

      // Geometry is rebuilt only for the four tables that carry any. The
      // expensive part -- triangulating polygons, decomposing polylines into
      // segments, flattening coordinates -- happens here, once, so mounting
      // the map later is only a buffer upload.
      const nextGeometries: Geometries = { ...geometries };
      if (rawGeometries) {
        if (!originRef.current) {
          const raw = rawBounds(rawGeometries);
          if (raw) originRef.current = originOf(raw);
        }
        const origin = originRef.current ?? { x: 0, y: 0 };
        if (target === 'zones') nextGeometries.zones = makePolygons(rawGeometries, origin);
        else if (target === 'agents') nextGeometries.agents = makePoints(rawGeometries, origin);
        else if (target === 'network') nextGeometries.network = makeSegments(rawGeometries, origin);
        else if (target === 'desire_lines') nextGeometries.desireLines = makeSegments(rawGeometries, origin);
      }

      // A replaced file may not even have the column that was driving the
      // map, so the selection can't survive it.
      const nextSelection = activeColumn?.table === target ? null : activeColumn;

      repaint(nextGeometries, nextTables, nextSelection, dark);
      setTables(nextTables);
      setGeometries(nextGeometries);
      setBounds(boundsOf(nextGeometries));
      setActiveColumn(nextSelection);
    },
    [tables, geometries, activeColumn, dark, repaint],
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
    setTables({});
    setGeometries(emptyGeometries());
    setBounds(null);
    setActiveColumn(null);
    setColorVersion(v => v + 1);
  }

  function toggleDark() {
    const next = !dark;
    setDark(next);
    repaint(geometries, tables, activeColumn, next);
  }

  const picker = (
    <input ref={inputRef} type="file" accept=".csv,.gpkg" style={{ display: 'none' }} onChange={onFileChosen} />
  );

  if (view.kind === 'map') {
    return (
      <>
        {picker}
        <Map
          dark={dark}
          geometries={geometries}
          bounds={bounds}
          lineLayer={activeLineLayer(geometries, activeColumn, tables)}
          blendDesireLines={desireLinesAreColored(activeColumn, tables)}
          colorVersion={colorVersion}
          onToggleDark={toggleDark}
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
          dark={dark}
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
        dark={dark}
        table={table}
        activeColumn={activeColumn}
        onSelectColumn={column => selectColumn(view.table, column)}
        onBack={() => setView({ kind: 'diagram' })}
        onPickFile={() => pickFile(view.table)}
      />
    </>
  );
}
