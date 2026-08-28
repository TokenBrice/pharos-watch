import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { getReserveAdapter } from "../reserve-adapters";
import { syncReserveCoin } from "../sync-live-reserves-core";
import { shouldAttemptFetch } from "../../lib/circuit-breaker";

vi.mock("../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn(),
}));

const SAMPLE_PAYLOAD = {
  collateral: {
    assets: [
      { symbol: "sUSDS", percentage: 50 },
      { symbol: "EURC", percentage: 10 },
      { symbol: "axlEUROC", percentage: 5 },
      { symbol: "CELO", percentage: 15 },
      { symbol: "USDGLO", percentage: 5 },
      { symbol: "stETH", percentage: 3 },
      { symbol: "USDT", percentage: 4 },
      { symbol: "USDC", percentage: 2 },
      { symbol: "axlUSDC", percentage: 1 },
      { symbol: "AUSD", percentage: 4 },
      { symbol: "WETH", percentage: 1 },
    ],
  },
};

function reserveDb() {
  return mockD1([
    { match: "INSERT INTO reserve_sync_state", rows: [] },
    { match: "UPDATE reserve_sync_state", rows: [] },
    { match: "INSERT INTO reserve_composition", rows: [] },
    { match: "INSERT OR IGNORE INTO reserve_composition_history", rows: [] },
    { match: "INSERT OR IGNORE INTO reserve_sync_attempt_history", rows: [] },
  ]);
}

describe("reserve adapter real-registry smoke", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(shouldAttemptFetch).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("syncs a real mento-configured coin through syncReserveCoin and persists the validated snapshot", async () => {
    const coin = ACTIVE_STABLECOINS.find((entry) => entry.id === "ceur-celo");
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

    const db = reserveDb();
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

    const compositionInsert = db.getHistory().find((entry) =>
      entry.sql.includes("INSERT INTO reserve_composition (")
    );
    expect(compositionInsert).toBeDefined();
    expect(compositionInsert!.binds[0]).toBe("ceur-celo");
    expect(compositionInsert!.binds[3]).toBe("mento");
    expect(compositionInsert!.binds[6]).toBe(1);

    const slices = JSON.parse(String(compositionInsert!.binds[1])) as Array<Record<string, unknown>>;
    expect(slices).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "sUSDS (Sky savings USDS)", pct: 50, coinId: "susds-sky" }),
      expect.objectContaining({ name: "EURC (Circle euro stablecoin)", pct: 15, coinId: "eurc-circle" }),
      expect.objectContaining({ name: "CELO", pct: 15 }),
    ]));

    const metadata = JSON.parse(String(compositionInsert!.binds[5])) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp,
      stableReservePct: 81,
    });
    expect(typeof metadata.durationMs).toBe("number");
    expect(JSON.parse(String(compositionInsert!.binds[7]))).toEqual([
      expect.objectContaining({ code: "mento-redemption-telemetry-failed" }),
    ]);

    const attemptHistoryInsert = db.getHistory().find((entry) =>
      entry.sql.includes("INSERT OR IGNORE INTO reserve_sync_attempt_history (")
    );
    expect(attemptHistoryInsert).toBeDefined();
    expect(attemptHistoryInsert!.binds[0]).toBe("ceur-celo");
    expect(attemptHistoryInsert!.binds[2]).toBe("mento");
    expect(attemptHistoryInsert!.binds[5]).toBe("degraded");
    expect(db.getHistory().some((entry) => entry.sql.includes("UPDATE reserve_sync_state"))).toBe(true);
  });
});
