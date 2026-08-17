import { RAMP_LENGTH, gradientAt, grayAt, ramps } from './colors';
import type { RgbColor } from './colors';
import { equalize, valueAtPercentile } from './equalize';
import type { Equalizer } from './equalize';
import type { Bounds, Geometries, RowBounds, SegmentGeometry } from './geometryMaker';
import type { Draft, LayerRender, Tables } from './mapValues';
import {
  agentRender, agentResources, desireLineRender, desireLineResources,
  featureValues, networkRender, zoneRender, zoneResources,
} from './mapValues';
import { consolidateDesireLines } from './desireLines';
import { collapseZones } from './zoneShapes';
import type { CollapsedZones } from './zoneShapes';
import type { PolygonGeometry } from './geometryMaker';
import { buildNodeGraph, simplifyNetwork } from './networkGraph';
import type { Aggregation, NodeGraph } from './networkGraph';
import { thinFromCentroid } from './thinning';
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

// The shared detail-slider ceiling for every layer, replacing what used to
// be four separate per-layer ceilings (each one the exact distance
// guaranteeing a particular survivor count for that layer alone). Those
// were provably always at or under this: any two candidates a layer's own
// ceiling could span are both inside the viewport, and no two points inside
// a rectangle can be farther apart than its diagonal. So this always
// collapses at least as far as each layer's own true minimum, with slack
// past it -- which is what makes it possible to actually watch a layer stop
// changing rather than just trust that it would have. It's also what makes
// one detail value mean the same real merge radius for every layer at once,
// which per-layer ceilings never could once they're all on screen together.
export function viewportDiagonal(viewport: Bounds): number {
  return Math.hypot(viewport.maxX - viewport.minX, viewport.maxY - viewport.minY);
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
// The neutral fill for zones and agents when no single resource is being
// shown -- "all resources" or nothing picked yet. Distinct from both white
// (this feature has no value for what *is* selected) and black (which stays
// reserved for structure: borders, joints, network's own neutral line).
const NEUTRAL_GRAY: RgbColor = grayAt(0.5);
// Structure, never data: outlines, joints, and a road with nothing selected.
const BLACK: RgbColor = { r: 0, g: 0, b: 0 };

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
// Floor and ceiling are the same on every layer: exactly zero, and the
// viewport diagonal (see viewportDiagonal). The floor is exact -- the
// original data, nothing merged -- and the ceiling deliberately overshoots
// each layer's own true minimum rather than land exactly on it, which is
// what lets the same detail value mean the same real merge radius across
// every layer at once.
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

  const exclusion = exclusionFor(detail, viewportDiagonal(viewport));

  const { kept, owners } = thinFromCentroid(candidates, xOf, yOf, exclusion);

  const sums = new Map<number, number>();
  for (let k = 0; k < candidates.length; k++) {
    const into = owners[k];
    sums.set(into, (sums.get(into) ?? 0) + values[candidates[k]]);
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

// One width for every line the map draws: zone borders, network, desire
// lines, and agent-dot borders. Thickness here is legibility, not data --
// varying it by layer would suggest a difference in what's being measured
// that isn't there, and varying it by density would make the busiest places,
// already the hardest to read, the thinnest. A single tunable in one place
// rather than four independent constants, so retuning it is a one-line
// change, not a search-and-replace.
export const LINE_WIDTH_CSS_PX = 1.5;

// --- zones ------------------------------------------------------------------

// Zones appear in every mode -- coloured in their own, hollow as the basemap
// under the others -- but the collapse only depends on the view and the
// control, never on which mode is asking. One slot is enough: a frame asks
// with the same arguments every time.
let zoneCache: {
  geometry: PolygonGeometry;
  exclusion: number;
  viewport: Bounds;
  collapsed: CollapsedZones;
} | null = null;

function collapsedZones(geometry: PolygonGeometry, viewport: Bounds, detail: number): CollapsedZones {
  const exclusion = exclusionFor(detail, viewportDiagonal(viewport));
  const hit = zoneCache;
  if (hit && hit.geometry === geometry && hit.exclusion === exclusion
    && hit.viewport.minX === viewport.minX && hit.viewport.maxX === viewport.maxX
    && hit.viewport.minY === viewport.minY && hit.viewport.maxY === viewport.maxY) {
    return hit.collapsed;
  }
  const collapsed = collapseZones(geometry, viewport, exclusion);
  zoneCache = { geometry, exclusion, viewport, collapsed };
  return collapsed;
}

// --- desire lines -----------------------------------------------------------
//
// Desire lines share LINE_WIDTH_CSS_PX too. The value is carried by the
// accumulated colour, and a wider stroke deposits no more flow than a
// hairline -- the resolve pass divides by coverage, so thickness spreads a
// value over more pixels rather than inflating it.

// --- network ----------------------------------------------------------------

// Detail runs 0 (coarsest -- the viewport diagonal, an exclusion no layer
// can outgrow) to 1 (every feature stands on its own, drawing its true
// shape). Cubed so most of the travel sits in the fine half, where the
// interesting range is: linear spacing would spend most of the slider on
// skeletons that differ only in how sparse they are.
export function exclusionFor(detail: number, ceiling: number, floor = 0): number {
  const clamped = Math.max(0, Math.min(1, detail));
  // Spans floor..ceiling rather than 0..ceiling: the network's floor is an
  // exact zero, but agents draw a real circle and cannot go below one device
  // pixel of it. Passing no floor gives back the network's behaviour exactly.
  const span = Math.max(0, ceiling - floor);
  return floor + span * (1 - clamped) ** 3;
}

// Full detail by default -- the original data, nothing collapsed.
export const DEFAULT_DETAIL = 1;

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

// --- the scene: one independent piece per layer, composited together -------
//
// Every layer used to be a branch of one if/else chain that returned after
// the first match -- only one of them could ever be on screen. Compositing
// means all four can be non-null in the same Scene at once, so each layer
// now gets its own small builder, resolved from its own LayerRender, and
// buildScene just calls all four and assembles the result. Nothing shared
// between layers here except the viewport and the detail control.

export type BuiltScene = {
  scene: Scene;
  legends: { zones: Legend | null; agents: Legend | null; network: Legend | null };
  // Desire lines can only be measured by drawing them, so their legend is
  // finished after the render returns its stats.
  pendingFlowRamp: RgbColor[] | null;
};

function flatColors(vertices: number, color: RgbColor): Uint8Array {
  const out = new Uint8Array(vertices * 3);
  for (let vertex = 0; vertex < vertices; vertex++) {
    out[vertex * 3] = color.r;
    out[vertex * 3 + 1] = color.g;
    out[vertex * 3 + 2] = color.b;
  }
  return out;
}

function buildZones(
  tables: Tables,
  geometries: Geometries,
  render: LayerRender,
  viewport: Bounds,
  detail: number,
): { zones: Scene['zones']; legend: Legend | null } {
  if (render.kind === 'off') return { zones: null, legend: null };

  const zones = geometries.zones;
  if (!zones) return { zones: null, legend: null };
  const collapsed = collapsedZones(zones, viewport, detail);
  const vertices = collapsed.fillPositions.length / 2;
  const shape = (fillColors: Uint8Array) => ({
    fillPositions: collapsed.fillPositions, fillColors,
    borderPositions: collapsed.borderPositions, borderWidthCssPx: LINE_WIDTH_CSS_PX,
  });

  const selection = render.kind === 'selected' && render.selection.mode === 'zones' ? render.selection : null;
  const values = selection ? featureValues(tables, selection) : null;
  const ramp = selection ? rampFor(zoneResources(tables, selection.source), selection.resource) : null;

  // Neutral covers every way there is nothing to colour by, including a
  // selection that cannot resolve -- its file was never loaded, or that
  // resource isn't among its columns. The geometry still draws either way:
  // a dropdown pointing at a file you haven't loaded should leave the
  // basemap uncoloured, never make the whole layer disappear.
  if (!selection || !values || !ramp) {
    return { zones: shape(flatColors(vertices, NEUTRAL_GRAY)), legend: null };
  }

  const equalizer = visibleEqualizer(values, zones.rowBounds, zones.rowCount, viewport);
  const fillColors = new Uint8Array(vertices * 3);
  for (let vertex = 0; vertex < vertices; vertex++) {
    const color = colorOf(values[collapsed.fillRow[vertex]], equalizer, ramp);
    fillColors[vertex * 3] = color.r;
    fillColors[vertex * 3 + 1] = color.g;
    fillColors[vertex * 3 + 2] = color.b;
  }
  return { zones: shape(fillColors), legend: legendFrom(equalizer, ramp) };
}

function buildAgents(
  tables: Tables,
  geometries: Geometries,
  render: LayerRender,
  viewport: Bounds,
  pixelsPerUnit: number,
  pixelRatio: number,
  detail: number,
): { agents: Scene['agents']; legend: Legend | null } {
  if (render.kind === 'off') return { agents: null, legend: null };

  const agents = geometries.agents;
  if (!agents) return { agents: null, legend: null };

  const selection = render.kind === 'selected' && render.selection.mode === 'agents' ? render.selection : null;
  const values = selection ? featureValues(tables, selection) : null;
  const ramp = selection ? rampFor(agentResources(tables, selection.kind), selection.resource) : null;

  // Same fallback as zones: an unresolvable selection leaves the dots on
  // screen uncoloured rather than removing them.
  if (!selection || !values || !ramp) {
    // The geometric collapse -- which agents survive, and where -- doesn't
    // depend on any value, so a flat dummy stands in. It only has to be
    // finite, so none get filtered out as though they were missing data.
    const dummyValues = new Float64Array(agents.positions.length / 2).fill(0);
    const thinned = thinAgents(agents.positions, dummyValues, viewport, pixelsPerUnit, pixelRatio, detail);
    return {
      agents: {
        positions: thinned.positions,
        colors: flatColors(thinned.values.length, NEUTRAL_GRAY),
        radiusCssPx: thinned.radiusCssPx,
        borderCssPx: LINE_WIDTH_CSS_PX,
      },
      legend: null,
    };
  }

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
    agents: {
      positions: thinned.positions, colors,
      radiusCssPx: thinned.radiusCssPx, borderCssPx: LINE_WIDTH_CSS_PX,
    },
    legend: legendFrom(equalizer, ramp),
  };
}

function buildNetwork(
  tables: Tables,
  geometries: Geometries,
  render: LayerRender,
  viewport: Bounds,
  detail: number,
): { network: Scene['network']; legend: Legend | null } {
  if (render.kind === 'off') return { network: null, legend: null };

  const network = geometries.network;
  if (!network) return { network: null, legend: null };

  const selection = render.kind === 'selected' && render.selection.mode === 'network' ? render.selection : null;
  const values = selection ? featureValues(tables, selection) : null;
  // Network carries one quantity at a time rather than a set of resources,
  // so it takes the first ramp of a one-gon: a single distinct hue.
  const ramp = ramps(1)[0];
  const graph = networkGraph(network);

  // The roads are still roads with nothing selected, so they draw in black
  // -- the app's structural colour -- rather than vanishing. Black rather
  // than the gray zones and agents fall back to: those are areas and marks
  // whose *fill* is missing, while a road with no value is just a line, and
  // a line with no data is the same ink every other outline uses. The
  // collapse itself needs no values, so a flat zero stands in for them.
  if (!selection || !values) {
    const exclusion = exclusionFor(detail, viewportDiagonal(viewport));
    const blank = new Float64Array(network.rowCount).fill(0);
    const { positions, endpointNode } = simplifyNetwork(graph, blank, viewport, exclusion, 'mean');
    return {
      network: {
        positions,
        colors: flatColors(positions.length / 4, BLACK),
        jointColors: flatColors(endpointNode.length, BLACK),
        widthCssPx: LINE_WIDTH_CSS_PX,
      },
      legend: null,
    };
  }

  // Grade is a property of a stretch of road, so several links collapsing
  // into one virtual edge average (by length); counts and grams are
  // quantities carried over it, so they add.
  const aggregation: Aggregation = selection.source === 'grade' ? 'mean' : 'sum';

  // One path at every level of detail. The radius alone decides how much
  // is shown, and at zero it decides nothing: every link stands alone
  // between two hubs and draws its own shape, which is the original
  // network back.
  const exclusion = exclusionFor(detail, viewportDiagonal(viewport));
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
    network: {
      positions, colors, jointColors: jointColors(ts, endpointNode, ramp), widthCssPx: LINE_WIDTH_CSS_PX,
    },
    legend: legendFrom(equalizer, ramp),
  };
}

function buildDesireLines(
  tables: Tables,
  geometries: Geometries,
  render: LayerRender,
  viewport: Bounds,
  detail: number,
): { desireLines: Scene['desireLines']; pendingFlowRamp: RgbColor[] | null } {
  // Neutral folds into off here specifically, unlike the other three layers:
  // desire lines have no geometry that exists independent of a resource --
  // there is no "all resources" edge set to fall back on without compositing
  // several resources' flows together, which is deliberately not attempted
  // this pass.
  if (render.kind !== 'selected' || render.selection.mode !== 'desire_lines') {
    return { desireLines: null, pendingFlowRamp: null };
  }
  const selection = render.selection;

  const edges = geometries.desireLines?.get(selection.resource);
  const ramp = rampFor(desireLineResources(tables), selection.resource);
  if (!edges || !ramp) return { desireLines: null, pendingFlowRamp: null };

  // Consolidation only changes how many lines reach the accumulator, never
  // what it does with them: the same additive pass, the same equalized
  // resolve. At full detail nothing merges and this is exactly the raw set.
  const exclusion = exclusionFor(detail, viewportDiagonal(viewport));
  const flow = consolidateDesireLines(edges.positions, edges.quantities, viewport, exclusion);

  return {
    desireLines: { positions: flow.positions, quantities: flow.quantities, ramp, widthCssPx: LINE_WIDTH_CSS_PX },
    pendingFlowRamp: ramp,
  };
}

export function buildScene(
  tables: Tables,
  geometries: Geometries,
  draft: Draft,
  view: View,
  pixelsPerUnit: number,
  pixelRatio: number,
  detail: number,
): BuiltScene {
  const viewport = viewportOf(view);

  const zones = buildZones(tables, geometries, zoneRender(draft, tables), viewport, detail);
  const agents = buildAgents(
    tables, geometries, agentRender(draft, tables), viewport, pixelsPerUnit, pixelRatio, detail,
  );
  const network = buildNetwork(tables, geometries, networkRender(draft, tables), viewport, detail);
  const desireLines = buildDesireLines(tables, geometries, desireLineRender(draft, tables), viewport, detail);

  return {
    scene: {
      view, pixelRatio,
      zones: zones.zones, agents: agents.agents, network: network.network, desireLines: desireLines.desireLines,
    },
    legends: { zones: zones.legend, agents: agents.legend, network: network.legend },
    pendingFlowRamp: desireLines.pendingFlowRamp,
  };
}

export { RAMP_LENGTH };
