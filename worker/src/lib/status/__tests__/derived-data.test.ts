import { afterEach, describe, expect, it, vi } from "vitest";
import * as conservationModule from "../../mint-burn-conservation";
import { MINT_BURN_CONFIGS } from "../../mint-burn-contracts";
import { MintBurnConservationRecordSchema, MintBurnReconciliationSummarySchema } from "@shared/types/status";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/constants";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { getDatasetFreshness, getMintBurnReconciliation } from "../derived-data";

const NOW = 1_800_000_000;

function conservationFixture(config = MINT_BURN_CONFIGS.find((entry) => entry.stablecoinId === "usds-sky")!) {
  return {
    version: 1 as const, key: conservationModule.mintBurnConservationCacheKey(config),
    configFingerprint: conservationModule.mintBurnConservationFingerprint(config),
    stablecoinId: config.stablecoinId, chainId: config.chain.chainId,
    address: config.contractAddress, decimals: config.decimals,
    checkedAt: NOW, status: "ok" as const,
    fromBlock: 99_999_990, toBlock: 99_999_999,
    fromBlockHash: "0x" + "a".repeat(64), toBlockHash: "0x" + "b".repeat(64),
    fromTimestamp: NOW - 120, toTimestamp: NOW - 12,
    mintRaw: "110", burnRaw: "10", supplyDeltaRaw: "100", residualRaw: "0", logCount: 2,
  };
}

async function reconcile(options: {
  id?: string; records?: unknown[]; coverage?: string; chainCirculating?: Record<string, unknown>; supplySource?: string;
} = {}) {
  const id = options.id ?? "usds-sky";
  const configs = MINT_BURN_CONFIGS.filter((config) => config.stablecoinId === id);
  const records = options.records ?? configs.map(conservationFixture);
  vi.spyOn(conservationModule, "readMintBurnConservationRecords").mockResolvedValue(new Map(
    configs.map((config, index) => [conservationModule.mintBurnConservationCacheKey(config), records[index]]),
  ));
  const db = mockD1([
    { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [{ value: JSON.stringify({ peggedAssets: [{
      id, symbol: "TEST", price: 1, circulating: { peggedUSD: 1_000_000 },
      chainCirculating: options.chainCirculating ?? { Ethereum: { current: 300_000_100, circulatingPrevDay: 100 } },
      supplySource: options.supplySource ?? "defillama",
    }] }), updated_at: NOW }] },
    { match: "pharos:status-derived:mint-burn-24h", rows: [{ stablecoin_id: id, chain_id: "ethereum", net_flow_usd: 10 }] },
    { match: "pharos:status-derived:mint-burn-first-hour-seek", rows: [] },
    { match: "FROM mint_burn_sync_state", rows: options.coverage === "missing-cursor" ? [] : MINT_BURN_CONFIGS.map((config) => ({
      config_key: `${config.chain.chainId}-${config.contractAddress}`, last_block: options.coverage === "lagging" ? 90_000_000 : options.coverage === "quiet" ? 99_999_925 : 99_999_999,
    })) },
    ...["sync-mint-burn", "sync-mint-burn-extended"].map((job) => ({
      match: "FROM cron_runs", matchBinds: [job], rows: [{
        started_at: options.coverage === "stale" ? NOW - 86400 : NOW,
        status: options.coverage === "error" ? "error" : "ok",
        metadata: JSON.stringify({ chainHeads: { ethereum: 100_000_000 } }),
      }],
    })),
  ]);
  const result = await getMintBurnReconciliation(db, NOW);
  expect(db.getHistory().find((entry) => entry.sql.includes("mint-burn-24h"))?.binds)
    .toEqual([Math.floor(NOW / 3600) * 3600 - 86400, Math.floor(NOW / 3600) * 3600]);
  expect(result?.conservationVersion).toBe(1);
  return result!;
}

describe("conservation compatibility schema", () => {
  it("accepts old status payloads without implying conservation evidence", () => {
    const parsed = MintBurnReconciliationSummarySchema.parse({ checkedAt: NOW, comparedCoins: 1,
      criticalCount: 1, insufficientCount: 0, rows: [{ stablecoinId: "usds-sky", symbol: "USDS",
        flowNet24hUsd: 10, chainSupplyDelta24hUsd: 100, absoluteDiffUsd: 90, diffRatio: 0.9,
        status: "critical", coverageStatus: "full" }] });
    expect(parsed.conservationVersion).toBeUndefined();
    expect(parsed.rows[0].conservation).toBeUndefined();
  });

  it.each(["01", "-0", "+1", "1e3", "1.0", "", "9".repeat(101)])("rejects noncanonical raw integer %s", (raw) => {
    expect(MintBurnConservationRecordSchema.safeParse({ ...conservationFixture(), residualRaw: raw }).success).toBe(false);
  });
});

describe("getMintBurnReconciliation verified conservation", () => {
  it("uses a fresh native pass, not a huge indicative USD gap", async () => {
    const result = await reconcile();
    expect(result.rows[0]).toMatchObject({ status: "ok", chainSupplyDelta24hUsd: 300_000_000 });
    expect(result.criticalCount).toBe(0);
    expect(result.rows[0].comparisonIssue).toContain("indicative");
  });

  it.each([
    ["missing", undefined],
    ["malformed", { status: "bad" }],
    ["stale", { checkedAt: NOW - 4501 }],
    ["old block", { toTimestamp: NOW - 4501, fromTimestamp: NOW - 4600 }],
    ["future", { checkedAt: NOW + 1 }],
    ["configuration changed", { configFingerprint: "different" }],
    ["wrong identity", { stablecoinId: "dai-makerdao" }],
    ["wrong address", { address: "0x" + "c".repeat(40) }],
    ["wrong decimals", { decimals: 6 }],
    ["bad hash", { toBlockHash: "0x" + "0".repeat(64) }],
    ["same hash", { toBlockHash: "0x" + "a".repeat(64) }],
    ["reversed blocks", { fromBlock: 100_000_000 }],
    ["future block", { toTimestamp: NOW + 1 }],
    ["unsynced block", { toBlock: 100_000_001 }],
    ["noncanonical raw", { mintRaw: "0110" }],
    ["inconsistent arithmetic", { residualRaw: "1" }],
    ["inconsistent status", { status: "mismatch" }],
    ["no logs but issuance", { logCount: 0 }],
    ["unavailable", { status: "unavailable", reason: "RPC failed" }],
  ])("fails closed for %s evidence", async (_label, patch) => {
    const result = await reconcile({ records: [patch === undefined ? undefined : { ...conservationFixture(), ...patch }] });
    expect(result.rows[0].status).toBe("insufficient-source");
    expect(result.criticalCount).toBe(0);
    expect(result.rows[0].conservation?.[0].status).not.toBe("ok");
  });

  it.each(["stale", "error", "missing-cursor", "lagging"])("gates positive evidence on %s scan coverage", async (coverage) => {
    expect((await reconcile({ coverage })).rows[0].status).toBe("insufficient-source");
  });

  it("accepts a completed quiet scan whose replay-safe cursor intentionally trails its audited end", async () => {
    const record = { ...conservationFixture(), fromBlock: 99_999_900,
      mintRaw: "0", burnRaw: "0", supplyDeltaRaw: "0", residualRaw: "0", logCount: 0 };
    expect((await reconcile({ records: [record], coverage: "quiet" })).rows[0].status).toBe("ok");
  });

  it("keeps a verified historical mismatch unresolved when cron or evidence age degrades", async () => {
    const record = { ...conservationFixture(), checkedAt: NOW - 86400, fromTimestamp: NOW - 86520,
      toTimestamp: NOW - 86412, status: "mismatch", supplyDeltaRaw: "99", residualRaw: "1" };
    const result = await reconcile({ records: [record], coverage: "stale" });
    expect(result.rows[0].status).toBe("critical");
    expect(result.rows[0].conservation?.[0].checkedAt).toBe(NOW - 86400);
  });

  it("verifies current-only supply independently without inventing USD history", async () => {
    const result = await reconcile({ supplySource: "onchain-total-supply", chainCirculating: { Ethereum: { current: 100, circulatingPrevDay: 0 } } });
    expect(result.rows[0]).toMatchObject({ status: "ok", chainSupplyDelta24hUsd: null, absoluteDiffUsd: null });
  });

  it.each([
    [{ Ethereum: { current: 110, circulatingPrevDay: 100 } }, 10],
    [{ ethereum: { current: 110, circulatingPrevDay: 0 } }, 110],
    [{ old: { chainId: "ethereum", current: 110, circulatingPrevDay: 100 } }, 10],
    [{ Ethereum: { current: 110 } }, null],
    [{ Ethereum: { current: 110, circulatingPrevDay: 100 }, ethereum: { current: 110, circulatingPrevDay: 100 } }, null],
  ])("keeps indicative supply identity separate from native verdict", async (chainCirculating, delta) => {
    expect((await reconcile({ chainCirculating })).rows[0]).toMatchObject({ status: "ok", chainSupplyDelta24hUsd: delta });
  });

  it("requires every configured BUIDL contract to pass", async () => {
    const configs = MINT_BURN_CONFIGS.filter((config) => config.stablecoinId === "buidl-blackrock");
    expect(configs).toHaveLength(2);
    expect((await reconcile({ id: "buidl-blackrock", records: [conservationFixture(configs[0]), undefined] })).rows[0].status)
      .toBe("insufficient-source");
    expect((await reconcile({ id: "buidl-blackrock" })).rows[0].status).toBe("ok");
  });

  it("keeps a valid mismatch critical even when another configured contract is missing", async () => {
    const config = MINT_BURN_CONFIGS.find((entry) => entry.stablecoinId === "buidl-blackrock")!;
    const record = { ...conservationFixture(config), status: "mismatch", supplyDeltaRaw: "99", residualRaw: "1" };
    expect((await reconcile({ id: "buidl-blackrock", records: [record, undefined] })).rows[0].status).toBe("critical");
  });

  it("retains old source-scope explanations as context without overriding native passes", async () => {
    vi.spyOn(conservationModule, "getMintBurnConservationEligibility").mockReturnValue({ supported: true });
    const result = await reconcile({ id: "dai-makerdao" });
    expect(result.rows[0].status).toBe("ok");
    expect(result.rows[0].comparisonIssue).toContain("DSR");
  });

  it("rejects positive evidence for a currently unsupported rebasing config", async () => {
    expect((await reconcile({ id: "ousd-origin-protocol" })).rows[0].status).toBe("insufficient-source");
  });

  it("does not cancel opposite residuals on separate contracts or intervals", async () => {
    const configs = MINT_BURN_CONFIGS.filter((config) => config.stablecoinId === "buidl-blackrock");
    const records = configs.map((config, index) => ({ ...conservationFixture(config),
      status: "mismatch", supplyDeltaRaw: index ? "101" : "99", residualRaw: index ? "-1" : "1",
      fromBlock: 99_999_980 + index * 5, toBlock: 99_999_981 + index * 5,
    }));
    expect((await reconcile({ id: "buidl-blackrock", records })).rows[0].status).toBe("critical");
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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
