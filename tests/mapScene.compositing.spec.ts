import { describe, expect, it } from 'vitest';
import { loadCsv } from '../src/lib/csvLoader';
import { makeTable } from '../src/lib/tableMaker';
import { ZERO_ORIGIN, makePolygons, makePoints, makeSegments } from '../src/lib/geometryMaker';
import type { RawGeometry } from '../src/lib/rawTable';
import { DEFAULT_DETAIL_BY_MODE, LINE_WIDTH_CSS_PX, buildScene, jointColors } from '../src/lib/mapScene';
import { MAP_RAMP_LENGTH, wheel } from '../src/lib/colors';
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
const build = (draft: Draft) =>
  buildScene(tables, geometries, draft, view, 100, 1, DEFAULT_DETAIL_BY_MODE, LINE_WIDTH_CSS_PX);

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

// The layer surviving isn't enough on its own: the individual roads inside
// it have to survive too. Links with no traffic for the current selection
// used to be dropped before any geometry was built, which left a filtered
// network as a few coloured threads in empty space and read as most of the
// map having failed to load.
describe('network links the selection carries no value for', () => {
  const onlyLink10 = makeTable('network_loads', loadCsv(
    'link_id,time_interval,vehicle,forward,resource,vehicle_count\n10,h0,van,True,pallets,5\n',
  ));
  const threeLinks = makeTable('network', loadCsv(
    'link_id,road_type,oneway,grade\n10,major,False,1\n11,major,False,2\n12,major,False,3\n',
  ));
  const geometry = {
    zones: null,
    agents: null,
    network: makeSegments(
      [line([[0, 0], [1, 0]]), line([[1, 0], [2, 0]]), line([[2, 0], [3, 0]])],
      ZERO_ORIGIN,
    ),
    desireLines: null,
  };
  const built = buildScene(
    { network: threeLinks, network_loads: onlyLink10 },
    geometry,
    { active: DEFAULT_ACTIVE, resource: 'pallets', networkSource: 'loads' },
    { centerX: 1.5, centerY: 0, scaleX: 0.5, scaleY: 0.5 },
    100, 1, DEFAULT_DETAIL_BY_MODE, LINE_WIDTH_CSS_PX,
  );
  const network = built.scene.network!;
  const colorAt = (i: number) =>
    `${network.colors[i * 3]},${network.colors[i * 3 + 1]},${network.colors[i * 3 + 2]}`;
  const lineCount = network.positions.length / 4;

  it('draws every road, not only the ones carrying traffic', () => {
    expect(lineCount).toBe(3);
  });

  it('paints the valueless ones black rather than white', () => {
    const colors = new Set(Array.from({ length: lineCount }, (_, i) => colorAt(i)));
    // White is what made them invisible against the paper; black is the
    // structural ink every other outline in the app uses.
    expect(colors.has('255,255,255')).toBe(false);
    expect(colors.has('0,0,0')).toBe(true);
    // Still two distinct readings: one road has data, two do not.
    expect(colors.size).toBe(2);
  });
});

// Joints cap the seam where link quads meet. They blend across a shared node,
// which is right for lines that each have a value -- and wrong the moment one
// of them doesn't, since a black road would end in a coloured dot borrowed
// from whichever neighbour had traffic.
describe('joint colours where a valued and a valueless link meet', () => {
  it('keeps the valueless link black at both ends', () => {
    const ramp = wheel().slice(0, MAP_RAMP_LENGTH);
    const ts = Float64Array.from([0.5, NaN]);      // line 0 has a value, line 1 does not
    const endpointNode = Int32Array.from([1, 7, 7, 2]);  // both meet at node 7
    const colors = jointColors(ts, endpointNode, ramp);
    const at = (i: number) => [colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]].join(',');

    expect(at(2)).toBe('0,0,0');
    expect(at(3)).toBe('0,0,0');
    // and the valued line still gets its colour, blend and all
    expect(at(0)).not.toBe('0,0,0');
    expect(at(1)).not.toBe('0,0,0');
  });
});
