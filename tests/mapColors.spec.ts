import { afterEach, describe, expect, it } from 'vitest';
import { loadCsv } from '../src/lib/csvLoader';
import { ZERO_ORIGIN, makePoints, makeSegments } from '../src/lib/geometryMaker';
import type { Geometries } from '../src/lib/geometryMaker';
import { MAP_DRIVERS, activeLineLayer, applyMapColors, desireLinesAreColored, targetOf } from '../src/lib/mapColors';
import type { RawGeometry } from '../src/lib/rawTable';
import { makeTable } from '../src/lib/tableMaker';

const INK = { r: 255, g: 255, b: 255 };
const PAPER = { r: 0, g: 0, b: 0 };

const line = (coords: [number, number][]): RawGeometry => ({ type: 'LineString', coordinates: coords });
const point = (x: number, y: number): RawGeometry => ({ type: 'Point', coordinates: [x, y] });

function scene(): Geometries {
  return {
    zones: null,
    network: makeSegments([line([[0, 0], [1, 1]]), line([[1, 1], [2, 2]])], ZERO_ORIGIN),
    desireLines: makeSegments([line([[0, 0], [3, 3]])], ZERO_ORIGIN),
    agents: makePoints([point(0, 0), point(1, 1)], ZERO_ORIGIN),
  };
}

const networkTable = makeTable(
  'network',
  loadCsv('link_id,grade,road_type,oneway\n0,1,major,True\n1,2,minor,False\n'),
);

// zone_id/agent_id, both strata, plus one value column -- enough to tell the
// anyStratum wildcard apart from a real column-name entry.
const agentsTable = makeTable(
  'agents',
  loadCsv('zone_id,agent_id,parcels_capacity\n1,1,5\n2,2,3\n'),
);

afterEach(() => {
  delete MAP_DRIVERS.network;
});

describe('applyMapColors', () => {
  it('paints everything in the ink color when nothing is selected', () => {
    const geometries = scene();
    applyMapColors(geometries, {}, null, INK, PAPER, false);
    expect(Array.from(geometries.network!.colors.slice(0, 3))).toEqual([255, 255, 255]);
    expect(Array.from(geometries.agents!.colors.slice(0, 3))).toEqual([255, 255, 255]);
  });

  it('stays monochrome for a column the map has no registered meaning for', () => {
    const geometries = scene();
    applyMapColors(geometries, { network: networkTable }, { table: 'network', column: 'road_type' }, INK, PAPER, false);
    expect(Array.from(geometries.network!.colors.slice(0, 3))).toEqual([255, 255, 255]);
  });

  it('colors a bucket once its column is registered, distinctly per stratum value', () => {
    MAP_DRIVERS.network = { road_type: 'network' };
    const geometries = scene();
    applyMapColors(geometries, { network: networkTable }, { table: 'network', column: 'road_type' }, INK, PAPER, false);

    const first = Array.from(geometries.network!.colors.slice(0, 3));
    const second = Array.from(geometries.network!.colors.slice(6, 9));
    expect(first).not.toEqual([255, 255, 255]);
    // two links, two road types -- so the two segments must differ
    expect(first).not.toEqual(second);
  });

  it('leaves other buckets monochrome when only one is driven', () => {
    MAP_DRIVERS.network = { road_type: 'network' };
    const geometries = scene();
    applyMapColors(geometries, { network: networkTable }, { table: 'network', column: 'road_type' }, INK, PAPER, false);
    expect(Array.from(geometries.agents!.colors.slice(0, 3))).toEqual([255, 255, 255]);
  });

  it('gives both vertices of a segment the same color, so a line is never a gradient', () => {
    MAP_DRIVERS.network = { road_type: 'network' };
    const geometries = scene();
    applyMapColors(geometries, { network: networkTable }, { table: 'network', column: 'road_type' }, INK, PAPER, false);
    expect(Array.from(geometries.network!.colors.slice(0, 3)))
      .toEqual(Array.from(geometries.network!.colors.slice(3, 6)));
  });
});

describe('activeLineLayer', () => {
  it('never returns both, and prefers network when nothing is driving', () => {
    expect(activeLineLayer(scene(), null, {})).toBe('network');
  });

  it('falls back to desire lines when the network is not loaded', () => {
    const geometries = { ...scene(), network: null };
    expect(activeLineLayer(geometries, null, {})).toBe('desireLines');
  });

  it('is null when neither line layer is loaded', () => {
    const geometries = { ...scene(), network: null, desireLines: null };
    expect(activeLineLayer(geometries, null, {})).toBeNull();
  });
});

describe('the anyStratum wildcard (agents)', () => {
  it('resolves any stratum column by name, not just ones listed explicitly', () => {
    expect(targetOf('agents', 'zone_id', agentsTable)).toBe('agents');
    expect(targetOf('agents', 'agent_id', agentsTable)).toBe('agents');
  });

  it('does not resolve a value column -- the wildcard is strata-only', () => {
    expect(targetOf('agents', 'parcels_capacity', agentsTable)).toBeNull();
  });

  it('returns null without table data to check strata membership against', () => {
    expect(targetOf('agents', 'zone_id')).toBeNull();
  });

  it('colors agents distinctly per zone_id end to end', () => {
    const geometries = scene();
    applyMapColors(geometries, { agents: agentsTable }, { table: 'agents', column: 'zone_id' }, INK, PAPER, false);
    const first = Array.from(geometries.agents!.colors.slice(0, 3));
    const second = Array.from(geometries.agents!.colors.slice(3, 6));
    expect(first).not.toEqual([255, 255, 255]);
    expect(first).not.toEqual(second);
  });
});

describe('desireLinesAreColored', () => {
  it('is false with nothing selected, so the blend passes stay off', () => {
    expect(desireLinesAreColored(null, {})).toBe(false);
  });

  it('is false for a column that drives some other bucket', () => {
    MAP_DRIVERS.network = { road_type: 'network' };
    expect(desireLinesAreColored({ table: 'network', column: 'road_type' }, { network: networkTable })).toBe(false);
  });
});
