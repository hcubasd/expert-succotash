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
});
