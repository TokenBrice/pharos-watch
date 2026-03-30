import { describe, expect, it, vi } from "vitest";

describe("loadDexPriceSources", () => {
  it("parses price_sources_json into per-stablecoin protocol arrays", async () => {
    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockResolvedValue({
          results: [
            {
              stablecoin_id: "usdc",
              price_sources_json: JSON.stringify([
                { protocol: "fluid", chain: "ethereum", price: 0.9998, tvl: 500000 },
                { protocol: "balancer", chain: "ethereum", price: 1.0001, tvl: 800000 },
              ]),
              updated_at: Math.floor(Date.now() / 1000),
            },
          ],
        }),
      }),
    } as unknown as D1Database;

    const { loadDexPriceSources } = await import("../../lib/depeg-helpers");
    const result = await loadDexPriceSources(mockDb);

    expect(result.get("usdc")).toHaveLength(2);
    expect(result.get("usdc")![0].protocol).toBe("fluid");
    expect(result.get("usdc")![1].protocol).toBe("balancer");
  });

  it("returns empty map on missing table", async () => {
    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockRejectedValue(new Error("no such table: dex_prices")),
      }),
    } as unknown as D1Database;

    const { loadDexPriceSources } = await import("../../lib/depeg-helpers");
    const result = await loadDexPriceSources(mockDb);
    expect(result.size).toBe(0);
  });

  it("logs and skips malformed price_sources_json rows", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockResolvedValue({
          results: [
            {
              stablecoin_id: "usdc",
              price_sources_json: "{bad-json",
              updated_at: Math.floor(Date.now() / 1000),
            },
          ],
        }),
      }),
    } as unknown as D1Database;

    const { loadDexPriceSources } = await import("../../lib/depeg-helpers");
    const result = await loadDexPriceSources(mockDb);

    expect(result.size).toBe(0);
    expect(
      warnSpy.mock.calls.some(([message]) =>
        String(message).includes("owner=depeg-helpers")
        && String(message).includes("context=dex_prices.price_sources_json"),
      ),
    ).toBe(true);

    warnSpy.mockRestore();
  });
});
