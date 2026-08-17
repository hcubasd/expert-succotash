import { grayAt, rgbStr } from '../lib/colors';
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
  detail: number;
  onDetail: (detail: number) => void;
};

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

const optionsOf = (values: string[]): Option[] => values.map(v => ({ value: v, label: v }));
const slider = grayAt(0.5);

type Card = { options: Option[]; selected: string | undefined; label: string };

function padSlots(cards: Card[]): (Card | null)[] {
  const out: (Card | null)[] = [...cards];
  while (out.length < CARD_SLOTS) out.push(null);
  return out;
}

// What a card reads as once something is picked: the option's own label, not
// the raw value behind it -- the network source card should say "vehicle
// count", never "loads". Falls back to the card's own name as a placeholder
// while nothing is selected.
function labelOf(card: Card): string {
  return card.options.find(option => option.value === card.selected)?.label ?? card.label;
}

// Grayed when there's nothing chosen yet, or when what *is* chosen has no
// data behind it -- the same signal the map gives by leaving that layer
// uncoloured, said again where the choice was made.
function isGrayed(card: Card): boolean {
  const current = card.options.find(option => option.value === card.selected);
  return !current || !!current.unavailable;
}

export default function MapPanel({ tables, draft, onDraft, legends, flowLegend, detail, onDetail }: Props) {
  const resourceOptions: Option[] = [ALL, ...optionsOf(allResources(tables))];

  // --- zones: one card, no All -- supply/demand/needs/capacities are
  // different quantities with different units, not slices of one that could
  // ever be summed together. All four are always offered, marked when the
  // file behind them isn't loaded: hiding them would leave no way to see
  // that the option exists at all, which is worse than showing it grayed.
  const zoneCards: Card[] = [
    {
      options: (['supply', 'demand', 'needs', 'capacities'] as const).map(source => ({
        value: source, label: source, unavailable: !tables[source],
      })),
      selected: draft.zoneSource,
      label: 'value',
    },
  ];

  // --- agents: one card, no All -- same reasoning as zones. Availability
  // here is per resource rather than per file: agents.gpkg carries a
  // {resource}_need / {resource}_capacity column only for the resources it
  // actually has.
  const agentCards: Card[] = [
    {
      options: (['need', 'capacity'] as const).map(kind => ({
        value: kind,
        label: kind,
        unavailable: !!draft.resource && draft.resource !== 'all'
          && !agentResources(tables, kind).includes(draft.resource),
      })),
      selected: draft.agentKind,
      label: 'value',
    },
  ];

  // --- network: up to five -- source, then time interval / vehicle / (for
  // emissions) pollutant / source, every one of which gets an All, because
  // each is a real slice of the same summable quantity. Grade stays offered
  // when neither loads nor emissions is loaded, so a file set with only
  // network.gpkg still has something to show rather than a blank column.
  const hasLoads = !!tables.network_loads;
  const hasEmissions = !!tables.network_emissions;
  const networkSourceOptions: Option[] = [
    ...(hasLoads ? [{ value: 'loads', label: 'vehicle count' }] : []),
    ...(hasEmissions ? [{ value: 'emissions', label: 'emissions' }] : []),
    ...(!hasLoads && !hasEmissions && tables.network ? [{ value: 'grade', label: 'grade' }] : []),
  ];
  const netSource = draft.networkSource;
  const netTakesDimensions = netSource === 'loads' || netSource === 'emissions';
  const netFileSource = netSource === 'emissions' ? 'emissions' : 'loads';

  const networkCards: Card[] = [
    { options: networkSourceOptions, selected: netSource, label: 'value' },
    {
      options: netTakesDimensions
        ? [ALL, ...optionsOf(stratumOptions(
            netFileSource === 'emissions' ? tables.network_emissions : tables.network_loads, 'time_interval',
          ))]
        : [],
      selected: draft.timeInterval,
      label: 'time interval',
    },
    {
      options: netTakesDimensions ? [ALL, ...optionsOf(networkVehicles(tables, netFileSource))] : [],
      selected: draft.vehicle,
      label: 'vehicle',
    },
    {
      options: netSource === 'emissions'
        ? [ALL, ...optionsOf(stratumOptions(tables.network_emissions, 'pollutant'))]
        : [],
      selected: draft.pollutant,
      label: 'pollutant',
    },
    {
      options: netSource === 'emissions'
        ? [ALL, ...optionsOf(stratumOptions(tables.network_emissions, 'source'))]
        : [],
      selected: draft.emissionSource,
      label: 'source',
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

  return (
    <div className="bg" style={{ flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
      <Dropdown
        options={resourceOptions}
        selected={draft.resource}
        label={labelOf({ options: resourceOptions, selected: draft.resource, label: 'resource' })}
        grayed={!draft.resource}
        onSelect={resource => onDraft({ ...draft, resource })}
      />

      <div className="bg" style={{ flex: 1, minHeight: 0 }}>
        {LAYERS.map(({ mode, label }) => {
          const available = modeIsAvailable(tables, mode);
          const on = available && draft.active[mode];
          return (
            <div key={mode} className="bg" style={{ flexDirection: 'column', flex: 1, minWidth: 0 }}>
              {/* Off, or not loaded, is said with the label's color alone --
                  no extra "(off)" text. Changing the text would change what
                  squeezeFg has to fit, so every toggle would resize every
                  label in the panel; changing only the color leaves the
                  layout completely alone. */}
              <div
                className="bg"
                style={{ cursor: available ? 'pointer' : 'default' }}
                onClick={available ? () => toggleLayer(mode) : undefined}
              >
                <div className="fg" style={{ color: on ? undefined : INACTIVE }}>{label}</div>
              </div>

              {padSlots(cardsFor[mode]).map((card, slot) => (
                <Dropdown
                  key={slot}
                  options={card?.options ?? []}
                  selected={card?.selected}
                  label={card ? labelOf(card) : ''}
                  empty={!card || card.options.length === 0}
                  grayed={!on || !card || isGrayed(card)}
                  onSelect={value => select(mode, slot, value)}
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

      <div className="bg" style={{ padding: '1em' }}>
        <input
          type="range"
          min={0}
          max={1}
          // No quantization: a native slider is already bounded to one
          // distinct position per pixel of its own track, so a numeric step
          // could only ever make that coarser, never finer.
          step="any"
          value={detail}
          onChange={event => onDetail(Number(event.target.value))}
          style={{ width: '100%', accentColor: rgbStr(slider) }}
        />
      </div>
    </div>
  );
}
