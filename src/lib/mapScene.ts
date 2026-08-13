import { RAMP_LENGTH, gradientAt, ramps } from './colors';
import type { RgbColor } from './colors';
import { equalize, valueAtPercentile } from './equalize';
import type { Equalizer } from './equalize';
import type { Bounds, Geometries, RowBounds } from './geometryMaker';
import type { MapSelection, Tables } from './mapValues';
import {
  agentResources, desireLineResources, featureValues, zoneResources,
} from './mapValues';
import type { FlowStats, Scene, View } from '../gl/renderer';

export const LEGEND_TICKS = 9;

export type Legend = {
  ramp: RgbColor[];
  // Where each label sits along the bar, and what value it stands for. The
  // positions are evenly spaced but the values are not -- that gap is the
  // equalization made visible, and is the whole reason the legend can't just
  // be a min and a max.
  ticks: { t: number; value: number }[];
  count: number;
};

// The world rectangle the view is currently showing. toClip maps
// (world - center) * scale into [-1,1], so the visible half-extent is the
// reciprocal of the scale.
export function viewportOf(view: View): Bounds {
  return {
    minX: view.centerX - 1 / view.scaleX,
    maxX: view.centerX + 1 / view.scaleX,
    minY: view.centerY - 1 / view.scaleY,
    maxY: view.centerY + 1 / view.scaleY,
  };
}

function intersects(rowBounds: RowBounds, row: number, viewport: Bounds): boolean {
  const minX = rowBounds[row * 4];
  const minY = rowBounds[row * 4 + 1];
  const maxX = rowBounds[row * 4 + 2];
  const maxY = rowBounds[row * 4 + 3];
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return false;
  return maxX >= viewport.minX && minX <= viewport.maxX && maxY >= viewport.minY && minY <= viewport.maxY;
}

function rampFor(resources: string[], resource: string): RgbColor[] | null {
  const index = resources.indexOf(resource);
  if (index < 0) return null;
  return ramps(resources.length)[index];
}

function legendFrom(equalizer: Equalizer, ramp: RgbColor[]): Legend {
  const ticks = [];
  for (let i = 0; i < LEGEND_TICKS; i++) {
    const t = i / (LEGEND_TICKS - 1);
    ticks.push({ t, value: equalizer.valueAt(t) });
  }
  return { ramp, ticks, count: equalizer.count };
}

export function legendFromFlow(stats: FlowStats, ramp: RgbColor[]): Legend {
  const ticks = [];
  for (let i = 0; i < LEGEND_TICKS; i++) {
    const t = i / (LEGEND_TICKS - 1);
    ticks.push({ t, value: valueAtPercentile(stats.cdf, stats.max, t) });
  }
  return { ramp, ticks, count: 0 };
}

// Equalize over exactly the rows that are on screen, so the ramp always
// spends its full range on what the reader can actually see.
function visibleEqualizer(values: Float64Array, rowBounds: RowBounds, rowCount: number, viewport: Bounds) {
  const visible: number[] = [];
  for (let row = 0; row < rowCount; row++) {
    if (Number.isFinite(values[row]) && intersects(rowBounds, row, viewport)) visible.push(values[row]);
  }
  return equalize(visible);
}

const WHITE: RgbColor = { r: 255, g: 255, b: 255 };

function colorOf(value: number, equalizer: Equalizer, ramp: RgbColor[]): RgbColor {
  // A feature with no value for this selection is left white rather than
  // given a colour at the bottom of the ramp: "no need for this resource" is
  // not the same statement as "the least need", and white reads as absent
  // against the white paper.
  if (!Number.isFinite(value)) return WHITE;
  return gradientAt(equalizer.at(value), ramp);
}

// --- agents ----------------------------------------------------------------

export type ThinnedAgents = {
  positions: Float32Array;
  values: Float64Array;
  radiusCssPx: number;
};

// One diameter for every agent on screen, fixed in CSS pixels so it never
// grows or shrinks with zoom -- the same dot at every scale, not a Google
// Maps-style explode-on-zoom-in. Agents are still walked outward from the
// centroid, and one that would land within a diameter of something already
// placed is dropped -- it would only repaint pixels already spoken for. What
// survives at extreme density is a tight cluster of separate coloured dots,
// which is the honest picture of "a lot packed into a small area". Zooming in
// doesn't grow the dots, but it does spread the underlying data apart in
// screen space, so more of it clears the fixed exclusion and gets drawn --
// the re-thin on every zoom is still doing real work, it just isn't sizing
// anything anymore.
export const AGENT_DIAMETER_CSS_PX = 12;

export function thinAgents(
  positions: Float32Array,
  values: Float64Array,
  viewport: Bounds,
  pixelsPerUnit: number,
  pixelRatio: number,
): ThinnedAgents {
  const candidates: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const x = positions[i * 2];
    const y = positions[i * 2 + 1];
    if (!Number.isFinite(values[i]) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < viewport.minX || x > viewport.maxX || y < viewport.minY || y > viewport.maxY) continue;
    candidates.push(i);
  }
  if (candidates.length === 0) {
    return { positions: new Float32Array(0), values: new Float64Array(0), radiusCssPx: 0 };
  }

  let sumX = 0;
  let sumY = 0;
  for (const i of candidates) {
    sumX += positions[i * 2];
    sumY += positions[i * 2 + 1];
  }
  const centroidX = sumX / candidates.length;
  const centroidY = sumY / candidates.length;

  const distanceToCentroid = (i: number) =>
    (positions[i * 2] - centroidX) ** 2 + (positions[i * 2 + 1] - centroidY) ** 2;

  const ordered = [...candidates].sort((a, b) => distanceToCentroid(a) - distanceToCentroid(b));

  // The fixed diameter, converted into this zoom's world units so the grid
  // and exclusion test below can stay in the coordinate space the positions
  // already use.
  const deviceDiameter = AGENT_DIAMETER_CSS_PX * pixelRatio;
  const exclusion = deviceDiameter / pixelsPerUnit;

  // A uniform grid at the exclusion radius: any agent close enough to
  // conflict is in this cell or one of the eight around it, so the whole
  // sweep stays linear instead of comparing every pair.
  const cell = Math.max(exclusion, 1e-12);
  const grid = new Map<string, number[]>();
  const keptIndices: number[] = [];

  for (const i of ordered) {
    const x = positions[i * 2];
    const y = positions[i * 2 + 1];
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);

    let blocked = false;
    for (let dx = -1; dx <= 1 && !blocked; dx++) {
      for (let dy = -1; dy <= 1 && !blocked; dy++) {
        const bucket = grid.get(`${cx + dx},${cy + dy}`);
        if (!bucket) continue;
        for (const j of bucket) {
          const d2 = (positions[j * 2] - x) ** 2 + (positions[j * 2 + 1] - y) ** 2;
          if (d2 < exclusion * exclusion) {
            blocked = true;
            break;
          }
        }
      }
    }
    if (blocked) continue;

    keptIndices.push(i);
    const key = `${cx},${cy}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(i);
    else grid.set(key, [i]);
  }

  const keptPositions = new Float32Array(keptIndices.length * 2);
  const keptValues = new Float64Array(keptIndices.length);
  keptIndices.forEach((source, target) => {
    keptPositions[target * 2] = positions[source * 2];
    keptPositions[target * 2 + 1] = positions[source * 2 + 1];
    keptValues[target] = values[source];
  });

  return {
    positions: keptPositions,
    values: keptValues,
    radiusCssPx: AGENT_DIAMETER_CSS_PX / 2,
  };
}

// --- the scene --------------------------------------------------------------

export type BuiltScene = {
  scene: Scene;
  legend: Legend | null;
  // Desire lines can only be measured by drawing them, so their legend is
  // finished after the render returns its stats.
  pendingFlowRamp: RgbColor[] | null;
};

export function buildScene(
  tables: Tables,
  geometries: Geometries,
  selection: MapSelection | null,
  view: View,
  pixelsPerUnit: number,
  pixelRatio: number,
): BuiltScene {
  const viewport = viewportOf(view);
  const hollowZones = geometries.zones ? { geometry: geometries.zones, fillColors: null } : null;

  const empty: BuiltScene = {
    scene: { view, pixelRatio, zones: hollowZones, network: null, agents: null, desireLines: null },
    legend: null,
    pendingFlowRamp: null,
  };
  if (!selection) return empty;

  if (selection.mode === 'zones') {
    const zones = geometries.zones;
    const values = featureValues(tables, selection);
    const ramp = rampFor(zoneResources(tables, selection.source), selection.resource);
    if (!zones || !values || !ramp) return empty;

    const equalizer = visibleEqualizer(values, zones.rowBounds, zones.rowCount, viewport);
    const fillColors = new Uint8Array((zones.fillPositions.length / 2) * 3);
    for (let vertex = 0; vertex < zones.fillPositions.length / 2; vertex++) {
      const color = colorOf(values[zones.fillRowIndex[vertex]], equalizer, ramp);
      fillColors[vertex * 3] = color.r;
      fillColors[vertex * 3 + 1] = color.g;
      fillColors[vertex * 3 + 2] = color.b;
    }

    return {
      scene: {
        view, pixelRatio, network: null, agents: null, desireLines: null,
        zones: { geometry: zones, fillColors },
      },
      legend: legendFrom(equalizer, ramp),
      pendingFlowRamp: null,
    };
  }

  if (selection.mode === 'network') {
    const network = geometries.network;
    const values = featureValues(tables, selection);
    // Network carries one quantity at a time rather than a set of resources,
    // so it takes the first ramp of a one-gon: a single distinct hue.
    const ramp = ramps(1)[0];
    if (!network || !values) return empty;

    const equalizer = visibleEqualizer(values, network.rowBounds, network.rowCount, viewport);
    const segments = network.positions.length / 4;
    // Two vertices per segment, both the same colour, since gl.LINES
    // advances attributes per vertex.
    const colors = new Uint8Array(segments * 2 * 3);
    for (let segment = 0; segment < segments; segment++) {
      const color = colorOf(values[network.rowIndex[segment]], equalizer, ramp);
      for (let corner = 0; corner < 2; corner++) {
        const at = (segment * 2 + corner) * 3;
        colors[at] = color.r;
        colors[at + 1] = color.g;
        colors[at + 2] = color.b;
      }
    }

    return {
      scene: {
        view, pixelRatio, zones: hollowZones, agents: null, desireLines: null,
        network: { geometry: network, colors },
      },
      legend: legendFrom(equalizer, ramp),
      pendingFlowRamp: null,
    };
  }

  if (selection.mode === 'agents') {
    const agents = geometries.agents;
    const values = featureValues(tables, selection);
    const ramp = rampFor(agentResources(tables, selection.kind), selection.resource);
    if (!agents || !values || !ramp) return empty;

    const thinned = thinAgents(agents.positions, values, viewport, pixelsPerUnit, pixelRatio);
    const equalizer = equalize(Array.from(thinned.values));
    const colors = new Uint8Array(thinned.values.length * 3);
    for (let i = 0; i < thinned.values.length; i++) {
      const color = colorOf(thinned.values[i], equalizer, ramp);
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }

    return {
      scene: {
        view, pixelRatio, zones: hollowZones, network: null, desireLines: null,
        agents: { positions: thinned.positions, colors, radiusCssPx: thinned.radiusCssPx },
      },
      legend: legendFrom(equalizer, ramp),
      pendingFlowRamp: null,
    };
  }

  const edges = geometries.desireLines?.get(selection.resource);
  const ramp = rampFor(desireLineResources(tables), selection.resource);
  if (!edges || !ramp) return empty;

  return {
    scene: {
      view, pixelRatio, zones: hollowZones, network: null, agents: null,
      desireLines: { positions: edges.positions, quantities: edges.quantities, ramp },
    },
    legend: null,
    pendingFlowRamp: ramp,
  };
}

export { RAMP_LENGTH };
