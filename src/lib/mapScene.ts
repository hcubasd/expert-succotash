import { RAMP_LENGTH, gradientAt, ramps } from './colors';
import type { RgbColor } from './colors';
import { equalize, valueAtPercentile } from './equalize';
import type { Equalizer } from './equalize';
import type { Bounds, Geometries, RowBounds, SegmentGeometry } from './geometryMaker';
import type { MapSelection, Tables } from './mapValues';
import {
  agentResources, desireLineResources, featureValues, zoneResources,
} from './mapValues';
import { consolidateDesireLines, maxDesireSpacing } from './desireLines';
import { buildNodeGraph, maxHubSpacing, simplifyNetwork } from './networkGraph';
import type { Aggregation, NodeGraph } from './networkGraph';
import { spanFromAnchor, thinFromCentroid } from './thinning';
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

// Agents thin exactly the way the network does -- same walk, same exclusion,
// same detail control -- with one difference: an excluded agent is *absorbed*
// rather than dropped. Its need or capacity is added to whichever drawn
// circle is nearest, so the total on screen is always the true total no
// matter how coarse the view. Nothing is discarded, and unlike the network
// there is no orphan case: every agent either survives or lands in exactly
// one circle.
//
// The exclusion is a diameter, not a radius. It is compared as a centre to
// centre separation, and two circles of half it each, that far apart, touch
// without ever overlapping -- so the drawn size can follow the control
// directly.
//
// Floor and ceiling are the same on every layer: exactly zero, and the exact
// span that leaves the anchor and the one feature farthest from it. Nothing
// is simpler than the original data at one end or two points at the other,
// so those are the whole range there is, and the control means the same
// thing here as it does for the roads and the flows.
//
// Only what is *drawn* keeps a floor of its own. A circle of radius zero
// puts no fragment on screen at all -- unlike a line, whose visibility never
// depended on the exclusion -- so the drawn radius is clamped to half a
// device pixel below. That clamp is downstream of every decision about what
// merges with what: it is a fact about ink, and it is never fed back into
// the thinning.
export function thinAgents(
  positions: Float32Array,
  values: Float64Array,
  viewport: Bounds,
  pixelsPerUnit: number,
  pixelRatio: number,
  detail: number,
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

  const xOf = (i: number) => positions[i * 2];
  const yOf = (i: number) => positions[i * 2 + 1];

  const exclusion = exclusionFor(detail, spanFromAnchor(candidates, xOf, yOf));

  const { kept, owner } = thinFromCentroid(candidates, xOf, yOf, exclusion);

  const sums = new Map<number, number>();
  for (const i of candidates) {
    const into = owner.get(i)!;
    sums.set(into, (sums.get(into) ?? 0) + values[i]);
  }

  const keptPositions = new Float32Array(kept.length * 2);
  const keptValues = new Float64Array(kept.length);
  kept.forEach((source, target) => {
    keptPositions[target * 2] = positions[source * 2];
    keptPositions[target * 2 + 1] = positions[source * 2 + 1];
    keptValues[target] = sums.get(source) ?? values[source];
  });

  // The drawn circle is the exclusion circle -- what you see is the area
  // whose agents were summed into it -- floored at one device pixel across
  // so that a merge radius of zero still leaves something on screen.
  const deviceDiameter = Math.max(exclusion * pixelsPerUnit, 1);

  return {
    positions: keptPositions,
    values: keptValues,
    radiusCssPx: deviceDiameter / 2 / pixelRatio,
  };
}

// --- desire lines -----------------------------------------------------------

// Desire lines are drawn at one width like the roads are, and for the same
// reason: width here is legibility, not data. The value is carried by the
// accumulated colour, and a wider stroke deposits no more flow than a
// hairline -- the resolve pass divides by coverage, so thickness spreads a
// value over more pixels rather than inflating it.
export const DESIRE_LINE_WIDTH_CSS_PX = 2;

// --- network ----------------------------------------------------------------

// How wide every road is drawn. One number for the whole map: thickness here
// is legibility, not data -- the value is already in the colour, and varying
// width by density would make the densest places, which are exactly the ones
// already hardest to read, the thinnest.
export const NETWORK_LINE_WIDTH_CSS_PX = 2;

// Detail runs 0 (coarsest -- the exact radius that leaves only the anchor
// and the single farthest node from it standing, joined by one line) to 1
// (every link stands alone and draws its own true shape). Cubed so most of
// the travel sits in the fine half, where the interesting range is: linear
// spacing would spend most of the slider on skeletons that differ only in
// how sparse they are. The two ends are not symmetric -- the fine end lands
// on the original geometry, the coarse end on the two most spatially
// extreme points in view -- but neither is ever nothing: these are the true
// geometric limits of the control, not a safety-padded approximation of
// them.
export function exclusionFor(detail: number, ceiling: number, floor = 0): number {
  const clamped = Math.max(0, Math.min(1, detail));
  // Spans floor..ceiling rather than 0..ceiling: the network's floor is an
  // exact zero, but agents draw a real circle and cannot go below one device
  // pixel of it. Passing no floor gives back the network's behaviour exactly.
  const span = Math.max(0, ceiling - floor);
  return floor + span * (1 - clamped) ** 3;
}

export const DEFAULT_DETAIL = 0.45;

// The colour for each line endpoint, blended where several lines meet.
//
// Blending happens along the ramp, not in RGB. Every colour the app draws is
// a vertex of one 256-hue wheel at a single luminance, and averaging two of
// them channel by channel lands between the vertices -- a colour that is off
// the wheel and below that luminance, which is exactly the washed-out result
// the single-luminance design exists to avoid. Averaging the *positions*
// along the ramp and looking up once keeps the answer on the wheel by
// construction.
//
// A ramp is also half the wheel laid out as a flat 128-entry array rather
// than a closed circle, so a midpoint between two positions is unambiguous:
// none of the wraparound that makes averaging hues on a full circle
// ill-defined applies here.
// endpointNode says which endpoints can be shared at all: only graph nodes
// can have more than one line meeting on them, and a vertex interior to a
// link is by definition its own. So the blend is a map over a few hundred
// thousand integer ids rather than a coordinate lookup over every one of the
// millions of endpoints a fully detailed view emits.
export function jointColors(
  ts: Float64Array,
  endpointNode: Int32Array,
  ramp: RgbColor[],
): Uint8Array {
  const endpoints = endpointNode.length;

  const blended = new Map<number, { sum: number; count: number }>();
  for (let endpoint = 0; endpoint < endpoints; endpoint++) {
    const node = endpointNode[endpoint];
    if (node < 0) continue;
    // Two endpoints per line, so the line's own position is endpoint >> 1.
    const t = ts[endpoint >> 1];
    if (!Number.isFinite(t)) continue;
    const entry = blended.get(node);
    if (entry) {
      entry.sum += t;
      entry.count++;
    } else {
      blended.set(node, { sum: t, count: 1 });
    }
  }

  const colors = new Uint8Array(endpoints * 3);
  for (let endpoint = 0; endpoint < endpoints; endpoint++) {
    const node = endpointNode[endpoint];
    // A bend inside one link takes that link's own colour: blending it with
    // itself is what the shared-node case would produce anyway.
    const own = ts[endpoint >> 1];
    const entry = node >= 0 ? blended.get(node) : undefined;
    const t = entry ? entry.sum / entry.count : own;
    // Non-finite means nothing meeting here had a value, which the lines
    // themselves render white.
    const color = Number.isFinite(t) ? gradientAt(t, ramp) : WHITE;
    colors[endpoint * 3] = color.r;
    colors[endpoint * 3 + 1] = color.g;
    colors[endpoint * 3 + 2] = color.b;
  }
  return colors;
}

// The graph is a property of the file, not of the view, so it survives every
// zoom. Keyed weakly off the geometry so a reloaded file drops the old one.
const graphCache = new WeakMap<SegmentGeometry, NodeGraph>();

function networkGraph(network: SegmentGeometry): NodeGraph {
  let graph = graphCache.get(network);
  if (!graph) {
    graph = buildNodeGraph(network);
    graphCache.set(network, graph);
  }
  return graph;
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
  detail: number,
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

    // Grade is a property of a stretch of road, so several links collapsing
    // into one virtual edge average (by length); counts and grams are
    // quantities carried over it, so they add.
    const aggregation: Aggregation = selection.source === 'grade' ? 'mean' : 'sum';
    const graph = networkGraph(network);

    // One path at every level of detail. The radius alone decides how much
    // is shown, and at zero it decides nothing: every link stands alone
    // between two hubs and draws its own shape, which is the original
    // network back. The ceiling is measured fresh each time -- it depends on
    // exactly which nodes this view can see, not on screen size, so it moves
    // with the viewport rather than the canvas.
    const exclusion = exclusionFor(detail, maxHubSpacing(graph, viewport));
    const { positions, values: lineValues, endpointNode } =
      simplifyNetwork(graph, values, viewport, exclusion, aggregation);

    const finite: number[] = [];
    for (const value of lineValues) if (Number.isFinite(value)) finite.push(value);
    const equalizer = equalize(finite);

    const lineCount = positions.length / 4;
    // Each line's position along the ramp, kept rather than only its colour,
    // because the joins blend these rather than the colours they resolve to.
    const ts = new Float64Array(lineCount);
    const colors = new Uint8Array(lineCount * 3);
    for (let line = 0; line < lineCount; line++) {
      const value = lineValues[line];
      ts[line] = Number.isFinite(value) ? equalizer.at(value) : NaN;
      const color = colorOf(value, equalizer, ramp);
      colors[line * 3] = color.r;
      colors[line * 3 + 1] = color.g;
      colors[line * 3 + 2] = color.b;
    }

    return {
      scene: {
        view, pixelRatio, zones: hollowZones, agents: null, desireLines: null,
        network: {
          positions,
          colors,
          jointColors: jointColors(ts, endpointNode, ramp),
          widthCssPx: NETWORK_LINE_WIDTH_CSS_PX,
        },
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

    const thinned = thinAgents(agents.positions, values, viewport, pixelsPerUnit, pixelRatio, detail);
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

  // Consolidation only changes how many lines reach the accumulator, never
  // what it does with them: the same additive pass, the same equalized
  // resolve. At full detail nothing merges and this is exactly the raw set.
  const exclusion = exclusionFor(detail, maxDesireSpacing(edges.positions, viewport));
  const flow = consolidateDesireLines(edges.positions, edges.quantities, viewport, exclusion);

  return {
    scene: {
      view, pixelRatio, zones: hollowZones, network: null, agents: null,
      desireLines: {
        positions: flow.positions,
        quantities: flow.quantities,
        ramp,
        widthCssPx: DESIRE_LINE_WIDTH_CSS_PX,
      },
    },
    legend: null,
    pendingFlowRamp: ramp,
  };
}

export { RAMP_LENGTH };
