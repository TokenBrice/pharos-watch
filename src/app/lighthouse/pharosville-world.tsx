"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import { AccessibilityLedger } from "./components/accessibility-ledger";
import { DetailPanel } from "./components/detail-panel";
import { KeyboardEntityBrowser } from "./components/keyboard-entity-browser";
import { MapKey } from "./components/map-key";
import { QueryStatusBanner } from "./components/query-status-banner";
import { WorldToolbar } from "./components/world-toolbar";
import { PharosVilleAssetManager } from "./renderer/asset-manager";
import { collectHitTargets, hitTest, type HitTarget } from "./renderer/hit-testing";
import { drawPharosVille } from "./renderer/world-canvas";
import { cameraZoomLabel, clampCameraToMap, defaultCamera, followTile, panCamera, zoomIn, zoomOut } from "./systems/camera";
import { buildMotionPlan } from "./systems/motion";
import { screenToTile, zoomCameraAt, type IsoCamera, type ScreenPoint } from "./systems/projection";
import { observeReducedMotion } from "./systems/reduced-motion";
import type { PharosVilleWorld as PharosVilleWorldModel, TileKind } from "./systems/world-types";

export function PharosVilleWorld({ world }: { world: PharosVilleWorldModel }) {
  const [assetManager] = useState(() => new PharosVilleAssetManager());
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const minimapRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ last: ScreenPoint; moved: boolean; pointerId: number } | null>(null);
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
  const selectedDetail = useMemo(
    () => selectedDetailId ? (world.detailIndex[selectedDetailId] ?? null) : null,
    [selectedDetailId, world.detailIndex],
  );
  const selectedEntity = useMemo(() => collectEntityByDetailId(world, selectedDetailId), [selectedDetailId, world]);
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

  const resetCamera = useCallback(() => {
    if (canvasSize.x <= 0 || canvasSize.y <= 0) return;
    setCamera(defaultCamera({ width: canvasSize.x, height: canvasSize.y, map: world.map }));
  }, [canvasSize.x, canvasSize.y, world.map]);

  const followSelected = useCallback(() => {
    if (!camera || !selectedEntity || canvasSize.x <= 0 || canvasSize.y <= 0) return;
    setCamera(followTile({
      camera,
      map: world.map,
      tile: selectedEntity.tile,
      viewport: canvasSize,
    }));
  }, [camera, canvasSize, selectedEntity, world.map]);

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
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const nextWidth = Math.floor(cssWidth * dpr);
      const nextHeight = Math.floor(cssHeight * dpr);
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
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let frameId = 0;
    const drawFrame = (time: number) => {
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
        frameId = requestAnimationFrame(drawFrame);
      }
    };
    drawFrame(performance.now());
    return () => {
      if (frameId) cancelAnimationFrame(frameId);
    };
  }, [assetLoadTick, assetManager, camera, canvasSize.x, canvasSize.y, hitTargets, hoveredTarget, motionPlan, reducedMotion, selectedTarget, world]);

  useEffect(() => {
    const minimap = minimapRef.current;
    if (!minimap || !camera) return;
    drawMinimap(minimap, world, selectedEntity, camera, canvasSize);
  }, [camera, canvasSize, selectedEntity, world]);

  useEffect(() => {
    if (process.env.NODE_ENV === "production" && window.location.hostname !== "localhost") return;
    const debugWindow = window as typeof window & {
      __pharosVilleDebug?: {
        camera: IsoCamera | null;
        cameraWithinBounds: boolean;
        assetsLoaded: boolean;
        canvasSize: ScreenPoint;
        motionFrameCount: number;
        reducedMotion: boolean;
        targets: readonly HitTarget[];
      };
    };
    debugWindow.__pharosVilleDebug = {
      camera,
      cameraWithinBounds: isCameraWithinBounds(camera, world.map, canvasSize),
      assetsLoaded,
      canvasSize,
      motionFrameCount: motionFrameCountRef.current,
      reducedMotion,
      targets: hitTargets,
    };
    return () => {
      delete debugWindow.__pharosVilleDebug;
    };
  }, [assetsLoaded, camera, canvasSize, hitTargets, reducedMotion, world.map]);

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
  }, [camera, canvasSize, clearSelection, world.map]);

  const handleMinimapClick = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!camera) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * world.map.width;
    const y = ((event.clientY - rect.top) / rect.height) * world.map.height;
    setCamera(followTile({ camera, map: world.map, tile: { x, y }, viewport: canvasSize }));
  }, [camera, canvasSize, world.map]);

  return (
    <main
      className="pharosville-desktop pharosville-shell"
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
      <WorldToolbar
        world={world}
        selectedDetailId={selectedDetailId}
        zoomLabel={camera ? cameraZoomLabel(camera) : "Fit"}
        onClearSelection={clearSelection}
        onFollowSelected={selectedEntity ? followSelected : undefined}
        onPan={(delta) => setCamera((previous) => previous ? panCamera(previous, delta, { map: world.map, viewport: canvasSize }) : previous)}
        onResetView={resetCamera}
        onZoomIn={() => setCamera((previous) => previous ? zoomIn(previous, canvasSize, world.map) : previous)}
        onZoomOut={() => setCamera((previous) => previous ? zoomOut(previous, canvasSize, world.map) : previous)}
      />
      <canvas
        ref={minimapRef}
        className="pharosville-minimap"
        aria-label="Minimap, click to pan PharosVille"
        data-testid="pharosville-minimap"
        height={128}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            resetCamera();
          }
        }}
        onPointerDown={handleMinimapClick}
        role="button"
        tabIndex={0}
        title="Click to pan the PharosVille map"
        width={128}
      />
      <aside className="pharosville-panel" aria-labelledby="pharosville-panel-title">
        <h2 id="pharosville-panel-title">PharosVille</h2>
        <QueryStatusBanner world={world} />
        <MapKey world={world} />
        <DetailPanel detail={selectedDetail} onClose={clearSelection} />
        <KeyboardEntityBrowser
          world={world}
          selectedDetailId={selectedDetailId}
          onSelectDetail={selectDetail}
        />
      </aside>
      <p className="sr-only" aria-live="polite">{announcement}</p>
      <AccessibilityLedger world={world} />
    </main>
  );
}

function collectEntityByDetailId(world: PharosVilleWorldModel, detailId: string | null) {
  if (!detailId) return null;
  return [world.lighthouse, ...world.docks, ...world.ships, ...world.shipClusters, ...world.graves]
    .find((entity) => entity.detailId === detailId) ?? null;
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

function drawMinimap(
  canvas: HTMLCanvasElement,
  world: PharosVilleWorldModel,
  selectedEntity: ReturnType<typeof collectEntityByDetailId>,
  camera: IsoCamera,
  viewport: ScreenPoint,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#061721";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const scaleX = canvas.width / world.map.width;
  const scaleY = canvas.height / world.map.height;
  const colors: Record<TileKind, string> = {
    "deep-water": "#052033",
    water: "#0d5f70",
    shore: "#b8af7f",
    land: "#d3c89a",
    road: "#9b835d",
  };
  for (const tile of world.map.tiles) {
    ctx.fillStyle = colors[tile.kind];
    ctx.fillRect(tile.x * scaleX, tile.y * scaleY, Math.ceil(scaleX), Math.ceil(scaleY));
  }
  if (selectedEntity) {
    ctx.strokeStyle = "#ffcc62";
    ctx.lineWidth = 2;
    ctx.strokeRect(selectedEntity.tile.x * scaleX - 3, selectedEntity.tile.y * scaleY - 3, 8, 8);
  }
  const center = screenToTile({ x: viewport.x / 2, y: viewport.y / 2 }, camera);
  ctx.strokeStyle = "#80d6ce";
  ctx.lineWidth = 2;
  ctx.strokeRect(
    Math.max(0, Math.min(canvas.width - 16, center.x * scaleX - 8)),
    Math.max(0, Math.min(canvas.height - 16, center.y * scaleY - 8)),
    16,
    16,
  );
}
