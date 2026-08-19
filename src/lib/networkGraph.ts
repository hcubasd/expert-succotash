import type { Bounds, SegmentGeometry } from './geometryMaker';
import { thinFromCentroid } from './thinning';

// The network as a graph, so it can be simplified into a readable skeleton
// rather than drawn link for link. At national extent the real thing is a
// solid smear -- 158k links over a 700km span is well under a pixel of road
// per pixel of screen -- and no line width or colour ramp fixes that, because
// the problem is that far more geometry is being drawn than the screen can
// separate.
//
// Nodes are *link endpoints only*. A link's interior vertices are shape, not
// topology: they say where a road bends, not where it meets another road.
// Keeping them would grow the graph from 73k nodes to 1.6M on the real
// network, twenty-two times the work, to describe exactly the same
// connectivity.
export type NodeGraph = {
  nodeX: Float64Array;
  nodeY: Float64Array;
  nodeCount: number;

  // Per link: the nodes it joins, its true traversed length (summed along
  // every bend, not endpoint to endpoint, so the flood below spreads at road
  // distance), and the table row its value comes from.
  linkA: Uint32Array;
  linkB: Uint32Array;
  linkLength: Float64Array;
  linkRow: Uint32Array;
  linkCount: number;

  // The span of drawable segments each link owns. The flood provably does
  // not need a link's interior vertices -- a chain of degree-2 nodes has the
  // same connectivity and the same shortest paths as the single weighted
  // edge it collapses to, so carrying them would be nineteen times the work
  // for an identical partition (measured). They are still needed to *draw*
  // the road's true shape, so the graph keeps a pointer to them rather than
  // a copy.
  linkFirstSegment: Uint32Array;
  linkLastSegment: Uint32Array;
  segmentPositions: Float32Array;

  // Adjacency in compressed-row form: node n's links are the slots
  // adjStart[n] .. adjStart[n+1] of adjNode/adjLength. One flat pair of
  // arrays rather than an array of arrays, since this is walked on every
  // zoom and the per-node allocation would dominate.
  adjStart: Uint32Array;
  adjNode: Uint32Array;
  adjLength: Float64Array;
};

export function buildNodeGraph(segments: SegmentGeometry): NodeGraph {
  const segmentCount = segments.positions.length / 4;

  // Segments arrive grouped by row and in order along each line, so a row's
  // first and last segment carry that link's two endpoints.
  const firstSegment = new Int32Array(segments.rowCount).fill(-1);
  const lastSegment = new Int32Array(segments.rowCount).fill(-1);
  const rowLength = new Float64Array(segments.rowCount);

  for (let s = 0; s < segmentCount; s++) {
    const row = segments.rowIndex[s];
    if (firstSegment[row] < 0) firstSegment[row] = s;
    lastSegment[row] = s;
    const dx = segments.positions[s * 4 + 2] - segments.positions[s * 4];
    const dy = segments.positions[s * 4 + 3] - segments.positions[s * 4 + 1];
    rowLength[row] += Math.hypot(dx, dy);
  }

  // Coordinates come off a Float32Array, so two links that meet really do
  // carry bit-identical endpoints and an exact key is enough -- no distance
  // tolerance, no spatial index. Verified on the real network: 317k endpoint
  // slots collapse to 73k nodes, and 99.9% of them land in one connected
  // component.
  const nodeIds = new Map<string, number>();
  const nodeX: number[] = [];
  const nodeY: number[] = [];

  const idOf = (x: number, y: number): number => {
    const key = `${x},${y}`;
    let id = nodeIds.get(key);
    if (id === undefined) {
      id = nodeX.length;
      nodeIds.set(key, id);
      nodeX.push(x);
      nodeY.push(y);
    }
    return id;
  };

  const linkA: number[] = [];
  const linkB: number[] = [];
  const linkLength: number[] = [];
  const linkRow: number[] = [];
  const linkFirst: number[] = [];
  const linkLast: number[] = [];

  for (let row = 0; row < segments.rowCount; row++) {
    const first = firstSegment[row];
    const last = lastSegment[row];
    if (first < 0) continue;

    const ax = segments.positions[first * 4];
    const ay = segments.positions[first * 4 + 1];
    const bx = segments.positions[last * 4 + 2];
    const by = segments.positions[last * 4 + 3];
    if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(bx) || !Number.isFinite(by)) continue;

    const a = idOf(ax, ay);
    const b = idOf(bx, by);
    // A closed loop joins one node to itself: it can never be a boundary
    // link, so it would only ever be absorbed anyway.
    if (a === b) continue;

    linkA.push(a);
    linkB.push(b);
    linkLength.push(rowLength[row]);
    linkRow.push(row);
    linkFirst.push(first);
    linkLast.push(last);
  }

  const nodeCount = nodeX.length;
  const linkCount = linkA.length;

  // Two passes to fill the adjacency: count each node's degree, turn the
  // counts into start offsets, then place each link's two directions.
  const adjStart = new Uint32Array(nodeCount + 1);
  for (let l = 0; l < linkCount; l++) {
    adjStart[linkA[l] + 1]++;
    adjStart[linkB[l] + 1]++;
  }
  for (let n = 0; n < nodeCount; n++) adjStart[n + 1] += adjStart[n];

  const cursor = adjStart.slice(0, nodeCount);
  const adjNode = new Uint32Array(linkCount * 2);
  const adjLength = new Float64Array(linkCount * 2);
  for (let l = 0; l < linkCount; l++) {
    const a = linkA[l];
    const b = linkB[l];
    adjNode[cursor[a]] = b;
    adjLength[cursor[a]] = linkLength[l];
    cursor[a]++;
    adjNode[cursor[b]] = a;
    adjLength[cursor[b]] = linkLength[l];
    cursor[b]++;
  }

  return {
    nodeX: Float64Array.from(nodeX),
    nodeY: Float64Array.from(nodeY),
    nodeCount,
    linkA: Uint32Array.from(linkA),
    linkB: Uint32Array.from(linkB),
    linkLength: Float64Array.from(linkLength),
    linkRow: Uint32Array.from(linkRow),
    linkCount,
    linkFirstSegment: Uint32Array.from(linkFirst),
    linkLastSegment: Uint32Array.from(linkLast),
    segmentPositions: segments.positions,
    adjStart,
    adjNode,
    adjLength,
  };
}

// Round joins need no array of their own: a line's endpoints laid out as
// x1,y1,x2,y2 already *are* a list of x,y points, so the same buffer draws
// the discs that cover the seams where quads meet.
export type VirtualNetwork = {
  // x1,y1,x2,y2 per drawable segment. A virtual edge is usually one straight
  // hub-to-hub chord, but an edge that turns out to *be* a single real link
  // emits that link's own segments instead, bends and all.
  positions: Float32Array;
  // One value per segment, repeated along a link's own segments.
  values: Float64Array;
  // Which graph node each segment endpoint sits on, or -1 for a vertex
  // interior to one link. Only real nodes can be shared between lines, so
  // this is what lets joins be blended by integer id instead of by
  // rediscovering shared coordinates across millions of endpoints.
  endpointNode: Int32Array;
};

// The nodes and links a view actually needs to look at: whichever links have
// at least one endpoint on screen, and the nodes those links touch.
function visibleCandidates(graph: NodeGraph, viewport: Bounds) {
  const { nodeX, nodeY, linkA, linkB, linkCount } = graph;
  const inView = (n: number) =>
    nodeX[n] >= viewport.minX && nodeX[n] <= viewport.maxX &&
    nodeY[n] >= viewport.minY && nodeY[n] <= viewport.maxY;

  // A link counts as visible if either end is on screen, which keeps the ones
  // straddling the edge of the view rather than cutting the network off at
  // the frame.
  const visibleLink = new Uint8Array(linkCount);
  const visibleNode = new Uint8Array(graph.nodeCount);
  for (let l = 0; l < linkCount; l++) {
    if (!inView(linkA[l]) && !inView(linkB[l])) continue;
    visibleLink[l] = 1;
    visibleNode[linkA[l]] = 1;
    visibleNode[linkB[l]] = 1;
  }

  const candidates: number[] = [];
  for (let n = 0; n < graph.nodeCount; n++) if (visibleNode[n]) candidates.push(n);
  return { candidates, visibleLink, visibleNode };
}

// Once every node has an owner, turning that into a drawable virtual
// network is one shared job. Every visible link falls into exactly one
// bucket, decided by its two endpoints' owners: same owner means it sits
// inside one hub's territory and is absorbed, different owners mean it
// bridges two territories and becomes part of the virtual edge between
// them. No link is counted twice and none needs a share-of-many-paths
// correction, because ownership is a single label per node rather than a
// set of routes.
const NONE = 0xffffffff;

function buildVirtualNetwork(
  graph: NodeGraph,
  values: Float64Array,
  visibleLink: Uint8Array,
  owner: Uint32Array,
): VirtualNetwork {
  const { nodeX, nodeY, linkA, linkB, linkCount } = graph;

  // One entry per surviving link, never a merge of several. Collapsing is
  // elimination: a link whose two endpoints land on the same point dies
  // outright (below), and every link that outlives that keeps its own value
  // untouched. Two survivors that happen to span the same pair of hubs stay
  // two links drawn on top of each other, not one link holding their total
  // -- summing them would put a number on screen that no road in the data
  // has, which is the same flaw that made the agent layer's values depend
  // on how far you were zoomed out. Aggregation belongs to the selection
  // (summing a stratum you asked to sum), never to the geometry.
  type Edge = { value: number; a: number; b: number; link: number };
  const edges: Edge[] = [];

  for (let l = 0; l < linkCount; l++) {
    if (!visibleLink[l]) continue;
    const ownerA = owner[linkA[l]];
    const ownerB = owner[linkB[l]];
    // Unowned means the link sits in a component no hub reached -- 0.06% of
    // the real network, in tiny islands off the main graph. Same owner on
    // both ends means the link collapsed to a point: it is gone, and its
    // load and emissions go with it rather than moving anywhere else.
    if (ownerA === NONE || ownerB === NONE || ownerA === ownerB) continue;

    // A link with no value for the current selection still gets drawn -- the
    // road is there whether or not any traffic was recorded on it. NaN
    // carries that through to the caller, which paints it as structure.
    edges.push({ value: values[graph.linkRow[l]], a: ownerA, b: ownerB, link: l });
  }

  // A link whose own endpoints both survived as themselves draws its real
  // road shape; one with an endpoint that moved draws a straight chord to
  // wherever that endpoint went. The condition loosens on its own as the
  // radius shrinks -- more surviving points means more links standing on
  // their own ends -- so detail arrives continuously, and at radius zero
  // every link qualifies and the original geometry is back.
  const drawsRealShape = (edge: Edge): boolean =>
    owner[linkA[edge.link]] === linkA[edge.link] &&
    owner[linkB[edge.link]] === linkB[edge.link];

  let segmentTotal = 0;
  for (const edge of edges) {
    segmentTotal += drawsRealShape(edge)
      ? graph.linkLastSegment[edge.link] - graph.linkFirstSegment[edge.link] + 1
      : 1;
  }

  const positions = new Float32Array(segmentTotal * 4);
  const edgeValues = new Float64Array(segmentTotal);
  const endpointNode = new Int32Array(segmentTotal * 2);
  let at = 0;

  for (const edge of edges) {
    const value = edge.value;

    if (drawsRealShape(edge)) {
      const first = graph.linkFirstSegment[edge.link];
      const last = graph.linkLastSegment[edge.link];
      for (let segment = first; segment <= last; segment++) {
        positions.set(graph.segmentPositions.subarray(segment * 4, segment * 4 + 4), at * 4);
        edgeValues[at] = value;
        // Only the two ends of the whole link are shared with anything else.
        endpointNode[at * 2] = segment === first ? linkA[edge.link] : -1;
        endpointNode[at * 2 + 1] = segment === last ? linkB[edge.link] : -1;
        at++;
      }
      continue;
    }

    positions[at * 4] = nodeX[edge.a];
    positions[at * 4 + 1] = nodeY[edge.a];
    positions[at * 4 + 2] = nodeX[edge.b];
    positions[at * 4 + 3] = nodeY[edge.b];
    edgeValues[at] = value;
    endpointNode[at * 2] = edge.a;
    endpointNode[at * 2 + 1] = edge.b;
    at++;
  }

  return { positions, values: edgeValues, endpointNode };
}

// Ownership goes to whichever hub is nearest by straight line -- the exact
// walk zones, agents and desire lines already use, not a road-distance
// flood. A prior Dijkstra-based version (one multi-source flood along real
// links) was measured against this at real-network scale (73k nodes, 158k
// links): the flood plus its bookkeeping cost tens of milliseconds per
// slider move, never free, and side by side on the real national-extent
// network the two were visually indistinguishable. Point-collapse won and
// the flood was removed rather than kept as a fallback.
export function simplifyNetwork(
  graph: NodeGraph,
  values: Float64Array,
  viewport: Bounds,
  exclusion: number,
): VirtualNetwork {
  const { nodeX, nodeY } = graph;
  const { candidates, visibleLink } = visibleCandidates(graph, viewport);

  if (candidates.length === 0) {
    return {
      positions: new Float32Array(0),
      values: new Float64Array(0),
      endpointNode: new Int32Array(0),
    };
  }

  const { owners } = thinFromCentroid(candidates, n => nodeX[n], n => nodeY[n], exclusion);
  const owner = new Uint32Array(graph.nodeCount).fill(NONE);
  for (let k = 0; k < candidates.length; k++) owner[candidates[k]] = owners[k];

  return buildVirtualNetwork(graph, values, visibleLink, owner);
}
