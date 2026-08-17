import { describe, expect, it } from 'vitest';
import { loadCsv } from '../src/lib/csvLoader';
import {
  agentRender, agentResources, desireLineRender, featureValues, modeIsAvailable,
  networkRender, networkResources, networkVehicles, zoneRender, zoneResources,
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
    'link_id,time_interval,vehicle,resource,forward,vehicle_count,velocity,load_pct\n'
    + '10,morning,truck,pallets,True,4,1,0.5\n'
    + '10,morning,truck,pallets,False,6,1,0.5\n'
    + '10,morning,van,pallets,False,3,1,0.5\n'
    + '10,evening,truck,pallets,True,99,1,0.5\n'
    + '11,morning,truck,pallets,True,7,1,0.5\n',
  ),
);

const emissions = makeTable(
  'network_emissions',
  loadCsv(
    'link_id,time_interval,vehicle,resource,forward,pollutant,source,grams\n'
    + '10,morning,truck,pallets,True,nox,exhaust,1.5\n'
    + '10,morning,truck,pallets,False,nox,exhaust,2.5\n'
    + '10,morning,van,pallets,True,nox,exhaust,50\n'
    + '10,morning,truck,pallets,True,nox,non-exhaust,100\n'
    + '10,morning,truck,pallets,True,pm10,exhaust,900\n'
    + '11,morning,truck,pallets,True,nox,exhaust,0.5\n',
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

  it('reads network resources and vehicles off whichever of loads or emissions is asked for', () => {
    expect(networkResources(tables, 'loads')).toEqual(['pallets']);
    expect(networkVehicles(tables, 'loads')).toEqual(['truck', 'van']);
    expect(networkResources(tables, 'emissions')).toEqual(['pallets']);
    expect(networkVehicles(tables, 'emissions')).toEqual(['truck', 'van']);
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

  it('sums vehicle counts per link within one interval, resource and vehicle, across directions', () => {
    const values = featureValues(tables, {
      mode: 'network', source: 'loads', timeInterval: 'morning', vehicle: 'truck', resource: 'pallets',
    })!;
    expect(values[0]).toBe(10); // 4 + 6, both directions of truck; van's 3 and evening's 99 excluded
    expect(values[1]).toBe(7);
  });

  it('sums emitted grams for one pollutant and source only, across directions', () => {
    const values = featureValues(tables, {
      mode: 'network', source: 'emissions', timeInterval: 'morning', vehicle: 'truck', resource: 'pallets',
      pollutant: 'nox', emissionSource: 'exhaust',
    })!;
    // 1.5 + 2.5; van's 50, the non-exhaust 100, and the pm10 900 are all excluded
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

describe('layer render resolvers', () => {
  const active = { zones: true, agents: true, network: true, desire_lines: true };
  const off = { zones: false, agents: false, network: false, desire_lines: false };

  it('zoneRender: off without the toggle or the table, neutral without a complete pick, selected with one', () => {
    expect(zoneRender({ active: off }, tables).kind).toBe('off');
    expect(zoneRender({ active }, {}).kind).toBe('off'); // no zones table at all

    expect(zoneRender({ active }, tables).kind).toBe('neutral'); // nothing picked yet
    expect(zoneRender({ active, resource: 'all', zoneSource: 'supply' }, tables).kind).toBe('neutral');
    expect(zoneRender({ active, resource: 'pallets' }, tables).kind).toBe('neutral'); // no zoneSource yet

    const selected = zoneRender({ active, resource: 'pallets', zoneSource: 'supply' }, tables);
    expect(selected).toEqual({
      kind: 'selected', selection: { mode: 'zones', source: 'supply', resource: 'pallets' },
    });
  });

  it('agentRender: same shape as zones -- kind stands in for source', () => {
    expect(agentRender({ active }, tables).kind).toBe('neutral');
    const selected = agentRender({ active, resource: 'pallets', agentKind: 'need' }, tables);
    expect(selected).toEqual({
      kind: 'selected', selection: { mode: 'agents', kind: 'need', resource: 'pallets' },
    });
  });

  it('desireLineRender: off with no table loaded, since this fixture has none', () => {
    expect(desireLineRender({ active, resource: 'pallets' }, tables).kind).toBe('off');
  });

  it('networkRender: neutral only until a source is picked -- after that it never goes back', () => {
    expect(networkRender({ active }, tables).kind).toBe('neutral'); // no source at all
    expect(networkRender({ active, networkSource: 'grade' }, tables))
      .toEqual({ kind: 'selected', selection: { mode: 'network', source: 'grade' } });
  });

  it("networkRender: missing dimensions default to 'all' rather than blocking the selection", () => {
    // Unlike zones/agents, picking a source is enough on its own -- every
    // other dimension defaults to the aggregate rather than staying neutral.
    const bareLoads = networkRender({ active, networkSource: 'loads' }, tables);
    expect(bareLoads).toEqual({
      kind: 'selected',
      selection: { mode: 'network', source: 'loads', timeInterval: 'all', vehicle: 'all', resource: 'all' },
    });

    const pinnedLoads = networkRender(
      { active, networkSource: 'loads', timeInterval: 'morning', vehicle: 'truck', resource: 'pallets' }, tables,
    );
    expect(pinnedLoads).toEqual({
      kind: 'selected',
      selection: { mode: 'network', source: 'loads', timeInterval: 'morning', vehicle: 'truck', resource: 'pallets' },
    });

    const bareEmissions = networkRender({ active, networkSource: 'emissions' }, tables);
    expect(bareEmissions).toEqual({
      kind: 'selected',
      selection: {
        mode: 'network', source: 'emissions',
        timeInterval: 'all', vehicle: 'all', resource: 'all', pollutant: 'all', emissionSource: 'all',
      },
    });
  });
});

describe('modeIsAvailable', () => {
  it('follows the file the mode is actually drawn from', () => {
    expect(modeIsAvailable(tables, 'zones')).toBe(true);
    expect(modeIsAvailable(tables, 'desire_lines')).toBe(false);
    expect(modeIsAvailable({}, 'network')).toBe(false);
  });
});
