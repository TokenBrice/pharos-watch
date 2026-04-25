import { describe, it, expect, vi } from "vitest";
import { drawHarborIsland } from "./harbor-island-sprite";
import type { SceneHarbor } from "../systems/scene-data";

function makeHarbor(overrides: Partial<SceneHarbor> = {}): SceneHarbor {
  return {
    id: "ethereum",
    name: "Ethereum",
    totalUsd: 600_000_000,
    stablecoinCount: 12,
    change7dPct: 1.5,
    resilienceTier: 1,
    boats: [],
    ...overrides,
  };
}

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

describe("drawHarborIsland", () => {
  it("emits at least 2 lamp positions (one warehouse + one dock terminus)", () => {
    const ctx = makeMockCtx();
    const result = drawHarborIsland(ctx, 100, 100, makeHarbor());
    expect(result.lampPositions.length).toBeGreaterThanOrEqual(2);
  });

  it("scales warehouse count by stablecoinCount (capped at 4)", () => {
    const ctx = makeMockCtx();
    const small = drawHarborIsland(ctx, 0, 0, makeHarbor({ stablecoinCount: 1 }));
    const large = drawHarborIsland(ctx, 0, 0, makeHarbor({ stablecoinCount: 100 }));
    // small: 1 warehouse + 1 dock-end lamp = 2
    expect(small.lampPositions.length).toBe(2);
    // large: 4 warehouses (capped) + 1 dock-end lamp = 5
    expect(large.lampPositions.length).toBe(5);
  });

  it("places dock terminus to the right of the island center", () => {
    const ctx = makeMockCtx();
    const result = drawHarborIsland(ctx, 100, 100, makeHarbor());
    expect(result.dockEndX).toBeGreaterThan(100);
  });
});
