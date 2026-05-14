"use client";

import { useCallback, useMemo, useRef, useState } from "react";
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
  simulationKey: _simulationKey,
}: UseContagionGraphDragOptions) {
  const [pinnedPositions, setPinnedPositions] = useState<Map<string, { x: number; y: number }>>(new Map());
  const [dragId, setDragId] = useState<string | null>(null);
  const dragMoved = useRef(false);
  const dragStart = useRef<{ mx: number; my: number; nx: number; ny: number } | null>(null);

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
    setDragId(nodeId);
    dragMoved.current = false;
    dragStart.current = {
      mx: svgPoint.x,
      my: svgPoint.y,
      nx: position.x,
      ny: position.y,
    };
  }, [positions, svgRef]);

  const handlePointerMove = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    if (!dragId || !dragStart.current) return;
    const svgPoint = projectClientPoint(svgRef.current, event.clientX, event.clientY);
    if (!svgPoint) return;

    const dx = svgPoint.x - dragStart.current.mx;
    const dy = svgPoint.y - dragStart.current.my;
    if (Math.abs(dx) + Math.abs(dy) > 1) dragMoved.current = true;

    setPinnedPositions((previous) => {
      const next = new Map(previous);
      const radius = nodeMap.get(dragId)?.r ?? MIN_RADIUS;
      const start = dragStart.current;
      if (start) {
        next.set(dragId, clampGraphPosition(start.nx + dx, start.ny + dy, radius));
      }
      return next;
    });
  }, [dragId, nodeMap, svgRef]);

  const handlePointerUp = useCallback(() => {
    setDragId(null);
    dragStart.current = null;
  }, []);

  const unpinNode = useCallback((nodeId: string) => {
    setPinnedPositions((previous) => {
      if (!previous.has(nodeId)) return previous;
      const next = new Map(previous);
      next.delete(nodeId);
      return next;
    });
  }, []);

  const unpinAll = useCallback(() => setPinnedPositions(new Map()), []);

  const pinnedNodeIds = useMemo<ReadonlySet<string>>(() => new Set(pinnedPositions.keys()), [pinnedPositions]);

  return {
    dragId,
    positions,
    pinnedPositions,
    pinnedNodeIds,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    unpinNode,
    unpinAll,
  };
}
