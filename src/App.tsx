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
import { stratumValues, valueNumbers } from './lib/mapValues';
import type { Draft } from './lib/mapValues';
import type { RawGeometry, RawTable } from './lib/rawTable';
import { FILENAME } from './lib/schema';
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
  const [draft, setDraft] = useState<Draft>({ mode: null });

  const inputRef = useRef<HTMLInputElement>(null);
  const pendingTable = useRef<TableName | null>(null);
  // Fixed by whichever geometry file arrives first and reused by every file
  // after it, so all buckets share one frame. See geometryMaker: this is what
  // keeps float32 vertex buffers precise for real projected coordinates.
  const originRef = useRef<Origin | null>(null);

  const loaded = useMemo(() => new Set(Object.keys(tables) as TableName[]), [tables]);

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
    setTables({});
    setGeometries(emptyGeometries());
    setActiveColumn(null);
    setDraft({ mode: null });
  }

  function selectColumn(table: TableName, column: string) {
    setActiveColumn(current =>
      current && current.table === table && current.column === column ? null : { table, column },
    );
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
        onPickFile={() => pickFile(view.table)}
      />
    </>
  );
}
