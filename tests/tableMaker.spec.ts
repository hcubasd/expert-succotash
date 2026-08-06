import { describe, expect, it } from 'vitest';
import { loadCsv } from '../src/lib/csvLoader';
import { makeTable, stratumText, valueText } from '../src/lib/tableMaker';

const table = (name: Parameters<typeof makeTable>[0], csv: string) => makeTable(name, loadCsv(csv));

describe('makeTable', () => {
  it('splits strata from values by the table schema, not by dtype', () => {
    const t = table('network', 'link_id,grade,road_type,oneway\n0,1.5,road_type_1,True\n');
    expect(t.strata.map(c => c.name)).toEqual(['link_id', 'road_type', 'oneway']);
    expect(t.values.map(c => c.name)).toEqual(['grade']);
  });

  it('dictionary-encodes strata in first-seen order', () => {
    const t = table(
      'vehicle_velocities',
      'vehicle,road_type,velocity\nvan,b,1\ntruck,a,2\nvan,a,3\n',
    );
    const vehicle = t.strata.find(c => c.name === 'vehicle')!;
    expect(vehicle.dictionary).toEqual(['van', 'truck']);
    expect(Array.from(vehicle.codes)).toEqual([0, 1, 0]);
  });

  it('reads a stratum cell back through its dictionary', () => {
    const t = table('road_capacities', 'road_type,capacity\nmajor,10\nminor,5\n');
    const column = t.strata[0];
    expect(stratumText(column, 0)).toBe('major');
    expect(stratumText(column, 1)).toBe('minor');
  });

  it('tracks a value column range and marks absent cells as not present', () => {
    const t = table('road_capacities', 'road_type,capacity\na,10\nb,\nc,4\n');
    const capacity = t.values[0];
    expect(capacity.min).toBe(4);
    expect(capacity.max).toBe(10);
    expect(capacity.present[1]).toBe(0);
    // absent is not zero -- it prints as nothing at all
    expect(valueText(capacity, 1)).toBe('');
    expect(valueText(capacity, 0)).toBe('10');
  });

  it('falls back to a usable range when a value column is entirely empty', () => {
    const t = table('road_capacities', 'road_type,capacity\na,\nb,\n');
    const capacity = t.values[0];
    expect(capacity.min).toBe(0);
    expect(capacity.max).toBe(1);
  });

  it('keeps identifiers as strata even though they are numeric', () => {
    const t = table(
      'desire_lines',
      'resource,quantity,origin_agent_id,destination_zone_id\nparcels,2,1,7\n',
    );
    expect(t.strata.map(c => c.name)).toEqual(['resource', 'origin_agent_id', 'destination_zone_id']);
    expect(t.values.map(c => c.name)).toEqual(['quantity']);
  });

  it('treats every distinct value of a boolean column as its own stratum value', () => {
    const t = table(
      'network_loads',
      'link_id,time_interval,vehicle,forward,vehicle_count,velocity,load_pct\n'
      + '0,day,van,True,1,5,1\n0,day,van,False,1,5,1\n',
    );
    const forward = t.strata.find(c => c.name === 'forward')!;
    expect(forward.dictionary).toEqual(['True', 'False']);
  });

  it('classifies the open-ended resource columns of an effects file by exclusion', () => {
    const t = table('supply_effects', 'stratum,stratum_value,grains,parcels\nzone_id,1,0.5,\n');
    expect(t.strata.map(c => c.name)).toEqual(['stratum', 'stratum_value']);
    expect(t.values.map(c => c.name)).toEqual(['grains', 'parcels']);
  });
});
