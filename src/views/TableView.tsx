import { useEffect, useRef } from 'react';
import { colorBg, squeezeFg } from 'psychic-potato';
import { cellColor } from '../lib/selection';
import type { Selection } from '../lib/selection';
import { uniqueOrdered } from '../lib/colors';
import type { LoadedFile } from '../lib/fileConfig';

type Props = {
  dark: boolean;
  file: LoadedFile;
  selection: Selection | null;
  luminance: number;
  onBack: () => void;
  onUpdate: (file: LoadedFile) => void;
  onToggleColumn: (column: string) => void;
};

// Rows never shrink — a short window scrolls instead of squashing every cell.
// Cell now carries real 1em padding (see below), which is what stands between
// the text and the cell edge; this is just a floor under that, so a cell with
// no content still holds a sane minimum row height.
const ROW_H = 20;

// No leaf column shrinks narrower than this — past this point the table
// stops squeezing font size to fit and switches to a fixed-width layout with
// horizontal scroll instead (see the wrapping div in the root render).
const MIN_COL_WIDTH = 72;

// A cell that carries a selection colour stashes it here at render time.
// colorBg() overwrites every .bg background, so the colour can only be applied
// after it runs; keeping it in the DOM avoids recomputing it in the effect.
type CellProps = {
  fill?: string;
  flex: number;
  onClick?: () => void;
  children: React.ReactNode;
};

function Cell({ fill, flex, onClick, children }: CellProps) {
  return (
    <div
      className="bg"
      data-fill={fill}
      style={{ flex, cursor: onClick ? 'pointer' : undefined, paddingTop: '1em', paddingBottom: '1em' }}
      onClick={onClick}
    >
      {/* black text on a coloured background, inherited otherwise */}
      <div className="fg" style={fill ? { color: '#000' } : undefined}>
        {children}
      </div>
    </div>
  );
}

function renderHeader(
  strata: string[],
  values: string[],
  onToggle: (col: string) => void,
): React.ReactNode {
  if (strata.length === 0) {
    if (values.length === 0) return null;
    return (
      <div className="bg" style={{ flexDirection: 'row', minHeight: ROW_H, flexShrink: 0 }}>
        {values.map(v => (
          <Cell key={v} flex={1} onClick={() => onToggle(v)}>{v}</Cell>
        ))}
      </div>
    );
  }

  const [s, ...rest] = strata;
  const remaining = strata.length + values.length;
  return (
    <div className="bg" style={{ flexDirection: 'row', minHeight: ROW_H, flexShrink: 0 }}>
      <Cell flex={1} onClick={() => onToggle(s)}>{s}</Cell>
      <div className="bg" style={{ flexDirection: 'column', flex: remaining - 1 }}>
        {renderHeader(rest, values, onToggle)}
      </div>
    </div>
  );
}

function renderBody(
  rows: Record<string, unknown>[],
  strata: string[],
  values: string[],
  file: LoadedFile,
  selection: Selection | null,
  luminance: number,
): React.ReactNode {
  // Leaf: every row in this group, one line each. Strata do not necessarily
  // key the table uniquely, so a group can hold more than one record.
  if (strata.length === 0) {
    if (values.length === 0) return null;
    return (
      <>
        {rows.map((row, i) => (
          <div
            key={i}
            className="bg"
            style={{ flexDirection: 'row', minHeight: ROW_H, flexShrink: 0 }}
          >
            {values.map(v => {
              const raw = row[v];
              return (
                <Cell key={v} flex={1} fill={cellColor(selection, file, v, raw, luminance)}>
                  {raw == null ? '' : String(raw)}
                </Cell>
              );
            })}
          </div>
        ))}
      </>
    );
  }

  // Branch: group by the leading stratum, recurse on the rest.
  const [s, ...rest] = strata;
  const remaining = strata.length + values.length;
  const groups = uniqueOrdered(rows.map(r => String(r[s] ?? '')));

  return (
    <>
      {groups.map(val => {
        const groupRows = rows.filter(r => String(r[s] ?? '') === val);
        return (
          <div key={val} className="bg" style={{ flexDirection: 'row', flexShrink: 0 }}>
            <Cell flex={1} fill={cellColor(selection, file, s, val, luminance)}>{val}</Cell>
            <div className="bg" style={{ flexDirection: 'column', flex: remaining - 1 }}>
              {renderBody(groupRows, rest, values, file, selection, luminance)}
            </div>
          </div>
        );
      })}
    </>
  );
}

export default function TableView({ dark, file, selection, luminance, onBack, onUpdate, onToggleColumn }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);

  const visibleCols = file.colOrder.filter(c => !file.hiddenCols.has(c));
  const visibleStrata = visibleCols.filter(c => file.strata.includes(c));
  const visibleValues = visibleCols.filter(c => file.values.includes(c));
  const minTableWidth = (visibleStrata.length + visibleValues.length) * MIN_COL_WIDTH;

  // The lit column, only if it belongs to this table.
  const activeCol = selection?.filename === file.filename ? selection.column : null;

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    // Depth-based grays first — this paints every .bg, selection included.
    colorBg(root, { from: 0.75, to: dark ? 0 : 1 });

    // Then re-apply the selection colours on top.
    root.querySelectorAll<HTMLElement>('[data-fill]').forEach(el => {
      const fill = el.dataset.fill;
      if (fill) el.style.backgroundColor = fill;
    });

    // Fit the header, then hold every cell to that size so columns stay aligned.
    // With every column hidden there is no bg/fg pair to measure and squeezeFg
    // would throw, so there is nothing to do.
    const header = headerRef.current;
    if (!header || !header.querySelector('div.fg')) return;
    const bodyFontPx = parseFloat(getComputedStyle(document.body).fontSize);
    const target = Math.min(squeezeFg(header), bodyFontPx);
    root.querySelectorAll<HTMLElement>('div.fg').forEach(el => {
      el.style.fontSize = `${target}px`;
    });
  }, [dark, selection, luminance, visibleCols.join(','), file.rows.length, file.filename]);

  function moveLeft() {
    if (!activeCol) return;
    const idx = file.colOrder.indexOf(activeCol);
    if (idx <= 0) return;
    const order = [...file.colOrder];
    [order[idx - 1], order[idx]] = [order[idx], order[idx - 1]];
    onUpdate({ ...file, colOrder: order });
  }

  function moveRight() {
    if (!activeCol) return;
    const idx = file.colOrder.indexOf(activeCol);
    if (idx < 0 || idx >= file.colOrder.length - 1) return;
    const order = [...file.colOrder];
    [order[idx], order[idx + 1]] = [order[idx + 1], order[idx]];
    onUpdate({ ...file, colOrder: order });
  }

  // Hidden from view, never from memory: rows keep every column. Hiding the lit
  // column also clears the selection, so nothing stays lit that can't be seen.
  function hideActive() {
    if (!activeCol) return;
    const hidden = new Set(file.hiddenCols);
    hidden.add(activeCol);
    onToggleColumn(activeCol);
    onUpdate({ ...file, hiddenCols: hidden });
  }

  function restoreHidden() {
    onUpdate({ ...file, hiddenCols: new Set() });
  }

  return (
    <div
      ref={rootRef}
      className="bg"
      style={{
        flexDirection: 'column',
        width: '100vw',
        height: '100vh',
        color: dark ? '#fff' : '#000',
      }}
    >
      {/*
        Horizontal scroll lives here, once, shared by header and body --
        deliberately not a .bg (see psychic-potato: non-bg divs don't count
        toward colorBg's depth, so this doesn't shift either child's ramp
        level). Below MIN_COL_WIDTH * column count it's a no-op: minWidth
        only stops columns shrinking further, flex still stretches them to
        fill a wider viewport. Past that point the content outgrows this
        wrapper and overflowX:auto starts scrolling it, header and body
        together, with no scroll-position syncing needed since they're both
        just children of this one scrolling box.
      */}
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflowX: 'auto' }}>
        <div ref={headerRef} className="bg" style={{ flexDirection: 'column', flexShrink: 0, minWidth: minTableWidth }}>
          {renderHeader(visibleStrata, visibleValues, onToggleColumn)}
        </div>

        <div
          className="bg"
          style={{ flex: 1, flexDirection: 'column', overflowY: 'auto', minWidth: minTableWidth }}
        >
          {file.rows.length === 0
            ? <div style={{ padding: 16, opacity: 0.5 }}>no rows</div>
            : renderBody(file.rows, visibleStrata, visibleValues, file, selection, luminance)}
        </div>
      </div>

      <div style={{ position: 'fixed', bottom: 12, left: 12, display: 'flex', gap: 4 }}>
        {file.hiddenCols.size > 0 && (
          <button className="overlay-btn" style={{ position: 'static' }} onClick={restoreHidden}>
            restore cols
          </button>
        )}
        <button className="overlay-btn" style={{ position: 'static' }} onClick={onBack}>
          ← diagram
        </button>
      </div>

      {activeCol && (
        <div style={{ position: 'fixed', bottom: 12, right: 12, display: 'flex', gap: 4 }}>
          <button className="overlay-btn" style={{ position: 'static' }} onClick={moveLeft}>←</button>
          <button className="overlay-btn" style={{ position: 'static' }} onClick={moveRight}>→</button>
          <button className="overlay-btn" style={{ position: 'static' }} onClick={hideActive}>✕</button>
        </div>
      )}
    </div>
  );
}
