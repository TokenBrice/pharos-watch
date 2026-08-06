import type { ContagionEdgeRelationship, GraphLink, GraphNode, HubTier } from "@/lib/contagion-layout";

export interface ResolvedLink {
  index: number;
  srcId: string;
  tgtId: string;
  weight: number;
  type: ContagionEdgeRelationship;
  srcTier: HubTier;
  tgtTier: HubTier;
}

export type FocusMode = "all" | "hub" | "neighborhood";
export type EdgeTypeFilter = "all" | ContagionEdgeRelationship;

export interface RippleState {
  connectedNodes: Set<string>;
  connectedEdges: Set<number>;
  nodeDistance: Map<string, number>;
  edgeDistance: Map<number, number>;
}

type ArrowDirection = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

function resolveLinkNodeId(node: GraphNode | string | number): string {
  return typeof node === "object" ? node.id : String(node);
}

export function resolveGraphLinks(links: readonly GraphLink[], tierById: ReadonlyMap<string, HubTier>): ResolvedLink[] {
  return links.map((link, index) => {
    const srcId = resolveLinkNodeId(link.source);
    const tgtId = resolveLinkNodeId(link.target);
    return {
      index,
      srcId,
      tgtId,
      weight: link.weight,
      type: link.type,
      srcTier: tierById.get(srcId) ?? 0,
      tgtTier: tierById.get(tgtId) ?? 0,
    };
  });
}

export function computeVisibleGraph(params: {
  resolvedLinks: readonly ResolvedLink[];
  focusMode: FocusMode;
  edgeTypeFilter: EdgeTypeFilter;
  neighborhoodFocusId: string | null;
  nodes: readonly Pick<GraphNode, "id">[];
  hubIdsByScore: readonly string[];
}): {
  visibleLinks: ResolvedLink[];
  visibleLinkIndices: Set<number>;
  visibleNodeIds: Set<string>;
} {
  const visible: ResolvedLink[] = [];
  const visibleIndices = new Set<number>();

  for (const link of params.resolvedLinks) {
    if (params.edgeTypeFilter !== "all" && link.type !== params.edgeTypeFilter) continue;

    const inScope =
      params.focusMode === "all"
        ? true
        : params.focusMode === "hub"
          ? link.srcTier > 0 || link.tgtTier > 0
          : params.neighborhoodFocusId !== null
            ? link.srcId === params.neighborhoodFocusId || link.tgtId === params.neighborhoodFocusId
            : false;
    if (!inScope) continue;

    visible.push(link);
    visibleIndices.add(link.index);
  }

  const nodeIds = new Set<string>();
  for (const link of visible) {
    nodeIds.add(link.srcId);
    nodeIds.add(link.tgtId);
  }

  if (params.focusMode === "all") {
    for (const node of params.nodes) nodeIds.add(node.id);
  } else if (params.focusMode === "hub") {
    for (const id of params.hubIdsByScore) nodeIds.add(id);
  } else {
    if (params.neighborhoodFocusId) nodeIds.add(params.neighborhoodFocusId);
  }

  return {
    visibleLinks: visible,
    visibleLinkIndices: visibleIndices,
    visibleNodeIds: nodeIds,
  };
}

export function computeRippleState(
  hoveredId: string | null,
  visibleLinks: readonly ResolvedLink[],
  maxRippleHops = 4,
): RippleState {
  const emptyResult: RippleState = {
    connectedNodes: new Set<string>(),
    connectedEdges: new Set<number>(),
    nodeDistance: new Map<string, number>(),
    edgeDistance: new Map<number, number>(),
  };
  if (!hoveredId) return emptyResult;

  // Links whose tgtId is the key; BFS walks these to find upstream providers that depend on hoveredId.
  const inboundByTarget = new Map<string, ResolvedLink[]>();
  const directByNode = new Map<string, ResolvedLink[]>();

  for (const link of visibleLinks) {
    const downstream = inboundByTarget.get(link.tgtId) ?? [];
    downstream.push(link);
    inboundByTarget.set(link.tgtId, downstream);

    const srcLinks = directByNode.get(link.srcId) ?? [];
    srcLinks.push(link);
    directByNode.set(link.srcId, srcLinks);

    const tgtLinks = directByNode.get(link.tgtId) ?? [];
    tgtLinks.push(link);
    directByNode.set(link.tgtId, tgtLinks);
  }

  const nodeDistance = new Map<string, number>([[hoveredId, 0]]);
  const edgeDistance = new Map<number, number>();

  const directLinks = directByNode.get(hoveredId) ?? [];
  for (const link of directLinks) {
    const neighborId = link.srcId === hoveredId ? link.tgtId : link.srcId;
    if (!nodeDistance.has(neighborId)) nodeDistance.set(neighborId, 1);
    if (!edgeDistance.has(link.index)) edgeDistance.set(link.index, 1);
  }

  const queue: string[] = [];
  const queued = new Set<string>();
  for (const link of inboundByTarget.get(hoveredId) ?? []) {
    if (queued.has(link.srcId)) continue;
    queued.add(link.srcId);
    queue.push(link.srcId);
  }

  let queueStart = 0;
  while (queueStart < queue.length) {
    const nodeId = queue[queueStart++];
    const currentDist = nodeDistance.get(nodeId) ?? 1;
    if (currentDist >= maxRippleHops) continue;

    const nextDist = currentDist + 1;
    for (const link of inboundByTarget.get(nodeId) ?? []) {
      if (!edgeDistance.has(link.index)) edgeDistance.set(link.index, nextDist);
      if (!nodeDistance.has(link.srcId)) {
        nodeDistance.set(link.srcId, nextDist);
        queue.push(link.srcId);
      }
    }
  }

  return {
    connectedNodes: new Set(nodeDistance.keys()),
    connectedEdges: new Set(edgeDistance.keys()),
    nodeDistance,
    edgeDistance,
  };
}

export function findDirectionalNeighbor(params: {
  nodeId: string;
  direction: ArrowDirection;
  links: readonly ResolvedLink[];
  positions: ReadonlyMap<string, { x: number; y: number }>;
}): string | null {
  const currentPos = params.positions.get(params.nodeId);
  if (!currentPos) return null;

  const connectedIds = new Set<string>();
  for (const link of params.links) {
    if (link.srcId === params.nodeId) connectedIds.add(link.tgtId);
    if (link.tgtId === params.nodeId) connectedIds.add(link.srcId);
  }
  if (connectedIds.size === 0) return null;

  let bestId: string | null = null;
  let bestScore = -Infinity;

  for (const connectedId of connectedIds) {
    const connectedPos = params.positions.get(connectedId);
    if (!connectedPos) continue;

    const dx = connectedPos.x - currentPos.x;
    const dy = connectedPos.y - currentPos.y;
    let score = 0;
    switch (params.direction) {
      case "ArrowRight":
        score = dx;
        break;
      case "ArrowLeft":
        score = -dx;
        break;
      case "ArrowDown":
        score = dy;
        break;
      case "ArrowUp":
        score = -dy;
        break;
    }

    if (score > 0 && score > bestScore) {
      bestScore = score;
      bestId = connectedId;
    }
  }

  return bestId;
}
