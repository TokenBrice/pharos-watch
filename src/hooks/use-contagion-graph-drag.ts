"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { clampGraphPosition, MIN_RADIUS } from "@/lib/contagion-layout";
import { upstreamArrowPoint } from "@/components/contagion-graph/contagion-graph-exposure";

interface PositionedNode {
  r: number;
}

interface UseContagionGraphDragOptions {
  nodeMap: Map<string, PositionedNode>;
  basePositions: Map<string, { x: number; y: number }>;
  simulationKey: string;
}

interface PinnedPositionState {
  simulationKey: string;
  positions: Map<string, { x: number; y: number }>;
}

interface DragState {
  simulationKey: string | null;
  id: string | null;
  positions: Map<string, { x: number; y: number }> | null;
}

const EMPTY_PINNED_POSITIONS = new Map<string, { x: number; y: number }>();

function projectClientPoint(
  svg: SVGSVGElement | null,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  if (!svg) return null;
  const point = svg.createSVGPoint();
  point.x = clientX;
  point.y = clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  return point.matrixTransform(ctm.inverse());
}

export function useContagionGraphDrag({
  nodeMap,
  basePositions,
  simulationKey,
}: UseContagionGraphDragOptions) {
  const [pinnedState, setPinnedState] = useState<PinnedPositionState>(() => ({
    simulationKey,
    positions: new Map(),
  }));
  const [dragState, setDragState] = useState<DragState>({ simulationKey: null, id: null, positions: null });
  const dragIdRef = useRef<string | null>(null);
  const dragSimulationKeyRef = useRef<string | null>(null);
  const dragMovedSincePointerDown = useRef(false);
  const dragStart = useRef<{ mx: number; my: number; nx: number; ny: number } | null>(null);
  const dragElement = useRef<SVGGElement | null>(null);
  const pendingPosition = useRef<{ x: number; y: number } | null>(null);

  // Persist topology resets during render so returning to an old key cannot
  // resurrect pins from an earlier simulation.
  if (pinnedState.simulationKey !== simulationKey) {
    setPinnedState({ simulationKey, positions: new Map() });
  }

  const pinnedPositions = pinnedState.simulationKey === simulationKey
    ? pinnedState.positions
    : EMPTY_PINNED_POSITIONS;
  const activeDragId = dragState.simulationKey === simulationKey ? dragState.id : null;

  const positions = useMemo(() => {
    // A solver settle must not replace the coordinate frame beneath an imperative drag.
    // Consume the latest base positions when pointerup/cancel releases this snapshot.
    if (activeDragId && dragState.positions) return dragState.positions;
    if (pinnedPositions.size === 0) return basePositions;
    const next = new Map(basePositions);
    for (const [id, position] of pinnedPositions) {
      if (next.has(id)) next.set(id, position);
    }
    return next;
  }, [activeDragId, basePositions, dragState.positions, pinnedPositions]);

  // Resolve coordinates against the event's SVG, including after fullscreen remounts.
  const handlePointerDown = useCallback((event: React.PointerEvent<SVGGElement>, nodeId: string) => {
    if (event.isPrimary === false) return;
    // Touch selects coins; only background gestures pan the viewport.
    if (event.pointerType === "touch") return;
    event.preventDefault();
    const svgPoint = projectClientPoint(event.currentTarget.ownerSVGElement, event.clientX, event.clientY);
    if (!svgPoint) return;
    const position = positions.get(nodeId);
    if (!position) return;

    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragIdRef.current = nodeId;
    dragSimulationKeyRef.current = simulationKey;
    setDragState({ simulationKey, id: nodeId, positions });
    dragMovedSincePointerDown.current = false;
    dragElement.current = event.currentTarget;
    pendingPosition.current = null;
    dragStart.current = {
      mx: svgPoint.x,
      my: svgPoint.y,
      nx: position.x,
      ny: position.y,
    };
  }, [positions, simulationKey]);

  const handlePointerMove = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    const activeDragId = dragIdRef.current;
    if (!activeDragId || dragSimulationKeyRef.current !== simulationKey || !dragStart.current) return;
    const svgPoint = projectClientPoint(event.currentTarget, event.clientX, event.clientY);
    if (!svgPoint) return;

    const dx = svgPoint.x - dragStart.current.mx;
    const dy = svgPoint.y - dragStart.current.my;
    if (Math.abs(dx) + Math.abs(dy) > 1) {
      dragMovedSincePointerDown.current = true;
    }

    const radius = nodeMap.get(activeDragId)?.r ?? MIN_RADIUS;
    const position = clampGraphPosition(dragStart.current.nx + dx, dragStart.current.ny + dy, radius);
    pendingPosition.current = position;
    const svg = event.currentTarget;
    const wrapper = dragElement.current?.closest("[data-drag-node]") ?? dragElement.current;
    wrapper?.setAttribute("transform", `translate(${position.x - dragStart.current.nx} ${position.y - dragStart.current.ny})`);
    // Logos use canvas-space clip circles; keep their clip and exposure halo with the node.
    for (const clip of svg.querySelectorAll<SVGCircleElement>("[data-clip-node]")) {
      if (clip.dataset.clipNode === activeDragId) {
        clip.setAttribute("cx", String(position.x));
        clip.setAttribute("cy", String(position.y));
      }
    }
    for (const edge of svg.querySelectorAll<SVGGElement>("[data-edge-source]")) {
      const sourceId = edge.dataset.edgeSource!;
      const targetId = edge.dataset.edgeTarget!;
      if (sourceId !== activeDragId && targetId !== activeDragId) continue;
      const source = sourceId === activeDragId ? position : positions.get(sourceId);
      const target = targetId === activeDragId ? position : positions.get(targetId);
      if (!source || !target) continue;
      const tip = upstreamArrowPoint(source, target, Number(edge.dataset.targetRadius));
      const lines = edge.querySelectorAll("line");
      lines.forEach((line, index) => {
        line.setAttribute("x1", String(source.x));
        line.setAttribute("y1", String(source.y));
        line.setAttribute("x2", String(index === 0 ? target.x : tip.x));
        line.setAttribute("y2", String(index === 0 ? target.y : tip.y));
      });
    }
  }, [nodeMap, positions, simulationKey]);

  const handlePointerUp = useCallback(() => {
    const id = dragIdRef.current;
    const position = pendingPosition.current;
    if (id && position && dragSimulationKeyRef.current === simulationKey) {
      setPinnedState(previous => {
        const next = new Map(previous.simulationKey === simulationKey ? previous.positions : EMPTY_PINNED_POSITIONS);
        next.set(id, position);
        return { simulationKey, positions: next };
      });
    }
    (dragElement.current?.closest("[data-drag-node]") ?? dragElement.current)?.removeAttribute("transform");
    dragElement.current = null;
    pendingPosition.current = null;
    dragIdRef.current = null;
    dragSimulationKeyRef.current = null;
    setDragState({ simulationKey: null, id: null, positions: null });
    dragStart.current = null;
  }, [simulationKey]);

  const consumeDragMovedSincePointerDown = useCallback(() => {
    const moved = dragMovedSincePointerDown.current;
    dragMovedSincePointerDown.current = false;
    return moved;
  }, []);

  const unpinNode = useCallback((nodeId: string) => {
    setPinnedState((previous) => {
      const previousPositions = previous.simulationKey === simulationKey
        ? previous.positions
        : EMPTY_PINNED_POSITIONS;
      if (!previousPositions.has(nodeId)) return previous;
      const next = new Map(previousPositions);
      next.delete(nodeId);
      return { simulationKey, positions: next };
    });
  }, [simulationKey]);

  const unpinAll = useCallback(() => setPinnedState({ simulationKey, positions: new Map() }), [simulationKey]);

  const pinnedNodeIds = useMemo<ReadonlySet<string>>(() => new Set(pinnedPositions.keys()), [pinnedPositions]);

  return {
    dragId: activeDragId,
    positions,
    pinnedPositions,
    pinnedNodeIds,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel: handlePointerUp,
    consumeDragMovedSincePointerDown,
    unpinNode,
    unpinAll,
  };
}
