import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildAlertContextLines } from "../telegram-alert-context";
import { TELEGRAM_CONTEXT_BUDGET_SEC } from "../../lib/telegram/context-freshness";
import { makeNoopD1 } from "../../test-helpers/noop-d1";
import { SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC } from "../../lib/safety-score-v9/consumer-freshness";

const mocks = vi.hoisted(() => ({
  loadActiveAlertSafetySourceAssessment: vi.fn(),
  loadStablecoinsCache: vi.fn(),
  logTelegramEvent: vi.fn(),
  getCache: vi.fn(),
  getMintBurnConfigsForStablecoin: vi.fn(),
}));

vi.mock("../../lib/alert-safety-source-cache", () => ({
  loadActiveAlertSafetySourceAssessment: mocks.loadActiveAlertSafetySourceAssessment,
}));

function safetyAssessment(
  snapshot: Record<string, { grade: string; score: number | null; methodologyVersion: string | null }>,
  state: "ok" | "stale" = "ok",
) {
  return {
    state,
    ageSeconds: 60,
    generation: "safety-v9-alert-source-v1",
    sourcePublicationGenerationId: "report-cards:v9:v1:test",
    acceptedPublicationGenerationId: "report-cards:v9:v1:test",
    freshnessMaxAgeSec: SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC,
    assessedAtSec: 61,
    envelope: {
      generation: "safety-v9-alert-source-v1",
      safetyScoreIdentity: { model: "v9", schemaVersion: 1, methodologyVersion: "9.0" },
      publicationGenerationId: "report-cards:v9:v1:test",
      methodologyVersion: "9.0",
      publishedAt: 1,
      snapshot,
    },
  };
}

vi.mock("../../lib/stablecoins-cache", () => ({
  loadStablecoinsCache: mocks.loadStablecoinsCache,
}));

vi.mock("../../lib/telegram/log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/telegram/log")>()),
  logTelegramEvent: mocks.logTelegramEvent,
}));

vi.mock("../../lib/db-cache", () => ({
  getCache: mocks.getCache,
}));

vi.mock("../../lib/mint-burn-contracts", () => ({
  getMintBurnConfigsForStablecoin: mocks.getMintBurnConfigsForStablecoin,
}));

describe("buildAlertContextLines", () => {
  beforeEach(() => {
    mocks.loadActiveAlertSafetySourceAssessment.mockReset().mockResolvedValue(safetyAssessment({}));
    mocks.loadStablecoinsCache.mockResolvedValue({ kind: "ok", payload: { peggedAssets: [] } });
    mocks.logTelegramEvent.mockReset();
    mocks.getMintBurnConfigsForStablecoin.mockReset().mockReturnValue([]);
    mocks.getCache.mockReset().mockResolvedValue(null);
  });

  it("appends a fresh net mint/burn flow segment only for mint-burn-tracked coins", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    mocks.getMintBurnConfigsForStablecoin.mockImplementation((id: string) =>
      id === "usdc-circle" ? [{ stablecoinId: id }] : [],
    );
    mocks.getCache.mockImplementation(async (_db: unknown, key: string) =>
      typeof key === "string" && key.includes("usdc-circle")
        ? { value: JSON.stringify({ netFlowUsd: 12_300_000, updatedAt: nowSec }), updatedAt: nowSec }
        : null,
    );
    const db = makeNoopD1({
      prepare: vi.fn(() => ({ bind: () => ({ all: async () => ({ results: [] }) }) })),
    });

    const context = await buildAlertContextLines(db, ["usdc-circle", "dai-makerdao"]);

    expect(context.get("usdc-circle")).toContain("Flow24h +$12");
    expect(context.get("dai-makerdao") ?? "").not.toContain("Flow24h");
    // The untracked coin never triggers a flow cache read (bounded to the tracked subset).
    expect(mocks.getCache).toHaveBeenCalledTimes(1);
  });

  it.each([[21_599, true], [21_600, true], [21_601, false]])(
    "retains the independent six-hour flow context boundary at %i seconds",
    async (age, included) => {
      const now = 1_790_000_000;
      vi.spyOn(Date, "now").mockReturnValue(now * 1000);
      mocks.getMintBurnConfigsForStablecoin.mockReturnValue([{ stablecoinId: "usdc-circle" }]);
      mocks.getCache.mockResolvedValue({
        value: JSON.stringify({ netFlowUsd: 12_300_000, updatedAt: now - Number(age) }),
        updatedAt: now - Number(age),
      });
      const db = makeNoopD1({
        prepare: vi.fn(() => ({ bind: () => ({ all: async () => ({ results: [] }) }) })),
      });
      const context = await buildAlertContextLines(db, ["usdc-circle"]);
      expect((context.get("usdc-circle") ?? "").includes("Flow24h")).toBe(included);
    },
  );

  it("omits safety context when the alert source assessment fails", async () => {
    mocks.loadActiveAlertSafetySourceAssessment.mockRejectedValueOnce(new Error("identity mismatch"));
    const db = makeNoopD1({
      prepare: vi.fn(() => ({ bind: () => ({ all: async () => ({ results: [] }) }) })),
    });

    const context = await buildAlertContextLines(db, ["usdc-circle"]);

    expect(context.get("usdc-circle") ?? "").not.toContain("Safety");
  });

  it("omits safety context when the alert source is not ok", async () => {
    mocks.loadActiveAlertSafetySourceAssessment.mockResolvedValueOnce(
      safetyAssessment({ "usdc-circle": { grade: "A", score: 85, methodologyVersion: "9.0" } }, "stale"),
    );
    const db = makeNoopD1({
      prepare: vi.fn(() => ({ bind: () => ({ all: async () => ({ results: [] }) }) })),
    });

    const context = await buildAlertContextLines(db, ["usdc-circle"]);

    expect(context.get("usdc-circle") ?? "").not.toContain("Safety");
  });

  it("includes V9 model provenance from the thin alert envelope", async () => {
    mocks.loadActiveAlertSafetySourceAssessment.mockResolvedValueOnce(
      safetyAssessment({ "usdc-circle": { grade: "A", score: 85, methodologyVersion: "9.0" } }),
    );
    const db = makeNoopD1({
      prepare: vi.fn(() => ({ bind: () => ({ all: async () => ({ results: [] }) }) })),
    });

    const context = await buildAlertContextLines(db, ["usdc-circle"]);

    expect(context.get("usdc-circle")).toContain("Safety A 85 (V9 9.0)");
  });

  it("chunks liquidity context reads to stay under the D1 bind limit", async () => {
    const bindCounts: number[] = [];
    let nextRowOffset = 0;
    const db = makeNoopD1({
      prepare: vi.fn(() => {
        let currentBindCount = 0;
        const statement = {
          bind: (...binds: string[]) => {
            currentBindCount = binds.length;
            bindCounts.push(binds.length);
            return statement;
          },
          all: async () => ({
            results:
              currentBindCount > 90
                ? []
                : Array.from({ length: currentBindCount }, (_, index) => ({
                    stablecoin_id: `coin-${nextRowOffset + index}`,
                    liquidity_score: 72,
                    total_tvl_usd: 1_000_000,
                    updated_at: Math.floor(Date.now() / 1000),
                  })),
          }),
        };
        const originalAll = statement.all;
        statement.all = async () => {
          const result = await originalAll();
          nextRowOffset += currentBindCount;
          return result;
        };
        return statement;
      }),
    });

    const ids = Array.from({ length: 91 }, (_, index) => `coin-${index}`);
    const context = await buildAlertContextLines(db, ids);

    expect(bindCounts).toEqual([90, 1]);
    expect(context.get("coin-0")).toContain("Liquidity 72");
    expect(context.get("coin-90")).toContain("Liquidity 72");
  });

  it("logs a warning and keeps successful liquidity chunks when one chunk fails", async () => {
    let call = 0;
    const db = makeNoopD1({
      prepare: vi.fn(() => {
        const statement = {
          bind: (..._binds: string[]) => statement,
          all: async () => {
            call += 1;
            if (call === 2) throw new Error("D1 bind failure");
            return {
              results: [
                {
                  stablecoin_id: "coin-0",
                  liquidity_score: 81,
                  total_tvl_usd: 2_000_000,
                  updated_at: Math.floor(Date.now() / 1000),
                },
              ],
            };
          },
        };
        return statement;
      }),
    });

    const ids = Array.from({ length: 91 }, (_, index) => `coin-${index}`);
    const context = await buildAlertContextLines(db, ids);

    expect(context.get("coin-0")).toContain("Liquidity 81");
    expect(context.has("coin-90")).toBe(false);
    expect(mocks.logTelegramEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        action: "alert-context-liquidity",
        module: "telegram-alert-context",
        requestedStablecoinCount: 91,
        chunkSize: 1,
        errorClass: "d1",
      }),
    );
  });

  describe("supply and DEX context clocks", () => {
    const NOW_SEC = 1_800_000_000;
    const DEX_BUDGET = TELEGRAM_CONTEXT_BUDGET_SEC.dexLiquidity;
    const SUPPLY_BUDGET = TELEGRAM_CONTEXT_BUDGET_SEC.supply;

    function liquidityDb(updatedAt: number | null) {
      return makeNoopD1({
        prepare: vi.fn(() => ({
          bind: () => ({
            all: async () => ({
              results: [{ stablecoin_id: "usdc-circle", liquidity_score: 91, total_tvl_usd: 123_000_000, updated_at: updatedAt }],
            }),
          }),
        })),
      });
    }

    function stablecoins(circulating: Record<string, unknown> | undefined, updatedAt = NOW_SEC, supplyObservedAt?: number) {
      mocks.loadStablecoinsCache.mockResolvedValue({
        kind: "ok",
        updatedAt,
        payload: { peggedAssets: [{ id: "usdc-circle", symbol: "USDC", circulating, supplyObservedAt }] },
      });
    }

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW_SEC * 1000);
      mocks.loadActiveAlertSafetySourceAssessment.mockResolvedValue(
        safetyAssessment({ "usdc-circle": { grade: "A", score: 85, methodologyVersion: "9.0" } }),
      );
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("never presents missing supply or 30-day-old DEX context as current or zero, and still returns the primary context", async () => {
      stablecoins({});
      const context = await buildAlertContextLines(liquidityDb(NOW_SEC - 30 * 86_400), ["usdc-circle"]);

      const line = context.get("usdc-circle") ?? "";
      expect(line).toContain("Safety A 85");
      expect(line).not.toContain("Supply");
      expect(line).not.toContain("$0");
      expect(line).not.toContain("Liquidity");
      expect(line).not.toContain("DEX TVL");
    });

    it.each([
      { name: "missing", circulating: undefined },
      { name: "empty", circulating: {} },
      { name: "invalid-only", circulating: { peggedUSD: "n/a" } },
    ])("omits $name supply buckets", async ({ circulating }) => {
      stablecoins(circulating);
      const context = await buildAlertContextLines(liquidityDb(NOW_SEC), ["usdc-circle"]);

      expect(context.get("usdc-circle") ?? "").not.toContain("Supply");
    });

    it("renders an explicit zero and a positive supply only while their clock is inside the supply budget", async () => {
      stablecoins({ peggedUSD: 0 });
      expect((await buildAlertContextLines(liquidityDb(NOW_SEC), ["usdc-circle"])).get("usdc-circle")).toContain("Supply $0");

      stablecoins({ peggedUSD: 5_000_000_000 }, NOW_SEC - SUPPLY_BUDGET);
      expect((await buildAlertContextLines(liquidityDb(NOW_SEC), ["usdc-circle"])).get("usdc-circle")).toContain("Supply $5");

      stablecoins({ peggedUSD: 5_000_000_000 }, NOW_SEC - SUPPLY_BUDGET - 1);
      expect((await buildAlertContextLines(liquidityDb(NOW_SEC), ["usdc-circle"])).get("usdc-circle") ?? "").not.toContain("Supply");

      // Retained supply keeps its own older observation clock even inside a fresh publication.
      stablecoins({ peggedUSD: 5_000_000_000 }, NOW_SEC, NOW_SEC - SUPPLY_BUDGET - 1);
      expect((await buildAlertContextLines(liquidityDb(NOW_SEC), ["usdc-circle"])).get("usdc-circle") ?? "").not.toContain("Supply");
    });

    it.each([
      { name: "just inside", age: DEX_BUDGET - 1, shown: true },
      { name: "exactly at", age: DEX_BUDGET, shown: true },
      { name: "just outside", age: DEX_BUDGET + 1, shown: false },
    ])("assesses DEX context $name the existing DEWS DEX budget", async ({ age, shown }) => {
      stablecoins({ peggedUSD: 5_000_000_000 });
      const line = (await buildAlertContextLines(liquidityDb(NOW_SEC - age), ["usdc-circle"])).get("usdc-circle") ?? "";

      expect(line.includes("Liquidity 91, DEX TVL")).toBe(shown);
      expect(line).toContain("Supply $5");
    });

    it("omits DEX context whose row has no observation clock", async () => {
      stablecoins({ peggedUSD: 5_000_000_000 });
      const line = (await buildAlertContextLines(liquidityDb(null), ["usdc-circle"])).get("usdc-circle") ?? "";

      expect(line).not.toContain("Liquidity");
    });
  });
});
