import { describe, expect, it, vi } from "vitest";
import { makeNoopD1 } from "../../test-helpers/noop-d1";

const GATE_LOAD_TIMEOUT_MS = 15_000;

describe("loadDexPriceSources", () => {
  it("parses price_sources_json into per-stablecoin protocol arrays", async () => {
    const mockDb = makeNoopD1({
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockResolvedValue({
          results: [
            {
              stablecoin_id: "usdc",
              price_sources_json: JSON.stringify([
                { protocol: "fluid", sourceFamily: "fluid", chain: "ethereum", price: 0.9998, tvl: 500000 },
                { protocol: "balancer", sourceFamily: "balancer", chain: "ethereum", price: 1.0001, tvl: 800000 },
              ]),
              updated_at: Math.floor(Date.now() / 1000),
            },
          ],
        }),
      }),
    });

    const { loadDexPriceSources } = await import("../../lib/depeg-helpers");
    const result = await loadDexPriceSources(mockDb);

    expect(result.get("usdc")).toHaveLength(2);
    expect(result.get("usdc")![0].protocol).toBe("fluid");
    expect(result.get("usdc")![1].protocol).toBe("balancer");
  }, GATE_LOAD_TIMEOUT_MS);

  it("returns empty map on missing table", async () => {
    const mockDb = makeNoopD1({
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockRejectedValue(new Error("no such table: dex_prices")),
      }),
    });

    const { loadDexPriceSources } = await import("../../lib/depeg-helpers");
    const result = await loadDexPriceSources(mockDb);
    expect(result.size).toBe(0);
  });

  it("logs and skips malformed price_sources_json rows", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mockDb = makeNoopD1({
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
    });

    const { createDexPriceSourceLoadTelemetry, loadDexPriceSources } = await import("../../lib/depeg-helpers");
    const telemetry = createDexPriceSourceLoadTelemetry();
    const result = await loadDexPriceSources(mockDb, undefined, telemetry);

    expect(result.size).toBe(0);
    expect(telemetry.malformedRows).toEqual([
      {
        stablecoinId: "usdc",
        updatedAt: expect.any(Number),
        reason: "json-parse-failed",
      },
    ]);
    expect(
      warnSpy.mock.calls.some(([message]) =>
        String(message).includes("owner=depeg-helpers")
        && String(message).includes("context=dex_prices.price_sources_json"),
      ),
    ).toBe(true);

    warnSpy.mockRestore();
  });

  it("records stale price source rows without loading them", async () => {
    const updatedAt = Math.floor(Date.now() / 1000) - 2_101;
    const mockDb = makeNoopD1({
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockResolvedValue({
          results: [
            {
              stablecoin_id: "usdc",
              price_sources_json: JSON.stringify([
                { protocol: "fluid", sourceFamily: "fluid", chain: "ethereum", price: 0.9998, tvl: 500000 },
              ]),
              updated_at: updatedAt,
            },
          ],
        }),
      }),
    });

    const { createDexPriceSourceLoadTelemetry, loadDexPriceSources } = await import("../../lib/depeg-helpers");
    const telemetry = createDexPriceSourceLoadTelemetry();
    const result = await loadDexPriceSources(mockDb, 2_100, telemetry);

    expect(result.size).toBe(0);
    expect(telemetry.staleRows).toEqual([
      {
        stablecoinId: "usdc",
        updatedAt,
        ageSec: expect.any(Number),
        maxAgeSec: 2_100,
      },
    ]);
    expect(telemetry.staleRows[0]!.ageSec).toBeGreaterThanOrEqual(2_101);
  });
});
