"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  computeRippleState,
  computeVisibleGraph,
  findDirectionalNeighbor,
  resolveGraphLinks,
  type EdgeTypeFilter,
  type FocusMode,
  type ResolvedLink,
} from "@/components/contagion-graph-graph";
import { useContagionGraphDrag } from "@/hooks/use-contagion-graph-drag";
import {
  buildGraphData,
  buildSupernodeState,
  DEFAULT_NODE_LIMIT,
  HEIGHT,
  runSimulation,
  WIDTH,
  type GraphLink,
  type GraphNode,
  type HubTier,
  type LayoutTarget,
  type NodeLimitOption,
  type SupernodeState,
  type ContagionGraphCard,
} from "@/lib/contagion-layout";
import type { ReportCardsV9DependencyEdge } from "@shared/types/report-cards-v9";

interface UseContagionGraphModelOptions {
  cards: readonly ContagionGraphCard[];
  dependencyEdges: readonly ReportCardsV9DependencyEdge[];
  mcapMap: Map<string, number>;
  focusCoinId?: string;
  maxNodes?: number;
}

const FOCUS_NEIGHBOR_RADIUS_X = 240;
const FOCUS_NEIGHBOR_RADIUS_Y = 180;

function resolveLinkEndpointId(endpoint: GraphLink["source"] | GraphLink["target"]): string {
  return typeof endpoint === "object" && endpoint !== null
    ? (endpoint as GraphNode).id
    : String(endpoint);
}

function filterToFocusNeighborhood(
  nodes: GraphNode[],
  links: GraphLink[],
  focusCoinId: string,
): { nodes: GraphNode[]; links: GraphLink[] } {
  const neighborIds = new Set<string>([focusCoinId]);
  for (const link of links) {
    const srcId = resolveLinkEndpointId(link.source);
    const tgtId = resolveLinkEndpointId(link.target);
    if (srcId === focusCoinId) neighborIds.add(tgtId);
    else if (tgtId === focusCoinId) neighborIds.add(srcId);
  }
  if (!neighborIds.has(focusCoinId) || neighborIds.size === 1) {
    return { nodes: [], links: [] };
  }
  const filteredNodes = nodes.filter((node) => neighborIds.has(node.id));
  if (!filteredNodes.some((node) => node.id === focusCoinId)) {
    return { nodes: [], links: [] };
  }
  const filteredLinks = links.filter((link) => {
    const srcId = resolveLinkEndpointId(link.source);
    const tgtId = resolveLinkEndpointId(link.target);
    return srcId === focusCoinId || tgtId === focusCoinId;
  });
  return { nodes: filteredNodes, links: filteredLinks };
}

function buildFocusLayoutTargets(
  nodes: readonly GraphNode[],
  focusCoinId: string,
): Map<string, LayoutTarget> {
  const targets = new Map<string, LayoutTarget>();
  targets.set(focusCoinId, { x: WIDTH / 2, y: HEIGHT / 2 });
  const neighbors = nodes.filter((node) => node.id !== focusCoinId);
  if (neighbors.length === 0) return targets;
  for (let i = 0; i < neighbors.length; i++) {
    const angle = -Math.PI / 2 + (i / neighbors.length) * Math.PI * 2;
    targets.set(neighbors[i].id, {
      x: WIDTH / 2 + Math.cos(angle) * FOCUS_NEIGHBOR_RADIUS_X,
      y: HEIGHT / 2 + Math.sin(angle) * FOCUS_NEIGHBOR_RADIUS_Y,
    });
  }
  return targets;
}

export interface ContagionGraphNodeSelectOption {
  id: string;
  symbol: string;
  mcap: number;
}

function buildHubIdsByScore(nodes: readonly GraphNode[], supernodeState: SupernodeState): string[] {
  return [...nodes]
    .filter((node) => (supernodeState.tierById.get(node.id) ?? 0) > 0)
    .sort((a, b) => (supernodeState.scoreById.get(b.id) ?? 0) - (supernodeState.scoreById.get(a.id) ?? 0))
    .map((node) => node.id);
}

function buildNodeSelectOptions(nodes: readonly GraphNode[]): ContagionGraphNodeSelectOption[] {
  return [...nodes]
    .sort((a, b) => b.mcap - a.mcap)
    .map((node) => ({ id: node.id, symbol: node.symbol, mcap: node.mcap }));
}

function resolveSelectedNeighborhoodId(params: {
  nodes: readonly GraphNode[];
  hubIdsByScore: readonly string[];
  selectedNeighborhoodId: string | null;
}): string | null {
  if (!params.nodes.length) return null;
  if (params.selectedNeighborhoodId && params.nodes.some((node) => node.id === params.selectedNeighborhoodId)) {
    return params.selectedNeighborhoodId;
  }
  return params.hubIdsByScore[0] ?? params.nodes[0].id;
}

function buildSimulationKey(
  nodes: readonly GraphNode[],
  linksLength: number,
  tierById: ReadonlyMap<string, HubTier>,
): string {
  return [
    nodes.map((node) => node.id).join("|"),
    linksLength,
    [...tierById.entries()].map(([id, tier]) => `${id}:${tier}`).join("|"),
  ].join("::");
}

export function useContagionGraphModel({
  cards,
  dependencyEdges,
  mcapMap,
  focusCoinId,
  maxNodes,
}: UseContagionGraphModelOptions) {
  const svgRef = useRef<SVGSVGElement>(null);
  const prevTierByIdRef = useRef<Map<string, HubTier>>(new Map());

  const [nodeLimit, setNodeLimit] = useState<NodeLimitOption>(DEFAULT_NODE_LIMIT);
  const effectiveNodeLimit = maxNodes ?? nodeLimit;

  const { nodes, links } = useMemo(() => {
    const built = buildGraphData(cards, mcapMap, dependencyEdges, effectiveNodeLimit);
    if (!focusCoinId) return built;
    return filterToFocusNeighborhood(built.nodes, built.links, focusCoinId);
  }, [cards, dependencyEdges, mcapMap, effectiveNodeLimit, focusCoinId]);

  const supernodeState = useMemo<SupernodeState>(() => {
    // eslint-disable-next-line react-hooks/refs -- read-only hysteresis snapshot from previous render
    const base = buildSupernodeState(nodes, links, prevTierByIdRef.current);
    if (!focusCoinId || nodes.length === 0) return base;
    const layoutTargetById = buildFocusLayoutTargets(nodes, focusCoinId);
    const anchorStrengthById = new Map<string, number>();
    for (const node of nodes) {
      anchorStrengthById.set(node.id, node.id === focusCoinId ? 1 : 0.2);
    }
    return { ...base, layoutTargetById, anchorStrengthById };
  }, [nodes, links, focusCoinId]);

  useEffect(() => {
    prevTierByIdRef.current = new Map(supernodeState.tierById);
  }, [supernodeState.tierById]);

  const [focusMode, setFocusMode] = useState<FocusMode>("all");
  const [edgeTypeFilter, setEdgeTypeFilter] = useState<EdgeTypeFilter>("all");
  const [selectedNeighborhoodId, setSelectedNeighborhoodId] = useState<string | null>(null);
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<number | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const hubIdsByScore = useMemo(() => buildHubIdsByScore(nodes, supernodeState), [nodes, supernodeState]);
  const nodeSelectOptions = useMemo(() => buildNodeSelectOptions(nodes), [nodes]);
  const effectiveSelectedNeighborhoodId = useMemo(
    () => resolveSelectedNeighborhoodId({ nodes, hubIdsByScore, selectedNeighborhoodId }),
    [hubIdsByScore, nodes, selectedNeighborhoodId],
  );
  const nodeMap = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const basePositions = useMemo(
    () =>
      nodes.length === 0 ? new Map<string, { x: number; y: number }>() : runSimulation(nodes, links, supernodeState),
    [links, nodes, supernodeState],
  );
  const simulationKey = useMemo(
    () => buildSimulationKey(nodes, links.length, supernodeState.tierById),
    [links.length, nodes, supernodeState.tierById],
  );
  const drag = useContagionGraphDrag({ svgRef, nodeMap, basePositions, simulationKey });
  const resolvedLinks = useMemo(
    () => resolveGraphLinks(links, supernodeState.tierById),
    [links, supernodeState.tierById],
  );
  const neighborhoodFocusId = focusMode === "neighborhood" ? effectiveSelectedNeighborhoodId : null;
  const resolvedLinkByIndex = useMemo(
    () => new Map<number, ResolvedLink>(resolvedLinks.map((link) => [link.index, link])),
    [resolvedLinks],
  );
  const { visibleLinks, visibleLinkIndices, visibleNodeIds } = useMemo(
    () =>
      computeVisibleGraph({
        resolvedLinks,
        focusMode,
        edgeTypeFilter,
        neighborhoodFocusId,
        nodes,
        hubIdsByScore,
      }),
    [edgeTypeFilter, focusMode, hubIdsByScore, neighborhoodFocusId, nodes, resolvedLinks],
  );
  const activeHoveredEdge = hoveredEdge !== null && visibleLinkIndices.has(hoveredEdge) ? hoveredEdge : null;
  const activeHoveredId = hoveredId !== null && visibleNodeIds.has(hoveredId) ? hoveredId : null;
  const effectiveInspectedId = useMemo(() => {
    const fallbackId = effectiveSelectedNeighborhoodId ?? hubIdsByScore[0] ?? nodes[0]?.id ?? null;
    const candidateId = activeHoveredId ?? inspectedId ?? fallbackId;
    if (candidateId && visibleNodeIds.has(candidateId)) return candidateId;
    return visibleNodeIds.values().next().value ?? null;
  }, [activeHoveredId, effectiveSelectedNeighborhoodId, hubIdsByScore, inspectedId, nodes, visibleNodeIds]);
  const rippleState = useMemo(() => computeRippleState(activeHoveredId, visibleLinks), [activeHoveredId, visibleLinks]);

  const handleTraceNodeChange = useCallback((nodeId: string | null) => {
    setSelectedNeighborhoodId(nodeId);
    setInspectedId(nodeId);
    if (nodeId) setFocusMode("neighborhood");
  }, []);

  const handleNodeKeyDown = useCallback(
    (event: React.KeyboardEvent, nodeId: string) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setSelectedNeighborhoodId(nodeId);
        setInspectedId(nodeId);
        setHoveredId((previous) => (previous === nodeId ? null : nodeId));
        return;
      }

      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      const bestId = findDirectionalNeighbor({
        nodeId,
        direction: event.key as "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight",
        links: resolvedLinks,
        positions: drag.positions,
      });
      const target = bestId
        ? (svgRef.current?.querySelector(`[data-node-id="${bestId}"]`) as HTMLElement | null)
        : null;
      target?.focus();
    },
    [drag.positions, resolvedLinks],
  );

  const handleNodeMouseEnter = useCallback((nodeId: string) => {
    setInspectedId(nodeId);
    setHoveredId(nodeId);
    setHoveredEdge(null);
  }, []);
  const handleNodeMouseLeave = useCallback(() => setHoveredId(null), []);
  const handleNodeFocus = useCallback((nodeId: string) => {
    setInspectedId(nodeId);
    setHoveredId(nodeId);
    setFocusedId(nodeId);
    setHoveredEdge(null);
  }, []);
  const handleNodeBlur = useCallback(() => {
    setHoveredId(null);
    setFocusedId(null);
  }, []);
  const handleNodeClick = useCallback(
    (nodeId: string) => {
      if (drag.dragId) return;
      if (drag.consumeDragMovedSincePointerDown()) return;
      setInspectedId(nodeId);
      setSelectedNeighborhoodId(nodeId);
    },
    [drag],
  );
  const handleNodeDoubleClick = useCallback(
    (nodeId: string) => {
      drag.unpinNode(nodeId);
    },
    [drag],
  );
  const handleEdgeMouseEnter = useCallback((edgeIndex: number) => setHoveredEdge(edgeIndex), []);
  const handleEdgeMouseLeave = useCallback(() => setHoveredEdge(null), []);

  const handleClearSelection = useCallback(() => {
    setSelectedNeighborhoodId(null);
    setInspectedId(null);
    setHoveredId(null);
    setHoveredEdge(null);
    setFocusedId(null);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      handleClearSelection();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [handleClearSelection]);

  return {
    svgRef,
    nodes,
    supernodeState,
    focusMode,
    setFocusMode,
    edgeTypeFilter,
    setEdgeTypeFilter,
    nodeLimit,
    setNodeLimit,
    nodeSelectOptions,
    effectiveSelectedNeighborhoodId,
    pinnedSelectionId: selectedNeighborhoodId,
    setSelectedNeighborhoodId,
    handleTraceNodeChange,
    effectiveInspectedId,
    setInspectedId,
    nodeMap,
    resolvedLinkByIndex,
    visibleLinks,
    visibleNodeIds,
    activeHoveredEdge,
    activeHoveredId,
    focusedId,
    ...drag,
    ...rippleState,
    handleNodeKeyDown,
    handleNodeMouseEnter,
    handleNodeMouseLeave,
    handleNodeFocus,
    handleNodeBlur,
    handleNodeClick,
    handleNodeDoubleClick,
    handleEdgeMouseEnter,
    handleEdgeMouseLeave,
    handleClearSelection,
  };
}
