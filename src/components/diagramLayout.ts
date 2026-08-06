import type { TableName } from '../lib/schema';

// The pipeline DAG, right-aligned by max depth from the sink. Fixed: these
// nodes and edges are urban-dollop's pipeline, and it doesn't change at
// runtime, so this is data rather than anything computed.
export type DiagramNode = { id: TableName; col: number; order: number };

export const NODES: DiagramNode[] = [
  // col 0 -- the eight effects/thresholds leaves
  { id: 'supply_effects', col: 0, order: 0 },
  { id: 'supply_thresholds', col: 0, order: 1 },
  { id: 'demand_effects', col: 0, order: 2 },
  { id: 'demand_thresholds', col: 0, order: 3 },
  { id: 'capacity_effects', col: 0, order: 4 },
  { id: 'capacity_thresholds', col: 0, order: 5 },
  { id: 'need_effects', col: 0, order: 6 },
  { id: 'need_thresholds', col: 0, order: 7 },
  // col 1 -- zones centered among the four combiner outputs
  { id: 'supply', col: 1, order: 0 },
  { id: 'demand', col: 1, order: 1 },
  { id: 'zones', col: 1, order: 2 },
  { id: 'capacities', col: 1, order: 3 },
  { id: 'needs', col: 1, order: 4 },
  // col 2
  { id: 'agents', col: 2, order: 0 },
  // col 3 -- the tallest column, which sets the card height everywhere
  { id: 'desire_lines', col: 3, order: 0 },
  { id: 'departures', col: 3, order: 1 },
  { id: 'time_intervals', col: 3, order: 2 },
  { id: 'dwell_times', col: 3, order: 3 },
  { id: 'vehicle_velocities', col: 3, order: 4 },
  { id: 'vehicle_capacities', col: 3, order: 5 },
  { id: 'road_capacities', col: 3, order: 6 },
  { id: 'alternative_specific_constants', col: 3, order: 7 },
  { id: 'network', col: 3, order: 8 },
  { id: 'vehicles', col: 3, order: 9 },
  // col 4 -- network_loads centered, it carries the most edges
  { id: 'copert_v_coefficients', col: 4, order: 0 },
  { id: 'network_loads', col: 4, order: 1 },
  { id: 'emission_factors', col: 4, order: 2 },
  // col 5
  { id: 'network_emissions', col: 5, order: 0 },
];

export const EDGES: { from: TableName; to: TableName }[] = [
  { from: 'supply_effects', to: 'supply' },
  { from: 'supply_thresholds', to: 'supply' },
  { from: 'demand_effects', to: 'demand' },
  { from: 'demand_thresholds', to: 'demand' },
  { from: 'capacity_effects', to: 'capacities' },
  { from: 'capacity_thresholds', to: 'capacities' },
  { from: 'need_effects', to: 'needs' },
  { from: 'need_thresholds', to: 'needs' },
  { from: 'zones', to: 'agents' },
  { from: 'supply', to: 'agents' },
  { from: 'demand', to: 'agents' },
  { from: 'capacities', to: 'agents' },
  { from: 'needs', to: 'agents' },
  { from: 'agents', to: 'desire_lines' },
  { from: 'desire_lines', to: 'network_loads' },
  { from: 'departures', to: 'network_loads' },
  { from: 'time_intervals', to: 'network_loads' },
  { from: 'dwell_times', to: 'network_loads' },
  { from: 'vehicle_velocities', to: 'network_loads' },
  { from: 'vehicle_capacities', to: 'network_loads' },
  { from: 'road_capacities', to: 'network_loads' },
  { from: 'alternative_specific_constants', to: 'network_loads' },
  { from: 'network', to: 'network_loads' },
  { from: 'vehicles', to: 'network_loads' },
  { from: 'network_loads', to: 'network_emissions' },
  { from: 'network', to: 'network_emissions' },
  { from: 'vehicles', to: 'network_emissions' },
  { from: 'copert_v_coefficients', to: 'network_emissions' },
  { from: 'emission_factors', to: 'network_emissions' },
];

// Card labels are the command names, spelled out in full.
export function labelOf(id: TableName): string {
  return id.replace(/_/g, '-');
}
