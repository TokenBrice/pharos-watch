import { describe, it, expect, vi } from "vitest";
import { buildBeamWaterLayer } from "./beam-water-layer";
import type { FrameState } from "../systems/scene-render";

function makeMockCtx(): CanvasRenderingContext2D & {
  __saveCount: number;
  __fillRectCount: number;
} {
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    fillRect: vi.fn(),
    fillStyle: "",
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
  };
  return ctx as unknown as CanvasRenderingContext2D & { __saveCount: number; __fillRectCount: number };
}

function makeFrame(rotationRad: number): FrameState {
  return {
    t: 0,
    width: 800,
    height: 600,
    dpr: 1,
    reducedMotion: false,
    scene: {
      harbors: [],
      beam: { color: "#22c55e", sweepSeconds: 12, band: "BEDROCK", score: 100 },
      sea: { amplitudePx: 1.5, highestBand: "CALM", tintHex: "#3a4f7a" },
      horizon: { cohorts: [] },
    },
    beam: { rotationRad, alpha: 0.55, colorHex: "#22c55e" },
    lantern: { alpha: 0.85 },
  };
}

describe("buildBeamWaterLayer", () => {
  it("does not paint when beam aims at the sky", () => {
    const layer = buildBeamWaterLayer();
    layer.setLighthouseAnchor(400, 400);
    const ctx = makeMockCtx();
    // -π/2 = pointing straight up (sin = -1)
    layer.draw(ctx, makeFrame(-Math.PI / 2));
    expect(ctx.fillRect).not.toHaveBeenCalled();
  });

  it("paints additive highlight when beam aims downward", () => {
    const layer = buildBeamWaterLayer();
    layer.setLighthouseAnchor(400, 400);
    const ctx = makeMockCtx();
    // π/2 = pointing straight down (sin = +1)
    layer.draw(ctx, makeFrame(Math.PI / 2));
    expect(ctx.fillRect).toHaveBeenCalledTimes(1);
    expect(ctx.globalCompositeOperation).toBe("lighter");
  });

  it("does not paint without an anchor (mount-race guard)", () => {
    const layer = buildBeamWaterLayer();
    const ctx = makeMockCtx();
    layer.draw(ctx, makeFrame(Math.PI / 2));
    expect(ctx.fillRect).not.toHaveBeenCalled();
  });
});
