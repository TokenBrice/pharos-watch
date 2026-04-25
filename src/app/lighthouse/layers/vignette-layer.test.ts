import { describe, it, expect, vi } from "vitest";
import { buildVignetteLayer } from "./vignette-layer";
import type { FrameState } from "../systems/scene-render";

function makeMockCtx(): CanvasRenderingContext2D {
  const linearGradient = { addColorStop: vi.fn() };
  return {
    fillStyle: "" as string | CanvasGradient,
    fillRect: vi.fn(),
    createLinearGradient: vi.fn(() => linearGradient),
  } as unknown as CanvasRenderingContext2D;
}

function makeFrame(width: number, height: number): FrameState {
  return {
    t: 0,
    width,
    height,
    dpr: 1,
    reducedMotion: false,
    scene: {
      harbors: [],
      beam: { color: "#22c55e", sweepSeconds: 12, band: "BEDROCK", score: 100 },
      sea: { amplitudePx: 1.5, highestBand: "CALM", tintHex: "#3a4f7a" },
      horizon: { cohorts: [] },
    },
    beam: { rotationRad: 0, alpha: 0.55, colorHex: "#22c55e" },
    lantern: { alpha: 0.85 },
  };
}

describe("buildVignetteLayer", () => {
  it("paints two gradient strips per draw call", () => {
    const layer = buildVignetteLayer();
    const ctx = makeMockCtx();
    layer.draw(ctx, makeFrame(800, 400));
    expect(ctx.createLinearGradient).toHaveBeenCalledTimes(2);
    expect(ctx.fillRect).toHaveBeenCalledTimes(2);
  });

  it("places the horizon haze centered on y = floor(height * 0.45)", () => {
    const layer = buildVignetteLayer();
    const ctx = makeMockCtx();
    layer.draw(ctx, makeFrame(800, 400));
    // Horizon at y0=180; haze rect from y=176 to y=184 (8 px tall)
    const fillRect = ctx.fillRect as unknown as ReturnType<typeof vi.fn>;
    const hazeCall = fillRect.mock.calls[0];
    expect(hazeCall[0]).toBe(0);
    expect(hazeCall[1]).toBe(176);
    expect(hazeCall[2]).toBe(800);
    expect(hazeCall[3]).toBe(8);
  });

  it("places the bottom vignette in the last 24 px", () => {
    const layer = buildVignetteLayer();
    const ctx = makeMockCtx();
    layer.draw(ctx, makeFrame(800, 400));
    const fillRect = ctx.fillRect as unknown as ReturnType<typeof vi.fn>;
    const vCall = fillRect.mock.calls[1];
    expect(vCall[1]).toBe(376);  // 400 - 24
    expect(vCall[3]).toBe(24);
  });
});
