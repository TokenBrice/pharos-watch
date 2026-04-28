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
import { cameraZoomLabel, clampCameraToMap, defaultCamera, followTile, panCamera, zoomIn, zoomOut } from "./systems/camera";
import { screenToTile, tileToScreen, zoomCameraAt, type IsoCamera, type ScreenPoint } from "./systems/projection";
import type { PharosVilleWorld as PharosVilleWorldModel, TileKind } from "./systems/world-types";

function drawDiamond(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, fill: string) {
  ctx.beginPath();
  ctx.moveTo(x, y - height / 2);
  ctx.lineTo(x + width / 2, y);
  ctx.lineTo(x, y + height / 2);
  ctx.lineTo(x - width / 2, y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

function drawBuilding(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, roof: string, zoom: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(zoom, zoom);
  ctx.fillStyle = color;
  ctx.fillRect(-8, -22, 16, 18);
  ctx.fillStyle = roof;
  ctx.beginPath();
  ctx.moveTo(-10, -22);
  ctx.lineTo(0, -34);
  ctx.lineTo(10, -22);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawShip(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number, sail: string, hull: string, zoom: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale * zoom, scale * zoom);
  ctx.fillStyle = hull;
  ctx.beginPath();
  ctx.moveTo(-14, 0);
  ctx.lineTo(14, 0);
  ctx.lineTo(8, 8);
  ctx.lineTo(-9, 8);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#271b12";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = "#5c4932";
  ctx.fillRect(-1, -22, 2, 23);
  ctx.fillStyle = sail;
  ctx.beginPath();
  ctx.moveTo(1, -21);
  ctx.lineTo(1, -3);
  ctx.lineTo(14, -6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawSelectionRing(ctx: CanvasRenderingContext2D, target: HitTarget, color: string) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.strokeRect(target.rect.x, target.rect.y, target.rect.width, target.rect.height);
}

function drawAsset(
  ctx: CanvasRenderingContext2D,
  asset: NonNullable<ReturnType<PharosVilleAssetManager["get"]>>,
  x: number,
  y: number,
  scale: number,
) {
  const { entry, image } = asset;
  const width = entry.width * entry.displayScale * scale;
  const height = entry.height * entry.displayScale * scale;
  ctx.drawImage(
    image,
    Math.round(x - entry.anchor[0] * entry.displayScale * scale),
    Math.round(y - entry.anchor[1] * entry.displayScale * scale),
    Math.round(width),
    Math.round(height),
  );
}

function drawPharosVille(input: {
  camera: IsoCamera;
  ctx: CanvasRenderingContext2D;
  height: number;
  hoveredTarget: HitTarget | null;
  selectedTarget: HitTarget | null;
  targets: readonly HitTarget[];
  width: number;
  world: PharosVilleWorldModel;
  assets: PharosVilleAssetManager | null;
}) {
  const { assets, camera, ctx, height, hoveredTarget, selectedTarget, targets, width, world } = input;
  ctx.imageSmoothingEnabled = false;
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "#082337");
  gradient.addColorStop(0.55, "#0c4a5b");
  gradient.addColorStop(1, "#061721");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  const colors: Record<TileKind, string> = {
    "deep-water": "#061a2b",
    water: "#0d5f70",
    shore: "#b8af7f",
    land: "#d3c89a",
    road: "#9b835d",
  };

  for (const tile of world.map.tiles) {
    const p = tileToScreen(tile, camera);
    drawDiamond(ctx, p.x, p.y, 32 * camera.zoom, 16 * camera.zoom, colors[tile.kind]);
    if (tile.kind === "water" && (tile.x + tile.y) % 9 === 0) {
      ctx.fillStyle = "rgba(186, 231, 225, 0.22)";
      ctx.fillRect(p.x - 7 * camera.zoom, p.y - 1, 14 * camera.zoom, Math.max(1, camera.zoom));
    }
  }

  const center = tileToScreen(world.lighthouse.tile, camera);
  const lighthouseAsset = assets?.get("landmark.lighthouse");
  if (lighthouseAsset) {
    drawAsset(ctx, lighthouseAsset, center.x, center.y, camera.zoom);
    ctx.strokeStyle = "rgba(255, 204, 98, 0.35)";
    ctx.lineWidth = 18 * camera.zoom;
    ctx.beginPath();
    ctx.moveTo(center.x, center.y - 88 * camera.zoom);
    ctx.lineTo(center.x + 260 * camera.zoom, center.y - 150 * camera.zoom);
    ctx.stroke();
  } else {
    ctx.save();
    ctx.translate(center.x, center.y);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.fillStyle = "#f4f0d2";
    ctx.fillRect(-14, -76, 28, 62);
    ctx.fillStyle = "#d8d0ad";
    ctx.fillRect(-19, -17, 38, 15);
    ctx.fillStyle = "#a97b34";
    ctx.fillRect(-10, -88, 20, 12);
    ctx.fillStyle = world.lighthouse.color;
    ctx.beginPath();
    ctx.arc(0, -90, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 204, 98, 0.35)";
    ctx.lineWidth = 18;
    ctx.beginPath();
    ctx.moveTo(0, -88);
    ctx.lineTo(260, -150);
    ctx.stroke();
    ctx.restore();
  }

  const buildings = [
    [27, 27, "#d8cfaa", "#6f4e37"],
    [36, 30, "#efe4ba", "#7b3f35"],
    [31, 38, "#cbbd8e", "#5d5548"],
    [24, 35, "#e5d9ad", "#8a6841"],
    [40, 35, "#d8cfaa", "#6a7546"],
  ] as const;
  for (const [x, y, color, roof] of buildings) {
    const p = tileToScreen({ x, y }, camera);
    drawBuilding(ctx, p.x, p.y, color, roof, camera.zoom);
  }

  ctx.strokeStyle = "#6d4c2f";
  ctx.lineWidth = 5;
  for (const dock of world.docks) {
    const p = tileToScreen(dock.tile, camera);
    const reach = (26 + dock.size * 6) * camera.zoom;
    const dockAsset = assets?.get("dock.wooden-pier");
    if (dockAsset) {
      drawAsset(ctx, dockAsset, p.x + (dock.tile.x < 32 ? -reach * 0.25 : reach * 0.25), p.y + 10 * camera.zoom, camera.zoom * Math.max(0.7, dock.size / 5));
    } else {
      ctx.lineWidth = (3 + dock.size) * camera.zoom;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + (dock.tile.x < 32 ? -reach : reach), p.y + 10);
      ctx.stroke();
    }
  }

  const shipColors = {
    "treasury-galleon": "#8a4f2b",
    "crypto-caravel": "#58433a",
    "algo-junk": "#774734",
  };
  const pennants: Record<string, string> = {
    emerald: "#d7f0df",
    blue: "#d7e6f7",
    cyan: "#d7f0ee",
    gold: "#ffe1a0",
    silver: "#e5e7eb",
    slate: "#c7d0d8",
  };
  for (const ship of world.ships) {
    const p = tileToScreen(ship.tile, camera);
    const shipAsset = assets?.get(`ship.${ship.visual.hull}`);
    if (shipAsset) {
      drawAsset(ctx, shipAsset, p.x, p.y + 12 * camera.zoom, camera.zoom * ship.visual.scale * 0.7);
    } else {
      drawShip(ctx, p.x, p.y - 4 * camera.zoom, ship.visual.scale, pennants[ship.visual.pennant] ?? pennants.slate, shipColors[ship.visual.hull], camera.zoom);
    }
  }

  for (const cluster of world.shipClusters) {
    const p = tileToScreen(cluster.tile, camera);
    const radius = Math.min(18, 7 + Math.sqrt(cluster.count) * 2) * camera.zoom;
    ctx.fillStyle = "rgba(255, 204, 98, 0.85)";
    ctx.beginPath();
    ctx.arc(p.x, p.y - 4, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#061721";
    ctx.font = `700 ${Math.max(10, 10 * camera.zoom)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(String(cluster.count), p.x, p.y);
    ctx.textAlign = "start";
  }

  ctx.fillStyle = "#4d584c";
  const tombstoneAsset = assets?.get("prop.tombstone");
  for (const grave of world.graves) {
    const p = tileToScreen(grave.tile, camera);
    if (tombstoneAsset) {
      drawAsset(ctx, tombstoneAsset, p.x, p.y + 2 * camera.zoom, camera.zoom * 0.54);
    } else {
      ctx.fillRect(p.x - 3 * camera.zoom, p.y - 8 * camera.zoom, 6 * camera.zoom, 9 * camera.zoom);
      ctx.fillRect(p.x - 5 * camera.zoom, p.y, 10 * camera.zoom, 2 * camera.zoom);
    }
  }

  if (hoveredTarget) drawSelectionRing(ctx, hoveredTarget, "rgba(128, 214, 206, 0.85)");
  if (selectedTarget) drawSelectionRing(ctx, selectedTarget, "rgba(255, 204, 98, 0.95)");

  ctx.fillStyle = "rgba(3, 10, 18, 0.34)";
  ctx.fillRect(0, 0, width, 72);
  ctx.fillStyle = "#f5edce";
  ctx.font = "700 20px ui-sans-serif, system-ui, sans-serif";
  ctx.fillText("PharosVille", 28, 34);
  ctx.font = "500 12px ui-sans-serif, system-ui, sans-serif";
  ctx.fillStyle = "#a9d9d3";
  ctx.fillText(`${world.ships.length} ships, ${world.docks.length} docks, ${world.graves.length} graves`, 28, 55);

  if (targets.length > 0 && process.env.NODE_ENV !== "production") {
    ctx.fillStyle = "rgba(128, 214, 206, 0.72)";
    ctx.font = "500 11px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(`${targets.length} hit targets`, 28, 70);
  }
}

export function PharosVilleWorld({ world }: { world: PharosVilleWorldModel }) {
  const [assetManager] = useState(() => new PharosVilleAssetManager());
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const minimapRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ last: ScreenPoint; moved: boolean; pointerId: number } | null>(null);
  const [camera, setCamera] = useState<IsoCamera | null>(null);
  const [canvasSize, setCanvasSize] = useState<ScreenPoint>({ x: 0, y: 0 });
  const [hoveredDetailId, setHoveredDetailId] = useState<string | null>(null);
  const [selectedDetailId, setSelectedDetailId] = useState<string | null>("lighthouse");
  const [announcement, setAnnouncement] = useState("PharosVille ready.");
  const [assetLoadTick, setAssetLoadTick] = useState(0);
  const selectedDetail = useMemo(
    () => selectedDetailId ? (world.detailIndex[selectedDetailId] ?? null) : null,
    [selectedDetailId, world.detailIndex],
  );
  const selectedEntity = useMemo(() => collectEntityByDetailId(world, selectedDetailId), [selectedDetailId, world]);
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
      .then(() => setAssetLoadTick((tick) => tick + 1))
      .catch(() => setAssetLoadTick((tick) => tick + 1));
    return () => {
      controller.abort();
    };
  }, [assetManager]);

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
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawPharosVille({
      camera,
      ctx,
      height: canvasSize.y,
      hoveredTarget,
      selectedTarget,
      targets: hitTargets,
      width: canvasSize.x,
      world,
      assets: assetManager,
    });
  }, [assetLoadTick, assetManager, camera, canvasSize.x, canvasSize.y, hitTargets, hoveredTarget, selectedTarget, world]);

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
        canvasSize: ScreenPoint;
        targets: readonly HitTarget[];
      };
    };
    debugWindow.__pharosVilleDebug = { camera, canvasSize, targets: hitTargets };
    return () => {
      delete debugWindow.__pharosVilleDebug;
    };
  }, [camera, canvasSize, hitTargets]);

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
