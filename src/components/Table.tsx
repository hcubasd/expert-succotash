import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { colorBg } from 'psychic-potato';
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
// The font never shrinks below a floor that's still legible at this font
// stack -- below it, columns widen to fit their content instead of text
// keeps shrinking to fit the columns -- see fitFont. The ceiling is body
// size itself (read live off the CSS variable there, not duplicated as a
// constant here): a headline-sized table reads as wrong, not as generous.
const MIN_FONT_SIZE = 11;
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

function CellBox({ cell, width, padding, dragProps, stickyTop }: {
  cell: Cell;
  width: number;
  // Top/bottom only ('1em 0') at the natural column width, matching or
  // exceeding sides too ('1em 1em') once fitFont has widened columns to fit
  // content -- see Table's own columnPadding for which and why.
  padding: string;
  dragProps?: Pick<
    React.HTMLAttributes<HTMLDivElement>,
    'onPointerDown' | 'onClickCapture'
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
  // black is always the readable ink over a filled cell.
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
        padding,
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
// the threshold marks it a drag and reorders live as the pointer crosses
// into other columns' cells, and a capture-phase click handler swallows the
// click that would otherwise follow a real drag -- the same trick works
// whether the cell underneath is a plain CellBox or a MapCard, since
// neither needs to know a drag was even a possibility.
//
// Deliberately window listeners rather than setPointerCapture, and the
// dragged column is snapshotted at pointerdown rather than read from props
// as the drag runs. Both are forced by the same thing: this drag *reorders
// the very elements it is being tracked against*, so neither the captured
// node nor this hook's own `columnName` prop still means what it did when
// the gesture started.
//
//   - Capture doesn't survive it. Value headers are keyed by column name,
//     so a reorder makes React *move* their DOM nodes; moving a node
//     detaches it, and detaching a node implicitly releases pointer
//     capture. Every later pointermove then goes to whatever is under the
//     cursor instead, and the drag silently dies mid-gesture.
//   - The prop doesn't survive it either. Stratum headers are rendered by
//     the recursive renderHeader, unkeyed, so their instances are bound to
//     *slots*, not columns: after a swap, the same instance (and the same
//     DOM node) is showing a different column, and `columnName` has changed
//     under the running gesture. Reading it per move makes the drag
//     re-identify itself as whichever column just moved in and start
//     dragging that one instead.
//
// Window listeners see every move regardless of what the DOM did, and the
// snapshot keeps "which column am I dragging" answerable from the gesture
// itself rather than from a tree that is being rearranged underneath it.
function useColumnDrag(columnName: string, onReorder: (from: string, to: string) => void) {
  type Drag = { x0: number; y0: number; column: string; dragging: boolean; lastHovered: string | null };
  const state = useRef<Drag | null>(null);
  // Separate from `state`, and deliberately not cleared until the click
  // that follows a real drag has been swallowed: pointerup and the click it
  // triggers are two separate browser events firing back to back, so if
  // this lived on `state` (nulled the instant the pointer lifts) the
  // capture-phase click handler below would always find nothing there by
  // the time it ran -- which is exactly why dropping a drag used to still
  // fire a click.
  const justDraggedRef = useRef(false);
  // The listeners below are installed once per gesture and outlive the
  // render that installed them, so they have to reach the *current*
  // onReorder rather than the one captured in that render's closure.
  const reorderRef = useRef(onReorder);
  reorderRef.current = onReorder;
  const teardownRef = useRef<(() => void) | null>(null);

  // Unmounting mid-drag (Clear navigating away with a pointer still down)
  // would otherwise leave both the window listeners and the forced cursor
  // behind on whatever view comes next.
  useEffect(() => () => {
    teardownRef.current?.();
    document.body.classList.remove('dragging-pointer');
  }, []);

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    // A React portal is a child of its host in the *React* tree even though
    // it lives at document.body in the DOM, so an open dropdown's popup
    // bubbles its events straight into this header's handlers. Starting a
    // drag from one would reorder columns when the user meant to pick an
    // option. A DOM containment check is exactly the line the React tree
    // blurs.
    if (!event.currentTarget.contains(event.target as Node)) return;
    justDraggedRef.current = false;
    state.current = { x0: event.clientX, y0: event.clientY, column: columnName, dragging: false, lastHovered: null };
    // Stops the browser's own text-selection drag from starting: a header
    // is plain text, and holding the pointer down and moving it is exactly
    // the native "select this text" gesture unless something says
    // otherwise. dragging-pointer (styles.css) forces user-select:none too,
    // but only once the threshold is crossed -- this covers the few pixels
    // before that.
    event.preventDefault();

    const onMove = (moveEvent: PointerEvent) => {
      const s = state.current;
      if (!s) return;
      if (!s.dragging) {
        if (Math.abs(moveEvent.clientX - s.x0) < MIN_DRAG_PX && Math.abs(moveEvent.clientY - s.y0) < MIN_DRAG_PX) return;
        s.dragging = true;
        document.body.classList.add('dragging-pointer');
      }
      // Live reorder: whichever column is under the pointer swaps into the
      // dragged column's slot immediately, not just once on release.
      //
      // Acting only when the hovered column *changes* is what keeps this
      // stable, and it has to be the last observed value rather than the
      // last swapped one. elementFromPoint reads what is on screen right
      // now, which is still the pre-swap layout when a second pointermove
      // arrives before React has repainted the first -- so the same target
      // gets read twice, and since reorderColumns is a plain swap, applying
      // it twice puts everything back where it started. That was the
      // flicker. Tracking every observed value (not just swapped ones) also
      // keeps a drag back the way it came working: the column being
      // returned to is no longer permanently suppressed by having been
      // swapped with earlier in the same gesture.
      const under = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
      const hovered = under?.closest<HTMLElement>('[data-column-name]')?.dataset.columnName ?? null;
      if (hovered !== s.lastHovered) {
        s.lastHovered = hovered;
        if (hovered && hovered !== s.column) reorderRef.current(s.column, hovered);
      }
    };
    const finish = () => {
      const s = state.current;
      state.current = null;
      if (s?.dragging) justDraggedRef.current = true;
      document.body.classList.remove('dragging-pointer');
      teardown();
    };
    const teardown = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      teardownRef.current = null;
    };
    teardownRef.current = teardown;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };
  const onClickCapture = (event: React.MouseEvent) => {
    if (!justDraggedRef.current) return;
    justDraggedRef.current = false;
    event.stopPropagation();
    event.preventDefault();
  };

  return { onPointerDown, onClickCapture, 'data-column-name': columnName };
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
  // 0 means "no override" -- columns sit at their natural, wrapper-derived
  // width. Set only when fitFont finds that width can't hold MIN_FONT_SIZE
  // for even the widest header label; cleared the moment it can again. See
  // fitFont for why this never needs to be reconciled against a stale value.
  const [minColumnWidth, setMinColumnWidth] = useState(0);

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
  //
  // The gaps are part of the width, not a rounding detail. Every row is a
  // .bg, and styles.css gives .bg a 1px gap, so each stratum level costs
  // columnWidth + 1 (its cell, plus the gap to the wrapper holding the
  // rest) and the values row at the bottom costs V*columnWidth + (V-1).
  // That sums to exactly totalColumns-1 pixels of gap across the whole
  // table, which tableWidth used to leave out entirely -- and since the
  // body clips at overflowX: hidden while the header doesn't clip at all,
  // the shortfall only ever showed up as the body's last column being cut
  // narrower than its own header.
  //
  // columnWidth takes the gaps out of the available room before dividing,
  // and is floored to a whole pixel so totalColumns * columnWidth stays
  // exact integer arithmetic rather than a float the browser's own layout
  // summation might not reproduce.
  const totalColumns = strata.length + values.length;
  const totalGaps = Math.max(0, totalColumns - 1);
  const naturalColumnWidth = totalColumns > 0
    ? Math.max(MIN_COL_WIDTH, Math.floor((wrapperWidth - totalGaps) / totalColumns))
    : MIN_COL_WIDTH;
  // minColumnWidth only ever raises this floor further -- fitFont sets it
  // once naturalColumnWidth can't hold MIN_FONT_SIZE even for the widest
  // header label, and every column widens together, not just the offender.
  const columnWidth = Math.max(naturalColumnWidth, minColumnWidth);
  const tableWidth = totalColumns * columnWidth + totalGaps;
  // Horizontal padding only exists once width is fitting content rather
  // than the other way around -- at the natural width, the side padding
  // would just be one more thing eating into the budget squeeze measures
  // against, for no benefit (see CellBox).
  const columnPadding = minColumnWidth > 0 ? '1em 1em' : '1em 0';

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
          {/* Keyed by slot, not by column name, and that is deliberate --
              the one case where the usual "never key a list by index"
              advice gives the wrong answer.

              Keying by name makes a reorder *move* these DOM nodes, and
              moving a node detaches and reinserts it. Doing that to the
              node a pointer is currently down on ends the gesture: it is
              what was silently releasing pointer capture before, and even
              with capture gone WebKit still fires pointercancel for it,
              which is exactly the drag dying mid-motion. Keying by slot
              instead leaves every node exactly where it is and updates its
              contents in place, so nothing under the pointer is ever
              detached -- the same thing the recursive stratum headers do
              positionally, which is why those drag cleanly.

              Nothing here is lost by it: these cells hold no state of
              their own that has to follow a particular column. The drag
              snapshots which column it grabbed at pointerdown (see
              useColumnDrag) rather than reading it from props as it runs,
              and hover targets are read live off data-column-name in the
              DOM, so both sides of the gesture stay correct while the
              instances themselves stay put. */}
          {values.map((column, slot) => (
            <DraggableValueHeaderCell
              key={slot}
              column={column}
              columnWidth={columnWidth}
              columnPadding={columnPadding}
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
          columnPadding={columnPadding}
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
                  padding={columnPadding}
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
              padding={columnPadding}
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
  //
  // This no longer goes through squeezeFg's own search. Every header .fg is
  // unconstrained by its .bg parent's width -- no min-width:0, no
  // overflow:hidden anywhere above it (see styles.css) -- so its rendered
  // rect is always the label's true single-line width, regardless of
  // whatever width the column happens to be on screen right now, including a
  // stale minColumnWidth override left over from a previous fit. That means
  // one measurement is enough, at whatever font size is already rendered --
  // nothing needs mutating just to take it: font metrics scale linearly with
  // pixel size for a fixed font-family, so the fit at any other size is a
  // straight ratio off of it, computed directly rather than searched for.
  // Nothing here depends on what's currently rendered beyond that one
  // reference size, so there's no stale state to reconcile and nothing that
  // can throw.
  const fitFont = useCallback(() => {
    const root = rootRef.current;
    const header = headerRef.current;
    const wrapper = wrapperRef.current;
    if (!root || !header || !wrapper || totalColumns === 0) return;
    const fgs = header.querySelectorAll<HTMLElement>('div.fg');
    if (fgs.length === 0) return;

    // Read live rather than from the wrapperWidth state: this can run from a
    // ResizeObserver callback that fires before that state's own observer
    // has flushed its update, and a stale width here would misjudge the fit.
    const totalGaps = Math.max(0, totalColumns - 1);
    const naturalWidth = Math.max(MIN_COL_WIDTH, Math.floor((wrapper.clientWidth - totalGaps) / totalColumns));

    // Measured at a fixed reference size, never at whatever root's font-size
    // already happens to be: this runs again on every window resize (and
    // root's own write below feeds right back into that trigger), so reading
    // root's *current* size here would make each call's reference the
    // previous call's own output. Glyph advance widths get hinted to whole
    // device pixels, and that rounding is coarser at a fractional
    // device-pixel-ratio -- which is the common case on Windows (125%/150%
    // display scaling is a default there, and dragging a window across
    // monitors with different scaling changes it live) but rare on macOS
    // (a clean 2x) or Linux (usually a clean 1x). One call's rounding noise
    // is invisible; feeding it back in as the next call's reference lets it
    // compound, drifting the fit further off with every resize until it
    // bottoms out at MIN_FONT_SIZE, or ping-pongs between adjacent pixel
    // values once the drift stops being reproducible call to call -- the
    // "tiny and flickering" failure this used to be able to hit on Windows.
    // Body size never changes, so measuring against it every time makes
    // this call self-correcting instead of self-compounding, matching what
    // the comment above already claims: nothing here should depend on
    // what's currently rendered beyond that one reference size.
    const bodySize = parseFloat(getComputedStyle(document.body).fontSize);
    const referenceSize = bodySize;
    const previousSize = root.style.fontSize;
    root.style.fontSize = `${referenceSize}px`;
    let widestAtReference = 0;
    fgs.forEach(el => { widestAtReference = Math.max(widestAtReference, el.getBoundingClientRect().width); });
    root.style.fontSize = previousSize;
    if (widestAtReference <= 0) return;

    // Bounded above by the body font: growing text to fill a wide column
    // would at a few columns read as a headline, not a table. 0.98 is
    // breathing room for a fitted size, the same margin squeezeFg used to
    // apply, not something to shave off the default.
    const exactFit = (referenceSize * naturalWidth) / widestAtReference;
    const candidate = exactFit * 0.98;

    if (candidate >= MIN_FONT_SIZE) {
      // Fits at the floor or better -- no override needed, natural width
      // stands. Floored to a whole pixel: every cell's padding is 1em, and a
      // fractional root font size makes that padding fractional too, which
      // is exactly the kind of subpixel mismatch that used to make the old
      // squeezeFg-based search throw. There's no search left to throw here,
      // but the whole-pixel floor still keeps 1em integral.
      const target = Math.max(MIN_FONT_SIZE, Math.floor(Math.min(candidate, bodySize)));
      root.style.fontSize = `${target}px`;
      setMinColumnWidth(0);
    } else {
      // Too narrow even at the floor. Hold the floor and widen every column
      // -- not just the offending one, they all share one width -- to
      // exactly what the worst label needs (the same reference measurement,
      // rescaled to MIN_FONT_SIZE), with real horizontal padding now that
      // width is fitting content instead of the other way around.
      const widestAtMin = widestAtReference * (MIN_FONT_SIZE / referenceSize);
      root.style.fontSize = `${MIN_FONT_SIZE}px`;
      setMinColumnWidth(Math.ceil(widestAtMin) + 2 * MIN_FONT_SIZE);
    }
  }, [totalColumns]);

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

  // Cleans up if this view unmounts mid-drag (e.g. Clear navigates away
  // while a pointer is still down) -- otherwise the class useColumnDrag
  // toggles, and the forced cursor it carries, would stick around on
  // whatever view comes next.
  useEffect(() => () => { document.body.classList.remove('dragging-pointer'); }, []);

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
function ReorderableStratumHeader({ column, columnWidth, columnPadding, options, selected, onSelect, onReorder }: {
  column: StratumColumn;
  columnWidth: number;
  columnPadding: string;
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
      style={{ flex: '0 0 auto', width: columnWidth, padding: columnPadding }}
      onPointerDown={drag.onPointerDown}
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
function DraggableValueHeaderCell({ column, columnWidth, columnPadding, onSelect, onReorder }: {
  column: ValueColumn;
  columnWidth: number;
  columnPadding: string;
  onSelect: () => void;
  onReorder: (from: string, to: string) => void;
}) {
  const drag = useColumnDrag(column.name, onReorder);
  return (
    <CellBox width={columnWidth} padding={columnPadding} dragProps={drag} cell={{ text: humanize(column.name), onClick: onSelect }} />
  );
}
