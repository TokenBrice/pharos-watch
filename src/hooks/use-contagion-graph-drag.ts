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

interface DragState {
  baseKey: string;
  positions: Map<string, { x: number; y: number }>;
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
  simulationKey,
}: UseContagionGraphDragOptions) {
  const [draggedPositions, setDraggedPositions] = useState<DragState>({
    baseKey: "",
    positions: new Map(),
  });
  const [dragId, setDragId] = useState<string | null>(null);
  const dragStart = useRef<{ mx: number; my: number; nx: number; ny: number } | null>(null);

  const positions = useMemo(() => {
    if (draggedPositions.baseKey !== simulationKey || draggedPositions.positions.size === 0) {
      return basePositions;
    }

    const next = new Map(basePositions);
    for (const [id, position] of draggedPositions.positions) {
      if (next.has(id)) next.set(id, position);
    }
    return next;
  }, [basePositions, draggedPositions, simulationKey]);

  const handlePointerDown = useCallback((event: React.PointerEvent, nodeId: string) => {
    if (!event.isPrimary) return;
    event.preventDefault();
    const svgPoint = projectClientPoint(svgRef.current, event.clientX, event.clientY);
    if (!svgPoint) return;
    const position = positions.get(nodeId);
    if (!position) return;

    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragId(nodeId);
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

    setDraggedPositions((previous) => {
      const next = previous.baseKey === simulationKey
        ? new Map(previous.positions)
        : new Map<string, { x: number; y: number }>();
      const radius = nodeMap.get(dragId)?.r ?? MIN_RADIUS;
      const start = dragStart.current;
      if (start) {
        next.set(dragId, clampGraphPosition(start.nx + dx, start.ny + dy, radius));
      }
      return {
        baseKey: simulationKey,
        positions: next,
      };
    });
  }, [dragId, nodeMap, simulationKey, svgRef]);

  const handlePointerUp = useCallback(() => {
    setDragId(null);
    dragStart.current = null;
  }, []);

  return {
    dragId,
    positions,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
  };
}
