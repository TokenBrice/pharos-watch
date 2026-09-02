import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildAlertContextLines } from "../telegram-alert-context";

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

vi.mock("../../lib/telegram-log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/telegram-log")>()),
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
    const db = {
      prepare: vi.fn(() => ({ bind: () => ({ all: async () => ({ results: [] }) }) })),
    } as unknown as D1Database;

    const context = await buildAlertContextLines(db, ["usdc-circle", "dai-makerdao"]);

    expect(context.get("usdc-circle")).toContain("Flow24h +$12");
    expect(context.get("dai-makerdao") ?? "").not.toContain("Flow24h");
    // The untracked coin never triggers a flow cache read (bounded to the tracked subset).
    expect(mocks.getCache).toHaveBeenCalledTimes(1);
  });

  it("omits safety context when the alert source assessment fails", async () => {
    mocks.loadActiveAlertSafetySourceAssessment.mockRejectedValueOnce(new Error("identity mismatch"));
    const db = {
      prepare: vi.fn(() => ({ bind: () => ({ all: async () => ({ results: [] }) }) })),
    } as unknown as D1Database;

    const context = await buildAlertContextLines(db, ["usdc-circle"]);

    expect(context.get("usdc-circle") ?? "").not.toContain("Safety");
  });

  it("omits safety context when the alert source is not ok", async () => {
    mocks.loadActiveAlertSafetySourceAssessment.mockResolvedValueOnce(
      safetyAssessment({ "usdc-circle": { grade: "A", score: 85, methodologyVersion: "9.0" } }, "stale"),
    );
    const db = {
      prepare: vi.fn(() => ({ bind: () => ({ all: async () => ({ results: [] }) }) })),
    } as unknown as D1Database;

    const context = await buildAlertContextLines(db, ["usdc-circle"]);

    expect(context.get("usdc-circle") ?? "").not.toContain("Safety");
  });

  it("includes V9 model provenance from the thin alert envelope", async () => {
    mocks.loadActiveAlertSafetySourceAssessment.mockResolvedValueOnce(
      safetyAssessment({ "usdc-circle": { grade: "A", score: 85, methodologyVersion: "9.0" } }),
    );
    const db = {
      prepare: vi.fn(() => ({ bind: () => ({ all: async () => ({ results: [] }) }) })),
    } as unknown as D1Database;

    const context = await buildAlertContextLines(db, ["usdc-circle"]);

    expect(context.get("usdc-circle")).toContain("Safety A 85 (V9 9.0)");
  });

  it("chunks liquidity context reads to stay under the D1 bind limit", async () => {
    const bindCounts: number[] = [];
    let nextRowOffset = 0;
    const db = {
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
    } as unknown as D1Database;

    const ids = Array.from({ length: 91 }, (_, index) => `coin-${index}`);
    const context = await buildAlertContextLines(db, ids);

    expect(bindCounts).toEqual([90, 1]);
    expect(context.get("coin-0")).toContain("Liquidity 72");
    expect(context.get("coin-90")).toContain("Liquidity 72");
  });

  it("logs a warning and keeps successful liquidity chunks when one chunk fails", async () => {
    let call = 0;
    const db = {
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
                },
              ],
            };
          },
        };
        return statement;
      }),
    } as unknown as D1Database;

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
});
