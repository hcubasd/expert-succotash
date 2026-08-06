// The pipeline is fixed: urban-dollop emits exactly these files, and this app
// only ever shows these. Nothing here is discovered at runtime.

export type TableName =
  | 'supply_effects' | 'supply_thresholds'
  | 'demand_effects' | 'demand_thresholds'
  | 'capacity_effects' | 'capacity_thresholds'
  | 'need_effects' | 'need_thresholds'
  | 'zones' | 'supply' | 'demand' | 'capacities' | 'needs'
  | 'agents' | 'desire_lines'
  | 'departures' | 'time_intervals' | 'dwell_times'
  | 'vehicle_velocities' | 'vehicle_capacities' | 'road_capacities'
  | 'alternative_specific_constants' | 'network' | 'vehicles'
  | 'network_loads' | 'copert_v_coefficients' | 'emission_factors'
  | 'network_emissions';

export const FILENAME: Record<TableName, string> = {
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
  desire_lines: 'desire_lines.gpkg',
  departures: 'departures.csv',
  time_intervals: 'time_intervals.csv',
  dwell_times: 'dwell_times.csv',
  vehicle_velocities: 'vehicle_velocities.csv',
  vehicle_capacities: 'vehicle_capacities.csv',
  road_capacities: 'road_capacities.csv',
  alternative_specific_constants: 'alternative_specific_constants.csv',
  network: 'network.gpkg',
  vehicles: 'vehicles.csv',
  network_loads: 'network_loads.csv',
  copert_v_coefficients: 'copert_v_coefficients.csv',
  emission_factors: 'emission_factors.csv',
  network_emissions: 'network_emissions.csv',
};

export const TABLE_NAMES = Object.keys(FILENAME) as TableName[];

// Strata vs values, per table.
//
// The rule, following urban-dollop's own design: anything --sigma sizes, and
// anything that keys a row (identifiers, categories, the axes of a cartesian
// product), is a stratum. Only the quantity actually sampled or computed for
// that key is a value. That's why numeric-but-keying columns -- zone_id,
// link_id, resource_level, gradient_bin -- are strata despite being numbers,
// and why booleans (oneway, forward) are too: they're 2-value categories.
//
// A few tables carry an open-ended set of resource columns whose names come
// from the data rather than the schema, so those cases classify by exclusion
// instead of by an explicit list.
export type Classification = { strata: string[]; values: string[] };

export function classifyColumns(table: TableName, headers: string[], isNumeric: (col: string) => boolean): Classification {
  const except = (...fixed: string[]) => ({
    strata: fixed.filter(h => headers.includes(h)),
    values: headers.filter(h => !fixed.includes(h)),
  });
  const only = (fixed: string[], valueCols: string[]) => ({
    strata: fixed.filter(h => headers.includes(h)),
    values: valueCols.filter(h => headers.includes(h)),
  });

  switch (table) {
    // Wide: stratum/stratum_value name a dimension, then one column per
    // resource. stratum_value mixes int zone_id rows with string rows for
    // every other dimension, so neither key column can be typed into place.
    case 'supply_effects':
    case 'demand_effects':
    case 'capacity_effects':
    case 'need_effects':
      return except('stratum', 'stratum_value');

    case 'supply_thresholds':
    case 'demand_thresholds':
    case 'capacity_thresholds':
    case 'need_thresholds':
      return only(['resource', 'resource_level'], ['threshold']);

    // Wide on stratum dimensions, then one rounded aggregate per resource.
    // zone_id keys rows despite being numeric; any other non-numeric column
    // is a dimension too, since the dimension names come from the data.
    case 'supply':
    case 'demand':
      return {
        strata: headers.filter(h => h === 'zone_id' || !isNumeric(h)),
        values: headers.filter(h => h !== 'zone_id' && isNumeric(h)),
      };

    // Wide on dimensions, long on resource: probability is the only real
    // value, everything else keys the row.
    case 'capacities':
    case 'needs':
      return {
        strata: headers.filter(h => h !== 'probability'),
        values: headers.filter(h => h === 'probability'),
      };

    case 'zones':
      return only(['zone_id'], []);

    // agent_id identifies, zone_id and the stratum dimensions key; the
    // {resource}_capacity / {resource}_need columns are the quantities.
    case 'agents':
      return {
        strata: headers.filter(h => h === 'agent_id' || h === 'zone_id' || !isNumeric(h)),
        values: headers.filter(h => h !== 'agent_id' && h !== 'zone_id' && isNumeric(h)),
      };

    // quantity is the transacted amount; the two id columns identify the
    // endpoints, so they key the row rather than measuring anything.
    case 'desire_lines':
      return only(['resource', 'origin_agent_id', 'destination_zone_id'], ['quantity']);

    case 'departures':
      return only(['resource', 'time_interval'], ['probability']);
    case 'time_intervals':
      return only(['time_interval'], ['duration']);
    case 'dwell_times':
      return only(['resource'], ['dwell_time', 'load_pct']);
    case 'vehicle_velocities':
      return only(['vehicle', 'road_type'], ['velocity']);
    case 'vehicle_capacities':
      return only(['vehicle', 'resource'], ['capacity']);
    case 'road_capacities':
      return only(['road_type'], ['capacity']);
    case 'alternative_specific_constants':
      return only(['vehicle', 'resource'], ['alternative_specific_constant']);

    // vehicle_type is a category the emission tables join on; the BPR and
    // choice-model parameters are all sampled quantities.
    case 'vehicles':
      return except('vehicle', 'vehicle_type');

    // oneway is a 2-value category; grade is the one physical measurement.
    case 'network':
      return only(['link_id', 'road_type', 'oneway'], ['grade']);

    // forward is which direction the traffic went -- a category, not a
    // magnitude.
    case 'network_loads':
      return only(
        ['link_id', 'time_interval', 'vehicle', 'forward'],
        ['vehicle_count', 'velocity', 'load_pct'],
      );

    // The gradient/payload bins are COPERT's own published grid: fixed
    // categories the coefficients are looked up by.
    case 'copert_v_coefficients':
      return except('vehicle_type', 'pollutant', 'gradient_bin', 'payload_bin');

    case 'emission_factors':
      return only(['vehicle_type', 'pollutant'], ['emission_factor']);

    // source (exhaust / non-exhaust) is a category, same status as forward.
    case 'network_emissions':
      return only(
        ['link_id', 'time_interval', 'vehicle', 'forward', 'pollutant', 'source'],
        ['grams'],
      );
  }
}
