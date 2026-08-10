import type { TableName } from './schema';
import type { Table } from './tableMaker';

// What the map is showing. Every mode ends at a *value* per feature, never a
// category -- zones carry supply/demand/expected agent need or capacity per
// resource, desire lines carry flow per resource, agents carry their own
// need or capacity per resource, network links carry grade, vehicle counts
// or emitted grams. That is what makes one equalized ramp the right tool
// everywhere rather than a palette of unrelated categorical colors.
export type ZoneSource = 'supply' | 'demand' | 'needs' | 'capacities';
export type AgentKind = 'need' | 'capacity';

export type MapSelection =
  | { mode: 'zones'; source: ZoneSource; resource: string }
  | { mode: 'desire_lines'; resource: string }
  | { mode: 'agents'; kind: AgentKind; resource: string }
  | { mode: 'network'; source: 'grade' }
  | { mode: 'network'; source: 'loads'; timeInterval: string }
  | {
      mode: 'network';
      source: 'emissions';
      timeInterval: string;
      pollutant: string;
      emissionSource: string;
    };

export type MapMode = MapSelection['mode'];

export type Tables = Partial<Record<TableName, Table>>;

// --- reading columns back out of the dictionary encoding -------------------

function stratumKeys(table: Table, name: string): string[] | null {
  const column = table.strata.find(c => c.name === name);
  if (!column) return null;
  const dictionary = column.dictionary.map(v => (v === null || v === undefined ? '' : String(v)));
  const out = new Array<string>(table.rowCount);
  for (let i = 0; i < table.rowCount; i++) out[i] = dictionary[column.codes[i]];
  return out;
}

function stratumNumbers(table: Table, name: string): Float64Array | null {
  const column = table.strata.find(c => c.name === name);
  if (!column) return null;
  const dictionary = column.dictionary.map(v => (typeof v === 'number' ? v : Number(v)));
  const out = new Float64Array(table.rowCount);
  for (let i = 0; i < table.rowCount; i++) out[i] = dictionary[column.codes[i]];
  return out;
}

function valueColumn(table: Table, name: string) {
  return table.values.find(c => c.name === name);
}

// Per-row reads, for callers outside this module that need a column as a
// plain array -- building desire-line edges, mostly.
export function stratumValues(table: Table, name: string): string[] | null {
  return stratumKeys(table, name);
}

export function valueNumbers(table: Table, name: string): Float64Array | null {
  const column = valueColumn(table, name);
  if (!column) return null;
  const out = new Float64Array(table.rowCount);
  for (let row = 0; row < table.rowCount; row++) {
    out[row] = column.present[row] ? column.data[row] : NaN;
  }
  return out;
}

// Distinct values of a stratum, in first-seen order -- which is the order
// the dictionary already holds them in, so this is a read rather than a scan.
export function stratumOptions(table: Table | undefined, name: string): string[] {
  const column = table?.strata.find(c => c.name === name);
  if (!column) return [];
  return column.dictionary.map(v => (v === null || v === undefined ? '' : String(v)));
}

// --- what resources exist, per source --------------------------------------
//
// Ramps are assigned per file, not globally: a file's own resource list
// decides its n, so loading another file later can never reshuffle the
// colors of one already on screen.

export function zoneResources(tables: Tables, source: ZoneSource): string[] {
  if (source === 'supply' || source === 'demand') {
    // Wide on resources: one value column per resource.
    return tables[source]?.values.map(c => c.name) ?? [];
  }
  return stratumOptions(tables[source], 'resource');
}

export function desireLineResources(tables: Tables): string[] {
  return stratumOptions(tables.desire_lines, 'resource');
}

// agents is wide on {resource}_capacity / {resource}_need, so the resource
// list is a suffix strip over the value columns.
export function agentResources(tables: Tables, kind: AgentKind): string[] {
  const suffix = `_${kind}`;
  return (tables.agents?.values ?? [])
    .map(c => c.name)
    .filter(name => name.endsWith(suffix))
    .map(name => name.slice(0, -suffix.length));
}

// --- per-feature values, indexed by geometry row ---------------------------
//
// Geometry rows and table rows come from the same file in the same order, so
// row i of one is row i of the other. Anything that has to reach across
// files joins on the key both sides carry (zone_id, link_id).

function zoneTotals(tables: Tables, source: ZoneSource, resource: string): Map<string, number> | null {
  const table = tables[source];
  if (!table) return null;

  const zoneIds = stratumKeys(table, 'zone_id');
  if (!zoneIds) return null;

  const totals = new Map<string, number>();

  if (source === 'supply' || source === 'demand') {
    const column = valueColumn(table, resource);
    if (!column) return null;
    // Summed rather than assigned: these files carry one row per zone today,
    // but the schema allows extra stratum dimensions, which would split a
    // zone across several rows.
    for (let row = 0; row < table.rowCount; row++) {
      if (!column.present[row]) continue;
      totals.set(zoneIds[row], (totals.get(zoneIds[row]) ?? 0) + column.data[row]);
    }
    return totals;
  }

  // needs / capacities are probability distributions over resource_level, so
  // the per-zone number is a genuine expected value: the level-weighted sum
  // of its probabilities.
  const resources = stratumKeys(table, 'resource');
  const levels = stratumNumbers(table, 'resource_level');
  const probability = valueColumn(table, 'probability');
  if (!resources || !levels || !probability) return null;

  for (let row = 0; row < table.rowCount; row++) {
    if (resources[row] !== resource || !probability.present[row]) continue;
    const level = levels[row];
    if (!Number.isFinite(level)) continue;
    totals.set(zoneIds[row], (totals.get(zoneIds[row]) ?? 0) + level * probability.data[row]);
  }
  return totals;
}

function linkTotals(tables: Tables, selection: Extract<MapSelection, { mode: 'network' }>): Map<string, number> | null {
  if (selection.source === 'grade') return null; // read straight off network itself

  const table = selection.source === 'loads' ? tables.network_loads : tables.network_emissions;
  if (!table) return null;

  const linkIds = stratumKeys(table, 'link_id');
  const intervals = stratumKeys(table, 'time_interval');
  if (!linkIds || !intervals) return null;

  const column = valueColumn(table, selection.source === 'loads' ? 'vehicle_count' : 'grams');
  if (!column) return null;

  // Emissions split further by pollutant and by exhaust / non-exhaust; both
  // files also split by vehicle and direction, which are summed over rather
  // than selected -- "per link per time period" means all traffic on it.
  const pollutants = selection.source === 'emissions' ? stratumKeys(table, 'pollutant') : null;
  const sources = selection.source === 'emissions' ? stratumKeys(table, 'source') : null;

  const totals = new Map<string, number>();
  for (let row = 0; row < table.rowCount; row++) {
    if (intervals[row] !== selection.timeInterval || !column.present[row]) continue;
    if (selection.source === 'emissions') {
      if (pollutants && pollutants[row] !== selection.pollutant) continue;
      if (sources && sources[row] !== selection.emissionSource) continue;
    }
    totals.set(linkIds[row], (totals.get(linkIds[row]) ?? 0) + column.data[row]);
  }
  return totals;
}

// NaN marks a feature with no value for this selection -- an agent with no
// need for a resource, a zone missing from supply, a link with no traffic in
// this interval. Those are skipped rather than drawn as zero, which is a
// different statement.
export function featureValues(tables: Tables, selection: MapSelection): Float64Array | null {
  if (selection.mode === 'zones') {
    const zones = tables.zones;
    if (!zones) return null;
    const zoneIds = stratumKeys(zones, 'zone_id');
    const totals = zoneTotals(tables, selection.source, selection.resource);
    if (!zoneIds || !totals) return null;

    const out = new Float64Array(zones.rowCount).fill(NaN);
    for (let row = 0; row < zones.rowCount; row++) {
      const value = totals.get(zoneIds[row]);
      if (value !== undefined) out[row] = value;
    }
    return out;
  }

  if (selection.mode === 'agents') {
    const agents = tables.agents;
    if (!agents) return null;
    const column = valueColumn(agents, `${selection.resource}_${selection.kind}`);
    if (!column) return null;

    const out = new Float64Array(agents.rowCount).fill(NaN);
    for (let row = 0; row < agents.rowCount; row++) {
      if (column.present[row]) out[row] = column.data[row];
    }
    return out;
  }

  if (selection.mode === 'network') {
    const network = tables.network;
    if (!network) return null;

    if (selection.source === 'grade') {
      const column = valueColumn(network, 'grade');
      if (!column) return null;
      const out = new Float64Array(network.rowCount).fill(NaN);
      for (let row = 0; row < network.rowCount; row++) {
        if (column.present[row]) out[row] = column.data[row];
      }
      return out;
    }

    const linkIds = stratumKeys(network, 'link_id');
    const totals = linkTotals(tables, selection);
    if (!linkIds || !totals) return null;

    const out = new Float64Array(network.rowCount).fill(NaN);
    for (let row = 0; row < network.rowCount; row++) {
      const value = totals.get(linkIds[row]);
      if (value !== undefined) out[row] = value;
    }
    return out;
  }

  // Desire lines never take this path: their values are accumulated per
  // pixel on the GPU, not per feature, because what is being colored is how
  // much flow crosses a point rather than what any one line carries.
  return null;
}

// Whether a mode has everything it needs to draw anything at all.
export function modeIsAvailable(tables: Tables, mode: MapMode): boolean {
  if (mode === 'zones') return !!tables.zones;
  if (mode === 'desire_lines') return !!tables.desire_lines;
  if (mode === 'agents') return !!tables.agents;
  return !!tables.network;
}

// A selection under construction. The panel fills this in step by step and
// only the complete forms color anything -- until then the map stays on its
// hollow basemap, which is also what "leaving the legend" returns to.
export type Draft = {
  mode: MapMode | null;
  zoneSource?: ZoneSource;
  agentKind?: AgentKind;
  networkSource?: 'grade' | 'loads' | 'emissions';
  timeInterval?: string;
  pollutant?: string;
  emissionSource?: string;
  resource?: string;
};

export function toSelection(draft: Draft): MapSelection | null {
  if (draft.mode === 'zones') {
    if (!draft.zoneSource || !draft.resource) return null;
    return { mode: 'zones', source: draft.zoneSource, resource: draft.resource };
  }
  if (draft.mode === 'desire_lines') {
    if (!draft.resource) return null;
    return { mode: 'desire_lines', resource: draft.resource };
  }
  if (draft.mode === 'agents') {
    if (!draft.agentKind || !draft.resource) return null;
    return { mode: 'agents', kind: draft.agentKind, resource: draft.resource };
  }
  if (draft.mode === 'network') {
    if (draft.networkSource === 'grade') return { mode: 'network', source: 'grade' };
    if (draft.networkSource === 'loads') {
      if (!draft.timeInterval) return null;
      return { mode: 'network', source: 'loads', timeInterval: draft.timeInterval };
    }
    if (draft.networkSource === 'emissions') {
      if (!draft.timeInterval || !draft.pollutant || !draft.emissionSource) return null;
      return {
        mode: 'network',
        source: 'emissions',
        timeInterval: draft.timeInterval,
        pollutant: draft.pollutant,
        emissionSource: draft.emissionSource,
      };
    }
  }
  return null;
}
