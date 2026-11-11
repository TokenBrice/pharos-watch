import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIGURED_COINS } from "../live-reserves/sync-live-reserves-shared";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { getReserveAdapter } from "../reserve-adapters";
import { syncReserveCoin } from "../live-reserves/sync-live-reserves-core";
import { shouldAttemptFetch } from "../../lib/circuit-breaker";

vi.mock("../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn(),
}));

const SAMPLE_PAYLOAD = {
  collateral: {
    assets: [
      { symbol: "sUSDS", percentage: 50 },
      { symbol: "EURC", percentage: 10 },
      { symbol: "axlEUROC", chain: "celo", percentage: 5 },
      { symbol: "CELO", percentage: 15 },
      { symbol: "USDGLO", percentage: 5 },
      { symbol: "stETH", percentage: 3 },
      { symbol: "USDT", percentage: 4 },
      { symbol: "USDC", percentage: 2 },
      { symbol: "axlUSDC", chain: "celo", percentage: 1 },
      { symbol: "AUSD", percentage: 4 },
      { symbol: "WETH", percentage: 1 },
    ],
  },
};

const fixtures = createLatestSchemaFixtureTracker();

describe("reserve adapter real-registry smoke", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(shouldAttemptFetch).mockResolvedValue(true);
  });

  afterEach(() => {
    fixtures.closeAll();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("syncs a real mento-configured coin through syncReserveCoin and persists the validated snapshot", async () => {
    const coin = CONFIGURED_COINS.find((entry) => entry.id === "ceur-celo");
    expect(coin?.liveReservesConfig?.adapter).toBe("mento");

    const adapter = getReserveAdapter("mento");
    expect(adapter).not.toBeNull();

    const sourceTimestamp = Math.floor(Date.parse("2026-05-11T23:21:16.007Z") / 1000);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-11T23:22:16.007Z"));
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(SAMPLE_PAYLOAD), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response('troves\\":[{}],\\"timestamp\\":\\"2026-05-11T23:21:16.007Z\\"},\\"dataUpdateCount\\":1', {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
      );

    const { sqlite, db } = fixtures.open();
    const signal = AbortSignal.timeout(5_000);
    const result = await syncReserveCoin({
      db,
      coin: coin!,
      signal,
      adapter,
      runAdapter: (currentCoin, currentConfig, currentAdapter) =>
        currentAdapter.fetch(currentCoin, currentConfig, signal, {
          nowSec: sourceTimestamp + 60,
          requestCache: new Map(),
        }),
      breakerCanFetch: new Map(),
      d1FinalizeTimeoutMs: 30_000,
      previousState: null,
    });

    expect(result).toMatchObject({
      status: "synced",
      breakerOutcome: true,
      // ceur-celo's live redemption telemetry (Mento broker-pool) needs
      // ctx.chainRpcs to resolve a Celo RPC candidate; this test's ctx omits
      // it, so the redemption read fails closed with a degraded warning while
      // the reserve composition below is persisted unaffected.
      hasWarnings: true,
    });
    expect(result.warningMessages).toEqual(["ceur-celo:mento-redemption-telemetry-failed"]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://mento-analytics-api-12390052758.us-central1.run.app/api/v2/reserve",
    );
    expect(fetchSpy.mock.calls[1]?.[0]).toBe("https://reserve.mento.org/");

    const composition = sqlite.prepare("SELECT * FROM reserve_composition WHERE stablecoin_id = ?").get("ceur-celo")!;
    expect(composition).toMatchObject({ stablecoin_id: "ceur-celo", source: "mento", warning_count: 1 });
    const slices = JSON.parse(String(composition.slices)) as Array<Record<string, unknown>>;
    expect(slices).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "sUSDS (Sky savings USDS)", pct: 50, coinId: "susds-sky" }),
      expect.objectContaining({ name: "EURC (Circle euro stablecoin)", pct: 10, coinId: "eurc-circle" }),
      expect.objectContaining({
        sourceKey: "mento:reserve:axleuroc",
        pct: 5,
        coinId: "eurc-circle",
        depType: "collateral",
        intermediary: expect.objectContaining({ kind: "bridge", chain: "celo", verified: true }),
      }),
      expect.objectContaining({ name: "CELO", pct: 15 }),
    ]));

    const metadata = JSON.parse(String(composition.metadata)) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp,
      stableReservePct: 81,
    });
    expect(typeof (metadata.diag as Record<string, unknown>).durationMs).toBe("number");
    expect(JSON.parse(String(composition.warnings))).toEqual([
      expect.objectContaining({ code: "mento-redemption-telemetry-failed" }),
    ]);

    expect(sqlite.prepare("SELECT adapter_key, status FROM reserve_sync_attempt_history WHERE stablecoin_id = ?")
      .get("ceur-celo")).toEqual({ adapter_key: "mento", status: "degraded" });
    expect(sqlite.prepare("SELECT last_status, warning_count FROM reserve_sync_state WHERE stablecoin_id = ?")
      .get("ceur-celo")).toEqual({ last_status: "degraded", warning_count: 1 });
  });
});
