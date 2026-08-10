import { afterEach, describe, expect, it } from 'vitest';
import { loadCsv } from '../src/lib/csvLoader';
import { ZERO_ORIGIN, makePoints, makeSegments } from '../src/lib/geometryMaker';
import type { Geometries } from '../src/lib/geometryMaker';
import { MAP_DRIVERS, activeLineLayer, applyMapColors, desireLinesAreColored, targetOf } from '../src/lib/mapColors';
import type { RawGeometry } from '../src/lib/rawTable';
import { makeTable } from '../src/lib/tableMaker';

// Every case below runs in dark mode, so ink is white and paper is black --
// which is what makes "fell back to ink" and "fell back to paper" tellable
// apart in the assertions.
const INK = [255, 255, 255];
const PAPER = [0, 0, 0];

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
  it('defaults the lines to ink and the agents to paper when nothing is selected', () => {
    const geometries = scene();
    applyMapColors(geometries, {}, null, true);
    expect(Array.from(geometries.network!.colors.slice(0, 3))).toEqual(INK);
    expect(Array.from(geometries.desireLines!.colors.slice(0, 3))).toEqual(INK);
    // Agents sit on top of everything, so they take the background color
    // rather than opposing it.
    expect(Array.from(geometries.agents!.colors.slice(0, 3))).toEqual(PAPER);
  });

  it('stays monochrome for a column the map has no registered meaning for', () => {
    const geometries = scene();
    applyMapColors(geometries, { network: networkTable }, { table: 'network', column: 'road_type' }, true);
    expect(Array.from(geometries.network!.colors.slice(0, 3))).toEqual(INK);
  });

  it('colors a bucket once its column is registered, distinctly per stratum value', () => {
    MAP_DRIVERS.network = { road_type: 'network' };
    const geometries = scene();
    applyMapColors(geometries, { network: networkTable }, { table: 'network', column: 'road_type' }, true);

    // one color per segment now, so segment 1 starts at byte 3, not 6
    const first = Array.from(geometries.network!.colors.slice(0, 3));
    const second = Array.from(geometries.network!.colors.slice(3, 6));
    expect(first).not.toEqual(INK);
    // two links, two road types -- so the two segments must differ
    expect(first).not.toEqual(second);
  });

  it('leaves other buckets at their defaults when only one is driven', () => {
    MAP_DRIVERS.network = { road_type: 'network' };
    const geometries = scene();
    applyMapColors(geometries, { network: networkTable }, { table: 'network', column: 'road_type' }, true);
    expect(Array.from(geometries.agents!.colors.slice(0, 3))).toEqual(PAPER);
    expect(Array.from(geometries.desireLines!.colors.slice(0, 3))).toEqual(INK);
  });

  it('writes exactly one color per segment, so a line cannot be a gradient', () => {
    MAP_DRIVERS.network = { road_type: 'network' };
    const geometries = scene();
    applyMapColors(geometries, { network: networkTable }, { table: 'network', column: 'road_type' }, true);
    const network = geometries.network!;
    // the segment is the draw instance, so there is no second vertex to
    // disagree with the first -- the old per-vertex hazard is gone by
    // construction rather than by being written carefully
    expect(network.colors.length).toBe((network.positions.length / 4) * 3);
    expect(network.hues.length).toBe(network.positions.length / 4);
  });

  it('flips ink and paper with the mode, so light mode is the mirror', () => {
    const geometries = scene();
    applyMapColors(geometries, {}, null, false);
    expect(Array.from(geometries.network!.colors.slice(0, 3))).toEqual(PAPER);
    expect(Array.from(geometries.agents!.colors.slice(0, 3))).toEqual(INK);
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
    applyMapColors(geometries, { agents: agentsTable }, { table: 'agents', column: 'zone_id' }, true);
    const first = Array.from(geometries.agents!.colors.slice(0, 3));
    const second = Array.from(geometries.agents!.colors.slice(3, 6));
    expect(first).not.toEqual(PAPER);
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
