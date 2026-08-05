import { parseCsv } from './csv';
import { readGpkg } from './gpkg';
import type { ParsedGeometry } from './gpkg';
import { randomRotation, uniqueOrdered } from './colors';

// The inputs to a column's palette, decided once when the file loads and
// held for its lifetime -- not the realized colors themselves (nothing here
// stores a Map<value, RgbColor> or a color array; those are cheap to
// recompute on demand from rows + recipe, and storing them would mean
// keeping every table's full palette in memory whether or not it's ever
// looked at). A stratum's `n` is its distinct-value count at load time;
// re-selecting the same column later always reproduces the same colors,
// rather than reshuffling on every click.
export type ColorRecipe =
  | { kind: 'stratum'; n: number; rotation: number }
  | { kind: 'value'; rotation: number };

// A loaded table holds data and view state only. Which column is lit lives in
// the app-wide Selection (see lib/selection.ts), since only one column
// anywhere is ever lit; the palette recipe for painting it lives here, on the
// file, so it's available to any view holding the file -- the map included,
// even before anything there reads it.
// `hiddenCols` hides from view, never from memory — rows are untouched.
export type LoadedFile = {
  filename: string;
  rows: Record<string, unknown>[];
  geometries: ParsedGeometry[] | null;
  strata: string[];
  values: string[];
  colOrder: string[];
  hiddenCols: Set<string>;
  colorRecipes: Map<string, ColorRecipe>;
};

function buildColorRecipes(
  rows: Record<string, unknown>[],
  strata: string[],
  values: string[],
): Map<string, ColorRecipe> {
  const recipes = new Map<string, ColorRecipe>();
  for (const col of strata) {
    const n = uniqueOrdered(rows.map(r => String(r[col] ?? ''))).length;
    recipes.set(col, { kind: 'stratum', n, rotation: randomRotation() });
  }
  for (const col of values) {
    recipes.set(col, { kind: 'value', rotation: randomRotation() });
  }
  return recipes;
}

export const NODE_TO_FILE: Record<string, string> = {
  supply_effects: 'supply_effects.csv',
  supply_thresholds: 'supply_thresholds.csv',
  demand_effects: 'demand_effects.csv',
  demand_thresholds: 'demand_thresholds.csv',
  capacity_effects: 'capacity_effects.csv',
  capacity_thresholds: 'capacity_thresholds.csv',
  need_effects: 'need_effects.csv',
  need_thresholds: 'need_thresholds.csv',
  zones: 'zones.gpkg',
  supply: 'supply.csv',
  demand: 'demand.csv',
  capacities: 'capacities.csv',
  needs: 'needs.csv',
  agents: 'agents.gpkg',
  departures: 'departures.csv',
  time_intervals: 'time_intervals.csv',
  dwell_times: 'dwell_times.csv',
  vehicle_velocities: 'vehicle_velocities.csv',
  vehicle_capacities: 'vehicle_capacities.csv',
  road_capacities: 'road_capacities.csv',
  alternative_specific_constants: 'alternative_specific_constants.csv',
  vehicles: 'vehicles.csv',
  network: 'network.gpkg',
  copert_v_coefficients: 'copert_v_coefficients.csv',
  emission_factors: 'emission_factors.csv',
  desire_lines: 'desire_lines.gpkg',
  network_loads: 'network_loads.csv',
  network_emissions: 'network_emissions.csv',
};

export const FILE_TO_NODE: Record<string, string> = Object.fromEntries(
  Object.entries(NODE_TO_FILE).map(([k, v]) => [v, k])
);

export function classifyColumns(
  filename: string,
  rows: Record<string, unknown>[],
): { strata: string[]; values: string[] } {
  if (rows.length === 0) return { strata: [], values: [] };
  const headers = Object.keys(rows[0]);
  const isNumeric = (col: string) => rows.every(r => r[col] === null || typeof r[col] === 'number');
  const base = filename.replace(/\.(csv|gpkg)$/, '');

  switch (base) {
    // Wide: stratum/stratum_value name-value pairs, then one column per
    // resource. Both stratum columns are always strata regardless of dtype
    // (stratum_value mixes int zone_id rows with string rows for every other
    // dimension); everything else is a resource, always numeric.
    case 'supply_effects':
    case 'demand_effects':
    case 'capacity_effects':
    case 'need_effects':
      return {
        strata: headers.filter(h => h === 'stratum' || h === 'stratum_value'),
        values: headers.filter(h => h !== 'stratum' && h !== 'stratum_value'),
      };
    // resource_level is numeric but plays stratum_value's shape-defining role
    // (see urban-dollop's README), so it's strata like resource, not a value.
    case 'supply_thresholds':
    case 'demand_thresholds':
    case 'capacity_thresholds':
    case 'need_thresholds':
      return { strata: headers.filter(h => h === 'resource' || h === 'resource_level'), values: ['threshold'] };
    // Wide on stratum dimensions, then one column per resource (always int,
    // rounded expected value). zone_id is always strata even though it's
    // numeric; any other all-string column is a dimension too.
    case 'supply':
    case 'demand':
      return {
        strata: headers.filter(h => h === 'zone_id' || !isNumeric(h)),
        values: headers.filter(h => h !== 'zone_id' && isNumeric(h)),
      };
    // Wide on dimensions, long on resource: resource/resource_level are
    // shape-defining like above, probability is the only real value column.
    case 'capacities':
    case 'needs':
      return { strata: headers.filter(h => h !== 'probability'), values: ['probability'] };
    // agent_id, zone_id + dimensions, {resource}_capacity/{resource}_need.
    case 'agents':
      return {
        strata: headers.filter(h => h === 'zone_id' || !isNumeric(h)),
        values: headers.filter(h => h !== 'zone_id' && isNumeric(h)),
      };
    // resource is a category; quantity is the one measured continuum.
    // origin_agent_id/destination_zone_id are identifiers, not quantities --
    // an id's magnitude carries no meaning, so both are strata like every
    // other identifier column in this app (link_id, zone_id, resource_level),
    // regardless of what any other file happens to do with a similarly-named
    // column.
    case 'desire_lines':
      return {
        strata: ['resource', 'origin_agent_id', 'destination_zone_id'],
        values: ['quantity'],
      };
    case 'departures':
      return { strata: ['resource', 'time_interval'], values: ['probability'] };
    case 'time_intervals':
      return { strata: ['time_interval'], values: ['duration'] };
    case 'dwell_times':
      return { strata: ['resource'], values: ['dwell_time', 'load_pct'] };
    case 'vehicles':
      return { strata: ['vehicle', 'vehicle_type'], values: headers.filter(h => h !== 'vehicle' && h !== 'vehicle_type') };
    case 'vehicle_velocities':
      return { strata: ['vehicle', 'road_type'], values: ['velocity'] };
    case 'vehicle_capacities':
      return { strata: ['vehicle', 'resource'], values: ['capacity'] };
    case 'road_capacities':
      return { strata: ['road_type'], values: ['capacity'] };
    case 'alternative_specific_constants':
      return { strata: ['vehicle', 'resource'], values: ['alternative_specific_constant'] };
    case 'zones':
      return { strata: ['zone_id'], values: [] };
    // link_id is an identifier, not a measurement, so it's strata like every
    // other id column -- oneway is a 2-value category (boolean); grade is
    // the one real physical measurement here.
    case 'network':
      return { strata: ['link_id', 'road_type', 'oneway'], values: ['grade'] };
    // forward is a 2-value category (which direction); vehicle_count,
    // velocity, and load_pct are all genuine measured quantities.
    case 'network_loads':
      return { strata: ['link_id', 'time_interval', 'vehicle', 'forward'], values: ['vehicle_count', 'velocity', 'load_pct'] };
    case 'copert_v_coefficients':
      return { strata: ['vehicle_type', 'pollutant', 'gradient_bin', 'payload_bin'], values: headers.filter(h => !['vehicle_type', 'pollutant', 'gradient_bin', 'payload_bin'].includes(h)) };
    case 'emission_factors':
      return { strata: ['vehicle_type', 'pollutant'], values: ['emission_factor'] };
    // source (exhaust/non-exhaust) is a 2-value category, same status as
    // forward -- grams is the one measured quantity.
    case 'network_emissions':
      return { strata: ['link_id', 'time_interval', 'vehicle', 'forward', 'pollutant', 'source'], values: ['grams'] };
    default:
      return { strata: headers.filter(h => !isNumeric(h)), values: headers.filter(h => isNumeric(h)) };
  }
}

export async function parseFile(file: File): Promise<LoadedFile> {
  const filename = file.name;
  let rows: Record<string, unknown>[] = [];
  let geometries: ParsedGeometry[] | null = null;

  if (filename.endsWith('.gpkg')) {
    const buf = await file.arrayBuffer();
    const tables = await readGpkg(buf);
    const layer = tables[0];
    if (layer) {
      rows = layer.rows;
      geometries = layer.geometries;
    }
  } else if (filename.endsWith('.csv')) {
    const text = await file.text();
    rows = parseCsv(text);
  }

  const { strata, values } = classifyColumns(filename, rows);
  const colOrder = [...strata, ...values];

  return {
    filename,
    rows,
    geometries,
    strata,
    values,
    colOrder,
    hiddenCols: new Set(),
    colorRecipes: buildColorRecipes(rows, strata, values),
  };
}
