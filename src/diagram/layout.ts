export type DiagramNode = {
  id: string;
  label: string;
  col: number;    // 0 = leftmost (sources), 5 = rightmost (sink)
  order: number;  // top-to-bottom position within column
};

export type DiagramEdge = { from: string; to: string };

// Right-aligned column assignment (max-depth-from-sink):
//   col 0: supply_thresholds, supply_slopes, demand_thresholds, demand_slopes
//   col 1: batch_sizes, supply, demand, zones
//   col 2: agents
//   col 3: desire_lines … vehicles  (10 nodes — tallest column)
//   col 4: network_loads, copert_v_coefficients, emission_factors
//   col 5: network_emissions

export const NODES: DiagramNode[] = [
  // col 0
  { id: 'supply_thresholds',              label: 'supply-thresholds',         col: 0, order: 0 },
  { id: 'supply_slopes',                  label: 'supply-slopes',             col: 0, order: 1 },
  { id: 'demand_thresholds',              label: 'demand-thresholds',         col: 0, order: 2 },
  { id: 'demand_slopes',                  label: 'demand-slopes',             col: 0, order: 3 },
  // col 1
  { id: 'batch_sizes',                    label: 'batch-sizes',               col: 1, order: 0 },
  { id: 'supply',                         label: 'supply',                    col: 1, order: 1 },
  { id: 'demand',                         label: 'demand',                    col: 1, order: 2 },
  { id: 'zones',                          label: 'zones',                     col: 1, order: 3 },
  // col 2
  { id: 'agents',                         label: 'agents',                    col: 2, order: 0 },
  // col 3 — tallest column; defines slot height for all columns
  { id: 'desire_lines',                   label: 'desire-lines',              col: 3, order: 0 },
  { id: 'departures',                     label: 'departures',                col: 3, order: 1 },
  { id: 'time_intervals',                 label: 'time-intervals',            col: 3, order: 2 },
  { id: 'dwell_times',                    label: 'dwell-times',               col: 3, order: 3 },
  { id: 'vehicle_velocities',             label: 'vehicle-velocities',        col: 3, order: 4 },
  { id: 'vehicle_capacities',             label: 'vehicle-capacities',        col: 3, order: 5 },
  { id: 'road_capacities',               label: 'road-capacities',           col: 3, order: 6 },
  { id: 'alternative_specific_constants', label: 'alt-specific-consts',       col: 3, order: 7 },
  { id: 'network',                        label: 'network',                   col: 3, order: 8 },
  { id: 'vehicles',                       label: 'vehicles',                  col: 3, order: 9 },
  // col 4
  { id: 'network_loads',                  label: 'network-loads',             col: 4, order: 0 },
  { id: 'copert_v_coefficients',          label: 'copert-v-coefficients',     col: 4, order: 1 },
  { id: 'emission_factors',              label: 'emission-factors',           col: 4, order: 2 },
  // col 5
  { id: 'network_emissions',              label: 'network-emissions',         col: 5, order: 0 },
];

export const EDGES: DiagramEdge[] = [
  { from: 'supply_thresholds',              to: 'supply' },
  { from: 'supply_slopes',                  to: 'supply' },
  { from: 'demand_thresholds',              to: 'demand' },
  { from: 'demand_slopes',                  to: 'demand' },
  { from: 'supply',                         to: 'agents' },
  { from: 'demand',                         to: 'agents' },
  { from: 'batch_sizes',                    to: 'agents' },
  { from: 'zones',                          to: 'agents' },
  { from: 'agents',                         to: 'desire_lines' },
  { from: 'batch_sizes',                    to: 'desire_lines' },
  { from: 'desire_lines',                   to: 'network_loads' },
  { from: 'departures',                     to: 'network_loads' },
  { from: 'time_intervals',                 to: 'network_loads' },
  { from: 'dwell_times',                    to: 'network_loads' },
  { from: 'vehicle_velocities',             to: 'network_loads' },
  { from: 'vehicle_capacities',             to: 'network_loads' },
  { from: 'road_capacities',               to: 'network_loads' },
  { from: 'alternative_specific_constants', to: 'network_loads' },
  { from: 'network',                        to: 'network_loads' },
  { from: 'vehicles',                       to: 'network_loads' },
  { from: 'network_loads',                  to: 'network_emissions' },
  { from: 'network',                        to: 'network_emissions' },
  { from: 'vehicles',                       to: 'network_emissions' },
  { from: 'copert_v_coefficients',          to: 'network_emissions' },
  { from: 'emission_factors',              to: 'network_emissions' },
];
