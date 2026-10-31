import { afterEach, describe, expect, it, vi } from "vitest";
import * as conservationModule from "../../mint-burn-conservation";
import { MINT_BURN_CONFIGS } from "../../mint-burn-contracts";
import { MintBurnConservationRecordSchema, MintBurnReconciliationSummarySchema } from "@shared/types/status";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { getDatasetCadenceSec } from "@shared/lib/status-dataset-freshness";
import * as safetySourceModule from "../../safety-score-index";
import { makeWorkerReportCardsV9Response } from "../../../test-helpers/report-cards-v9";
import { DatasetFreshnessSchema } from "@shared/types/status/core";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { getDatasetFreshness, getMintBurnReconciliation } from "../derived-data";
import { makeMintBurnScanSegments } from "../../../test-helpers/__shared/mint-burn";
import { mintBurnConfigKey } from "../../mint-burn-pipeline/sync-state";
import { mintBurnScanFingerprint } from "../../mint-burn-pipeline/scan-coverage";
import { isGrandfatheredMintBurnConfig } from "../../mint-burn-publication";

const NOW = 1_800_000_000;

// Per-scenario stored sync cursors. `lagging` puts the cursor far below the audited window, so the
// record-scoped clauses demote it. `lagging-but-covered` is the production shape: 301 Ethereum blocks
// (one hour, > the 300-block threshold) behind the snapshot head, yet at or after the audited window's
// own opening block and inside the snapshot's observed head.
const LAST_BLOCK_BY_COVERAGE: Readonly<Record<string, number>> = {
  lagging: 90_000_000,
  "lagging-but-covered": 99_999_699,
  quiet: 99_999_925,
};

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
  id?: string; records?: unknown[]; coverage?: string; admittedTron?: boolean; disabledKeys?: string[];
} = {}) {
  const id = options.id ?? "usds-sky";
  const configs = MINT_BURN_CONFIGS.filter((config) => config.stablecoinId === id);
  const records = options.records ?? configs.map(conservationFixture);
  vi.spyOn(conservationModule, "readMintBurnConservationRecords").mockResolvedValue(new Map(
    configs.map((config, index) => [conservationModule.mintBurnConservationCacheKey(config), records[index]]),
  ));
  const db = mockD1([
    { match: "FROM mint_burn_admission", rows: options.admittedTron ? MINT_BURN_CONFIGS
      .filter((config) => config.chain.chainId === "tron").map((config) => ({
        config_key: mintBurnConfigKey(config), config_fingerprint: mintBurnScanFingerprint(config),
        admitted_at: NOW - 1, baseline_from: NOW - 90 * 86400, baseline_to: NOW - 1,
      })) : [] },
    { match: "FROM mint_burn_publication_policy", rows: [{
      disabled_keys: JSON.stringify(options.disabledKeys ?? []), paused_keys: "[]",
    }] },
    { match: "pharos:mint-burn-scan-coverage:read", rows: makeMintBurnScanSegments(Math.floor(NOW / 3600) * 3600) },
    { match: "pharos:mint-burn-legacy-evidence", rows: [] },
    { match: "FROM mint_burn_sync_state", rows: options.coverage === "missing-cursor" ? [] : MINT_BURN_CONFIGS.map((config) => ({
      config_key: `${config.chain.chainId}-${config.contractAddress}`, last_block: LAST_BLOCK_BY_COVERAGE[options.coverage ?? ""] ?? 99_999_999,
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
  expect(db.getHistory().some((entry) => entry.sql.includes("mint-burn-24h") || entry.sql.includes("key = ?"))).toBe(false);
  expect(result.conservationVersion).toBe(1);
  if (!options.disabledKeys) {
    // Only admitted configs reach reconciliation; post-gate additions stay pending until admitted.
    const admittedTron = (config: (typeof MINT_BURN_CONFIGS)[number]) => !!options.admittedTron && config.chain.chainId === "tron";
    expect(result.rows).toHaveLength(new Set(MINT_BURN_CONFIGS.filter((config) => ACTIVE_IDS.has(config.stablecoinId)
      && (isGrandfatheredMintBurnConfig(config) || admittedTron(config))).map((config) => config.stablecoinId)).size);
  }
  return { ...result, rows: result.rows.filter((row) => row.stablecoinId === id) };
}

describe("conservation compatibility schema", () => {
  it("accepts old status payloads without implying conservation evidence", () => {
    const parsed = MintBurnReconciliationSummarySchema.parse({ checkedAt: NOW,
      criticalCount: 1, rows: [{ stablecoinId: "usds-sky", symbol: "USDS",
        status: "critical", coverageStatus: "full" }] });
    expect(parsed.conservationVersion).toBeUndefined();
    expect(parsed.rows[0].conservation).toBeUndefined();
  });

  it("accepts the published record without the internal configuration fingerprint", () => {
    const { configFingerprint: _fingerprint, ...published } = conservationFixture();
    expect(MintBurnConservationRecordSchema.safeParse(published).success).toBe(true);
  });

  it("validates conservation address spelling against its chain without changing EVM admission", () => {
    const address = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
    const tron = { ...conservationFixture(), chainId: "tron", address,
      status: "unsupported", reason: "tron-historical-state-unavailable", fromBlock: null, toBlock: null };
    expect(MintBurnConservationRecordSchema.parse(tron).address).toBe(address);
    for (const patch of [
      { address: address.toLowerCase() }, { address: `${address}1` }, { address: address.replace("7", "0") },
      { address: "0xa614f803b6fd780986a42c78ec9c7f77e6ded13c" }, { chainId: "ethereum" },
    ]) expect(MintBurnConservationRecordSchema.safeParse({ ...tron, ...patch }).success).toBe(false);
    expect(MintBurnConservationRecordSchema.safeParse({ ...conservationFixture(), address: `0x${"A".repeat(40)}` }).success).toBe(true);
  });

  it.each(["01", "-0", "+1", "1e3", "1.0", "", "9".repeat(101)])("rejects noncanonical raw integer %s", (raw) => {
    expect(MintBurnConservationRecordSchema.safeParse({ ...conservationFixture(), residualRaw: raw }).success).toBe(false);
  });
});

describe("getMintBurnReconciliation verified conservation", () => {
  it.each(["tbill-openeden"])("excludes inactive %s just like the producer", async (id) => {
    expect(MINT_BURN_CONFIGS.some((config) => config.stablecoinId === id)).toBe(true);
    expect(ACTIVE_IDS.has(id)).toBe(false);
    const result = await reconcile({ id });
    expect(result.rows).toEqual([]);
    const readConfigs = vi.mocked(conservationModule.readMintBurnConservationRecords).mock.calls[0][1];
    expect(readConfigs?.some((config) => config.stablecoinId === id)).toBe(false);
  });

  it("uses native evidence without reading circulating supply or USD-flow comparisons", async () => {
    const result = await reconcile();
    expect(result.rows[0]).toMatchObject({ status: "ok" });
    expect(result.criticalCount).toBe(0);
    expect(result.rows[0]).not.toHaveProperty("flowNet24hUsd");
    expect(result).not.toHaveProperty("comparedCoins");
    expect(result).not.toHaveProperty("insufficientCount");
    expect(result.rows.flatMap((row) => row.conservation ?? []).every((record) => !("configFingerprint" in record))).toBe(true);
  });

  it.each([
    ["missing", undefined],
    ["malformed", { status: "bad" }],
    ["stale", { checkedAt: NOW - 4501 }],
    ["old block", { toTimestamp: NOW - 4501, fromTimestamp: NOW - 4600 }],
    ["future", { checkedAt: NOW + 1 }],
    ["configuration changed", { configFingerprint: "different" }],
    ["missing internal fingerprint", { configFingerprint: undefined }],
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

  it("keeps a verified pass whose audited window is covered while the coin's flow cursor reads lagging", async () => {
    // Head 100_000_000 vs cursor 99_999_699 => 301 blocks, past the 300-block Ethereum coverage budget,
    // so the row's coverageStatus is "lagging" — the by-design extended-lane deferral shape. The audited
    // window is still inside [cursor, snapshot head], so the conservation verdict must stay verified.
    const record = { ...conservationFixture(), fromBlock: 99_999_600, toBlock: 99_999_699 };
    const result = await reconcile({ records: [record], coverage: "lagging-but-covered" });
    expect(result.rows[0]).toMatchObject({ status: "ok", coverageStatus: "lagging" });
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


  it("rejects positive evidence for a currently unsupported rebasing config", async () => {
    expect((await reconcile({ id: "m-m0" })).rows[0].status).toBe("insufficient-source");
  });

  it("excludes pending Tron from USDT reconciliation and coverage", async () => {
    const result = await reconcile({ id: "usdt-tether" });
    expect(result.rows[0]).toMatchObject({ status: "ok", coverageStatus: "full" });
    expect(result.rows[0].conservation?.map((record) => record.chainId)).toEqual(["ethereum"]);
    const readConfigs = vi.mocked(conservationModule.readMintBurnConservationRecords).mock.calls[0][1];
    expect(readConfigs.some((config) => config.chain.chainId === "tron")).toBe(false);
  });

  it("excludes operator-disabled legs instead of reading their stale conservation evidence", async () => {
    const ethereum = MINT_BURN_CONFIGS.find((config) => config.stablecoinId === "usdt-tether" && config.chain.chainId === "ethereum")!;
    const result = await reconcile({ id: "usdt-tether", disabledKeys: [mintBurnConfigKey(ethereum)] });
    expect(result.rows).toEqual([]);
    const readConfigs = vi.mocked(conservationModule.readMintBurnConservationRecords).mock.calls[0][1];
    expect(readConfigs.some((config) => config.stablecoinId === "usdt-tether")).toBe(false);
  });

  it("keeps admitted unsupported Tron visible with its reason without degrading USDT", async () => {
    const result = await reconcile({ id: "usdt-tether", admittedTron: true });
    expect(result.rows[0]).toMatchObject({ status: "ok", coverageStatus: "full" });
    expect(result.rows[0].conservationIssue).toBeUndefined();
    const tron = result.rows[0].conservation?.find((record) => record.chainId === "tron");
    expect(tron).toMatchObject({
      status: "unsupported", reason: "tron-historical-state-unavailable",
      address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", fromBlock: null, toBlock: null,
    });
    expect(tron).not.toHaveProperty("residualRaw");
    expect(MintBurnReconciliationSummarySchema.safeParse(result).success).toBe(true);
  });

  it.each(["Tr7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u"])(
    "rejects case-changed or bad-checksum Tron evidence %s before any positive verdict", async (address) => {
      const eligibility = conservationModule.getMintBurnConservationEligibility;
      vi.spyOn(conservationModule, "getMintBurnConservationEligibility").mockImplementation((config) =>
        config.chain.chainId === "tron" ? { supported: true } : eligibility(config));
      const configs = MINT_BURN_CONFIGS.filter((config) => config.stablecoinId === "usdt-tether");
      const records = configs.map((config) => ({ ...conservationFixture(config),
        ...(config.chain.chainId === "tron" ? { address } : {}) }));
      const result = await reconcile({ id: "usdt-tether", records, admittedTron: true });
      expect(result.rows[0].conservation?.find((record) => record.chainId === "tron")).toMatchObject({
        status: "unavailable", reason: "Conservation evidence does not match the current contract configuration or clock.",
      });
    },
  );

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
  it("fails closed for safety freshness without an accepted canonical publication instead of reading legacy history", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const db = mockD1([]);
    const freshness = await getDatasetFreshness(db);
    expect(freshness.safetyGrades).toBeNull();
    expect(freshness.unavailableReasons?.safetyGrades).toBe("missing-timestamp");
    expect(db.getHistory().some((entry) => entry.sql.includes("safety_grade_history"))).toBe(false);
  });

  it("keeps other dataset freshness available when the canonical publication read fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    vi.spyOn(safetySourceModule, "loadActiveSafetyScoreIndex").mockRejectedValue(new Error("publication unavailable"));
    const freshness = await getDatasetFreshness(mockD1([
      { match: "SELECT MAX(updated_at) as latest FROM cache", rows: [], first: { latest: NOW - 60 } },
    ]));
    expect(freshness).toMatchObject({ safetyGrades: null, stablecoins: NOW - 60 });
    expect(freshness.unavailableReasons?.safetyGrades).toBe("missing-timestamp");
  });

  it.each(["v9", "held"] as const)("uses the canonical %s publication clock with the publication producer budget", async (kind) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const updatedAt = NOW - 2 * 86400;
    const snapshot = makeWorkerReportCardsV9Response({ updatedAt });
    vi.spyOn(safetySourceModule, "loadActiveSafetyScoreIndex").mockResolvedValue(
      kind === "v9" ? { kind, snapshot }
        : { kind, snapshot, reason: "v9-publication-held", detail: "Held publication" },
    );
    const freshness = await getDatasetFreshness(mockD1([]));
    expect(freshness.safetyGrades).toBe(updatedAt);
    expect(freshness.unavailableReasons?.safetyGrades).toBeUndefined();
    expect(getDatasetCadenceSec("safetyGrades")).toBe(3600);
  });

  it.each([
    [NOW + 1, "future-timestamp"],
    [NOW + 61, "future-timestamp"],
    [Number.NaN, "invalid-timestamp"],
    [Number.POSITIVE_INFINITY, "invalid-timestamp"],
    [null, "missing-timestamp"],
  ] as const)("rejects dataset clock %s with a per-dataset machine reason", async (clock, reason) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    if (clock != null) {
      vi.spyOn(safetySourceModule, "loadActiveSafetyScoreIndex").mockResolvedValue({
        kind: "v9", snapshot: { ...makeWorkerReportCardsV9Response(), updatedAt: clock },
      });
    }
    const freshness = await getDatasetFreshness(mockD1([
      { match: "SELECT MAX(updated_at) as latest FROM cache", rows: [], first: { latest: clock } },
      { match: "SELECT MAX(snapshot_date)", rows: [], first: { latest: NOW - 100 } },
    ]));
    expect(freshness.stablecoins).toBeNull();
    expect(freshness.unavailableReasons?.stablecoins).toBe(reason);
    expect(freshness.supply).toBe(NOW - 100);
    expect(freshness.safetyGrades).toBeNull();
    expect(freshness.unavailableReasons?.safetyGrades).toBe(reason);
    expect(DatasetFreshnessSchema.parse(freshness).unavailableReasons).toEqual(freshness.unavailableReasons);
  });

  it("preserves an admitted observed zero timestamp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const freshness = await getDatasetFreshness(mockD1([
      { match: "SELECT MAX(updated_at) as latest FROM cache", rows: [], first: { latest: 0 } },
    ]));
    expect(freshness.stablecoins).toBe(0);
    expect(freshness.unavailableReasons?.stablecoins).toBeUndefined();
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
