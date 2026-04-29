import type { PharosVilleMotionPlan, ShipMotionSample } from "../systems/motion";
import type { IsoCamera } from "../systems/projection";
import type { PharosVilleWorld } from "../systems/world-types";
import type { PharosVilleAssetManager } from "./asset-manager";
import type { WorldDrawablePass } from "./drawable-pass";
import type { HitTarget } from "./hit-testing";

export interface PharosVilleCanvasMotion {
  plan: PharosVilleMotionPlan;
  reducedMotion: boolean;
  timeSeconds: number;
}

export interface DrawPharosVilleInput {
  assets: PharosVilleAssetManager | null;
  camera: IsoCamera;
  ctx: CanvasRenderingContext2D;
  height: number;
  hoveredTarget: HitTarget | null;
  motion: PharosVilleCanvasMotion;
  selectedTarget: HitTarget | null;
  shipMotionSamples?: ReadonlyMap<string, ShipMotionSample>;
  targets: readonly HitTarget[];
  width: number;
  world: PharosVilleWorld;
}

export interface PharosVilleRenderMetrics {
  drawableCounts: Record<WorldDrawablePass, number>;
  drawableCount: number;
  movingShipCount: number;
  visibleTileCount: number;
}
