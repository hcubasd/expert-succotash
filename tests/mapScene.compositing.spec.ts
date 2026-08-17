import { describe, expect, it } from 'vitest';
import { loadCsv } from '../src/lib/csvLoader';
import { makeTable } from '../src/lib/tableMaker';
import { ZERO_ORIGIN, makePolygons, makePoints, makeSegments } from '../src/lib/geometryMaker';
import type { RawGeometry } from '../src/lib/rawTable';
import { buildScene } from '../src/lib/mapScene';
import { DEFAULT_ACTIVE } from '../src/lib/mapValues';
import type { Draft } from '../src/lib/mapValues';

const square = (x: number): RawGeometry => ({
  type: 'Polygon',
  coordinates: [[[x, 0], [x + 1, 0], [x + 1, 1], [x, 1]]],
});
const point = (x: number, y: number): RawGeometry => ({ type: 'Point', coordinates: [x, y] });
const line = (coords: [number, number][]): RawGeometry => ({ type: 'LineString', coordinates: coords });

const zones = makeTable('zones', loadCsv('zone_id\n1\n2\n'));
const supply = makeTable('supply', loadCsv('zone_id,pallets,parcels\n1,11,27\n2,20,14\n'));
const agents = makeTable('agents', loadCsv('zone_id,agent_id,pallets_need\n1,1,5\n1,2,3\n'));
const network = makeTable('network', loadCsv('link_id,road_type,oneway,grade\n10,major,True,3\n'));

// needs / capacities / demand are deliberately absent: picking one of those
// is the case that used to wipe the layer off the map.
const tables = { zones, supply, agents, network };
const geometries = {
  zones: makePolygons([square(0), square(2)], ZERO_ORIGIN),
  agents: makePoints([point(0.5, 0.5), point(2.5, 0.5)], ZERO_ORIGIN),
  network: makeSegments([line([[0, 0], [3, 1]])], ZERO_ORIGIN),
  desireLines: null,
};
const view = { centerX: 1.5, centerY: 0.5, scaleX: 0.5, scaleY: 0.5 };
const build = (draft: Draft) => buildScene(tables, geometries, draft, view, 100, 1, 1);

// Losing a whole layer because a dropdown points at a file that was never
// loaded is far worse than showing that layer uncoloured -- it reads as the
// app being broken rather than as a selection being incomplete. Every one of
// these used to return null for its layer.
describe('a selection that cannot resolve still draws its geometry', () => {
  it('keeps zones when the chosen source file is not loaded', () => {
    const built = build({ active: DEFAULT_ACTIVE, resource: 'pallets', zoneSource: 'needs' });
    expect(built.scene.zones).not.toBeNull();
    expect(built.scene.zones!.fillPositions.length).toBeGreaterThan(0);
    expect(built.legends.zones).toBeNull();
  });

  it('keeps zones when the chosen resource is not among that file\'s columns', () => {
    const built = build({ active: DEFAULT_ACTIVE, resource: 'widgets', zoneSource: 'supply' });
    expect(built.scene.zones).not.toBeNull();
    expect(built.legends.zones).toBeNull();
  });

  it('colors zones, with a legend, once the selection does resolve', () => {
    const built = build({ active: DEFAULT_ACTIVE, resource: 'pallets', zoneSource: 'supply' });
    expect(built.scene.zones).not.toBeNull();
    expect(built.legends.zones).not.toBeNull();
  });

  it('keeps agents when the chosen kind has no column for that resource', () => {
    // pallets_capacity does not exist; only pallets_need does.
    const built = build({ active: DEFAULT_ACTIVE, resource: 'pallets', agentKind: 'capacity' });
    expect(built.scene.agents).not.toBeNull();
    expect(built.scene.agents!.positions.length).toBeGreaterThan(0);
    expect(built.legends.agents).toBeNull();
  });

  it('keeps the network drawn when nothing is selected for it', () => {
    const built = build({ active: DEFAULT_ACTIVE });
    expect(built.scene.network).not.toBeNull();
    expect(built.scene.network!.positions.length).toBeGreaterThan(0);
    expect(built.legends.network).toBeNull();
  });

  it('keeps the network drawn when its loads file is missing', () => {
    const built = build({ active: DEFAULT_ACTIVE, networkSource: 'loads', resource: 'pallets' });
    expect(built.scene.network).not.toBeNull();
    expect(built.legends.network).toBeNull();
  });

  it('still omits a layer that is switched off outright', () => {
    const built = build({ active: { ...DEFAULT_ACTIVE, zones: false }, resource: 'pallets', zoneSource: 'supply' });
    expect(built.scene.zones).toBeNull();
  });
});
