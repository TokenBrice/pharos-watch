"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clampGraphPosition, MIN_RADIUS } from "@/lib/contagion-layout";

interface PositionedNode {
  r: number;
}

interface UseContagionGraphDragOptions {
  svgRef: React.RefObject<SVGSVGElement | null>;
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
  svgRef,
  nodeMap,
  basePositions,
  simulationKey,
}: UseContagionGraphDragOptions) {
  const [pinnedState, setPinnedState] = useState<PinnedPositionState>(() => ({
    simulationKey,
    positions: new Map(),
  }));
  const [dragState, setDragState] = useState<DragState>({ simulationKey: null, id: null });
  const dragIdRef = useRef<string | null>(null);
  const dragSimulationKeyRef = useRef<string | null>(null);
  const dragMoved = useRef(false);
  const dragMovedSincePointerDown = useRef(false);
  const dragStart = useRef<{ mx: number; my: number; nx: number; ny: number } | null>(null);

  useEffect(() => {
    // Reset drag pins when the graph topology key changes; old coordinates do not apply to the new simulation.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPinnedState((previous) => (
      previous.simulationKey === simulationKey
        ? previous
        : { simulationKey, positions: new Map() }
    ));
  }, [simulationKey]);

  const pinnedPositions = pinnedState.simulationKey === simulationKey
    ? pinnedState.positions
    : EMPTY_PINNED_POSITIONS;
  const activeDragId = dragState.simulationKey === simulationKey ? dragState.id : null;

  const positions = useMemo(() => {
    if (pinnedPositions.size === 0) return basePositions;
    const next = new Map(basePositions);
    for (const [id, position] of pinnedPositions) {
      if (next.has(id)) next.set(id, position);
    }
    return next;
  }, [basePositions, pinnedPositions]);

  const handlePointerDown = useCallback((event: React.PointerEvent, nodeId: string) => {
    if (event.isPrimary === false) return;
    event.preventDefault();
    const svgPoint = projectClientPoint(svgRef.current, event.clientX, event.clientY);
    if (!svgPoint) return;
    const position = positions.get(nodeId);
    if (!position) return;

    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragIdRef.current = nodeId;
    dragSimulationKeyRef.current = simulationKey;
    setDragState({ simulationKey, id: nodeId });
    dragMoved.current = false;
    dragMovedSincePointerDown.current = false;
    dragStart.current = {
      mx: svgPoint.x,
      my: svgPoint.y,
      nx: position.x,
      ny: position.y,
    };
  }, [positions, simulationKey, svgRef]);

  const handlePointerMove = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    const activeDragId = dragIdRef.current;
    if (!activeDragId || dragSimulationKeyRef.current !== simulationKey || !dragStart.current) return;
    const svgPoint = projectClientPoint(svgRef.current, event.clientX, event.clientY);
    if (!svgPoint) return;

    const dx = svgPoint.x - dragStart.current.mx;
    const dy = svgPoint.y - dragStart.current.my;
    if (Math.abs(dx) + Math.abs(dy) > 1) {
      dragMoved.current = true;
      dragMovedSincePointerDown.current = true;
    }

    setPinnedState((previous) => {
      const previousPositions = previous.simulationKey === simulationKey
        ? previous.positions
        : EMPTY_PINNED_POSITIONS;
      const next = new Map(previousPositions);
      const radius = nodeMap.get(activeDragId)?.r ?? MIN_RADIUS;
      const start = dragStart.current;
      if (start) {
        next.set(activeDragId, clampGraphPosition(start.nx + dx, start.ny + dy, radius));
      }
      return { simulationKey, positions: next };
    });
  }, [nodeMap, simulationKey, svgRef]);

  const handlePointerUp = useCallback(() => {
    dragIdRef.current = null;
    dragSimulationKeyRef.current = null;
    setDragState({ simulationKey: null, id: null });
    dragStart.current = null;
  }, []);

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
    consumeDragMovedSincePointerDown,
    unpinNode,
    unpinAll,
  };
}
