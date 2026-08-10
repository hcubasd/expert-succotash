import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { colorBg, squeezeFg } from 'psychic-potato';
import { LUMINANCE, gradientAt, indexColor, ngon, rgbStr, semicircle } from '../lib/colors';
import { equalize } from '../lib/equalize';
import { stratumText, valueText } from '../lib/tableMaker';
import type { StratumColumn, Table as TableData, ValueColumn } from '../lib/tableMaker';
import { labelOf } from './diagramLayout';

type Props = {
  table: TableData;
  // Which column is lit. The map no longer reads this -- it has its own
  // explicit selection -- so this is purely about highlighting here.
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
// Each block is grouped on its own and appended as a sibling, never merged
// into what's already on screen: merging would regroup the last group and
// re-centre its label under the reader. The cost is that a group spanning a
// block boundary shows its label once per block.
const PAGE = 100;

type Cell = { text: string; fill?: string; onClick?: () => void };

function CellBox({ cell, flex }: { cell: Cell; flex: number }) {
  // Every swatch is drawn at the one palette luminance, which is bright, so
  // black is always the readable ink over a filled cell.
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

export default function Table({ table, activeColumn, onSelectColumn, onBack, onPickFile }: Props) {
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

  // Blocks of PAGE rows, each grouped independently at render time. Only the
  // last one is ever new, so appending leaves every mounted block untouched.
  const batches = useMemo(() => {
    const end = Math.min(limit, rows.length);
    const out: number[][] = [];
    for (let start = 0; start < end; start += PAGE) {
      out.push(rows.slice(start, Math.min(start + PAGE, end)));
    }
    return out;
  }, [rows, limit]);

  const shown = Math.min(limit, rows.length);

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

    // Equalized over the rows actually in view, not the column's full range.
    // Filtering by a stratum therefore redistributes the ramp across that
    // stratum's own values -- the table's equivalent of the map re-equalizing
    // when a zoom changes what's on screen.
    const present: number[] = [];
    for (const row of rows) if (value.present[row]) present.push(value.data[row]);
    const equalizer = equalize(present);

    return {
      kind: 'value' as const,
      ofRow: (row: number) => {
        if (!value.present[row]) return undefined;
        return rgbStr(gradientAt(equalizer.at(value.data[row]), gradient));
      },
    };
  }, [lit, table, rows]);

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

  // The header IS its top row -- no container around it, since unlike the
  // body it never holds more than one. `outer` marks that top row so it can
  // carry the ref and the width the body shares; wrapping it instead would
  // cost a .bg level and push every header cell a depth deeper than it is.
  function renderHeader(remainingStrata: StratumColumn[], outer = false): React.ReactNode {
    const remaining = remainingStrata.length + values.length;
    const rowRef = outer ? headerRef : undefined;
    const rowStyle: React.CSSProperties = {
      flexDirection: 'row',
      minHeight: ROW_H,
      flexShrink: 0,
      ...(outer ? { minWidth: minTableWidth } : null),
    };

    if (remainingStrata.length === 0) {
      if (values.length === 0) return null;
      return (
        <div ref={rowRef} className="bg" style={rowStyle}>
          {values.map(column => (
            <CellBox key={column.name} flex={1} cell={{ text: column.name, onClick: () => onSelectColumn(column.name) }} />
          ))}
        </div>
      );
    }
    const [first, ...rest] = remainingStrata;
    return (
      <div ref={rowRef} className="bg" style={rowStyle}>
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

  // Repaint the depth ramp, then lay the selected column's own colors back
  // over it. Every trigger here is one that puts unpainted .bg divs on the
  // screen -- a new file, a reorder, a filter, an appended block -- plus the
  // two that change what the paint should be: the mode and the selection.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    // From the palette's own luminance up to white: there is one mode now,
    // so the ramp has one direction.
    colorBg(root, { from: LUMINANCE, to: 1 });
    root.querySelectorAll<HTMLElement>('[data-fill]').forEach(el => {
      const fill = el.dataset.fill;
      if (fill) el.style.backgroundColor = fill;
    });
  }, [lit, table, strataOrder, valuesOrder, filters, batches.length]);

  // Only the header is measured; the body inherits the result. Fitting the
  // whole table would re-measure every mounted cell on each step of the
  // search for a size the columns already share.
  const fitFont = useCallback(() => {
    const root = rootRef.current;
    const header = headerRef.current;
    if (!root || !header || !header.querySelector('div.fg')) return;
    let fitted: number;
    try {
      fitted = squeezeFg(header, 0.98);
    } catch {
      return;
    }
    // Bounded above by the body font: squeezeFg happily grows text to fill a
    // wide column, which at a few columns looks like a headline, not a table.
    // The bound is the raw body font -- 0.98 is breathing room for a fitted
    // size, not something to shave off the default.
    const target = Math.min(fitted, parseFloat(getComputedStyle(document.body).fontSize));
    // One size on the root, inherited by every cell, rather than written
    // onto each .fg in turn: that is what lets an appended block come out at
    // the right size having measured nothing, so paging never refits. The
    // header's own cells carry the inline size squeezeFg just set, so they
    // have to be cleared back to inheriting or they would keep `fitted`
    // even where the clamp lowered it.
    root.style.fontSize = `${target}px`;
    header.querySelectorAll<HTMLElement>('div.fg').forEach(el => {
      el.style.fontSize = '';
    });
  }, []);

  // The header's own geometry only changes with the column set, so that --
  // and the window resizing under it -- is the whole trigger list. Notably
  // not the selection, the mode, or an appended block, none of which move a
  // single cell edge.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    fitFont();
    const observer = new ResizeObserver(fitFont);
    observer.observe(root);
    return () => observer.disconnect();
  }, [fitFont, table, strataOrder, valuesOrder]);

  function handleScroll() {
    const body = bodyRef.current;
    if (!body) return;
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - ROW_H * 4) {
      setLimit(current => (current >= rows.length ? current : current + PAGE));
    }
  }

  // Horizontal scrolling lives on the root, not on a wrapper box around
  // header and body: they share a minimum width, so scrolling their common
  // ancestor keeps them in lockstep with no position syncing, and it leaves
  // them as direct .bg children of a .bg parent -- which is what makes the
  // 1px gap between them fall out of styles.css for free, exactly like
  // every other gap in the table.
  return (
    <div
      ref={rootRef}
      className="bg"
      style={{
        flexDirection: 'column', width: '100vw', height: '100vh',
        overflowX: 'auto', color: '#000',
      }}
    >
      {renderHeader(strata, true)}
      <div
        ref={bodyRef}
        className="bg"
        style={{ flex: 1, flexDirection: 'column', overflowY: 'auto', minWidth: minTableWidth }}
        onScroll={handleScroll}
      >
        {batches.length === 0
          ? <div style={{ opacity: 0.5 }}>no rows</div>
          : batches.map((batch, i) => <Fragment key={i}>{renderBody(batch, strata)}</Fragment>)}
      </div>

      <div style={{ position: 'fixed', bottom: 12, left: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="overlay-btn" style={{ position: 'static' }} onClick={onBack}>
          ← diagram
        </button>
        <span style={{ fontSize: 12, opacity: 0.6 }}>
          {labelOf(table.name)} · {shown} of {rows.length}
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
