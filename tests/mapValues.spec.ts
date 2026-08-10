import { describe, expect, it } from 'vitest';
import { loadCsv } from '../src/lib/csvLoader';
import {
  agentResources, featureValues, modeIsAvailable, toSelection, zoneResources,
} from '../src/lib/mapValues';
import type { Tables } from '../src/lib/mapValues';
import { makeTable } from '../src/lib/tableMaker';

const zones = makeTable('zones', loadCsv('zone_id\n1\n2\n3\n'));

const supply = makeTable('supply', loadCsv('zone_id,pallets,parcels\n1,11,27\n2,20,14\n'));

// Two zones, one resource, three levels each -- the shape needs.csv and
// capacities.csv really have.
const needs = makeTable(
  'needs',
  loadCsv(
    'zone_id,resource,resource_level,probability\n'
    + '1,pallets,0,0.5\n1,pallets,1,0.25\n1,pallets,2,0.25\n'
    + '2,pallets,0,0.0\n2,pallets,1,0.0\n2,pallets,2,1.0\n',
  ),
);

const agents = makeTable(
  'agents',
  loadCsv('zone_id,agent_id,pallets_capacity,pallets_need,parcels_need\n1,1,5,2,7\n1,2,3,,4\n'),
);

const network = makeTable('network', loadCsv('link_id,road_type,oneway,grade\n10,major,True,3\n11,minor,False,1\n'));

const loads = makeTable(
  'network_loads',
  loadCsv(
    'link_id,time_interval,vehicle,forward,vehicle_count,velocity,load_pct\n'
    + '10,morning,truck,True,4,1,0.5\n'
    + '10,morning,van,False,6,1,0.5\n'
    + '10,evening,truck,True,99,1,0.5\n'
    + '11,morning,truck,True,7,1,0.5\n',
  ),
);

const emissions = makeTable(
  'network_emissions',
  loadCsv(
    'link_id,time_interval,vehicle,forward,pollutant,source,grams\n'
    + '10,morning,truck,True,nox,exhaust,1.5\n'
    + '10,morning,van,True,nox,exhaust,2.5\n'
    + '10,morning,truck,True,nox,non-exhaust,100\n'
    + '10,morning,truck,True,pm10,exhaust,900\n'
    + '11,morning,truck,True,nox,exhaust,0.5\n',
  ),
);

const tables: Tables = { zones, supply, needs, agents, network, network_loads: loads, network_emissions: emissions };

describe('resource discovery', () => {
  it('reads supply resources off its value columns, since it is wide on them', () => {
    expect(zoneResources(tables, 'supply')).toEqual(['pallets', 'parcels']);
  });

  it('reads needs resources off the resource stratum, since it is long on them', () => {
    expect(zoneResources(tables, 'needs')).toEqual(['pallets']);
  });

  it('strips the suffix off agent columns, and keeps need and capacity apart', () => {
    expect(agentResources(tables, 'capacity')).toEqual(['pallets']);
    expect(agentResources(tables, 'need')).toEqual(['pallets', 'parcels']);
  });
});

describe('featureValues', () => {
  it('joins supply onto zones by zone_id, leaving unmatched zones without a value', () => {
    const values = featureValues(tables, { mode: 'zones', source: 'supply', resource: 'pallets' })!;
    expect(values[0]).toBe(11);
    expect(values[1]).toBe(20);
    // zone 3 has no supply row at all
    expect(Number.isNaN(values[2])).toBe(true);
  });

  it('computes needs as a real expected value, level weighted by probability', () => {
    const values = featureValues(tables, { mode: 'zones', source: 'needs', resource: 'pallets' })!;
    // 0*0.5 + 1*0.25 + 2*0.25
    expect(values[0]).toBeCloseTo(0.75, 10);
    // all mass on level 2
    expect(values[1]).toBeCloseTo(2, 10);
  });

  it('reads an agent value straight off its own row, and marks a blank absent', () => {
    const capacity = featureValues(tables, { mode: 'agents', kind: 'capacity', resource: 'pallets' })!;
    expect(Array.from(capacity)).toEqual([5, 3]);

    // The second agent has no pallets_need at all -- absent, which is not
    // the same as a need of zero, and is why it comes back NaN to be skipped
    // rather than drawn at the bottom of the ramp.
    const need = featureValues(tables, { mode: 'agents', kind: 'need', resource: 'pallets' })!;
    expect(need[0]).toBe(2);
    expect(Number.isNaN(need[1])).toBe(true);
  });

  it('sums vehicle counts per link within one interval, across vehicles and directions', () => {
    const values = featureValues(tables, { mode: 'network', source: 'loads', timeInterval: 'morning' })!;
    expect(values[0]).toBe(10); // 4 + 6, evening's 99 excluded
    expect(values[1]).toBe(7);
  });

  it('sums emitted grams for one pollutant and source only', () => {
    const values = featureValues(tables, {
      mode: 'network', source: 'emissions', timeInterval: 'morning', pollutant: 'nox', emissionSource: 'exhaust',
    })!;
    // 1.5 + 2.5; the non-exhaust 100 and the pm10 900 are both excluded
    expect(values[0]).toBeCloseTo(4, 10);
    expect(values[1]).toBeCloseTo(0.5, 10);
  });

  it('reads grade straight off the network table', () => {
    const values = featureValues(tables, { mode: 'network', source: 'grade' })!;
    expect(Array.from(values)).toEqual([3, 1]);
  });

  it('has nothing to compute for desire lines -- those are accumulated per pixel', () => {
    expect(featureValues(tables, { mode: 'desire_lines', resource: 'pallets' })).toBeNull();
  });
});

describe('toSelection', () => {
  it('stays null until every step of a mode is answered', () => {
    expect(toSelection({ mode: 'zones' })).toBeNull();
    expect(toSelection({ mode: 'zones', zoneSource: 'supply' })).toBeNull();
    expect(toSelection({ mode: 'zones', zoneSource: 'supply', resource: 'pallets' })).not.toBeNull();
  });

  it('takes grade with no further questions, but emissions with three', () => {
    expect(toSelection({ mode: 'network', networkSource: 'grade' })).not.toBeNull();
    expect(toSelection({ mode: 'network', networkSource: 'emissions', timeInterval: 'morning' })).toBeNull();
    expect(toSelection({
      mode: 'network',
      networkSource: 'emissions',
      timeInterval: 'morning',
      pollutant: 'nox',
      emissionSource: 'exhaust',
    })).not.toBeNull();
  });
});

describe('modeIsAvailable', () => {
  it('follows the file the mode is actually drawn from', () => {
    expect(modeIsAvailable(tables, 'zones')).toBe(true);
    expect(modeIsAvailable(tables, 'desire_lines')).toBe(false);
    expect(modeIsAvailable({}, 'network')).toBe(false);
  });
});
