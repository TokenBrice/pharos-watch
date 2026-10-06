import { describe, expect, it, vi } from "vitest";
import type { AdapterFn } from "../types";

const mocks = vi.hoisted(() => ({
  m0Initialized: false,
  circleInitialized: false,
  fetch: vi.fn(),
}));

vi.mock("../m0", () => {
  mocks.m0Initialized = true;
  return { fetchM0Reserves: mocks.fetch };
});
vi.mock("../circle-transparency", () => {
  mocks.circleInitialized = true;
  return { fetchCircleReserves: vi.fn() };
});

import { getReserveAdapter } from "../index";

describe("lazy reserve adapter registry", () => {
  it("inspects availability without initializing adapters, then loads only the fetched adapter", async () => {
    const adapter = getReserveAdapter("m0")!;
    expect(adapter.key).toBe("m0");
    expect(getReserveAdapter("circle-transparency")).not.toBeNull();
    expect(getReserveAdapter("unknown-adapter")).toBeNull();
    expect(mocks.m0Initialized).toBe(false);
    expect(mocks.circleInitialized).toBe(false);

    const result = { slices: [] };
    mocks.fetch.mockResolvedValue(result);
    const args: Parameters<AdapterFn> = [
      { id: "coin", name: "Coin", symbol: "COIN", flags: {
        pegCurrency: "USD", governance: "centralized", backing: "rwa-backed",
        yieldBearing: false, rwa: true, navToken: false,
      } },
      { adapter: "m0", version: 1, semantics: "collateral-mix", inputs: { primary: { kind: "http-json", url: "https://example.com" } } },
      new AbortController().signal,
      {},
    ];
    expect(await adapter.fetch(...args)).toBe(result);
    expect(mocks.fetch).toHaveBeenCalledWith(...args);
    expect(mocks.m0Initialized).toBe(true);
    expect(mocks.circleInitialized).toBe(false);

    mocks.fetch.mockRejectedValueOnce(new Error("adapter failed"));
    await expect(adapter.fetch(...args)).rejects.toThrow("adapter failed");
  });
});
