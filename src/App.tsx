import { useCallback, useMemo, useState } from 'react';
import MapView from './views/MapView';
import DiagramView from './views/DiagramView';
import TableView from './views/TableView';
import { NODES } from './diagram/layout';
import { FILE_TO_NODE } from './lib/fileConfig';
import type { LoadedFile } from './lib/fileConfig';
import { ngon, randomRotation, rgbStr } from './lib/colors';
import type { RgbColor } from './lib/colors';
import { buildSelection } from './lib/selection';
import type { Selection } from './lib/selection';

type View =
  | { kind: 'map' }
  | { kind: 'diagram' }
  | { kind: 'table'; filename: string };

export default function App() {
  const [view, setView] = useState<View>({ kind: 'map' });
  const [dark, setDark] = useState(false);
  const [files, setFiles] = useState<Map<string, LoadedFile>>(new Map());

  // Nothing is lit anywhere until the user clicks a column header.
  const [selection, setSelection] = useState<Selection | null>(null);

  // The diagram's palette is one rotation of the N-gon, fixed for the session.
  // Colours are handed out as files arrive, not up front, so the set of used
  // hues always matches the set of loaded files.
  const [nodeRotation] = useState(randomRotation);
  const [nodeColors, setNodeColors] = useState<Map<string, RgbColor>>(new Map());
  const palette = useMemo(() => ngon(NODES.length, nodeRotation), [nodeRotation]);

  const loadFile = useCallback((filename: string, file: LoadedFile) => {
    setFiles(prev => new Map(prev).set(filename, file));

    const nodeId = FILE_TO_NODE[filename];
    if (!nodeId) return;
    setNodeColors(prev => {
      if (prev.has(nodeId)) return prev;
      const used = new Set([...prev.values()].map(rgbStr));
      const free = palette.filter(c => !used.has(rgbStr(c)));
      if (free.length === 0) return prev;
      const pick = free[Math.floor(Math.random() * free.length)];
      return new Map(prev).set(nodeId, pick);
    });
  }, [palette]);

  const updateFile = useCallback((filename: string, file: LoadedFile) => {
    setFiles(prev => new Map(prev).set(filename, file));
  }, []);

  // Clicking a column lights it and extinguishes whatever was lit before,
  // in this table or any other. Clicking the lit column clears the selection.
  const toggleColumn = useCallback((file: LoadedFile, column: string) => {
    setSelection(prev =>
      prev && prev.filename === file.filename && prev.column === column
        ? null
        : buildSelection(file, column)
    );
  }, []);

  if (view.kind === 'map') {
    return (
      <MapView
        dark={dark}
        onToggleDark={() => setDark(d => !d)}
        onDiagram={() => setView({ kind: 'diagram' })}
        files={files}
        selection={selection}
      />
    );
  }

  if (view.kind === 'diagram') {
    return (
      <DiagramView
        dark={dark}
        files={files}
        nodeColors={nodeColors}
        onLoadFile={loadFile}
        onBack={() => setView({ kind: 'map' })}
        onOpenTable={filename => setView({ kind: 'table', filename })}
      />
    );
  }

  const file = files.get(view.filename);
  if (!file) {
    return (
      <div style={{ padding: 24 }}>
        file not loaded: {view.filename}
        <br />
        <button onClick={() => setView({ kind: 'diagram' })}>← diagram</button>
      </div>
    );
  }

  return (
    <TableView
      dark={dark}
      file={file}
      selection={selection}
      onBack={() => setView({ kind: 'diagram' })}
      onUpdate={updated => updateFile(view.filename, updated)}
      onToggleColumn={column => toggleColumn(file, column)}
    />
  );
}
