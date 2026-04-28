"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  computeRippleState,
  computeVisibleGraph,
  findDirectionalNeighbor,
  resolveGraphLinks,
  type FocusMode,
  type ResolvedLink,
} from "@/components/contagion-graph-graph";
import { useContagionGraphDrag } from "@/hooks/use-contagion-graph-drag";
import {
  buildGraphData,
  buildSupernodeState,
  runSimulation,
  type GraphNode,
  type HubTier,
  type SupernodeState,
} from "@/lib/contagion-layout";
import type { ReportCard, ReportCardsResponse } from "@shared/types";

interface UseContagionGraphModelOptions {
  cards: ReportCard[];
  dependencyEdges?: ReportCardsResponse["dependencyGraph"]["edges"];
  mcapMap: Map<string, number>;
}

export interface ContagionGraphNodeSelectOption {
  id: string;
  symbol: string;
  mcap: number;
}

function buildHubIdsByScore(
  nodes: readonly GraphNode[],
  supernodeState: SupernodeState,
): string[] {
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
}: UseContagionGraphModelOptions) {
  const svgRef = useRef<SVGSVGElement>(null);
  const prevTierByIdRef = useRef<Map<string, HubTier>>(new Map());

  const { nodes, links } = useMemo(
    () => buildGraphData(cards, mcapMap, dependencyEdges),
    [cards, dependencyEdges, mcapMap],
  );

  const supernodeState = useMemo<SupernodeState>(
    // eslint-disable-next-line react-hooks/refs -- read-only hysteresis snapshot from previous render
    () => buildSupernodeState(nodes, links, prevTierByIdRef.current),
    [nodes, links],
  );

  useEffect(() => {
    prevTierByIdRef.current = new Map(supernodeState.tierById);
  }, [supernodeState.tierById]);

  const [focusMode, setFocusMode] = useState<FocusMode>("all");
  const [selectedNeighborhoodId, setSelectedNeighborhoodId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<number | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const hubIdsByScore = useMemo(
    () => buildHubIdsByScore(nodes, supernodeState),
    [nodes, supernodeState],
  );
  const nodeSelectOptions = useMemo(() => buildNodeSelectOptions(nodes), [nodes]);
  const effectiveSelectedNeighborhoodId = useMemo(
    () => resolveSelectedNeighborhoodId({ nodes, hubIdsByScore, selectedNeighborhoodId }),
    [hubIdsByScore, nodes, selectedNeighborhoodId],
  );
  const nodeMap = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const basePositions = useMemo(
    () => (nodes.length === 0 ? new Map<string, { x: number; y: number }>() : runSimulation(nodes, links, supernodeState)),
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
  const neighborhoodFocusId = focusMode === "neighborhood"
    ? effectiveSelectedNeighborhoodId
    : null;
  const resolvedLinkByIndex = useMemo(
    () => new Map<number, ResolvedLink>(resolvedLinks.map((link) => [link.index, link])),
    [resolvedLinks],
  );
  const { visibleLinks, visibleLinkIndices, visibleNodeIds } = useMemo(
    () => computeVisibleGraph({ resolvedLinks, focusMode, neighborhoodFocusId, nodes, hubIdsByScore }),
    [focusMode, hubIdsByScore, neighborhoodFocusId, nodes, resolvedLinks],
  );
  const activeHoveredEdge = hoveredEdge !== null && visibleLinkIndices.has(hoveredEdge)
    ? hoveredEdge
    : null;
  const activeHoveredId = hoveredId !== null && visibleNodeIds.has(hoveredId)
    ? hoveredId
    : null;
  const rippleState = useMemo(
    () => computeRippleState(activeHoveredId, visibleLinks),
    [activeHoveredId, visibleLinks],
  );

  const handleNodeKeyDown = useCallback((event: React.KeyboardEvent, nodeId: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (focusMode === "neighborhood") setSelectedNeighborhoodId(nodeId);
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
      ? svgRef.current?.querySelector(`[data-node-id="${bestId}"]`) as HTMLElement | null
      : null;
    target?.focus();
  }, [drag.positions, focusMode, resolvedLinks]);

  const handleNodeMouseEnter = useCallback((nodeId: string) => {
    setHoveredId(nodeId);
    setHoveredEdge(null);
  }, []);
  const handleNodeMouseLeave = useCallback(() => setHoveredId(null), []);
  const handleNodeFocus = useCallback((nodeId: string) => {
    setHoveredId(nodeId);
    setFocusedId(nodeId);
    setHoveredEdge(null);
  }, []);
  const handleNodeBlur = useCallback(() => {
    setHoveredId(null);
    setFocusedId(null);
  }, []);
  const handleNodeClick = useCallback((nodeId: string) => {
    if (drag.dragId) return;
    if (focusMode === "neighborhood") setSelectedNeighborhoodId(nodeId);
  }, [drag.dragId, focusMode]);
  const handleEdgeMouseEnter = useCallback((edgeIndex: number) => setHoveredEdge(edgeIndex), []);
  const handleEdgeMouseLeave = useCallback(() => setHoveredEdge(null), []);

  return {
    svgRef,
    nodes,
    supernodeState,
    focusMode,
    setFocusMode,
    nodeSelectOptions,
    effectiveSelectedNeighborhoodId,
    setSelectedNeighborhoodId,
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
    handleEdgeMouseEnter,
    handleEdgeMouseLeave,
  };
}
