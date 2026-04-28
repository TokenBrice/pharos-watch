"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { AccessibilityLedger } from "./components/accessibility-ledger";
import { DetailPanel } from "./components/detail-panel";
import { KeyboardEntityBrowser } from "./components/keyboard-entity-browser";
import { MapKey } from "./components/map-key";
import { QueryStatusBanner } from "./components/query-status-banner";
import { WorldToolbar } from "./components/world-toolbar";
import type { PharosVilleWorld as PharosVilleWorldModel, TileKind } from "./systems/world-types";

function project(tileX: number, tileY: number, originX: number, originY: number) {
  return {
    x: originX + (tileX - tileY) * 16,
    y: originY + (tileX + tileY) * 8,
  };
}

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

function drawBuilding(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, roof: string) {
  ctx.fillStyle = color;
  ctx.fillRect(x - 8, y - 22, 16, 18);
  ctx.fillStyle = roof;
  ctx.beginPath();
  ctx.moveTo(x - 10, y - 22);
  ctx.lineTo(x, y - 34);
  ctx.lineTo(x + 10, y - 22);
  ctx.closePath();
  ctx.fill();
}

function drawShip(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number, sail: string, hull: string) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
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

function drawPharosVille(ctx: CanvasRenderingContext2D, width: number, height: number, world: PharosVilleWorldModel) {
  ctx.imageSmoothingEnabled = false;
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "#082337");
  gradient.addColorStop(0.55, "#0c4a5b");
  gradient.addColorStop(1, "#061721");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  const originX = Math.round(width / 2);
  const originY = Math.max(40, Math.round(height * 0.08));
  const colors: Record<TileKind, string> = {
    "deep-water": "#061a2b",
    water: "#0d5f70",
    shore: "#b8af7f",
    land: "#d3c89a",
    road: "#9b835d",
  };

  for (const tile of world.map.tiles) {
    const p = project(tile.x, tile.y, originX, originY);
    drawDiamond(ctx, p.x, p.y, 32, 16, colors[tile.kind]);
    if (tile.kind === "water" && (tile.x + tile.y) % 9 === 0) {
      ctx.fillStyle = "rgba(186, 231, 225, 0.22)";
      ctx.fillRect(p.x - 7, p.y - 1, 14, 1);
    }
  }

  const center = project(world.lighthouse.tile.x, world.lighthouse.tile.y, originX, originY);
  ctx.fillStyle = "#f4f0d2";
  ctx.fillRect(center.x - 14, center.y - 76, 28, 62);
  ctx.fillStyle = "#d8d0ad";
  ctx.fillRect(center.x - 19, center.y - 17, 38, 15);
  ctx.fillStyle = "#a97b34";
  ctx.fillRect(center.x - 10, center.y - 88, 20, 12);
  ctx.fillStyle = world.lighthouse.color;
  ctx.beginPath();
  ctx.arc(center.x, center.y - 90, 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 204, 98, 0.35)";
  ctx.lineWidth = 18;
  ctx.beginPath();
  ctx.moveTo(center.x, center.y - 88);
  ctx.lineTo(center.x + 260, center.y - 150);
  ctx.stroke();

  const buildings = [
    [27, 27, "#d8cfaa", "#6f4e37"],
    [36, 30, "#efe4ba", "#7b3f35"],
    [31, 38, "#cbbd8e", "#5d5548"],
    [24, 35, "#e5d9ad", "#8a6841"],
    [40, 35, "#d8cfaa", "#6a7546"],
  ] as const;
  for (const [x, y, color, roof] of buildings) {
    const p = project(x, y, originX, originY);
    drawBuilding(ctx, p.x, p.y, color, roof);
  }

  ctx.strokeStyle = "#6d4c2f";
  ctx.lineWidth = 5;
  for (const dock of world.docks) {
    const p = project(dock.tile.x, dock.tile.y, originX, originY);
    const reach = 26 + dock.size * 6;
    ctx.lineWidth = 3 + dock.size;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + (dock.tile.x < 32 ? -reach : reach), p.y + 10);
    ctx.stroke();
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
    const p = project(ship.tile.x, ship.tile.y, originX, originY);
    drawShip(ctx, p.x, p.y - 4, ship.visual.scale, pennants[ship.visual.pennant] ?? pennants.slate, shipColors[ship.visual.hull]);
  }

  for (const cluster of world.shipClusters) {
    const p = project(cluster.tile.x, cluster.tile.y, originX, originY);
    const radius = Math.min(18, 7 + Math.sqrt(cluster.count) * 2);
    ctx.fillStyle = "rgba(255, 204, 98, 0.85)";
    ctx.beginPath();
    ctx.arc(p.x, p.y - 4, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#061721";
    ctx.font = "700 10px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(String(cluster.count), p.x, p.y);
    ctx.textAlign = "start";
  }

  ctx.fillStyle = "#4d584c";
  for (const grave of world.graves) {
    const p = project(grave.tile.x, grave.tile.y, originX, originY);
    ctx.fillRect(p.x - 3, p.y - 8, 6, 9);
    ctx.fillRect(p.x - 5, p.y, 10, 2);
  }

  ctx.fillStyle = "rgba(3, 10, 18, 0.34)";
  ctx.fillRect(0, 0, width, 72);
  ctx.fillStyle = "#f5edce";
  ctx.font = "700 20px ui-sans-serif, system-ui, sans-serif";
  ctx.fillText("PharosVille", 28, 34);
  ctx.font = "500 12px ui-sans-serif, system-ui, sans-serif";
  ctx.fillStyle = "#a9d9d3";
  ctx.fillText(`${world.ships.length} ships, ${world.docks.length} docks, ${world.graves.length} graves`, 28, 55);
}

export function PharosVilleWorld({ world }: { world: PharosVilleWorldModel }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [selectedDetailId, setSelectedDetailId] = useState<string>("lighthouse");
  const selectedDetail = useMemo(
    () => world.detailIndex[selectedDetailId] ?? null,
    [selectedDetailId, world.detailIndex],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const cssWidth = Math.max(1, Math.floor(rect.width));
      const cssHeight = Math.max(1, Math.floor(rect.height));
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(cssWidth * dpr);
      canvas.height = Math.floor(cssHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawPharosVille(ctx, cssWidth, cssHeight, world);
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [world]);

  return (
    <main className="pharosville-desktop pharosville-shell" data-testid="pharosville-world">
      <canvas ref={canvasRef} className="pharosville-canvas" data-testid="pharosville-canvas" aria-hidden="true" />
      <WorldToolbar world={world} selectedDetailId={selectedDetailId} />
      <aside className="pharosville-panel" aria-labelledby="pharosville-panel-title">
        <h2 id="pharosville-panel-title">PharosVille</h2>
        <QueryStatusBanner world={world} />
        <MapKey world={world} />
        <DetailPanel detail={selectedDetail} onClose={() => setSelectedDetailId("lighthouse")} />
        <KeyboardEntityBrowser
          world={world}
          selectedDetailId={selectedDetailId}
          onSelectDetail={setSelectedDetailId}
        />
      </aside>
      <AccessibilityLedger world={world} />
    </main>
  );
}
