import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { colorBg, squeezeFg } from 'psychic-potato';
import { gradientAt, indexColor, ngon, rgbStr, semicircle } from '../lib/colors';
import { stratumText, valueText } from '../lib/tableMaker';
import type { StratumColumn, Table as TableData, ValueColumn } from '../lib/tableMaker';
import { labelOf } from './diagramLayout';

type Props = {
  dark: boolean;
  table: TableData;
  // The one column lit app-wide. Table only highlights it when it belongs
  // here; the map reads the same selection for its own purposes.
  activeColumn: { table: string; column: string } | null;
  onSelectColumn: (column: string) => void;
  onBack: () => void;
  onPickFile: () => void;
};

// A row never shrinks below this; a short window scrolls instead of squashing.
const ROW_H = 20;
// Past this, columns stop shrinking and the table scrolls horizontally rather
// than squeezing text into slivers.
const MIN_COL_WIDTH = 72;
// Rows are appended in blocks as the body scrolls to its end -- the whole
// table is scanned once at load time, but only a window of it is ever mounted.
const PAGE = 1000;

type Cell = { text: string; fill?: string; onClick?: () => void };

function CellBox({ cell, flex }: { cell: Cell; flex: number }) {
  return (
    <div
      className="bg"
      data-fill={cell.fill}
      style={{ flex, cursor: cell.onClick ? 'pointer' : undefined, minWidth: 0 }}
      onClick={cell.onClick}
    >
      <div className="fg" style={cell.fill ? { color: '#000' } : undefined}>{cell.text}</div>
    </div>
  );
}

export default function Table({ dark, table, activeColumn, onSelectColumn, onBack, onPickFile }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Ordering and filtering are how this table is being looked at right now,
  // not facts about the data -- so they live here and vanish on unmount,
  // leaving the loaded table untouched as the single source of truth.
  const [strataOrder, setStrataOrder] = useState<string[]>(() => table.strata.map(c => c.name));
  const [valuesOrder, setValuesOrder] = useState<string[]>(() => table.values.map(c => c.name));
  const [filters, setFilters] = useState<Record<string, number>>({});
  const [limit, setLimit] = useState(PAGE);

  const lit = activeColumn && activeColumn.table === table.name ? activeColumn.column : null;

  const strata = useMemo(
    () => strataOrder.map(name => table.strata.find(c => c.name === name)).filter((c): c is StratumColumn => !!c),
    [strataOrder, table],
  );
  const values = useMemo(
    () => valuesOrder.map(name => table.values.find(c => c.name === name)).filter((c): c is ValueColumn => !!c),
    [valuesOrder, table],
  );

  // Filtering by a stratum value needs no aggregation decision -- it's the
  // same columns, fewer rows -- which is why it works uniformly for every
  // table in the pipeline where hiding a column wouldn't.
  const rows = useMemo(() => {
    const active = Object.entries(filters)
      .map(([name, code]) => ({ column: table.strata.find(c => c.name === name), code }))
      .filter((f): f is { column: StratumColumn; code: number } => !!f.column);

    const kept: number[] = [];
    for (let row = 0; row < table.rowCount; row++) {
      let matches = true;
      for (const { column, code } of active) {
        if (column.codes[row] !== code) {
          matches = false;
          break;
        }
      }
      if (matches) kept.push(row);
    }
    return kept;
  }, [filters, table]);

  const visible = useMemo(() => rows.slice(0, limit), [rows, limit]);

  useEffect(() => setLimit(PAGE), [filters, table]);

  // Palette lookups are built once per selection, not per cell: a column's
  // codes are already palette indices, so painting stays a lookup even at a
  // million rows.
  const paint = useMemo(() => {
    if (!lit) return null;
    const stratum = table.strata.find(c => c.name === lit);
    if (stratum) {
      const palette = ngon(stratum.dictionary.length, stratum.rotation);
      if (!palette.length) return null;
      return { kind: 'stratum' as const, ofCode: (code: number) => rgbStr(indexColor(palette, code)) };
    }
    const value = table.values.find(c => c.name === lit);
    if (!value) return null;
    const gradient = semicircle(value.rotation);
    const span = value.max - value.min;
    return {
      kind: 'value' as const,
      ofRow: (row: number) => {
        if (!value.present[row]) return undefined;
        const t = span === 0 ? 0.5 : (value.data[row] - value.min) / span;
        return rgbStr(gradientAt(t, gradient));
      },
    };
  }, [lit, table]);

  const stratumFill = (column: StratumColumn, code: number) =>
    lit === column.name && paint?.kind === 'stratum' ? paint.ofCode(code) : undefined;
  const valueFill = (column: ValueColumn, row: number) =>
    lit === column.name && paint?.kind === 'value' ? paint.ofRow(row) : undefined;

  const minTableWidth = (strata.length + values.length) * MIN_COL_WIDTH;

  function toggleFilter(column: StratumColumn, code: number) {
    setFilters(previous => {
      const next = { ...previous };
      if (next[column.name] === code) delete next[column.name];
      else next[column.name] = code;
      return next;
    });
  }

  // Reordering rotates within a group: strata only among strata (which
  // changes the nesting order, and so how rows are grouped), values only
  // among values (purely left-to-right display order). The two never
  // interleave -- a value column among the strata wouldn't mean anything.
  function rotateActive() {
    if (!lit) return;
    const rotate = (order: string[]) => {
      const i = order.indexOf(lit);
      if (i < 0) return order;
      const next = [...order];
      next.splice(i, 1);
      next.splice((i - 1 + order.length) % order.length, 0, lit);
      return next;
    };
    if (strataOrder.includes(lit)) setStrataOrder(rotate);
    else if (valuesOrder.includes(lit)) setValuesOrder(rotate);
  }

  function renderHeader(remainingStrata: StratumColumn[]): React.ReactNode {
    const remaining = remainingStrata.length + values.length;
    if (remainingStrata.length === 0) {
      if (values.length === 0) return null;
      return (
        <div className="bg" style={{ flexDirection: 'row', minHeight: ROW_H, flexShrink: 0 }}>
          {values.map(column => (
            <CellBox key={column.name} flex={1} cell={{ text: column.name, onClick: () => onSelectColumn(column.name) }} />
          ))}
        </div>
      );
    }
    const [first, ...rest] = remainingStrata;
    return (
      <div className="bg" style={{ flexDirection: 'row', minHeight: ROW_H, flexShrink: 0 }}>
        <CellBox flex={1} cell={{ text: first.name, onClick: () => onSelectColumn(first.name) }} />
        <div className="bg" style={{ flexDirection: 'column', flex: remaining - 1, minWidth: 0 }}>
          {renderHeader(rest)}
        </div>
      </div>
    );
  }

  // Grouping walks the strata in order: take the leading column, group the
  // rows it still covers by code (first seen first), recurse on the rest.
  // Reordering strata changes only the shape of this tree -- a row's own
  // values never change, they just land somewhere else vertically.
  function renderBody(rowIndices: number[], remainingStrata: StratumColumn[]): React.ReactNode {
    const remaining = remainingStrata.length + values.length;
    if (remainingStrata.length === 0) {
      if (values.length === 0) return null;
      return (
        <>
          {rowIndices.map(row => (
            <div key={row} className="bg" style={{ flexDirection: 'row', minHeight: ROW_H, flexShrink: 0 }}>
              {values.map(column => (
                <CellBox key={column.name} flex={1} cell={{ text: valueText(column, row), fill: valueFill(column, row) }} />
              ))}
            </div>
          ))}
        </>
      );
    }

    const [first, ...rest] = remainingStrata;
    const groups: { code: number; rows: number[] }[] = [];
    const seen = new Map<number, number>();
    for (const row of rowIndices) {
      const code = first.codes[row];
      let at = seen.get(code);
      if (at === undefined) {
        at = groups.length;
        seen.set(code, at);
        groups.push({ code, rows: [] });
      }
      groups[at].rows.push(row);
    }

    return (
      <>
        {groups.map(group => (
          <div key={group.code} className="bg" style={{ flexDirection: 'row', flexShrink: 0 }}>
            <CellBox
              flex={1}
              cell={{
                text: stratumText(first, group.rows[0]),
                fill: stratumFill(first, group.code),
                onClick: () => toggleFilter(first, group.code),
              }}
            />
            <div className="bg" style={{ flexDirection: 'column', flex: remaining - 1, minWidth: 0 }}>
              {renderBody(group.rows, rest)}
            </div>
          </div>
        ))}
      </>
    );
  }

  useLayoutEffect(() => {
    const root = rootRef.current;
    const header = headerRef.current;
    if (!root) return;

    colorBg(root, { from: 0.75, to: dark ? 0 : 1 });
    root.querySelectorAll<HTMLElement>('[data-fill]').forEach(el => {
      const fill = el.dataset.fill;
      if (fill) el.style.backgroundColor = fill;
    });

    // Only the header is measured, then every cell is held to that size.
    // Fitting the whole table would re-measure every mounted cell on each
    // step of the search -- and again on every appended page -- for a size
    // the columns already share.
    if (!header || !header.querySelector('div.fg')) return;
    let fitted: number;
    try {
      fitted = squeezeFg(header);
    } catch {
      return;
    }
    // Bounded above by the body font: squeezeFg happily grows text to fill a
    // wide column, which at a few columns looks like a headline, not a table.
    const target = Math.min(fitted, parseFloat(getComputedStyle(document.body).fontSize));
    root.querySelectorAll<HTMLElement>('div.fg').forEach(el => {
      el.style.fontSize = `${target}px`;
    });
  }, [dark, lit, table, strataOrder, valuesOrder, filters, visible.length]);

  function handleScroll() {
    const body = bodyRef.current;
    if (!body) return;
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - ROW_H * 4) {
      setLimit(current => (current >= rows.length ? current : current + PAGE));
    }
  }

  return (
    <div
      ref={rootRef}
      className="bg"
      style={{ flexDirection: 'column', width: '100vw', height: '100vh', color: dark ? '#fff' : '#000' }}
    >
      {/* One scroll box for header and body together: they share a minimum
          width, so they scroll in lockstep with no position syncing. */}
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflowX: 'auto' }}>
        <div ref={headerRef} className="bg" style={{ flexDirection: 'column', flexShrink: 0, minWidth: minTableWidth }}>
          {renderHeader(strata)}
        </div>
        <div
          ref={bodyRef}
          className="bg"
          style={{ flex: 1, flexDirection: 'column', overflowY: 'auto', minWidth: minTableWidth }}
          onScroll={handleScroll}
        >
          {visible.length === 0
            ? <div style={{ padding: 16, opacity: 0.5 }}>no rows</div>
            : renderBody(visible, strata)}
        </div>
      </div>

      <div style={{ position: 'fixed', bottom: 12, left: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="overlay-btn" style={{ position: 'static' }} onClick={onBack}>
          ← diagram
        </button>
        <span style={{ fontSize: 12, opacity: 0.6 }}>
          {labelOf(table.name)} · {visible.length} of {rows.length}
          {rows.length !== table.rowCount ? ` (filtered from ${table.rowCount})` : ''}
        </span>
      </div>

      <div style={{ position: 'fixed', bottom: 12, right: 12, display: 'flex', gap: 4 }}>
        {lit
          ? <button className="overlay-btn" style={{ position: 'static' }} onClick={rotateActive}>←</button>
          : <button className="overlay-btn" style={{ position: 'static' }} onClick={onPickFile}>load file</button>}
      </div>
    </div>
  );
}
