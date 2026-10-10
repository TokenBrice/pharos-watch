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
  MIN_RADIUS,
  HEIGHT,
  runSimulationInChunks,
  WIDTH,
  type GraphLink,
  type GraphNode,
  type LayoutTarget,
  type NodeLimitOption,
  type SupernodeState,
  type ContagionGraphCard,
} from "@/lib/contagion-layout";
import type { ReportCardsV9DependencyEdge } from "@shared/types/report-cards-v9";
import { trackEvent } from "@/lib/analytics";
import { NODE_LIMIT_OPTIONS } from "@/lib/contagion-layout";
import { buildDependencyHubsModel } from "@/lib/dependency-hubs-model";
import type { HubExposure } from "@shared/lib/dependency-exposure";
import { highlightedExposureEdges, type ExposureOverlay } from "./contagion-graph-exposure";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";

interface UseContagionGraphModelOptions {
  cards: readonly ContagionGraphCard[];
  dependencyEdges: readonly ReportCardsV9DependencyEdge[];
  mcapMap: ReadonlyMap<string, number | null>;
  focusCoinId?: string;
  maxNodes?: number;
  syncUrlState?: boolean;
  trackActions?: boolean;
  exposureOverlay?: ExposureOverlay | null;
  onUseAsExposureRoot?: (coinId: string) => void;
  hubExposures?: readonly HubExposure[];
}

const FOCUS_NEIGHBOR_RADIUS_X = 240;
const SMALL_LINK_SHARE_THRESHOLD = 0.001;
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
  mcap: number | null;
}

function buildHubIdsByScore(nodes: readonly GraphNode[], supernodeState: SupernodeState): string[] {
  return [...nodes]
    .filter((node) => (supernodeState.tierById.get(node.id) ?? 0) > 0)
    .sort((a, b) => (supernodeState.scoreById.get(b.id) ?? 0) - (supernodeState.scoreById.get(a.id) ?? 0))
    .map((node) => node.id);
}

function buildNodeSelectOptions(nodes: readonly GraphNode[]): ContagionGraphNodeSelectOption[] {
  return [...nodes]
    .sort((a, b) => (b.mcap ?? -1) - (a.mcap ?? -1))
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
  links: readonly GraphLink[],
  focusCoinId?: string,
): string {
  return [
    nodes.map((node) => node.id).sort().join("|"),
    // Coarse topology version, independent of market-cap ranks, radii and tiers.
    links.map(link => `${resolveLinkEndpointId(link.source)}>${resolveLinkEndpointId(link.target)}:${link.type}:${Math.round(link.weight * 100)}`).sort().join("|"),
    focusCoinId ?? "",
  ].join("::");
}

export function useContagionGraphModel({
  cards,
  dependencyEdges: publishedDependencyEdges,
  mcapMap,
  focusCoinId,
  maxNodes,
  syncUrlState = false,
  trackActions = true,
  exposureOverlay: controlledExposureOverlay = null,
  onUseAsExposureRoot,
  hubExposures,
}: UseContagionGraphModelOptions) {
  const exposureOverlay = controlledExposureOverlay?.roots.length ? controlledExposureOverlay : null;
  // Quarantine malformed edges individually; identifiable unknown basket shares stay drawable.
  const dependencyEdges = useMemo(() => publishedDependencyEdges
    .filter(edge => edge && typeof edge.from === "string" && typeof edge.to === "string" && (edge.kind === "serial" || edge.kind === "basket"))
    .map(edge => edge.kind === "basket" && edge.weight !== null && (!Number.isFinite(edge.weight) || edge.weight < 0 || edge.weight > 1)
      ? { ...edge, weight: null } : edge), [publishedDependencyEdges]);
  const fullGraph = useMemo(
    () => buildGraphData(cards, mcapMap, dependencyEdges, "all"),
    [cards, dependencyEdges, mcapMap],
  );
  const fullExposure = useMemo(() => hubExposures ?? buildDependencyHubsModel({
    cards: cards.map(card => ({ ...card, name: card.symbol })),
    edges: dependencyEdges,
    mcapMap,
  }).hubs, [hubExposures, cards, dependencyEdges, mcapMap]);
  const directExposureById = useMemo(
    () => new Map(fullExposure.map(hub => [hub.hubId, hub])),
    [fullExposure],
  );
  const fullSupernodeState = useMemo(
    () => buildSupernodeState(fullGraph.nodes, fullGraph.links,
      new Map(fullExposure.map(hub => [hub.hubId, hub.direct.knownUsd]))),
    [fullGraph, fullExposure],
  );
  const fullResolvedLinks = useMemo(
    () => resolveGraphLinks(fullGraph.links, fullSupernodeState.tierById),
    [fullGraph, fullSupernodeState],
  );

  const [nodeLimit, setNodeLimit] = useState<NodeLimitOption>(DEFAULT_NODE_LIMIT);
  const effectiveNodeLimit = maxNodes ?? nodeLimit;
  const exposureRoots = exposureOverlay?.roots;
  const exposureRows = exposureOverlay?.rows;

  const { nodes, links } = useMemo(() => {
    if (exposureRoots && exposureRows) {
      const roots = new Set(exposureRoots);
      const footprint = fullGraph.nodes.filter(node => roots.has(node.id) || exposureRows.has(node.id));
      for (const card of cards) {
        if (!card.isDefunct && roots.has(card.id) && !footprint.some(node => node.id === card.id)) {
          footprint.push({ id: card.id, symbol: card.symbol, grade: card.grade, partialEvidence: card.partialEvidence, mcap: mcapMap.get(card.id) ?? null, r: MIN_RADIUS });
        }
      }
      footprint.sort((a, b) => (roots.has(a.id) ? 0 : exposureRows.get(a.id)?.minHop ?? Infinity) - (roots.has(b.id) ? 0 : exposureRows.get(b.id)?.minHop ?? Infinity) || (b.mcap ?? -1) - (a.mcap ?? -1));
      const nodes = effectiveNodeLimit === "all" ? footprint : footprint.slice(0, effectiveNodeLimit);
      const ids = new Set(nodes.map(node => node.id));
      return { nodes, links: fullGraph.links.filter(link => ids.has(resolveLinkEndpointId(link.source)) && ids.has(resolveLinkEndpointId(link.target))) };
    }
    const built = buildGraphData(cards, mcapMap, dependencyEdges, effectiveNodeLimit);
    if (!focusCoinId) return built;
    return filterToFocusNeighborhood(built.nodes, built.links, focusCoinId);
  }, [cards, dependencyEdges, mcapMap, effectiveNodeLimit, focusCoinId, exposureRoots, exposureRows, fullGraph]);

  const supernodeState = useMemo<SupernodeState>(() => {
    const base = fullSupernodeState;
    if (!focusCoinId || nodes.length === 0) return base;
    const layoutTargetById = buildFocusLayoutTargets(nodes, focusCoinId);
    const anchorStrengthById = new Map<string, number>();
    for (const node of nodes) {
      anchorStrengthById.set(node.id, node.id === focusCoinId ? 1 : 0.2);
    }
    return { ...base, layoutTargetById, anchorStrengthById };
  }, [nodes, fullSupernodeState, focusCoinId]);

  const [focusMode, setFocusMode] = useState<FocusMode>("all");
  const [edgeTypeFilter, setEdgeTypeFilter] = useState<EdgeTypeFilter>("all");
  const [selectedNeighborhoodId, setSelectedNeighborhoodId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<number | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [showSmallLinks, setShowSmallLinks] = useState(false);

  const [urlReady, setUrlReady] = useState(false);
  const urlInitialized = useRef(false);
  useEffect(() => {
    if (!syncUrlState || urlInitialized.current || !cards.length) return;
    urlInitialized.current = true;
    const params = new URLSearchParams(window.location.search);
    const focus = params.get("focus");
    const trace = params.get("trace");
    const type = params.get("type");
    const limit = params.get("limit");
    const validTrace = (id: string | null): id is string =>
      Boolean(id && (CLIENT_TRACKED_META_BY_ID.has(id) || cards.some((card) => card.id === id)));
    const root = validTrace(focus) ? focus : validTrace(trace) ? trace : null;
    // Browser URL state is read only after hydration, preserving static export.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Read browser URL state once after hydration so static-export markup stays identical on the server and first client render.
    setFocusMode(validTrace(focus) ? "neighborhood" : focus === "hub" || focus === "neighborhood" ? focus : "all");
    setSelectedNeighborhoodId(root);
    if (type === "all" || type === "collateral" || type === "wrapper") setEdgeTypeFilter(type);
    const parsedLimit = NODE_LIMIT_OPTIONS.find((option) => String(option) === limit);
    if (parsedLimit !== undefined) setNodeLimit(parsedLimit);
    else if (root) setNodeLimit("all");
    setUrlReady(true);
  }, [syncUrlState, cards, dependencyEdges]);

  useEffect(() => {
    if (!syncUrlState || !urlReady) return;
    const url = new URL(window.location.href);
    const edgeFreeFocus = focusMode === "neighborhood" && selectedNeighborhoodId && !fullGraph.nodes.some(node => node.id === selectedNeighborhoodId);
    url.searchParams.set("focus", edgeFreeFocus ? selectedNeighborhoodId : focusMode);
    url.searchParams.set("type", edgeTypeFilter);
    url.searchParams.set("limit", String(nodeLimit));
    if (selectedNeighborhoodId) url.searchParams.set("trace", selectedNeighborhoodId);
    else url.searchParams.delete("trace");
    window.history.replaceState(window.history.state, "", url);
  }, [syncUrlState, urlReady, focusMode, edgeTypeFilter, nodeLimit, selectedNeighborhoodId, fullGraph]);

  const changeFocusMode = useCallback((value: FocusMode) => {
    if (value === focusMode) return;
    setFocusMode(value);
    if (trackActions) trackEvent("dependency_map_action", { action: "focus", value });
  }, [focusMode, trackActions]);
  const changeEdgeTypeFilter = useCallback((value: EdgeTypeFilter) => {
    if (value === edgeTypeFilter) return;
    setEdgeTypeFilter(value);
    if (trackActions) trackEvent("dependency_map_action", { action: "type", value });
  }, [edgeTypeFilter, trackActions]);
  const changeNodeLimit = useCallback((value: NodeLimitOption) => {
    if (value === nodeLimit) return;
    setNodeLimit(value);
    if (trackActions) trackEvent("dependency_map_action", { action: "limit", value: String(value) });
  }, [nodeLimit, trackActions]);
  const hubIdsByScore = useMemo(() => buildHubIdsByScore(nodes, supernodeState), [nodes, supernodeState]);
  const nodeSelectOptions = useMemo(() => {
    const options = buildNodeSelectOptions(fullGraph.nodes);
    if (syncUrlState) {
      const ids = new Set(options.map(node => node.id));
      for (const coin of CLIENT_TRACKED_META_BY_ID.values()) {
        if (!ids.has(coin.id)) options.push({ id: coin.id, symbol: coin.symbol, mcap: mcapMap.get(coin.id) ?? null });
      }
    }
    return options;
  }, [fullGraph.nodes, syncUrlState, mcapMap]);
  const effectiveSelectedNeighborhoodId = useMemo(
    () => selectedNeighborhoodId && CLIENT_TRACKED_META_BY_ID.has(selectedNeighborhoodId)
      ? selectedNeighborhoodId
      : resolveSelectedNeighborhoodId({ nodes, hubIdsByScore, selectedNeighborhoodId }),
    [hubIdsByScore, nodes, selectedNeighborhoodId],
  );
  const nodeMap = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const simulationKey = useMemo(
    () => buildSimulationKey(nodes, links, focusCoinId),
    [nodes, links, focusCoinId],
  );
  const layoutInput = useRef({ nodes, links, supernodeState });
  useEffect(() => { layoutInput.current = { nodes, links, supernodeState }; }, [nodes, links, supernodeState]);
  const [settledPositions, setSettledPositions] = useState<Map<string, { x: number; y: number }>>(() => new Map());
  useEffect(() => {
    const input = layoutInput.current;
    return runSimulationInChunks(input.nodes, input.links, input.supernodeState, setSettledPositions);
  }, [simulationKey]);
  const basePositions = useMemo(() => {
    const positions = new Map<string, { x: number; y: number }>();
    for (const node of nodes) {
      positions.set(node.id, settledPositions.get(node.id)
        ?? supernodeState.layoutTargetById.get(node.id) ?? { x: WIDTH / 2, y: HEIGHT / 2 });
    }
    return positions;
  }, [nodes, settledPositions, supernodeState.layoutTargetById]);
  const drag = useContagionGraphDrag({ nodeMap, basePositions, simulationKey });
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
        focusMode: exposureOverlay ? "all" : focusMode,
        edgeTypeFilter: exposureOverlay ? "all" : edgeTypeFilter,
        neighborhoodFocusId,
        nodes,
        hubIdsByScore,
      }),
    [edgeTypeFilter, focusMode, hubIdsByScore, neighborhoodFocusId, nodes, resolvedLinks, exposureOverlay],
  );
  const emptyFocusCoin = !exposureOverlay && focusMode === "neighborhood" && effectiveSelectedNeighborhoodId
    && !fullGraph.nodes.some(node => node.id === effectiveSelectedNeighborhoodId)
    ? CLIENT_TRACKED_META_BY_ID.get(effectiveSelectedNeighborhoodId) ?? null : null;
  const smallLinkCount = visibleLinks.filter(link => !link.shareUnknown && link.weight < SMALL_LINK_SHARE_THRESHOLD).length;
  const canvasLinks = useMemo(() => {
    const highlighted = highlightedExposureEdges(exposureOverlay?.highlightedPaths ?? []);
    return showSmallLinks ? visibleLinks : visibleLinks.filter(link => highlighted.has(`${link.srcId}\0${link.tgtId}`) || link.shareUnknown || link.weight >= SMALL_LINK_SHARE_THRESHOLD);
  }, [showSmallLinks, visibleLinks, exposureOverlay]);
  const activeHoveredEdge = hoveredEdge !== null && visibleLinkIndices.has(hoveredEdge) ? hoveredEdge : null;
  const activeHoveredId = hoveredId !== null && visibleNodeIds.has(hoveredId) ? hoveredId : null;
  const rippleState = useMemo(() => computeRippleState(activeHoveredId, visibleLinks), [activeHoveredId, visibleLinks]);
  const exposureNodeIds = useMemo(() => new Set([
    ...(exposureOverlay?.roots ?? []), ...(exposureOverlay?.rows.keys() ?? []),
  ]), [exposureOverlay]);
  const highlightedPathEdges = useMemo(
    () => highlightedExposureEdges(exposureOverlay?.highlightedPaths ?? []), [exposureOverlay],
  );

  const handleTraceNodeChange = useCallback((nodeId: string | null) => {
    setSelectedNeighborhoodId(nodeId);
    if (nodeId) changeFocusMode("neighborhood");
    if (trackActions && nodeId !== selectedNeighborhoodId) trackEvent("dependency_map_action", { action: "trace", value: nodeId ?? "" });
  }, [changeFocusMode, selectedNeighborhoodId, trackActions]);

  const handleNodeKeyDown = useCallback(
    (event: React.KeyboardEvent<SVGGElement>, nodeId: string) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setSelectedNeighborhoodId(nodeId);
        if (trackActions && nodeId !== selectedNeighborhoodId) trackEvent("dependency_map_action", { action: "trace", value: nodeId });
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
      // Resolved from the event's own <svg> so the inline card and the fullscreen dialog each
      // move focus inside the stage the key press came from.
      const target = bestId
        ? (event.currentTarget.ownerSVGElement?.querySelector(`[data-node-id="${bestId}"]`) as HTMLElement | null)
        : null;
      target?.focus();
    },
    [drag.positions, resolvedLinks, trackActions, selectedNeighborhoodId],
  );

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
  const handleNodeClick = useCallback(
    (nodeId: string) => {
      if (drag.dragId) return;
      if (drag.consumeDragMovedSincePointerDown()) return;
      setSelectedNeighborhoodId(nodeId);
      if (trackActions && nodeId !== selectedNeighborhoodId) trackEvent("dependency_map_action", { action: "trace", value: nodeId });
    },
    [drag, trackActions, selectedNeighborhoodId],
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
    if (trackActions && selectedNeighborhoodId) trackEvent("dependency_map_action", { action: "trace", value: "" });
    setHoveredId(null);
    setHoveredEdge(null);
    setFocusedId(null);
  }, [trackActions, selectedNeighborhoodId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      if (target instanceof Element && target.closest('[role="dialog"]')) return;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      handleClearSelection();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [handleClearSelection]);

  return {
    nodes,
    emptyFocusCoin,
    supernodeState,
    focusMode,
    setFocusMode: changeFocusMode,
    edgeTypeFilter,
    setEdgeTypeFilter: changeEdgeTypeFilter,
    nodeLimit,
    effectiveNodeLimit,
    setNodeLimit: changeNodeLimit,
    nodeSelectOptions,
    effectiveSelectedNeighborhoodId,
    pinnedSelectionId: selectedNeighborhoodId,
    handleTraceNodeChange,
    nodeMap,
    resolvedLinkByIndex,
    visibleLinks,
    canvasLinks,
    smallLinkCount,
    showSmallLinks,
    setShowSmallLinks,
    directExposureById,
    fullResolvedLinks,
    exposureOverlay,
    exposureNodeIds,
    highlightedPathEdges,
    onUseAsExposureRoot,
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
