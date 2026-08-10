import { grayAt, rgbStr } from '../lib/colors';
import type { Legend } from '../lib/mapScene';
import {
  agentResources, desireLineResources, modeIsAvailable, stratumOptions, toSelection, zoneResources,
} from '../lib/mapValues';
import type { AgentKind, Draft, MapMode, Tables, ZoneSource } from '../lib/mapValues';

type Props = {
  tables: Tables;
  draft: Draft;
  onDraft: (draft: Draft) => void;
  legend: Legend | null;
  onDiagram: () => void;
};

const MODES: { id: MapMode; label: string }[] = [
  { id: 'zones', label: 'zones' },
  { id: 'desire_lines', label: 'desire lines' },
  { id: 'agents', label: 'agents' },
  { id: 'network', label: 'network' },
];

const ZONE_SOURCES: { id: ZoneSource; label: string }[] = [
  { id: 'supply', label: 'supply' },
  { id: 'demand', label: 'demand' },
  { id: 'needs', label: 'E.V. agent need' },
  { id: 'capacities', label: 'E.V. agent capacity' },
];

const shell = grayAt(0.96);
const idle = grayAt(0.89);
const chosen = grayAt(0.73912);

function Choice({ label, active, disabled, onClick }: {
  label: string; active: boolean; disabled?: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        border: 'none',
        borderRadius: 3,
        padding: '5px 9px',
        font: 'inherit',
        fontSize: 12,
        cursor: disabled ? 'default' : 'pointer',
        background: rgbStr(active ? chosen : idle),
        color: disabled ? 'rgba(0,0,0,0.3)' : '#000',
        opacity: disabled ? 0.55 : 1,
        textAlign: 'left',
      }}
    >
      {label}
    </button>
  );
}

function Row({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span style={{ fontSize: 10, letterSpacing: 0.6, textTransform: 'uppercase', opacity: 0.55 }}>{title}</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>{children}</div>
    </div>
  );
}

// The bar shows the ramp's colours at even spacing, because they are evenly
// spaced -- equally far apart around the wheel. It's the tick *values* that
// bunch up, and that asymmetry is the equalization being honest: a crowded
// band of the data really does get more of the ramp than a sparse one.
function LegendBar({ legend }: { legend: Legend }) {
  return (
    <div style={{ display: 'flex', gap: 8, minHeight: 0, flex: 1 }}>
      <div style={{ display: 'flex', flexDirection: 'column-reverse', width: 26, borderRadius: 2, overflow: 'hidden' }}>
        {legend.ramp.map((color, i) => (
          <div key={i} style={{ flex: 1, background: rgbStr(color) }} />
        ))}
      </div>
      <div style={{ position: 'relative', flex: 1, fontSize: 10 }}>
        {legend.ticks.map(({ t, value }) => (
          <div
            key={t}
            style={{
              position: 'absolute',
              bottom: `${t * 100}%`,
              transform: 'translateY(50%)',
              whiteSpace: 'nowrap',
            }}
          >
            <span style={{ opacity: 0.35 }}>— </span>
            {Number.isFinite(value) ? value.toPrecision(4).replace(/\.?0+$/, '') : ''}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function MapPanel({ tables, draft, onDraft, legend, onDiagram }: Props) {
  const complete = toSelection(draft) !== null;

  const resources =
    draft.mode === 'zones' && draft.zoneSource ? zoneResources(tables, draft.zoneSource)
    : draft.mode === 'desire_lines' ? desireLineResources(tables)
    : draft.mode === 'agents' && draft.agentKind ? agentResources(tables, draft.agentKind)
    : [];

  const intervals = stratumOptions(
    draft.networkSource === 'emissions' ? tables.network_emissions : tables.network_loads,
    'time_interval',
  );
  const pollutants = stratumOptions(tables.network_emissions, 'pollutant');
  const emissionSources = stratumOptions(tables.network_emissions, 'source');

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        padding: 14,
        minWidth: 0,
        minHeight: 0,
        overflow: 'auto',
        background: rgbStr(shell),
        color: '#000',
        fontFamily: 'inherit',
      }}
    >
      <Row title="map">
        {MODES.map(({ id, label }) => (
          <Choice
            key={id}
            label={label}
            active={draft.mode === id}
            disabled={!modeIsAvailable(tables, id)}
            // Switching mode drops everything downstream of it -- a resource
            // chosen for supply means nothing to the network.
            onClick={() => onDraft({ mode: draft.mode === id ? null : id })}
          />
        ))}
      </Row>

      {draft.mode === 'zones' && (
        <Row title="value">
          {ZONE_SOURCES.map(({ id, label }) => (
            <Choice
              key={id}
              label={label}
              active={draft.zoneSource === id}
              disabled={!tables[id]}
              onClick={() => onDraft({ mode: 'zones', zoneSource: id })}
            />
          ))}
        </Row>
      )}

      {draft.mode === 'agents' && (
        <Row title="value">
          {(['need', 'capacity'] as AgentKind[]).map(kind => (
            <Choice
              key={kind}
              label={kind}
              active={draft.agentKind === kind}
              onClick={() => onDraft({ mode: 'agents', agentKind: kind })}
            />
          ))}
        </Row>
      )}

      {draft.mode === 'network' && (
        <Row title="value">
          <Choice
            label="grade"
            active={draft.networkSource === 'grade'}
            onClick={() => onDraft({ mode: 'network', networkSource: 'grade' })}
          />
          <Choice
            label="vehicle count"
            active={draft.networkSource === 'loads'}
            disabled={!tables.network_loads}
            onClick={() => onDraft({ mode: 'network', networkSource: 'loads' })}
          />
          <Choice
            label="emissions"
            active={draft.networkSource === 'emissions'}
            disabled={!tables.network_emissions}
            onClick={() => onDraft({ mode: 'network', networkSource: 'emissions' })}
          />
        </Row>
      )}

      {draft.mode === 'network' && draft.networkSource && draft.networkSource !== 'grade' && (
        <Row title="time interval">
          {intervals.map(interval => (
            <Choice
              key={interval}
              label={interval}
              active={draft.timeInterval === interval}
              onClick={() => onDraft({ ...draft, timeInterval: interval })}
            />
          ))}
        </Row>
      )}

      {draft.mode === 'network' && draft.networkSource === 'emissions' && (
        <>
          <Row title="pollutant">
            {pollutants.map(pollutant => (
              <Choice
                key={pollutant}
                label={pollutant}
                active={draft.pollutant === pollutant}
                onClick={() => onDraft({ ...draft, pollutant })}
              />
            ))}
          </Row>
          <Row title="source">
            {emissionSources.map(source => (
              <Choice
                key={source}
                label={source}
                active={draft.emissionSource === source}
                onClick={() => onDraft({ ...draft, emissionSource: source })}
              />
            ))}
          </Row>
        </>
      )}

      {resources.length > 0 && (
        <Row title="resource">
          {resources.map(resource => (
            <Choice
              key={resource}
              label={resource}
              active={draft.resource === resource}
              onClick={() => onDraft({ ...draft, resource })}
            />
          ))}
        </Row>
      )}

      {complete && legend && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minHeight: 160 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: 10, letterSpacing: 0.6, textTransform: 'uppercase', opacity: 0.55 }}>
              legend
            </span>
            <Choice
              label="clear"
              active={false}
              // Leaving the legend drops the resource, not the mode: the map
              // falls back to its hollow basemap and the resource has to be
              // picked again to colour anything.
              onClick={() => onDraft({ ...draft, resource: undefined })}
            />
          </div>
          <LegendBar legend={legend} />
        </div>
      )}

      <button className="overlay-btn" style={{ position: 'static', marginTop: 'auto' }} onClick={onDiagram}>
        diagram →
      </button>
    </div>
  );
}
