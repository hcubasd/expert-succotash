import { parseCsv } from './csv';
import { readGpkg } from './gpkg';
import type { ParsedGeometry } from './gpkg';

// A loaded table holds data and view state only. Colour lives in the app-wide
// Selection (see lib/selection.ts) because only one column anywhere is ever lit.
// `hiddenCols` hides from view, never from memory — rows are untouched.
export type LoadedFile = {
  filename: string;
  rows: Record<string, unknown>[];
  geometries: ParsedGeometry[] | null;
  strata: string[];
  values: string[];
  colOrder: string[];
  hiddenCols: Set<string>;
};

export const NODE_TO_FILE: Record<string, string> = {
  supply_thresholds: 'supply_thresholds.csv',
  supply_slopes: 'supply_slopes.csv',
  demand_thresholds: 'demand_thresholds.csv',
  demand_slopes: 'demand_slopes.csv',
  batch_sizes: 'batch_sizes.csv',
  zones: 'zones.gpkg',
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
  supply: 'supply.csv',
  demand: 'demand.csv',
  agents: 'agents.gpkg',
  desire_lines: 'desire_lines.gpkg',
  network_loads: 'network_loads.csv',
  network_emissions: 'network_emissions.csv',
};

export const FILE_TO_NODE: Record<string, string> = Object.fromEntries(
  Object.entries(NODE_TO_FILE).map(([k, v]) => [v, k])
);

function classifyColumns(
  filename: string,
  rows: Record<string, unknown>[],
): { strata: string[]; values: string[] } {
  if (rows.length === 0) return { strata: [], values: [] };
  const headers = Object.keys(rows[0]);
  const isNumeric = (col: string) => rows.every(r => r[col] === null || typeof r[col] === 'number');
  const base = filename.replace(/\.(csv|gpkg)$/, '');

  switch (base) {
    case 'supply':
    case 'demand':
    case 'agents':
      return { strata: headers.filter(h => !isNumeric(h)), values: headers.filter(h => isNumeric(h)) };
    case 'supply_thresholds':
    case 'demand_thresholds':
      return { strata: headers.filter(h => h === 'resource' || h === 'resource_level'), values: ['threshold'] };
    case 'supply_slopes':
    case 'demand_slopes':
      return { strata: headers.filter(h => h !== 'slope'), values: ['slope'] };
    case 'batch_sizes':
      return { strata: ['resource', 'batch_size'], values: ['probability'] };
    case 'desire_lines':
      return { strata: [], values: headers.filter(h => isNumeric(h)) };
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
      return { strata: ['vehicle', 'resource'], values: ['alpha'] };
    case 'zones':
      return { strata: ['zone_id'], values: [] };
    case 'network':
      return { strata: ['road_type', 'direction'], values: headers.filter(h => !['road_type', 'direction'].includes(h) && isNumeric(h)) };
    case 'network_loads':
      return { strata: ['link_id', 'time_interval', 'vehicle'], values: ['count', 'velocity', 'load_pct'] };
    case 'copert_v_coefficients':
      return { strata: ['vehicle_type', 'pollutant', 'gradient_bin', 'payload_bin'], values: headers.filter(h => !['vehicle_type', 'pollutant', 'gradient_bin', 'payload_bin'].includes(h)) };
    case 'emission_factors':
      return { strata: ['vehicle_type', 'pollutant'], values: ['ef'] };
    case 'network_emissions':
      return { strata: ['link_id', 'time_interval', 'vehicle', 'pollutant'], values: ['grams'] };
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
  };
}
