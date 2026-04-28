import type { SceneData } from "./scene-data";

export interface FrameState {
  /** Seconds since first frame, monotonic. */
  t: number;
  /** Canvas CSS width in pixels (DPR-independent). */
  width: number;
  /** Canvas CSS height in pixels. */
  height: number;
  /** Device pixel ratio applied to the canvas, capped at 2. */
  dpr: number;
  /** True when the OS-level reduced-motion preference is active. */
  reducedMotion: boolean;
  /** Latest data adapter output. */
  scene: SceneData;
  /** Tweened beam state (mutated by GSAP, read by the lighthouse layer each frame). */
  beam: { rotationRad: number; alpha: number; colorHex: string };
  /** Tweened lantern halo alpha. */
  lantern: { alpha: number };
}

export interface DrawableLayer {
  draw(ctx: CanvasRenderingContext2D, frame: FrameState): void;
  dispose?: () => void;
}

export function createInitialFrameState(scene: SceneData): FrameState {
  return {
    t: 0,
    width: 0,
    height: 0,
    dpr: 1,
    reducedMotion: false,
    scene,
    beam: { rotationRad: 0, alpha: 0.55, colorHex: scene.beam.color },
    lantern: { alpha: 0.85 },
  };
}
