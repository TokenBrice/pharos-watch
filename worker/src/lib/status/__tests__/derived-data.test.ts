import { afterEach, describe, expect, it, vi } from "vitest";
import { MINT_BURN_CONFIGS } from "../../mint-burn-contracts";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/safety-score";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { getDatasetFreshness, getMintBurnReconciliation } from "../derived-data";

const NOW = 1_800_000_000;

describe("getMintBurnReconciliation chain identity", () => {
  it.each<[Record<string, unknown>, number | null, string?, string?]>([
    [{ Ethereum: { current: 110, circulatingPrevDay: 100 } }, 10],
    [{ Ethereum: { current: 110, circulatingPrevDay: 0 } }, 110],
    [{ ethereum: { current: 110, circulatingPrevDay: 100 } }, 10],
    [{ legacy: { chainId: "ethereum", current: 110, circulatingPrevDay: 100 } }, 10],
    [{ Ethereum: { chainId: "base", current: 110, circulatingPrevDay: 100 } }, null],
    [{ Ethereum: { current: 110 } }, null],
    [{ Ethereum: { current: 110, circulatingPrevDay: null } }, null],
    [{ Ethereum: { current: 110, circulatingPrevDay: 100 }, ethereum: { current: 110, circulatingPrevDay: 100 } }, null],
    [{ Ethereum: { current: 110, circulatingPrevDay: 100 } }, null, "stale-head"],
    [{ Ethereum: { current: 110, circulatingPrevDay: 100 } }, null, "missing-cursor"],
    [{ Ethereum: { current: 110, circulatingPrevDay: 100 } }, null, "lagging"],
    [{ Ethereum: { current: 110, circulatingPrevDay: 100 } }, 10, "extended-only"],
    [{ Ethereum: { current: 110, circulatingPrevDay: 0 } }, null, "legacy-onchain"],
    ...["dai-makerdao", "usdd-tron-dao-reserve", "crvusd-curve", "jpyc-jpyc", "eurcv-societe-generale-forge", "alusd-alchemix", "tryb-bilira", "frxusd-frax", "fxusd-f-x-protocol", "m-m0", "ousd-origin-protocol"]
      .map<[Record<string, unknown>, null, string, string]>((id) => [{ Ethereum: { current: 110, circulatingPrevDay: 100 } }, null, "", id]),
    [{ Ethereum: { current: 110, circulatingPrevDay: 100 } }, 10, "", "usds-sky"],
    [{ Ethereum: { current: 20_000_100, circulatingPrevDay: 100 } }, 20_000_000, "", "usds-sky"],
    [{ Ethereum: { current: 110, circulatingPrevDay: 100 } }, 10, "other-source", "dai-makerdao"],
  ])("resolves chain supply without inventing or duplicating history: %j", async (chainCirculating, delta, coverageCase = "", stablecoinId = "usdc-circle") => {
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        rows: [{
          value: JSON.stringify({ peggedAssets: [{
            id: stablecoinId, symbol: "USDC", price: 1,
            circulating: { peggedUSD: 1_000_000 }, chainCirculating,
            supplySource: coverageCase === "legacy-onchain" ? "onchain-total-supply"
              : coverageCase === "other-source" ? "reviewed-source" : "defillama",
          }] }),
          updated_at: NOW,
        }],
      },
      {
        match: "pharos:status-derived:mint-burn-24h",
        rows: [{ stablecoin_id: stablecoinId, chain_id: "ethereum", net_flow_usd: 10 }],
      },
      { match: "pharos:status-derived:mint-burn-first-hour-seek", rows: [] },
      { match: "FROM mint_burn_sync_state", rows: coverageCase === "missing-cursor" ? [] : MINT_BURN_CONFIGS.map((config) => ({
        config_key: `${config.chain.chainId}-${config.contractAddress}`, last_block: coverageCase === "lagging" ? 90_000_000 : 99_999_999,
      })) },
      { match: "FROM cron_runs", matchBinds: ["sync-mint-burn"], rows: [{
        started_at: coverageCase === "stale-head" || coverageCase === "extended-only" ? NOW - 86400 : NOW,
        status: "ok", metadata: JSON.stringify({ chainHeads: { ethereum: 100_000_000 } }),
      }] },
      { match: "FROM cron_runs", matchBinds: ["sync-mint-burn-extended"], rows: [{
        started_at: coverageCase === "stale-head" ? NOW - 86400 : NOW,
        status: "ok", metadata: JSON.stringify({ chainHeads: { ethereum: 100_000_000 } }),
      }] },
    ]);
    const result = await getMintBurnReconciliation(db, NOW);
    expect(db.getHistory().find((entry) => entry.sql.includes("mint-burn-24h"))?.binds)
      .toEqual([Math.floor(NOW / 3600) * 3600 - 86400, Math.floor(NOW / 3600) * 3600]);
    expect(result?.rows).toHaveLength(1);
    expect(result?.rows[0]).toMatchObject({
      chainSupplyDelta24hUsd: delta,
      status: delta === null ? "insufficient-source" : delta === 20_000_000 ? "critical" : "ok",
    });
    expect(result?.rows[0]?.comparisonIssue).toEqual(delta === null ? expect.any(String) : undefined);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

function publishedPointer(updatedAt: number) {
  return {
    key: "dews:published-generation",
    value: JSON.stringify({
      updatedAt,
      source: "compute-dews",
      publishStatus: "published",
      coverageVersion: 2,
      expectedRowCount: 2,
      stablecoinIdsDigest: "a".repeat(64),
    }),
    updated_at: updatedAt,
  };
}

describe("getDatasetFreshness", () => {
  it("fails closed for safety freshness when the compact cache has no identity instead of reading legacy history", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["report_card_cache"],
        rows: [
          {
            key: "report_card_cache",
            value: JSON.stringify({
              methodologyVersion: "v8-test",
              updatedAt: NOW - 60,
              scores: { "usdc-circle": { score: 99, grade: "A+" } },
            }),
            updated_at: NOW - 60,
          },
        ],
      },
    ]);

    const freshness = await getDatasetFreshness(db);

    expect(freshness.safetyGrades).toBeNull();
    expect(db.getHistory().some((entry) => entry.sql.includes("safety_grade_history"))).toBe(false);
  });

  it("keeps dataset freshness available when the report-card cache read fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["report_card_cache"],
        rows: [],
        throwError: "report-card cache unavailable",
      },
    ]);

    await expect(getDatasetFreshness(db)).resolves.toMatchObject({
      safetyGrades: null,
    });
  });

  it("fails closed for safety freshness when the V8 release sees a complete V9 compact publication", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const updatedAt = NOW - 60;
    const publicationGenerationId = `safety-score-v9:9.0:${updatedAt}`;
    const scoreIds = [...ACTIVE_IDS].sort();
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["report_card_cache"],
        rows: [
          {
            key: "report_card_cache",
            value: JSON.stringify({
              methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
              updatedAt,
              scores: Object.fromEntries(scoreIds.map((id) => [id, { score: 99, grade: "A+" }])),
              safetyScoreIdentity: {
                model: "v9",
                schemaVersion: 1,
                methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
                policyId: "v9-policy-2026-05",
                policyDigest: "b".repeat(64),
                evaluationBuildDigest: "c".repeat(64),
                baseInputGenerationId: `report-cards-input:v1:${"d".repeat(64)}`,
                publicationGenerationId,
              },
              publicationGenerationId,
              completeness: {
                generationId: publicationGenerationId,
                methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
                expectedCount: scoreIds.length,
                scoredCount: scoreIds.length,
                notRatedCount: 0,
                notRatedIds: [],
              },
            }),
            updated_at: updatedAt,
          },
        ],
      },
    ]);

    const freshness = await getDatasetFreshness(db);

    expect(freshness.safetyGrades).toBeNull();
    expect(db.getHistory().some((entry) => entry.sql.includes("safety_grade_history"))).toBe(false);
  });

  it("uses the DEWS publication pointer and never a newer partial table timestamp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const publishedAt = NOW - 300;
    const pointer = publishedPointer(publishedAt);
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["dews:published-generation"],
        rows: [pointer],
        first: pointer,
      },
      {
        match: "FROM stress_signals",
        first: { latest: NOW - 10 },
        rows: [],
      },
    ]);

    const freshness = await getDatasetFreshness(db);

    expect(freshness.dews).toBe(publishedAt);
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM stress_signals"))).toBe(false);
  });

  it("reports DEWS freshness as unavailable without valid publication evidence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["dews:published-generation"],
        rows: [],
        first: null,
      },
    ]);

    const freshness = await getDatasetFreshness(db);

    expect(freshness.dews).toBeNull();
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM stress_signals"))).toBe(false);
  });
});
