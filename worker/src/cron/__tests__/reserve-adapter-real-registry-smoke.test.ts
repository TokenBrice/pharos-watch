import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";
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

describe("reserve adapter real-registry smoke", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(shouldAttemptFetch).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("syncs a real mento-configured coin through syncReserveCoin and persists the validated snapshot", async () => {
    const coin = ACTIVE_STABLECOINS.find((entry) => entry.id === "ceur-celo");
    expect(coin?.liveReservesConfig?.adapter).toBe("mento");

    const adapter = getReserveAdapter("mento");
    expect(adapter).not.toBeNull();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(SAMPLE_PAYLOAD), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const db = mockD1();
    const signal = AbortSignal.timeout(5_000);
    const result = await syncReserveCoin({
      db,
      coin: coin!,
      signal,
      adapter,
      runAdapter: (currentCoin, currentConfig, currentAdapter) =>
        currentAdapter.fetch(currentCoin, currentConfig, signal, {
          nowSec: Math.floor(Date.now() / 1000),
          requestCache: new Map(),
        }),
      breakerCanFetch: new Map(),
      previousState: null,
    });

    expect(result).toMatchObject({
      status: "synced",
      breakerOutcome: true,
      hasWarnings: true,
    });
    expect(result.warningMessages).toContain("ceur-celo:freshness-unverified");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://mento-analytics-api-12390052758.us-central1.run.app/api/v2/reserve",
    );

    const compositionInsert = db.getHistory().find((entry) =>
      entry.sql.includes("INSERT INTO reserve_composition (")
    );
    expect(compositionInsert).toBeDefined();
    expect(compositionInsert!.binds[0]).toBe("ceur-celo");
    expect(compositionInsert!.binds[3]).toBe("mento");
    expect(compositionInsert!.binds[6]).toBe(1);

    const slices = JSON.parse(String(compositionInsert!.binds[1])) as Array<Record<string, unknown>>;
    expect(slices).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "sUSDS (Sky savings USDS)", pct: 50, coinId: "usds-sky" }),
      expect.objectContaining({ name: "EURC (Circle euro stablecoin)", pct: 15, coinId: "eurc-circle" }),
      expect.objectContaining({ name: "CELO", pct: 15 }),
    ]));

    const metadata = JSON.parse(String(compositionInsert!.binds[5])) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      freshnessMode: "unverified",
      stableReservePct: 81,
      details: {
        freshnessSource: "mento-analytics-api",
      },
    });
    expect(typeof metadata.durationMs).toBe("number");
    const warnings = JSON.parse(String(compositionInsert!.binds[7])) as Array<Record<string, unknown>>;
    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "freshness-unverified", effect: "info", severity: "info" }),
    ]));

    const attemptHistoryInsert = db.getHistory().find((entry) =>
      entry.sql.includes("INSERT INTO reserve_sync_attempt_history (")
    );
    expect(attemptHistoryInsert).toBeDefined();
    expect(attemptHistoryInsert!.binds[0]).toBe("ceur-celo");
    expect(attemptHistoryInsert!.binds[2]).toBe("mento");
    expect(attemptHistoryInsert!.binds[5]).toBe("ok");
    expect(db.getHistory().some((entry) => entry.sql.includes("UPDATE reserve_sync_state"))).toBe(true);
  });
});
