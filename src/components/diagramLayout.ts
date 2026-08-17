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
  { id: 'vehicles', col: 3, order: 2 },
  { id: 'dwell_times', col: 3, order: 3 },
  { id: 'vehicle_velocities', col: 3, order: 4 },
  { id: 'vehicle_capacities', col: 3, order: 5 },
  { id: 'road_capacities', col: 3, order: 6 },
  { id: 'network', col: 3, order: 7 },
  { id: 'alternative_specific_constants', col: 3, order: 8 },
  { id: 'time_intervals', col: 3, order: 9 },
  { id: 'consolidation_radii', col: 3, order: 10 },
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
  { from: 'consolidation_radii', to: 'network_loads' },
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

// Each node's fixed slot in the 29-gon (0..28) used for its card color.
// Rotation of the whole n-gon changes which hue lands at slot 0, but never
// the circular distance between any two slots -- verified directly against
// miniature-waffle's own matchColors output, not assumed -- so this
// arrangement can be solved once, offline, independent of whatever rotation
// gets picked at runtime for hue variety between sessions.
//
// Solved by simulated annealing, minimizing the total closeness penalty
//   sum over pairs of w / d,   d = circular slot distance
// over two kinds of pair at once. 1/d blows up as a pair converges, so
// near-identical hues are what the search works hardest to avoid.
//
//   connected nodes    w = deg(u) + deg(v)
//   same-column nodes  w = 2 / k,  k = how many cards apart vertically
//
// So a card is pushed away from what it connects to *and* from what sits
// next to it, with the vertical pull decaying with distance -- opposite
// ends of a column may share a hue, immediate neighbours may not -- and
// capped below the weakest edge (min edge weight is 4) so wiring stays the
// dominant signal. Note the two goals genuinely fight: network_loads has 12
// neighbours and 10 of them are stacked in column 3, so pushing them off the
// hub crowds them onto each other. Column 3 is a compromise by necessity.
//
// Re-solved for 29 nodes (added consolidation_radii) after landing at 28.
// Best of 60 independent restarts converged to the same 44.9862 penalty
// twice at different step counts, which is good evidence it's the true
// optimum rather than a lucky local one -- the spread across restarts was
// small (44.99 to 45.40) but not perfectly identical every time the way the
// 28-node solve was, likely a difference in annealing schedule rather than
// a different underlying optimum. See conversation history for the solver
// -- not worth keeping in the repo, this table is the only artifact that
// matters at runtime.
export const POSITIONS: Record<TableName, number> = {
  supply_effects: 25,
  supply_thresholds: 3,
  demand_effects: 20,
  demand_thresholds: 12,
  capacity_effects: 0,
  capacity_thresholds: 23,
  need_effects: 8,
  need_thresholds: 17,
  supply: 18,
  demand: 27,
  zones: 21,
  capacities: 15,
  needs: 24,
  agents: 5,
  desire_lines: 14,
  departures: 7,
  vehicles: 1,
  dwell_times: 11,
  vehicle_velocities: 4,
  vehicle_capacities: 16,
  road_capacities: 9,
  network: 28,
  alternative_specific_constants: 6,
  time_intervals: 13,
  consolidation_radii: 2,
  copert_v_coefficients: 19,
  network_loads: 22,
  emission_factors: 26,
  network_emissions: 10,
};
