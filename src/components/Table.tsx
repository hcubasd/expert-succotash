import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { colorBg, squeezeFg } from 'psychic-potato';
import { LUMINANCE, gradientAt, indexColor, ngon, rgbStr, semicircle } from '../lib/colors';
import { equalize } from '../lib/equalize';
import { humanize } from '../lib/humanize';
import { stratumText, valueText } from '../lib/tableMaker';
import type { StratumColumn, Table as TableData, ValueColumn } from '../lib/tableMaker';
import Dropdown from './Dropdown';
import type { Option } from './Dropdown';

type Props = {
  table: TableData;
  // Which column is lit. The map no longer reads this -- it has its own
  // explicit selection -- so this is purely about highlighting here. Only
  // ever a value column now: strata color as a group, driven by filters,
  // not by which one was clicked last.
  activeColumn: { table: string; column: string } | null;
  onSelectColumn: (column: string) => void;
  onBack: () => void;
  onClear: () => void;
};

// Past this, columns stop shrinking and the table scrolls horizontally rather
// than squeezing text into slivers.
const MIN_COL_WIDTH = 256;
// No row height is fixed any more: every cell gets 1em top/bottom padding,
// and the column width is what actually drives font size through squeezeFg
// -- height just hugs whatever that settles on. Without a fixed pixel to
// measure against, "close enough to the bottom to load more rows" is a flat
// approximation rather than a row count.
const NEAR_BOTTOM_PX = 100;
// Rows are appended in blocks as the body scrolls to its end -- the whole
// table is scanned once at load time, but only a window of it is ever mounted.
// Each block is grouped on its own and appended as a sibling, never merged
// into what's already on screen: merging would regroup the last group and
// re-centre its label under the reader. The cost is that a group spanning a
// block boundary shows its label once per block -- explicitly kept as is,
// not something this pass changes.
const PAGE = 100;
// Below this a drag reads as a click (open the dropdown, or light the
// column), not a reorder -- same threshold Map.tsx uses for its own
// drag-vs-click split.
const MIN_DRAG_PX = 4;

const ALL: Option = { value: 'all', label: 'All' };

type Cell = { text: string; fill?: string; onClick?: () => void; italic?: boolean };

function CellBox({ cell, width, dragProps, stickyTop }: {
  cell: Cell;
  width: number;
  dragProps?: Pick<
    React.HTMLAttributes<HTMLDivElement>,
    'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onClickCapture'
  > & { 'data-column-name'?: string };
  // The *text* sticks, never the box around it. The box is the group's
  // swatch: it has to keep its full height so the colors still read as
  // nested bands with 1px seams. Sticking the box instead shrinks it to fit
  // its one line of text, which is what turned every group label into a
  // little floating chip. A CSS length string (em-based -- see the call
  // site) rather than a bare number, since this is no longer a pixel value.
  stickyTop?: string;
}) {
  // Every swatch is drawn at the one palette luminance, which is bright, so
  // black is always the readable ink over a filled cell. Padding is
  // top/bottom only: the column's width is what constrains squeezeFg, so
  // padding the sides too would just be one more thing eating into the
  // budget that fit is measured against, for no benefit -- the row's
  // height, not its width, is what this padding is actually shaping.
  //
  // A fixed pixel width, not a flex share: every leaf cell in the table --
  // header or body, whatever stratum depth it sits at -- takes the exact
  // same columnWidth computed once in Table itself. Proportional flex
  // shares (flex:1 against a sibling wrapper's flex:(remaining-1)) used to
  // do this instead, cascaded down through however many nested wrapper
  // levels separated a cell from the row that set minTableWidth -- header
  // and body are separate flex layouts computing that cascade independently,
  // free to round a fraction of a pixel differently at every level, which
  // is exactly what surfaced as the last column's width drifting from its
  // header. A shared, precomputed width can't drift: there's nothing left
  // for either side to compute on its own.
  return (
    <div
      className="bg"
      data-fill={cell.fill}
      style={{
        flex: '0 0 auto', width, cursor: cell.onClick ? 'pointer' : undefined,
        fontStyle: cell.italic ? 'italic' : undefined,
        padding: '1em 0',
      }}
      onClick={cell.onClick}
      {...dragProps}
    >
      <div
        className="fg"
        style={{
          ...(cell.fill ? { color: '#000' } : null),
          // .fg centers itself with margin:auto, which would absorb all the
          // free space in a tall group and leave sticky nothing to move
          // within. Pinned to the top with horizontal centering kept, it has
          // the whole group's height to travel down as its rows scroll past.
          ...(stickyTop !== undefined
            ? { position: 'sticky', top: stickyTop, alignSelf: 'flex-start', margin: '0 auto' }
            : null),
        }}
      >
        {cell.text}
      </div>
    </div>
  );
}

// Click-vs-drag for a header cell: pointerdown starts tracking, a move past
// the threshold marks it a drag, and a capture-phase click handler swallows
// the click that would otherwise follow a real drag -- the same trick
// works whether the cell underneath is a plain CellBox or a MapCard, since
// neither needs to know a drag was even a possibility.
function useColumnDrag(columnName: string, onReorder: (from: string, to: string) => void) {
  const state = useRef<{ x0: number; y0: number; dragging: boolean } | null>(null);

  const onPointerDown = (event: React.PointerEvent) => {
    // A React portal is a child of its host in the *React* tree even though
    // it lives at document.body in the DOM, so an open dropdown's popup
    // bubbles its events straight into this header's handlers. Capturing on
    // one of those would pin the pointer to the header and hand the
    // following click to it instead of to the option the user pressed --
    // which is to say, the dropdown would stop selecting anything at all.
    // A DOM containment check is exactly the line the React tree blurs.
    if (!event.currentTarget.contains(event.target as Node)) return;
    state.current = { x0: event.clientX, y0: event.clientY, dragging: false };
    // Without this, dragging past this cell's own edge hands pointermove
    // and pointerup to whatever element the cursor is now over instead --
    // so releasing over the drop target fires *its* onPointerUp, which has
    // no drag state of its own and does nothing, while this cell's own
    // onPointerUp (holding the state the reorder actually needs) never
    // fires at all. Capturing keeps every event routed back here regardless
    // of where the pointer physically ends up; elementFromPoint in
    // onPointerUp still finds the real drop target underneath it.
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent) => {
    const s = state.current;
    if (!s || s.dragging) return;
    if (Math.abs(event.clientX - s.x0) >= MIN_DRAG_PX || Math.abs(event.clientY - s.y0) >= MIN_DRAG_PX) {
      s.dragging = true;
    }
  };
  const onPointerUp = (event: React.PointerEvent) => {
    const s = state.current;
    state.current = null;
    if (!s?.dragging) return;
    const under = document.elementFromPoint(event.clientX, event.clientY);
    const to = under?.closest<HTMLElement>('[data-column-name]')?.dataset.columnName;
    if (to && to !== columnName) onReorder(columnName, to);
  };
  const onClickCapture = (event: React.MouseEvent) => {
    if (state.current?.dragging) {
      event.stopPropagation();
      event.preventDefault();
    }
  };

  return { onPointerDown, onPointerMove, onPointerUp, onClickCapture, 'data-column-name': columnName };
}

export default function Table({ table, activeColumn, onSelectColumn, onBack, onClear }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Ordering and filtering are how this table is being looked at right now,
  // not facts about the data -- so they live here and vanish on unmount,
  // leaving the loaded table untouched as the single source of truth.
  const [strataOrder, setStrataOrder] = useState<string[]>(() => table.strata.map(c => c.name));
  const [valuesOrder, setValuesOrder] = useState<string[]>(() => table.values.map(c => c.name));
  const [filters, setFilters] = useState<Record<string, number>>({});
  const [limit, setLimit] = useState(PAGE);
  // The scroll wrapper's own clientWidth: how much room columns actually
  // have to fill before horizontal scrolling has to take over. 0 until the
  // first measurement lands, which only ever shows up as one extra
  // layout-effect pass before paint -- the same pattern the map's own
  // measured sizing uses.
  const [wrapperWidth, setWrapperWidth] = useState(0);

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

  useEffect(() => setLimit(PAGE), [filters, table]);

  const anyFilterActive = Object.keys(filters).length > 0;

  // One palette per stratum column, built once per table rather than per
  // render: a dictionary can run to tens of thousands of distinct values,
  // and both the cells and that column's own dropdown options read from it.
  const stratumPaletteOf = useMemo(() => {
    const map = new Map<string, (code: number) => string>();
    for (const stratum of table.strata) {
      const palette = ngon(stratum.dictionary.length, stratum.rotation);
      if (palette.length) map.set(stratum.name, (code: number) => rgbStr(indexColor(palette, code)));
    }
    return map;
  }, [table]);

  // Options carry their column's own swatch, so a dropdown reads as the
  // same colors the column paints with rather than as a plain list.
  const stratumOptionsOf = useMemo(() => {
    const map = new Map<string, Option[]>();
    for (const stratum of table.strata) {
      const colorOf = stratumPaletteOf.get(stratum.name);
      map.set(stratum.name, [
        ALL,
        ...stratum.dictionary.map((value, code) => ({
          value: String(code),
          label: value === null || value === undefined ? '' : String(value),
          color: colorOf?.(code),
        })),
      ]);
    }
    return map;
  }, [table, stratumPaletteOf]);

  // Values keep the old model exactly: one lit column, no dropdown (there's
  // no discrete option list to offer for a continuous quantity), equalized
  // over whatever rows the current filters leave in view.
  const valuePaint = useMemo(() => {
    if (!lit) return null;
    const value = table.values.find(c => c.name === lit);
    if (!value) return null;
    const gradient = semicircle(value.rotation);
    const present: number[] = [];
    for (const row of rows) if (value.present[row]) present.push(value.data[row]);
    const equalizer = equalize(present);
    return {
      ofRow: (row: number) => {
        if (!value.present[row]) return undefined;
        return rgbStr(gradientAt(equalizer.at(value.data[row]), gradient));
      },
    };
  }, [lit, table, rows]);

  // Every stratum column colors at once, as soon as anything is filtered --
  // not one "lit" column at a time. That's what makes filtering by one
  // column visibly group the others too.
  const stratumFill = (column: StratumColumn, code: number) =>
    (anyFilterActive ? stratumPaletteOf.get(column.name)?.(code) : undefined);
  const valueFill = (column: ValueColumn, row: number) => (lit === column.name ? valuePaint?.ofRow(row) : undefined);

  // Every leaf cell, header or body, gets this exact width -- filling the
  // available room when there's plenty, floored at MIN_COL_WIDTH once there
  // isn't, past which the table scrolls instead of squeezing further.
  const totalColumns = strata.length + values.length;
  const columnWidth = totalColumns > 0 ? Math.max(MIN_COL_WIDTH, wrapperWidth / totalColumns) : MIN_COL_WIDTH;
  const tableWidth = totalColumns * columnWidth;

  function toggleFilter(column: StratumColumn, code: number) {
    setFilters(previous => {
      const next = { ...previous };
      if (next[column.name] === code) delete next[column.name];
      else next[column.name] = code;
      return next;
    });
  }

  function setFilterFromDropdown(column: StratumColumn, value: string) {
    setFilters(previous => {
      const next = { ...previous };
      if (value === 'all') delete next[column.name];
      else next[column.name] = Number(value);
      return next;
    });
  }

  // A swap, not an insertion: strata only trade places with strata (which
  // changes the nesting order, and so how rows are grouped), values only
  // with values (purely left-to-right display order). A drag from one kind
  // to the other is silently ignored -- a value column among the strata
  // wouldn't mean anything, same reasoning the old rotate-button version
  // had, just reached by a direct drag now instead of a "select, then press
  // a button" two-step, which this replaces outright.
  function reorderColumns(from: string, to: string) {
    const swap = (order: string[]) => {
      const i = order.indexOf(from);
      const j = order.indexOf(to);
      if (i < 0 || j < 0) return order;
      const next = [...order];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    };
    if (strataOrder.includes(from) && strataOrder.includes(to)) setStrataOrder(swap);
    else if (valuesOrder.includes(from) && valuesOrder.includes(to)) setValuesOrder(swap);
  }

  // The header IS its top row -- no container around it, since unlike the
  // body it never holds more than one. `outer` marks that top row so it can
  // carry the ref and the width the body shares; wrapping it instead would
  // cost a .bg level and push every header cell a depth deeper than it is.
  function renderHeader(remainingStrata: StratumColumn[], outer = false): React.ReactNode {
    const rowRef = outer ? headerRef : undefined;
    const rowStyle: React.CSSProperties = {
      flexDirection: 'row',
      flexShrink: 0,
      ...(outer ? { minWidth: tableWidth } : null),
    };

    if (remainingStrata.length === 0) {
      if (values.length === 0) return null;
      return (
        <div ref={rowRef} className="bg" style={rowStyle}>
          {values.map(column => (
            <DraggableValueHeaderCell
              key={column.name}
              column={column}
              columnWidth={columnWidth}
              onSelect={() => onSelectColumn(column.name)}
              onReorder={reorderColumns}
            />
          ))}
        </div>
      );
    }
    const [first, ...rest] = remainingStrata;
    const filtered = filters[first.name];
    return (
      <div ref={rowRef} className="bg" style={rowStyle}>
        <ReorderableStratumHeader
          column={first}
          columnWidth={columnWidth}
          options={stratumOptionsOf.get(first.name) ?? [ALL]}
          selected={filtered !== undefined ? String(filtered) : 'all'}
          onSelect={value => setFilterFromDropdown(first, value)}
          onReorder={reorderColumns}
        />
        {/* No flex share, no minWidth floor -- this wrapper's own width is
            just whatever its content (the recursive row inside it) needs,
            which is exactly totalColumns-1 leaf cells' worth now that every
            leaf carries its own fixed width. */}
        <div className="bg" style={{ flexDirection: 'column', flexShrink: 0 }}>
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
    if (remainingStrata.length === 0) {
      if (values.length === 0) return null;
      return (
        <>
          {rowIndices.map(row => (
            <div key={row} className="bg" style={{ flexDirection: 'row', flexShrink: 0 }}>
              {values.map(column => (
                <CellBox
                  key={column.name}
                  width={columnWidth}
                  cell={{ text: valueText(column, row), fill: valueFill(column, row) }}
                />
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
            {/* Sticky at the same offset regardless of depth, not stacked
                by it: a deeper stratum's label sits in its own column,
                beside the shallower ones, never below them -- this row is
                flexDirection: row, and every level recurses further right
                into "the rest", not further down. All of them scroll
                against the same body, so they all want the same resting
                point once stuck. depth * something was answering a
                question about a tree view this isn't; matching the cell's
                own 1em top padding is what actually keeps the label sitting
                where it was before it engaged. The label is what sticks --
                alignSelf: flex-start (set inside CellBox whenever it's
                sticky) keeps it at its own short natural height instead of
                the row's default stretch-to-match-sibling, which is what
                leaves it room to stick in the first place: stretched to the
                whole group's height, it would already fill the space and
                sticky would have nothing left to do. A group whose rows run
                off the top of the scrolled body keeps its label in view the
                whole time you're still inside it. */}
            <CellBox
              width={columnWidth}
              stickyTop="1em"
              cell={{
                text: stratumText(first, group.rows[0]),
                fill: stratumFill(first, group.code),
                onClick: () => toggleFilter(first, group.code),
              }}
            />
            {/* No flex share, no minWidth floor -- same reasoning as the
                header's own "rest" wrapper: sized by its content now that
                every leaf below it carries its own fixed width. */}
            <div className="bg" style={{ flexDirection: 'column', flexShrink: 0 }}>
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
    //
    // Floored to a whole pixel, and that is load-bearing, not tidiness. Every
    // cell's padding is 1em, so a fractional root font size makes the padding
    // fractional too -- and squeezeFg tests the fit by comparing
    // getComputedStyle's rounded padding string against getBoundingClientRect's
    // own subpixel grid. A cell hugs its text, so that comparison lands at
    // exactly zero, and those two number sources disagreeing by a hair put it
    // a hair *below* zero instead. Every font in the sweep then reads as
    // overflowing, the bracket never flips, squeezeFg throws, and the catch
    // above drops the refit on the floor. Only the very first fit survived
    // that, because until it ran the root was still on body's whole-pixel
    // size -- which is exactly why remounting the table looked fixed and
    // resizing it did nothing. A whole pixel keeps 1em integral and the
    // arithmetic exact.
    const bodySize = parseFloat(getComputedStyle(document.body).fontSize);
    const target = Math.max(1, Math.floor(Math.min(fitted, bodySize)));
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

  // clientWidth, not the wrapper's own offset/outer width: for a scrolling
  // container that's the visible viewport size, excluding whatever's
  // currently scrolled off -- exactly the room columnWidth has to divide up
  // before horizontal scrolling has to take over.
  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const measure = () => setWrapperWidth(wrapper.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, []);

  // Same confirm Diagram's own Clear carries, worded for one file instead of
  // every loaded one.
  function handleClear() {
    if (window.confirm(`Clear ${humanize(table.name)}? This cannot be undone.`)) onClear();
  }

  function handleScroll() {
    const body = bodyRef.current;
    if (!body) return;
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - NEAR_BOTTOM_PX) {
      setLimit(current => (current >= rows.length ? current : current + PAGE));
    }
  }

  return (
    <div
      ref={rootRef}
      className="bg"
      style={{ flexDirection: 'column', width: '100vw', height: '100vh', color: '#000' }}
    >
      {/* Same padding as every other cell, so the title reads as the
          table's own top band rather than as a separate header bar with its
          own rules. */}
      <div className="bg" style={{ flexShrink: 0, padding: '1em 0' }}>
        <div className="fg">{humanize(table.name)}</div>
      </div>

      {/* Horizontal scrolling lives on this wrapper, not the outer root: the
          title shouldn't be dragged sideways by how wide the table itself
          is, and header/body share this as their common ancestor, which is
          what keeps the 1px gap between them falling out of styles.css for
          free, same as before. */}
      <div
        ref={wrapperRef}
        className="bg"
        style={{ flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0, overflowX: 'auto' }}
      >
        {renderHeader(strata, true)}
        <div
          ref={bodyRef}
          className="bg"
          // overflowX is explicit, not left to default to visible: a
          // non-visible overflow-y with overflow-x still visible computes
          // overflow-x to auto too (the CSS spec's own rule for that
          // combination), which was giving the body its own independent
          // horizontal scrollbar -- so scrolling it moved only the body,
          // leaving the header and title behind instead of the wrapper
          // above carrying all three together as it's meant to.
          style={{ flex: 1, flexDirection: 'column', overflowY: 'auto', overflowX: 'hidden', minWidth: tableWidth }}
          onScroll={handleScroll}
        >
          {batches.length === 0
            ? <div style={{ opacity: 0.5 }}>no rows</div>
            : batches.map((batch, i) => <Fragment key={i}>{renderBody(batch, strata)}</Fragment>)}
        </div>
      </div>

      <button className="word-btn" style={{ bottom: '1em', left: '1em' }} onClick={onBack}>Diagram</button>
      <button className="word-btn" style={{ bottom: '1em', right: '1em' }} onClick={handleClear}>Clear</button>
    </div>
  );
}

// The stratum header cell: a MapCard (dropdown filter picker) doubling as a
// drag-to-reorder handle. Pulled out on its own because the drag hook can't
// be called conditionally inline the way the value headers' map callback
// does above -- this is exactly one call site, not a loop, so there's
// nothing conditional about it.
function ReorderableStratumHeader({ column, columnWidth, options, selected, onSelect, onReorder }: {
  column: StratumColumn;
  columnWidth: number;
  options: Option[];
  selected: string;
  onSelect: (value: string) => void;
  onReorder: (from: string, to: string) => void;
}) {
  const drag = useColumnDrag(column.name, onReorder);
  return (
    <Dropdown
      options={options}
      selected={selected}
      // Always the column's own name -- what's filtered shows as the italic
      // mark, not by relabelling the header to the value you picked.
      label={humanize(column.name)}
      italic={selected !== 'all'}
      onSelect={onSelect}
      // A fixed width, not a flex share -- see the long note on CellBox for
      // why this can't be left to a proportional split any more.
      style={{ flex: '0 0 auto', width: columnWidth, padding: '1em 0' }}
      onPointerDown={drag.onPointerDown}
      onPointerMove={drag.onPointerMove}
      onPointerUp={drag.onPointerUp}
      onClickCapture={drag.onClickCapture}
      dataColumnName={column.name}
    />
  );
}

// Same reasoning as ReorderableStratumHeader: useColumnDrag calls useRef, so
// it has to run at a real component's own top level, never inline inside the
// values.map() callback above -- a hook's call count has to stay identical
// render to render, and a callback run once per column doesn't guarantee
// that.
// No italic here, unlike the stratum headers: italic means "this column is
// filtering the rows", and clicking a value header only colors it.
function DraggableValueHeaderCell({ column, columnWidth, onSelect, onReorder }: {
  column: ValueColumn;
  columnWidth: number;
  onSelect: () => void;
  onReorder: (from: string, to: string) => void;
}) {
  const drag = useColumnDrag(column.name, onReorder);
  return (
    <CellBox width={columnWidth} dragProps={drag} cell={{ text: humanize(column.name), onClick: onSelect }} />
  );
}
