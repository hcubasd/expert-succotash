import { describe, expect, it } from 'vitest';
import { classifyColumns } from '../src/lib/fileConfig';

describe('classifyColumns', () => {
  it('returns nothing for an empty table', () => {
    expect(classifyColumns('supply.csv', [])).toEqual({ strata: [], values: [] });
  });

  for (const base of ['supply_effects', 'demand_effects', 'capacity_effects', 'need_effects']) {
    it(`${base}.csv: stratum/stratum_value are strata, resource columns are values`, () => {
      const rows = [
        { stratum: 'zone_id', stratum_value: 1, grains: 0.5, parcels: null },
        { stratum: 'stratum_1', stratum_value: 'value_1', grains: -0.2, parcels: 0.1 },
      ];
      expect(classifyColumns(`${base}.csv`, rows)).toEqual({
        strata: ['stratum', 'stratum_value'],
        values: ['grains', 'parcels'],
      });
    });
  }

  for (const base of ['supply_thresholds', 'demand_thresholds', 'capacity_thresholds', 'need_thresholds']) {
    it(`${base}.csv: resource and resource_level are strata despite resource_level being numeric`, () => {
      const rows = [
        { resource: 'grains', resource_level: 0, threshold: -0.3 },
        { resource: 'grains', resource_level: 5, threshold: null },
      ];
      expect(classifyColumns(`${base}.csv`, rows)).toEqual({
        strata: ['resource', 'resource_level'],
        values: ['threshold'],
      });
    });
  }

  for (const base of ['supply', 'demand']) {
    it(`${base}.csv: zone_id is strata despite being numeric, other string dims are strata, resources are values`, () => {
      const rows = [
        { zone_id: 1, stratum_1: 'value_1', grains: 5, parcels: null },
        { zone_id: 2, stratum_1: 'value_2', grains: 3, parcels: 1 },
      ];
      expect(classifyColumns(`${base}.csv`, rows)).toEqual({
        strata: ['zone_id', 'stratum_1'],
        values: ['grains', 'parcels'],
      });
    });
  }

  for (const base of ['capacities', 'needs']) {
    it(`${base}.csv: everything but probability is strata, including numeric resource_level`, () => {
      const rows = [
        { zone_id: 1, resource: 'grains', resource_level: 0, probability: 0.4 },
        { zone_id: 1, resource: 'grains', resource_level: 5, probability: 0.6 },
      ];
      expect(classifyColumns(`${base}.csv`, rows)).toEqual({
        strata: ['zone_id', 'resource', 'resource_level'],
        values: ['probability'],
      });
    });
  }

  it('agents.gpkg: zone_id is strata, agent_id and resource capacity/need columns are values', () => {
    const rows = [
      { zone_id: 1, agent_id: 1, grains_capacity: 5, grains_need: 3 },
      { zone_id: 2, agent_id: 2, grains_capacity: 0, grains_need: 0 },
    ];
    expect(classifyColumns('agents.gpkg', rows)).toEqual({
      strata: ['zone_id'],
      values: ['agent_id', 'grains_capacity', 'grains_need'],
    });
  });

  it('zones.gpkg: zone_id is strata, no values', () => {
    const rows = [{ zone_id: 1 }, { zone_id: 2 }];
    expect(classifyColumns('zones.gpkg', rows)).toEqual({ strata: ['zone_id'], values: [] });
  });

  it('desire_lines.gpkg: resource and the two id columns are strata, quantity is the one value', () => {
    const rows = [
      { resource: 'parcels', quantity: 2, origin_agent_id: 1, destination_zone_id: 7 },
    ];
    expect(classifyColumns('desire_lines.gpkg', rows)).toEqual({
      strata: ['resource', 'origin_agent_id', 'destination_zone_id'],
      values: ['quantity'],
    });
  });

  it('network.gpkg: link_id, road_type, and oneway are strata, grade is the one value', () => {
    const rows = [{ link_id: 0, road_type: 'road_type_1', oneway: 0, grade: 1.2 }];
    expect(classifyColumns('network.gpkg', rows)).toEqual({
      strata: ['link_id', 'road_type', 'oneway'],
      values: ['grade'],
    });
  });

  it('network_loads.csv: link_id/time_interval/vehicle/forward are strata, the rest are values', () => {
    const rows = [
      { link_id: 0, time_interval: 'morning', vehicle: 'van', forward: true, vehicle_count: 1, velocity: 5.3, load_pct: 1.0 },
    ];
    expect(classifyColumns('network_loads.csv', rows)).toEqual({
      strata: ['link_id', 'time_interval', 'vehicle', 'forward'],
      values: ['vehicle_count', 'velocity', 'load_pct'],
    });
  });

  it('alternative_specific_constants.csv: vehicle/resource are strata, alternative_specific_constant is the value', () => {
    const rows = [{ vehicle: 'van', resource: 'parcels', alternative_specific_constant: -0.5 }];
    expect(classifyColumns('alternative_specific_constants.csv', rows)).toEqual({
      strata: ['vehicle', 'resource'],
      values: ['alternative_specific_constant'],
    });
  });

  it('emission_factors.csv: vehicle_type/pollutant are strata, emission_factor is the value', () => {
    const rows = [{ vehicle_type: 'vehicle_type_1', pollutant: 'pm10', emission_factor: 0.3 }];
    expect(classifyColumns('emission_factors.csv', rows)).toEqual({
      strata: ['vehicle_type', 'pollutant'],
      values: ['emission_factor'],
    });
  });

  it('network_emissions.csv: everything but grams is strata, including forward and source', () => {
    const rows = [
      { link_id: 0, time_interval: 'morning', vehicle: 'van', forward: true, pollutant: 'nox', source: 'exhaust', grams: 1.0 },
    ];
    expect(classifyColumns('network_emissions.csv', rows)).toEqual({
      strata: ['link_id', 'time_interval', 'vehicle', 'forward', 'pollutant', 'source'],
      values: ['grams'],
    });
  });
});
