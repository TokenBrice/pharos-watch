"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { AccessibilityLedger } from "./components/accessibility-ledger";
import { useFullscreenMode } from "./hooks/use-fullscreen-mode";
import { PharosVilleAssetManager } from "./renderer/asset-manager";
import { collectHitTargets, hitTest, type HitTarget } from "./renderer/hit-testing";
import { drawPharosVille } from "./renderer/world-canvas";
import { clampCameraToMap, defaultCamera, panCamera } from "./systems/camera";
import { resolveCanvasBudget } from "./systems/canvas-budget";
import { buildMotionPlan } from "./systems/motion";
import { zoomCameraAt, type IsoCamera, type ScreenPoint } from "./systems/projection";
import { observeReducedMotion } from "./systems/reduced-motion";
import type { PharosVilleWorld as PharosVilleWorldModel } from "./systems/world-types";

export function PharosVilleWorld({ world }: { world: PharosVilleWorldModel }) {
  const [assetManager] = useState(() => new PharosVilleAssetManager());
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ last: ScreenPoint; moved: boolean; pointerId: number } | null>(null);
  const animationFramePendingRef = useRef(false);
  const canvasBudgetRef = useRef<ReturnType<typeof resolveCanvasBudget> | null>(null);
  const motionStartTimeRef = useRef<number | null>(null);
  const motionFrameCountRef = useRef(0);
  const [camera, setCamera] = useState<IsoCamera | null>(null);
  const [canvasSize, setCanvasSize] = useState<ScreenPoint>({ x: 0, y: 0 });
  const [hoveredDetailId, setHoveredDetailId] = useState<string | null>(null);
  const [selectedDetailId, setSelectedDetailId] = useState<string | null>("lighthouse");
  const [announcement, setAnnouncement] = useState("PharosVille ready.");
  const [assetLoadTick, setAssetLoadTick] = useState(0);
  const [assetsLoaded, setAssetsLoaded] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(true);
  const shellRef = useRef<HTMLElement | null>(null);
  const { exitFullscreen, fullscreenMode, toggleFullscreen } = useFullscreenMode(shellRef);
  const motionPlan = useMemo(() => buildMotionPlan(world, selectedDetailId), [selectedDetailId, world]);
  const hitTargets = useMemo(() => {
    void assetLoadTick;
    return camera ? collectHitTargets({ assets: assetManager, camera, hoveredDetailId, selectedDetailId, world }) : [];
  }, [assetLoadTick, assetManager, camera, hoveredDetailId, selectedDetailId, world]);
  const hoveredTarget = hitTargets.find((target) => target.detailId === hoveredDetailId) ?? null;
  const selectedTarget = hitTargets.find((target) => target.detailId === selectedDetailId) ?? null;

  const selectDetail = useCallback((detailId: string) => {
    const detail = world.detailIndex[detailId];
    setSelectedDetailId(detailId);
    setAnnouncement(detail ? `Selected ${detail.title}.` : "Selected map entity.");
  }, [world.detailIndex]);

  const clearSelection = useCallback(() => {
    setSelectedDetailId(null);
    setAnnouncement("Selection cleared.");
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    assetManager.loadCritical(controller.signal)
      .then(() => {
        setAssetLoadTick((tick) => tick + 1);
        return assetManager.loadDeferred(controller.signal);
      })
      .then(() => {
        setAssetsLoaded(true);
        setAssetLoadTick((tick) => tick + 1);
      })
      .catch(() => setAssetLoadTick((tick) => tick + 1));
    return () => {
      controller.abort();
    };
  }, [assetManager]);

  useEffect(() => observeReducedMotion(setReducedMotion), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const cssWidth = Math.max(1, Math.floor(rect.width));
      const cssHeight = Math.max(1, Math.floor(rect.height));
      const budget = resolveCanvasBudget({
        cssHeight,
        cssWidth,
        requestedDpr: window.devicePixelRatio || 1,
      });
      canvasBudgetRef.current = budget;
      const nextWidth = budget.backingWidth;
      const nextHeight = budget.backingHeight;
      if (canvas.width !== nextWidth) canvas.width = nextWidth;
      if (canvas.height !== nextHeight) canvas.height = nextHeight;
      const nextCanvasSize = { x: cssWidth, y: cssHeight };
      setCanvasSize(nextCanvasSize);
      setCamera((previous) => previous
        ? clampCameraToMap(previous, { map: world.map, viewport: nextCanvasSize })
        : defaultCamera({ width: cssWidth, height: cssHeight, map: world.map }));
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [world.map]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !camera || canvasSize.x <= 0 || canvasSize.y <= 0) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    const budget = canvasBudgetRef.current ?? resolveCanvasBudget({
      cssHeight: canvasSize.y,
      cssWidth: canvasSize.x,
      requestedDpr: window.devicePixelRatio || 1,
    });
    const dpr = budget.effectiveDpr;
    let frameId = 0;
    const drawFrame = (time: number) => {
      animationFramePendingRef.current = false;
      if (motionStartTimeRef.current == null) motionStartTimeRef.current = time;
      const timeSeconds = reducedMotion ? 0 : (time - motionStartTimeRef.current) / 1000;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawPharosVille({
        camera,
        ctx,
        height: canvasSize.y,
        hoveredTarget,
        motion: {
          plan: motionPlan,
          reducedMotion,
          timeSeconds,
        },
        selectedTarget,
        targets: hitTargets,
        width: canvasSize.x,
        world,
        assets: assetManager,
      });
      if (!reducedMotion) {
        motionFrameCountRef.current += 1;
        updateDebugMotion({ frameCount: motionFrameCountRef.current, reducedMotion });
        animationFramePendingRef.current = true;
        frameId = requestAnimationFrame(drawFrame);
      }
    };
    drawFrame(performance.now());
    return () => {
      animationFramePendingRef.current = false;
      if (frameId) cancelAnimationFrame(frameId);
    };
  }, [assetLoadTick, assetManager, camera, canvasSize.x, canvasSize.y, hitTargets, hoveredTarget, motionPlan, reducedMotion, selectedTarget, world]);

  useEffect(() => {
    if (process.env.NODE_ENV === "production" && window.location.hostname !== "localhost") return;
    const debugWindow = window as typeof window & {
      __pharosVilleDebug?: {
        camera: IsoCamera | null;
        cameraWithinBounds: boolean;
        assetsLoaded: boolean;
        canvasBudget: ReturnType<typeof resolveCanvasBudget> | null;
        canvasSize: ScreenPoint;
        animationFramePending: boolean;
        motionFrameCount: number;
        reducedMotion: boolean;
        selectedDetailId: string | null;
        targets: readonly HitTarget[];
      };
    };
    debugWindow.__pharosVilleDebug = {
      camera,
      cameraWithinBounds: isCameraWithinBounds(camera, world.map, canvasSize),
      assetsLoaded,
      animationFramePending: animationFramePendingRef.current,
      canvasBudget: canvasBudgetRef.current,
      canvasSize,
      motionFrameCount: motionFrameCountRef.current,
      reducedMotion,
      selectedDetailId,
      targets: hitTargets,
    };
    return () => {
      delete debugWindow.__pharosVilleDebug;
    };
  }, [assetsLoaded, camera, canvasSize, hitTargets, reducedMotion, selectedDetailId, world.map]);

  const canvasPoint = useCallback((event: ReactPointerEvent<HTMLCanvasElement> | ReactWheelEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const rect = canvas?.getBoundingClientRect();
    return {
      x: event.clientX - (rect?.left ?? 0),
      y: event.clientY - (rect?.top ?? 0),
    };
  }, []);

  const updateHover = useCallback((point: ScreenPoint) => {
    const target = hitTest(hitTargets, point);
    setHoveredDetailId((previous) => previous === target?.detailId ? previous : (target?.detailId ?? null));
  }, [hitTargets]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { last: canvasPoint(event), moved: false, pointerId: event.pointerId };
  }, [canvasPoint]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = canvasPoint(event);
    const drag = dragRef.current;
    if (drag?.pointerId === event.pointerId) {
      const delta = { x: point.x - drag.last.x, y: point.y - drag.last.y };
      if (Math.abs(delta.x) + Math.abs(delta.y) > 1) {
        drag.moved = true;
        setCamera((previous) => previous ? panCamera(previous, delta, { map: world.map, viewport: canvasSize }) : previous);
      }
      drag.last = point;
      return;
    }
    updateHover(point);
  }, [canvasPoint, canvasSize, updateHover, world.map]);

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = canvasPoint(event);
    const drag = dragRef.current;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (drag?.moved) return;
    const target = hitTest(hitTargets, point);
    if (target) selectDetail(target.detailId);
  }, [canvasPoint, hitTargets, selectDetail]);

  const handleWheel = useCallback((event: ReactWheelEvent<HTMLCanvasElement>) => {
    if (!camera) return;
    event.preventDefault();
    const direction = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    setCamera(clampCameraToMap(zoomCameraAt(camera, canvasPoint(event), camera.zoom * direction), { map: world.map, viewport: canvasSize }));
  }, [camera, canvasPoint, canvasSize, world.map]);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (!camera) return;
    if (event.key === "Escape") {
      if (fullscreenMode) {
        event.preventDefault();
        exitFullscreen();
        return;
      }
      clearSelection();
      return;
    }
    const step = event.shiftKey ? 72 : 32;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const deltas: Record<string, ScreenPoint> = {
        ArrowDown: { x: 0, y: -step },
        ArrowLeft: { x: step, y: 0 },
        ArrowRight: { x: -step, y: 0 },
        ArrowUp: { x: 0, y: step },
      };
      setCamera(panCamera(camera, deltas[event.key], { map: world.map, viewport: canvasSize }));
    }
  }, [camera, canvasSize, clearSelection, exitFullscreen, fullscreenMode, world.map]);

  return (
    <main
      ref={shellRef}
      className={fullscreenMode ? "pharosville-desktop pharosville-shell pharosville-shell--fullscreen" : "pharosville-desktop pharosville-shell"}
      data-testid="pharosville-world"
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      <canvas
        ref={canvasRef}
        className={hoveredTarget ? "pharosville-canvas pharosville-canvas--selectable" : "pharosville-canvas"}
        data-testid="pharosville-canvas"
        aria-hidden="true"
        onPointerDown={handlePointerDown}
        onPointerLeave={() => setHoveredDetailId(null)}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onWheel={handleWheel}
      />
      <button
        type="button"
        className="pharosville-fullscreen-button"
        aria-label={fullscreenMode ? "Exit fullscreen" : "Enter fullscreen"}
        title={fullscreenMode ? "Exit fullscreen" : "Enter fullscreen"}
        onClick={toggleFullscreen}
      >
        {fullscreenMode ? <Minimize2 aria-hidden="true" size={17} /> : <Maximize2 aria-hidden="true" size={17} />}
      </button>
      <p className="sr-only" aria-live="polite">{announcement}</p>
      <AccessibilityLedger world={world} />
    </main>
  );
}

function isCameraWithinBounds(camera: IsoCamera | null, map: PharosVilleWorldModel["map"], viewport: ScreenPoint) {
  if (!camera || viewport.x <= 0 || viewport.y <= 0) return false;
  const clamped = clampCameraToMap(camera, { map, viewport });
  return (
    Math.abs(clamped.offsetX - camera.offsetX) <= 1
    && Math.abs(clamped.offsetY - camera.offsetY) <= 1
    && clamped.zoom === camera.zoom
  );
}

function updateDebugMotion(input: { frameCount: number; reducedMotion: boolean }) {
  if (process.env.NODE_ENV === "production" && window.location.hostname !== "localhost") return;
  const debugWindow = window as typeof window & {
    __pharosVilleDebug?: {
      motionFrameCount?: number;
      reducedMotion?: boolean;
    };
  };
  if (!debugWindow.__pharosVilleDebug) return;
  debugWindow.__pharosVilleDebug.motionFrameCount = input.frameCount;
  debugWindow.__pharosVilleDebug.reducedMotion = input.reducedMotion;
}
