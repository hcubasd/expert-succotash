import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { grayAt, rgbStr } from '../lib/colors';
import { humanize } from '../lib/humanize';
import type { Legend } from '../lib/mapScene';
import {
  agentRender, agentResources, allResources, desireLineRender,
  modeIsAvailable, networkRender, networkVehicles, stratumOptions, zoneRender,
} from '../lib/mapValues';
import type { Draft, LayerRender, MapMode, Tables } from '../lib/mapValues';
import Dropdown, { INACTIVE } from './Dropdown';
import type { Option } from './Dropdown';
import LegendCanvas from './LegendCanvas';

type Props = {
  tables: Tables;
  draft: Draft;
  onDraft: (draft: Draft) => void;
  legends: { zones: Legend | null; agents: Legend | null; network: Legend | null };
  flowLegend: Legend | null;
  detail: Record<MapMode, number>;
  onDetail: (mode: MapMode, detail: number) => void;
  lineWidth: number;
  onLineWidth: (lineWidth: number) => void;
};

// The slider's own range: 0 makes every line vanish, 8 is thick enough to
// read as a highlight rather than a line. Not tied to LINE_WIDTH_CSS_PX --
// that's a default starting value, not a ceiling.
const MAX_LINE_WIDTH = 8;

const ALL: Option = { value: 'all', label: 'All' };
const LAYERS: { mode: MapMode; label: string }[] = [
  { mode: 'zones', label: 'zones' },
  { mode: 'network', label: 'network' },
  { mode: 'desire_lines', label: 'desire lines' },
  { mode: 'agents', label: 'agents' },
];
// Every layer's column holds the same number of card slots, so the legends
// underneath all start at the same height. Network needs the most: value,
// then time interval, vehicle, pollutant and source.
const CARD_SLOTS = 5;

const optionsOf = (values: string[]): Option[] => values.map(v => ({ value: v, label: humanize(v) }));
const slider = grayAt(0.5);

type Card = { options: Option[]; selected: string | undefined };

function padSlots(cards: Card[]): (Card | null)[] {
  const out: (Card | null)[] = [...cards];
  while (out.length < CARD_SLOTS) out.push(null);
  return out;
}

// What a card reads as: the selected option's own label, or -- while nothing
// is picked yet -- a preview of the first option instead of the field's own
// generic name (a card just reading "value" was the actual complaint this
// replaced). Only meaningful once there's at least one real option; an empty
// card is shown blank by the `empty` prop regardless of what this returns.
function shownOption(card: Card): Option | undefined {
  return card.options.find(option => option.value === card.selected) ?? card.options[0];
}
function labelOf(card: Card): string {
  return shownOption(card)?.label ?? '';
}
// The value behind whatever labelOf is showing -- passed on as Dropdown's
// own `selected`, so the popup bolds the previewed first option too, not
// only a value the user actually clicked.
function shownValue(card: Card): string | undefined {
  return shownOption(card)?.value;
}

// Grayed when the option being shown -- selected, or previewed as the first
// one -- has no data behind it. Same signal the map gives by leaving that
// layer uncoloured, said again where the choice is made.
function isGrayed(card: Card): boolean {
  const shown = shownOption(card);
  return !shown || !!shown.unavailable;
}

export default function MapPanel({
  tables, draft, onDraft, legends, flowLegend, detail, onDetail, lineWidth, onLineWidth,
}: Props) {
  const resourceOptions: Option[] = [ALL, ...optionsOf(allResources(tables))];

  // Four columns splitting the panel evenly land on fractional pixels
  // almost always -- (panelWidth - 3) / 4 rarely divides cleanly -- and a
  // fractional column edge is invisible on a solid .bg background but very
  // visible on a legend, whose canvas either blurs across it or misses it
  // by a device pixel. Neither is fixable from inside the canvas: it has to
  // sit exactly where its own siblings sit, so the edges themselves are
  // what have to be whole. Measured and divided here instead of left to
  // flex, the same way the table gives its columns explicit integer widths.
  //
  // The remainder goes to the *last* column rather than being spread: every
  // boundary a legend actually has to line up against is then a whole
  // number, and the one fractional edge left over is the panel's own right
  // edge, against the window, with nothing beside it to disagree with.
  const columnsRef = useRef<HTMLDivElement>(null);
  const [columnsWidth, setColumnsWidth] = useState(0);

  useLayoutEffect(() => {
    const element = columnsRef.current;
    if (!element) return;
    const measure = () => setColumnsWidth(element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const GAPS = LAYERS.length - 1;
  const baseColumn = columnsWidth > 0 ? Math.floor((columnsWidth - GAPS) / LAYERS.length) : 0;
  const lastColumn = columnsWidth > 0 ? columnsWidth - GAPS - baseColumn * (LAYERS.length - 1) : 0;
  // Before the first measurement there is nothing to divide, so the columns
  // fall back to flex and simply look the way they always did for one frame.
  const columnStyle = (index: number): React.CSSProperties =>
    (columnsWidth <= 0
      ? { flex: 1 }
      : { flex: '0 0 auto', width: index === LAYERS.length - 1 ? lastColumn : baseColumn });

  // --- zones: one card, no All -- supply/demand/needs/capacities are
  // different quantities with different units, not slices of one that could
  // ever be summed together. All four are always offered, marked when the
  // file behind them isn't loaded: hiding them would leave no way to see
  // that the option exists at all, which is worse than showing it grayed.
  const zoneCards: Card[] = [
    {
      options: (['supply', 'demand', 'needs', 'capacities'] as const).map(source => ({
        value: source, label: humanize(source), unavailable: !tables[source],
      })),
      selected: draft.zoneSource,
    },
  ];

  // --- agents: one card, no All -- same reasoning as zones, but availability
  // is two separate checks rather than one: the file has to be loaded at
  // all (agents.gpkg, same as zones' per-file check), and once a resource is
  // picked, that resource has to actually have a {resource}_need /
  // {resource}_capacity column -- agents.gpkg carries one only for the
  // resources it actually has.
  const agentCards: Card[] = [
    {
      options: (['need', 'capacity'] as const).map(kind => ({
        value: kind,
        label: humanize(kind),
        unavailable: !tables.agents || (!!draft.resource && draft.resource !== 'all'
          && !agentResources(tables, kind).includes(draft.resource)),
      })),
      selected: draft.agentKind,
    },
  ];

  // --- network: up to five -- source, then time interval / vehicle / (for
  // emissions) pollutant / source, every one of which gets an All, because
  // each is a real slice of the same summable quantity. Grade stays offered
  // when neither loads nor emissions is loaded, so a file set with only
  // network.gpkg still has something to show rather than a blank column.
  const hasLoads = !!tables.network_loads;
  const hasEmissions = !!tables.network_emissions;
  // Grade is deliberately not offered. Every other thing the map colours by
  // is a quantity of some resource, and the ramps now rotate per resource --
  // grade has no resource to rotate on, so it is the one driver that falls
  // outside that scheme. Left out entirely rather than given an arbitrary
  // rotation, until there's a decision about where it belongs. The selection
  // type and featureValues still understand 'grade'; only the way in is
  // closed.
  const networkSourceOptions: Option[] = [
    ...(hasLoads ? [{ value: 'loads', label: 'Vehicle count' }] : []),
    ...(hasEmissions ? [{ value: 'emissions', label: 'Emissions' }] : []),
  ];
  const netSource = draft.networkSource;
  const netTakesDimensions = netSource === 'loads' || netSource === 'emissions';
  const netFileSource = netSource === 'emissions' ? 'emissions' : 'loads';

  const networkCards: Card[] = [
    { options: networkSourceOptions, selected: netSource },
    {
      options: netTakesDimensions
        ? [ALL, ...optionsOf(stratumOptions(
            netFileSource === 'emissions' ? tables.network_emissions : tables.network_loads, 'time_interval',
          ))]
        : [],
      selected: draft.timeInterval,
    },
    {
      options: netTakesDimensions ? [ALL, ...optionsOf(networkVehicles(tables, netFileSource))] : [],
      selected: draft.vehicle,
    },
    {
      options: netSource === 'emissions'
        ? [ALL, ...optionsOf(stratumOptions(tables.network_emissions, 'pollutant'))]
        : [],
      selected: draft.pollutant,
    },
    {
      options: netSource === 'emissions'
        ? [ALL, ...optionsOf(stratumOptions(tables.network_emissions, 'source'))]
        : [],
      selected: draft.emissionSource,
    },
  ];

  // --- desire lines: none -- the shared resource picker is all it uses.
  const cardsFor: Record<MapMode, Card[]> = {
    zones: zoneCards, agents: agentCards, network: networkCards, desire_lines: [],
  };
  const legendFor: Record<MapMode, Legend | null> = {
    zones: legends.zones, agents: legends.agents, network: legends.network, desire_lines: flowLegend,
  };
  const renderFor: Record<MapMode, LayerRender> = {
    zones: zoneRender(draft, tables),
    agents: agentRender(draft, tables),
    network: networkRender(draft, tables),
    desire_lines: desireLineRender(draft, tables),
  };

  // Which draft field each layer's nth card writes to. Selecting a network
  // source drops everything downstream of it: a time interval or vehicle
  // picked for loads doesn't necessarily exist for emissions.
  function select(mode: MapMode, slot: number, value: string) {
    if (mode === 'zones') return onDraft({ ...draft, zoneSource: value as Draft['zoneSource'] });
    if (mode === 'agents') return onDraft({ ...draft, agentKind: value as Draft['agentKind'] });
    if (mode !== 'network') return;
    if (slot === 0) {
      return onDraft({
        ...draft, networkSource: value as Draft['networkSource'],
        timeInterval: undefined, vehicle: undefined, pollutant: undefined, emissionSource: undefined,
      });
    }
    if (slot === 1) return onDraft({ ...draft, timeInterval: value });
    if (slot === 2) return onDraft({ ...draft, vehicle: value });
    if (slot === 3) return onDraft({ ...draft, pollutant: value });
    if (slot === 4) return onDraft({ ...draft, emissionSource: value });
  }

  function toggleLayer(mode: MapMode) {
    onDraft({ ...draft, active: { ...draft.active, [mode]: !draft.active[mode] } });
  }

  const resourceCard: Card = { options: resourceOptions, selected: draft.resource };

  // A card with nothing chosen previews its first option, and until now that
  // was only ever a label: the draft field stayed undefined, so the layer
  // rendered neutral while its control read as already set. Loading a file
  // and coming back to the map showed an enabled, apparently-selected card
  // over an uncoloured map, and picking the value that was already displayed
  // was what finally applied it. Committing the preview here is what makes
  // the control and the map agree -- what you see selected is selected.
  //
  // One onDraft for all of them rather than one per card: each call rebuilds
  // the draft from the same starting value, so separate calls would each
  // discard the others' work. Network's dimensions resolve on a later pass,
  // once its source is committed and their option lists exist at all, which
  // is why this settles rather than needing to fill everything at once.
  useEffect(() => {
    const next = { ...draft };
    let changed = false;
    const fill = <K extends keyof Draft>(key: K, card: Card) => {
      if (next[key] !== undefined) return;
      const value = shownValue(card);
      if (value === undefined) return;
      next[key] = value as Draft[K];
      changed = true;
    };

    fill('resource', resourceCard);
    fill('zoneSource', zoneCards[0]);
    fill('agentKind', agentCards[0]);
    fill('networkSource', networkCards[0]);
    fill('timeInterval', networkCards[1]);
    fill('vehicle', networkCards[2]);
    fill('pollutant', networkCards[3]);
    fill('emissionSource', networkCards[4]);

    if (changed) onDraft(next);
  });

  return (
    <div className="bg" style={{ flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
      <Dropdown
        options={resourceOptions}
        selected={shownValue(resourceCard)}
        label={labelOf(resourceCard)}
        empty={allResources(tables).length === 0}
        grayed={isGrayed(resourceCard)}
        onSelect={resource => onDraft({ ...draft, resource })}
        style={{ padding: '1em 0' }}
      />

      <div ref={columnsRef} className="bg" style={{ flex: 1, minHeight: 0 }}>
        {LAYERS.map(({ mode, label }, index) => {
          const available = modeIsAvailable(tables, mode);
          const on = available && draft.active[mode];
          return (
            <div
              key={mode}
              className="bg"
              style={{ flexDirection: 'column', ...columnStyle(index), minWidth: 0 }}
            >
              {/* Off, or not loaded, is said with the label's color alone --
                  no extra "(off)" text. Changing the text would change what
                  squeezeFg has to fit, so every toggle would resize every
                  label in the panel; changing only the color leaves the
                  layout completely alone. */}
              <div
                className="bg"
                style={{ cursor: available ? 'pointer' : 'default', padding: '1em 0' }}
                onClick={available ? () => toggleLayer(mode) : undefined}
              >
                <div className="fg" style={{ color: on ? undefined : INACTIVE }}>{humanize(label)}</div>
              </div>

              {padSlots(cardsFor[mode]).map((card, slot) => (
                <Dropdown
                  key={slot}
                  options={card?.options ?? []}
                  selected={card ? shownValue(card) : undefined}
                  label={card ? labelOf(card) : ''}
                  empty={!card || card.options.length === 0}
                  grayed={!on || !card || isGrayed(card)}
                  onSelect={value => select(mode, slot, value)}
                  style={{ padding: '1em 0' }}
                />
              ))}

              <div className="bg" style={{ flex: 1, minHeight: 0 }}>
                {on && renderFor[mode].kind === 'selected' && legendFor[mode]
                  ? <LegendCanvas legend={legendFor[mode]!} />
                  : null}
              </div>
            </div>
          );
        })}
      </div>

      {/* One slider per layer, not one shared control -- each row is a
          label exactly as wide as the first column above it, next to a
          slider filling the rest, stacked in the same LAYERS order those
          columns use.

          The label takes that column's own measured width outright rather
          than a 1:3 flex ratio. A ratio had to reproduce the column split
          by arithmetic -- and the two rows carry different numbers of 1px
          gaps, three against one, so the shares genuinely differ and it
          needed a flex-basis fudge to compensate. Reusing the number the
          columns were actually laid out with removes the arithmetic and the
          fudge together.

          Neither cell carries horizontal padding: box-sizing is border-box
          here, so padding would become the cell's own flex base size and
          eat into the split rather than insetting anything. The slider's
          own inset lives on the input, as a margin. */}
      <div className="bg" style={{ flexDirection: 'column' }}>
        {LAYERS.map(({ mode, label }) => (
          <div key={mode} className="bg" style={{ flexDirection: 'row' }}>
            <div className="bg" style={{ ...columnStyle(0), padding: '1em 0' }}>
              <div className="fg">{humanize(label)}</div>
            </div>
            <div className="bg" style={{ flex: 1, minWidth: 0, padding: '1em 0' }}>
              <input
                type="range"
                min={0}
                max={1}
                // No quantization: a native slider is already bounded to one
                // distinct position per pixel of its own track, so a numeric
                // step could only ever make that coarser, never finer.
                step="any"
                value={detail[mode]}
                onChange={event => onDetail(mode, Number(event.target.value))}
                // The 1em inset lives here, on the input, rather than as
                // horizontal padding on the cell around it -- padding there
                // would become the cell's flex base size and eat a quarter
                // of itself out of the label beside it, which is the
                // alignment bug described above. A margin on a flex item
                // takes its space out of the cell's own share instead, so
                // the 1:3 split is untouched.
                style={{ flex: 1, minWidth: 0, margin: '0 1em', accentColor: rgbStr(slider) }}
              />
            </div>
          </div>
        ))}

        {/* One more row, same shape as the four above it -- not a fifth
            layer, so it isn't in LAYERS, but it takes the same first-column
            width so its slider starts where theirs do. */}
        <div className="bg" style={{ flexDirection: 'row' }}>
          <div className="bg" style={{ ...columnStyle(0), padding: '1em 0' }}>
            <div className="fg">Lines</div>
          </div>
          <div className="bg" style={{ flex: 1, minWidth: 0, padding: '1em 0' }}>
            <input
              type="range"
              min={0}
              max={MAX_LINE_WIDTH}
              step="any"
              value={lineWidth}
              onChange={event => onLineWidth(Number(event.target.value))}
              style={{ flex: 1, minWidth: 0, margin: '0 1em', accentColor: rgbStr(slider) }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
