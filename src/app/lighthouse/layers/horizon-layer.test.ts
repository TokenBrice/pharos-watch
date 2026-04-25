import { describe, it, expect, vi } from "vitest";
import { buildHorizonLayer } from "./horizon-layer";
import type { FrameState } from "../systems/scene-render";
import type { SceneHorizonCohort } from "../systems/scene-data";

function makeMockCtx(): CanvasRenderingContext2D {
  return {
    fillStyle: "",
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
}

function makeCohorts(): SceneHorizonCohort[] {
  return [
    { id: "EUR", label: "EUR", pegType: "EUR", coinCount: 5 },
    { id: "JPY", label: "JPY", pegType: "JPY", coinCount: 2 },
  ];
}

function makeFrame(width: number, height: number, cohorts: SceneHorizonCohort[]): FrameState {
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
      horizon: { cohorts },
    },
    beam: { rotationRad: 0, alpha: 0.55, colorHex: "#22c55e" },
    lantern: { alpha: 0.85 },
  };
}

describe("buildHorizonLayer", () => {
  it("paints zero silhouettes when there are no cohorts", () => {
    const layer = buildHorizonLayer();
    const ctx = makeMockCtx();
    layer.draw(ctx, makeFrame(800, 600, []));
    expect(ctx.fill).not.toHaveBeenCalled();
  });

  it("paints one silhouette per cohort", () => {
    const layer = buildHorizonLayer();
    const ctx = makeMockCtx();
    layer.draw(ctx, makeFrame(1600, 800, makeCohorts()));
    expect(ctx.fill).toHaveBeenCalledTimes(2);
  });

  it("placements are stable across draws (same cohort set)", () => {
    const layer = buildHorizonLayer();
    const cohorts = makeCohorts();
    const a = makeMockCtx();
    const b = makeMockCtx();
    layer.draw(a, makeFrame(1600, 800, cohorts));
    layer.draw(b, makeFrame(1600, 800, cohorts));
    const aCalls = (a.fillRect as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const bCalls = (b.fillRect as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(aCalls).toEqual(bCalls);
  });
});
