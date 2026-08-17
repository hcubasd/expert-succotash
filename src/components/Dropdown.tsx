import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type Option = {
  value: string;
  label: string;
  // Table stratum values carry their own palette color, so the options can
  // read as the same swatches the column itself paints with.
  color?: string;
  // Nothing in the loaded files backs this choice -- the file it would read
  // from isn't loaded, or doesn't carry that resource. Still selectable on
  // purpose: picking it is how you find out, and the map says so by leaving
  // that layer uncoloured rather than by refusing the click.
  unavailable?: boolean;
};

type Props = {
  options: Option[];
  selected: string | undefined;
  // The trigger always reads as this, never as the current selection: these
  // are column headers and layer controls, whose own name is the useful
  // label. What's selected shows in the map (or as the italic filter mark),
  // not by relabelling the thing you clicked.
  label: string;
  onSelect: (value: string) => void;
  // Nothing to choose from -- still occupies its slot, so rows of cards stay
  // the same height, but never opens.
  empty?: boolean;
  grayed?: boolean;
  italic?: boolean;
  style?: React.CSSProperties;
  onPointerDown?: (event: React.PointerEvent) => void;
  onPointerMove?: (event: React.PointerEvent) => void;
  onPointerUp?: (event: React.PointerEvent) => void;
  onClickCapture?: (event: React.MouseEvent) => void;
  dataColumnName?: string;
};

// Anchored to whichever edge of the trigger leaves the most room, then
// grown outward from there. minWidth is the trigger's own width -- a
// narrower header still gets a list at least as wide as the header itself,
// though a longer option can still push it wider.
type Anchor =
  | { side: 'left'; left: number; top: number; fontSize: string; minWidth: number }
  | { side: 'right'; right: number; top: number; fontSize: string; minWidth: number };

// Long dictionaries are real -- a zone_id column runs to tens of thousands
// of distinct values -- so the list mounts a window and grows it as you
// reach the end, the same way the table body itself pages.
const PAGE = 100;
// The list scrolls past this many rows rather than growing taller -- an
// exact multiple of one cell's own height plus its gaps, not a viewport
// fraction, so the box never stops mid-cell.
const VISIBLE_CELLS = 8;
// Cells never squash below the table's own row height, whatever the
// inherited font size works out to.
const CELL_H = 20;

export default function Dropdown({
  options, selected, label, onSelect, empty, grayed, italic,
  style, onPointerDown, onPointerMove, onPointerUp, onClickCapture, dataColumnName,
}: Props) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [shown, setShown] = useState(PAGE);
  const [maxListHeight, setMaxListHeight] = useState<number | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const open = anchor !== null;

  // Every cell is the same height, so one of them measured is enough to cap
  // the list at exactly VISIBLE_CELLS rows -- the gaps between them are the
  // list's own `gap: 1`, one fewer than the cell count.
  useLayoutEffect(() => {
    if (!open) return;
    const first = listRef.current?.firstElementChild as HTMLElement | null;
    if (!first) return;
    setMaxListHeight(first.getBoundingClientRect().height * VISIBLE_CELLS + (VISIBLE_CELLS - 1));
  }, [open, anchor]);

  function openDropdown() {
    const trigger = triggerRef.current;
    if (!trigger || empty || options.length === 0) return;
    const rect = trigger.getBoundingClientRect();
    // The popup inherits nothing through a portal, so the trigger's own
    // computed size is copied across explicitly -- that's what makes the
    // list read as belonging to the header you just clicked rather than as
    // a separate widget at its own scale.
    const fontSize = getComputedStyle(trigger).fontSize;
    const top = rect.bottom + 1;
    const minWidth = rect.width;
    setShown(PAGE);
    setAnchor(
      rect.left + rect.width / 2 > window.innerWidth / 2
        ? { side: 'right', right: Math.max(0, window.innerWidth - rect.right), top, fontSize, minWidth }
        : { side: 'left', left: Math.max(0, rect.left), top, fontSize, minWidth },
    );
  }

  // A click anywhere outside closes it. The portal means "outside" has to
  // check the trigger and the list separately -- they are no longer one
  // subtree.
  useEffect(() => {
    if (!open) return;
    const onDocPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (listRef.current?.contains(target)) return;
      setAnchor(null);
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, [open]);

  // Anything that moves the trigger under an open list invalidates where it
  // was placed, and there's no sensible way to follow it mid-scroll, so it
  // closes instead of drifting -- but scrolling the list itself, to reach
  // more of a long dictionary, is not that: a capturing window listener
  // sees every scroll in the document, the list's own included, and without
  // this check the dropdown closed itself the instant you tried to scroll
  // it.
  useLayoutEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (listRef.current?.contains(event.target as Node)) return;
      setAnchor(null);
    };
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

  function onListScroll() {
    const list = listRef.current;
    if (!list) return;
    if (list.scrollTop + list.clientHeight >= list.scrollHeight - CELL_H * 4) {
      setShown(current => (current >= options.length ? current : current + PAGE));
    }
  }

  return (
    <div
      ref={triggerRef}
      className="bg"
      data-column-name={dataColumnName}
      style={{ cursor: empty ? 'default' : 'pointer', ...style }}
      onClick={() => (open ? setAnchor(null) : openDropdown())}
      onClickCapture={onClickCapture}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {/* Even an empty slot keeps a real fg: a bg with none collapses to
          nothing under squeezeFg, which is what threw whole columns of
          cards out of alignment with each other. */}
      <div
        className="fg"
        style={{
          visibility: empty ? 'hidden' : undefined,
          color: grayed ? INACTIVE : undefined,
          fontStyle: italic ? 'italic' : undefined,
        }}
      >
        {empty ? '\u00A0' : label}
      </div>

      {anchor && createPortal(
        <div
          ref={listRef}
          className="dropdown-list"
          onScroll={onListScroll}
          style={{
            position: 'fixed',
            top: anchor.top,
            ...(anchor.side === 'left' ? { left: anchor.left } : { right: anchor.right }),
            minWidth: anchor.minWidth,
            maxHeight: maxListHeight ?? undefined,
            overflowY: 'auto',
            zIndex: 1000,
            // Its own black ground showing through 1px gaps between cells,
            // the same way every .bg nesting elsewhere does it -- no
            // padding around the outside, since that draws as a border
            // around the whole list, and nothing else in the app has one.
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
            background: '#000',
            fontSize: anchor.fontSize,
            fontFamily: 'inherit',
          }}
        >
          {options.slice(0, shown).map(option => (
            <div
              key={option.value}
              onClick={event => {
                event.stopPropagation();
                onSelect(option.value);
                setAnchor(null);
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '1em 0.4em',
                whiteSpace: 'nowrap',
                cursor: 'pointer',
                background: option.color ?? '#fff',
                color: option.unavailable ? INACTIVE : '#000',
                fontWeight: option.value === selected ? 600 : undefined,
              }}
            >
              {option.label}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

// The one neutral the app uses for "this isn't available / isn't on":
// mid-gray, well clear of the palette luminance everything else sits at, so
// a grayed label reads as switched off rather than as another swatch.
export const INACTIVE = 'rgb(128, 128, 128)';
