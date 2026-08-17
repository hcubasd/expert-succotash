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
export type NetworkSource = 'grade' | 'loads' | 'emissions';

// A network dimension can be pinned to one value or aggregated across every
// value it has -- vehicle counts and grams both sum cleanly across any of
// time_interval, vehicle, resource, pollutant or source, so 'all' is always
// a real, well-defined answer here, never a placeholder.
export type Dim = string | 'all';

export type MapSelection =
  | { mode: 'zones'; source: ZoneSource; resource: string }
  | { mode: 'desire_lines'; resource: string }
  | { mode: 'agents'; kind: AgentKind; resource: string }
  | { mode: 'network'; source: 'grade' }
  | { mode: 'network'; source: 'loads'; timeInterval: Dim; vehicle: Dim; resource: Dim }
  | {
      mode: 'network';
      source: 'emissions';
      timeInterval: Dim;
      vehicle: Dim;
      resource: Dim;
      pollutant: Dim;
      emissionSource: Dim;
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

// loads and emissions carry the same resource/vehicle columns, so both read
// off whichever of the two files the current source names.
export function networkResources(tables: Tables, source: 'loads' | 'emissions'): string[] {
  const table = source === 'loads' ? tables.network_loads : tables.network_emissions;
  return stratumOptions(table, 'resource');
}

export function networkVehicles(tables: Tables, source: 'loads' | 'emissions'): string[] {
  const table = source === 'loads' ? tables.network_loads : tables.network_emissions;
  return stratumOptions(table, 'vehicle');
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

// The resource list every layer's global picker offers is the union across
// whichever files are actually loaded -- a resource that only exists in one
// file is still a real choice, it just leaves the other layers neutral.
export function allResources(tables: Tables): string[] {
  const seen = new Set<string>();
  for (const r of zoneResources(tables, 'supply')) seen.add(r);
  for (const r of zoneResources(tables, 'demand')) seen.add(r);
  for (const r of zoneResources(tables, 'needs')) seen.add(r);
  for (const r of zoneResources(tables, 'capacities')) seen.add(r);
  for (const r of agentResources(tables, 'need')) seen.add(r);
  for (const r of agentResources(tables, 'capacity')) seen.add(r);
  for (const r of desireLineResources(tables)) seen.add(r);
  for (const r of networkResources(tables, 'loads')) seen.add(r);
  for (const r of networkResources(tables, 'emissions')) seen.add(r);
  return [...seen];
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

// 'all' matches every row on that dimension rather than one specific value,
// which is what lets a link's rows sum across it instead of being filtered
// down to a single slice.
function matches(value: string, dim: Dim): boolean {
  return dim === 'all' || value === dim;
}

function linkTotals(tables: Tables, selection: Extract<MapSelection, { mode: 'network' }>): Map<string, number> | null {
  if (selection.source === 'grade') return null; // read straight off network itself

  const table = selection.source === 'loads' ? tables.network_loads : tables.network_emissions;
  if (!table) return null;

  const linkIds = stratumKeys(table, 'link_id');
  const intervals = stratumKeys(table, 'time_interval');
  const vehicles = stratumKeys(table, 'vehicle');
  const resources = stratumKeys(table, 'resource');
  if (!linkIds || !intervals || !vehicles || !resources) return null;

  const column = valueColumn(table, selection.source === 'loads' ? 'vehicle_count' : 'grams');
  if (!column) return null;

  // Emissions split further by pollutant and by exhaust / non-exhaust; both
  // files also split by direction, which is always summed over -- forward
  // and backward traffic on a link are never separately selectable.
  const pollutants = selection.source === 'emissions' ? stratumKeys(table, 'pollutant') : null;
  const sources = selection.source === 'emissions' ? stratumKeys(table, 'source') : null;

  const totals = new Map<string, number>();
  for (let row = 0; row < table.rowCount; row++) {
    if (!column.present[row]) continue;
    if (!matches(intervals[row], selection.timeInterval)) continue;
    if (!matches(vehicles[row], selection.vehicle)) continue;
    if (!matches(resources[row], selection.resource)) continue;
    if (selection.source === 'emissions') {
      if (pollutants && !matches(pollutants[row], selection.pollutant)) continue;
      if (sources && !matches(sources[row], selection.emissionSource)) continue;
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

// --- the draft: one shared resource, four independently toggled layers -----
//
// There is no more single "active mode" -- every layer composites onto the
// map at once, gated by its own on/off switch rather than by which one was
// picked last. The resource is the one thing every layer shares; everything
// else (which zone value, which network source, which time interval) is
// each layer's own business.
export type Draft = {
  // undefined: nothing chosen at all yet. 'all': the shared neutral/aggregate
  // state. A specific string: a real resource every layer resolves against.
  resource?: Dim;
  active: Record<MapMode, boolean>;
  zoneSource?: ZoneSource;
  agentKind?: AgentKind;
  networkSource?: NetworkSource;
  timeInterval?: Dim;
  vehicle?: Dim;
  pollutant?: Dim;
  emissionSource?: Dim;
};

export const DEFAULT_ACTIVE: Record<MapMode, boolean> = {
  zones: true, agents: true, network: true, desire_lines: true,
};

// What one layer actually draws, resolved from the shared draft:
//   off      -- toggled off, or its file isn't loaded
//   neutral  -- on, but nothing to color: no resource, "all" resources, or
//               (zones/agents only) the layer's own value kind isn't picked
//   selected -- a real, complete selection ready for featureValues
export type LayerRender =
  | { kind: 'off' }
  | { kind: 'neutral' }
  | { kind: 'selected'; selection: MapSelection };

export function zoneRender(draft: Draft, tables: Tables): LayerRender {
  if (!draft.active.zones || !tables.zones) return { kind: 'off' };
  if (!draft.resource || draft.resource === 'all' || !draft.zoneSource) return { kind: 'neutral' };
  return { kind: 'selected', selection: { mode: 'zones', source: draft.zoneSource, resource: draft.resource } };
}

export function agentRender(draft: Draft, tables: Tables): LayerRender {
  if (!draft.active.agents || !tables.agents) return { kind: 'off' };
  if (!draft.resource || draft.resource === 'all' || !draft.agentKind) return { kind: 'neutral' };
  return { kind: 'selected', selection: { mode: 'agents', kind: draft.agentKind, resource: draft.resource } };
}

export function desireLineRender(draft: Draft, tables: Tables): LayerRender {
  if (!draft.active.desire_lines || !tables.desire_lines) return { kind: 'off' };
  if (!draft.resource || draft.resource === 'all') return { kind: 'neutral' };
  return { kind: 'selected', selection: { mode: 'desire_lines', resource: draft.resource } };
}

// Network never goes neutral once it has a source -- "all resources" is a
// real aggregate for it, not an absence of one -- so an unset dimension
// defaults straight to 'all' rather than blocking the selection the way a
// missing zoneSource or agentKind does.
export function networkRender(draft: Draft, tables: Tables): LayerRender {
  if (!draft.active.network || !tables.network) return { kind: 'off' };
  if (!draft.networkSource) return { kind: 'neutral' };
  if (draft.networkSource === 'grade') return { kind: 'selected', selection: { mode: 'network', source: 'grade' } };

  const timeInterval = draft.timeInterval ?? 'all';
  const vehicle = draft.vehicle ?? 'all';
  const resource = draft.resource ?? 'all';

  if (draft.networkSource === 'loads') {
    return { kind: 'selected', selection: { mode: 'network', source: 'loads', timeInterval, vehicle, resource } };
  }
  const pollutant = draft.pollutant ?? 'all';
  const emissionSource = draft.emissionSource ?? 'all';
  return {
    kind: 'selected',
    selection: {
      mode: 'network', source: 'emissions', timeInterval, vehicle, resource, pollutant, emissionSource,
    },
  };
}
