import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as conservationModule from "../../mint-burn-conservation";
import { getMintBurnConfigsForStablecoin as byId, MINT_BURN_CONFIGS } from "../../mint-burn-contracts";
import { MintBurnConservationRecordSchema, MintBurnReconciliationSummarySchema } from "@shared/types/status";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { getDatasetCadenceSec } from "@shared/lib/status-dataset-freshness";
import * as safetySourceModule from "../../safety-score-index";
import { makeWorkerReportCardsV9Response } from "../../../test-helpers/report-cards-v9";
import { DatasetFreshnessSchema } from "@shared/types/status/core";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { getDatasetFreshness, getMintBurnReconciliation } from "../derived-data";
import { makeMintBurnScanSegments } from "../../../test-helpers/__shared/mint-burn";
import { mintBurnConfigKey } from "../../mint-burn-contract-identity";
import { mintBurnScanFingerprint } from "../../mint-burn-pipeline/scan-coverage";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { isGrandfatheredMintBurnConfig, syncMintBurnPublicationPolicy } from "../../mint-burn-publication";
import { readMintBurnSupplyReconciliation } from "../../mint-burn-supply-reconciliation";

vi.mock("../../mint-burn-supply-reconciliation", () => ({ readMintBurnSupplyReconciliation: vi.fn(async () => new Map()) }));

const NOW = 1_800_000_000;
const fixtures = createLatestSchemaFixtureTracker();

// A covered audited window can pass even when its flow cursor trails the head by 301 blocks.
const LAST_BLOCK_BY_COVERAGE: Readonly<Record<string, number>> = {
  lagging: 90_000_000,
  "lagging-but-covered": 99_999_699,
  quiet: 99_999_925,
};

function conservationFixture(config = byId("usds-sky")[0]) {
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
  id?: string; records?: unknown[]; coverage?: string; scanAgeSec?: number; admitted?: boolean; disabledKeys?: string[]; paused?: boolean;
} = {}) {
  const id = options.id ?? "usds-sky";
  const configs = byId(id);
  const records = options.records ?? configs.map(conservationFixture);
  vi.spyOn(conservationModule, "readMintBurnConservationRecords").mockResolvedValue(new Map(
    configs.map((config, index) => [conservationModule.mintBurnConservationCacheKey(config), records[index]]),
  ));
  const db = mockD1([
    { match: "FROM mint_burn_admission", rows: options.admitted ? configs.map((config) => ({
      config_key: mintBurnConfigKey(config), config_fingerprint: mintBurnScanFingerprint(config),
      admitted_at: NOW - 1, baseline_from: NOW - 90 * 86400, baseline_to: NOW - 1,
    })) : [] },
    { match: "FROM mint_burn_publication_policy", rows: [{
      disabled_keys: JSON.stringify(options.disabledKeys ?? []), paused_keys: JSON.stringify(options.paused ? configs.map(mintBurnConfigKey) : []),
    }] },
    { match: "pharos:mint-burn-scan-coverage:read", rows: makeMintBurnScanSegments(NOW, 90,
      MINT_BURN_CONFIGS.filter((config) => isGrandfatheredMintBurnConfig(config) || (options.admitted && config.stablecoinId === id)))
      .filter((row) => !options.paused || !configs.some((config) => mintBurnConfigKey(config) === row.config_key)) },
    { match: "pharos:mint-burn-legacy-evidence", rows: [] },
    { match: "FROM mint_burn_sync_state", rows: options.coverage === "missing-cursor" ? [] : MINT_BURN_CONFIGS.map((config) => ({
      config_key: `${config.chain.chainId}-${config.contractAddress}`, last_block: options.coverage === "lagging-tron" && config.chain.chainId === "tron"
        ? 90_000_000 : LAST_BLOCK_BY_COVERAGE[options.coverage ?? ""] ?? 99_999_999,
    })) },
    ...["sync-mint-burn", "sync-mint-burn-extended"].map((job) => ({
      match: "FROM cron_runs", matchBinds: [job], rows: [{
        started_at: NOW - (options.scanAgeSec ?? (options.coverage === "stale" ? 86400 : 0)),
        status: options.coverage === "error" ? "error" : "ok",
        metadata: JSON.stringify({ chainHeads: { ethereum: 100_000_000, tron: 100_000_000 } }),
      }],
    })),
  ]);
  const result = await getMintBurnReconciliation(db, NOW);
  expect(db.getHistory().some((entry) => entry.sql.includes("mint-burn-24h") || entry.sql.includes("key = ?"))).toBe(false);
  expect(result.conservationVersion).toBe(1);
  if (!options.disabledKeys) {
    const admitted = (config: (typeof MINT_BURN_CONFIGS)[number]) => !!options.admitted && config.stablecoinId === id;
    expect(result.rows).toHaveLength(new Set(MINT_BURN_CONFIGS.filter((config) => ACTIVE_IDS.has(config.stablecoinId)
      && (isGrandfatheredMintBurnConfig(config) || admitted(config))).map((config) => config.stablecoinId)).size);
  }
  return { ...result, rows: result.rows.filter((row) => row.stablecoinId === id),
    readConfigs: vi.mocked(conservationModule.readMintBurnConservationRecords).mock.lastCall![1] };
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
  it("projects daily ledger findings without changing the raw scan verdict", async () => {
    const config = byId("usds-sky")[0];
    const leg = { configKey: mintBurnConfigKey(config), chainId: config.chain.chainId,
      address: config.contractAddress, decimals: config.decimals, latestDay: NOW - 86400, checkedAt: NOW,
      status: "unavailable" as const, reason: "incomplete-scan-coverage", windows: [],
      activeFindings: [{ day: NOW - 172800, status: "review-suppression" as const, reason: "material-review-suppression" }] };
    vi.mocked(readMintBurnSupplyReconciliation).mockResolvedValueOnce(new Map([[leg.configKey, leg]]));
    const result = await reconcile();
    expect(result.rows[0].dailyReconciliation).toEqual([leg]);
    expect(result.rows[0].status).toBe("ok");
    expect(MintBurnReconciliationSummarySchema.safeParse(result).success).toBe(true);
  });

  it.each(["tbill-openeden"])("excludes inactive %s just like the producer", async (id) => {
    expect(MINT_BURN_CONFIGS.some((config) => config.stablecoinId === id)).toBe(true);
    expect(ACTIVE_IDS.has(id)).toBe(false);
    const result = await reconcile({ id });
    expect(result.rows).toEqual([]);
    expect(result.readConfigs.some((config) => config.stablecoinId === id)).toBe(false);
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
    ["stale", { checkedAt: NOW - 5401, toTimestamp: NOW - 5413, fromTimestamp: NOW - 5521 }],
    ["old block", { toTimestamp: NOW - 5401, fromTimestamp: NOW - 5521 }],
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
    for (const paused of [false, true]) {
      const result = await reconcile({ paused, records: [patch === undefined ? undefined : { ...conservationFixture(), ...patch }] });
      expect(result.rows[0].status).toBe("insufficient-source");
      expect(result.criticalCount).toBe(0);
      expect(result.rows[0].conservation?.[0].status).not.toBe("ok");
    }
  });

  it.each(["stale", "error", "missing-cursor", "lagging"])("gates positive evidence on %s scan coverage", async (coverage) => {
    expect((await reconcile({ coverage })).rows[0].status).toBe("insufficient-source");
  });

  it.each([["usds-sky", 5400], ["fdusd-first-digital", 10800]] as const)("uses three producer intervals for %s proof and scans", async (id, maxAgeSec) => {
    for (const age of [maxAgeSec, maxAgeSec + 1]) {
      const result = await reconcile({ id, scanAgeSec: age, records: [{ ...conservationFixture(byId(id)[0]),
        checkedAt: NOW - age, toTimestamp: NOW - age, fromTimestamp: NOW - age - 120 }] });
      expect(result.rows[0].status).toBe(age === maxAgeSec ? "ok" : "insufficient-source");
      expect(MintBurnReconciliationSummarySchema.parse(result).rows[0].conservation?.[0].maxAgeSec).toBe(maxAgeSec);
    }
    expect((await reconcile({ id, scanAgeSec: maxAgeSec + 1 })).rows[0].status).toBe("insufficient-source");
  });

  it.each([
    ["lagging-but-covered", { fromBlock: 99_999_600, toBlock: 99_999_699 }, "lagging"],
    ["quiet", { fromBlock: 99_999_900, mintRaw: "0", burnRaw: "0", supplyDeltaRaw: "0", residualRaw: "0", logCount: 0 }, "full"],
  ] as const)("verifies %s audited blocks independently of flow backlog", async (coverage, patch, coverageStatus) => {
    const result = await reconcile({ records: [{ ...conservationFixture(), ...patch }], coverage });
    expect(result.rows[0]).toMatchObject({ status: "ok", coverageStatus });
  });

  it("keeps a verified historical mismatch unresolved when cron or evidence age degrades", async () => {
    const record = { ...conservationFixture(), checkedAt: NOW - 86400, fromTimestamp: NOW - 86520,
      toTimestamp: NOW - 86412, status: "mismatch", supplyDeltaRaw: "99", residualRaw: "1" };
    const result = await reconcile({ records: [record], coverage: "stale" });
    expect(result.rows[0].status).toBe("critical");
    expect(result.rows[0].conservation?.[0].checkedAt).toBe(NOW - 86400);
  });


  it("retains quarantined SQLite mismatches until a covering pass and propagates failed reads", async () => {
    const { db, sqlite } = fixtures.open();
    const bad = byId("usds-sky")[0];
    await syncMintBurnPublicationPolicy(db, [], NOW);
    for (const config of MINT_BURN_CONFIGS) {
      const end = NOW - (config === bad ? 86400 : 0);
      sqlite.prepare(`INSERT INTO mint_burn_scan_coverage
        (config_key, config_fingerprint, chain_id, from_block, to_block, from_timestamp, to_timestamp,
         finality_tag, finalized_block, accepted_at) VALUES (?, ?, ?, 1, 100, ?, ?, 'finalized', 100, ?)`)
        .run(mintBurnConfigKey(config), mintBurnScanFingerprint(config), config.chain.chainId, end - 3600, end, NOW);
    }
    const mismatch = { ...conservationFixture(bad), status: "mismatch" as const, supplyDeltaRaw: "99", residualRaw: "1" };
    await conservationModule.persistMintBurnConservation(db, mismatch);
    const row = async () => (await getMintBurnReconciliation(db, NOW)).rows.find((entry) => entry.stablecoinId === bad.stablecoinId)!;
    expect((await row()).status).toBe("critical");
    const policy = sqlite.prepare("SELECT paused_keys FROM mint_burn_publication_policy").get() as { paused_keys: string };
    expect(JSON.parse(policy.paused_keys)).toContain(mintBurnConfigKey(bad));
    const pass = { ...mismatch, status: "ok" as const, supplyDeltaRaw: "100", residualRaw: "0" };
    expect(await conservationModule.persistMintBurnConservation(db, { ...pass, fromBlock: pass.fromBlock + 1 })).toEqual({ written: false });
    expect((await row()).status).toBe("critical");
    expect(await conservationModule.persistMintBurnConservation(db, pass)).toEqual({ written: true });
    expect((await row()).status).toBe("insufficient-source");
    sqlite.prepare("INSERT INTO mint_burn_sync_state VALUES (?, ?)").run(mintBurnConfigKey(bad), pass.toBlock);
    sqlite.prepare("INSERT INTO cron_runs (job, started_at, duration_ms, status, metadata) VALUES (?, ?, 1, 'ok', ?)")
      .run(bad.tier === "extended" ? "sync-mint-burn-extended" : "sync-mint-burn", NOW,
        JSON.stringify({ chainHeads: { ethereum: pass.toBlock } }));
    expect((await row()).status).toBe("ok");
    vi.spyOn(conservationModule, "readMintBurnConservationRecords").mockRejectedValueOnce(new Error("read failed"));
    await expect(getMintBurnReconciliation(db, NOW)).rejects.toThrow("read failed");
  });

  it.each([
    ["all passing", "ok", false, "ok"],
    ["missing sibling", "ok", true, "insufficient-source"],
    ["mismatch and missing sibling", "mismatch", true, "critical"],
    ["opposite residuals and intervals", "mismatch", false, "critical"],
  ] as const)("requires every BUIDL contract independently: %s", async (_label, status, missing, expected) => {
    const configs = byId("buidl-blackrock");
    expect(configs).toHaveLength(2);
    const records = configs.map((config, i) => missing && i ? undefined : {
      ...conservationFixture(config), status,
      supplyDeltaRaw: status === "ok" ? "100" : i ? "101" : "99", residualRaw: status === "ok" ? "0" : i ? "-1" : "1",
      fromBlock: 99_999_980 + i * 5, toBlock: 99_999_981 + i * 5,
    });
    expect((await reconcile({ id: "buidl-blackrock", records })).rows[0].status).toBe(expected);
  });

  it.each(["m-m0", "swanusd-swan"])("keeps unsupported %s unverified with operator lag visible", async (id) => {
    expect((await reconcile({ id, coverage: "lagging", admitted: true })).rows[0]).toMatchObject({ status: "insufficient-source", coverageStatus: "lagging" });
  });

  it("excludes pending Tron from USDT reconciliation and coverage", async () => {
    const result = await reconcile({ id: "usdt-tether" });
    expect(result.rows[0]).toMatchObject({ status: "ok", coverageStatus: "full" });
    expect(result.rows[0].conservation?.map((record) => record.chainId)).toEqual(["ethereum"]);
    expect(result.readConfigs.some((config) => config.chain.chainId === "tron")).toBe(false);
  });

  it.each(["usdt-tether", "buidl-blackrock"])("excludes explicit and shared-bucket disables for %s", async (id) => {
    const result = await reconcile({ id, disabledKeys: [mintBurnConfigKey(byId(id)[0])], paused: true });
    expect(result.rows).toEqual([]);
    expect(result.readConfigs.some((config) => config.stablecoinId === id)).toBe(false);
  });

  it.each([["full", "full"], ["lagging-tron", "lagging"]])("keeps unsupported Tron %s without degrading USDT", async (coverage, coverageStatus) => {
    const result = await reconcile({ id: "usdt-tether", admitted: true, coverage });
    expect(result.rows[0]).toMatchObject({ status: "ok", coverageStatus });
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
      const configs = byId("usdt-tether");
      const records = configs.map((config) => ({ ...conservationFixture(config),
        ...(config.chain.chainId === "tron" ? { address } : {}) }));
      const result = await reconcile({ id: "usdt-tether", records, admitted: true });
      expect(result.rows[0].conservation?.find((record) => record.chainId === "tron")).toMatchObject({
        status: "unavailable", reason: "Conservation evidence does not match the current contract configuration or clock.",
      });
    },
  );
});

afterEach(() => {
  fixtures.closeAll();
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
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(NOW * 1000)); });
  it("fails closed for safety freshness without an accepted canonical publication instead of reading legacy history", async () => {
    const db = mockD1([]);
    const freshness = await getDatasetFreshness(db);
    expect(freshness.safetyGrades).toBeNull();
    expect(freshness.unavailableReasons?.safetyGrades).toBe("missing-timestamp");
    expect(db.getHistory().some((entry) => entry.sql.includes("safety_grade_history"))).toBe(false);
  });

  it("keeps other dataset freshness available when the canonical publication read fails", async () => {
    vi.spyOn(safetySourceModule, "loadActiveSafetyScoreIndex").mockRejectedValue(new Error("publication unavailable"));
    const freshness = await getDatasetFreshness(mockD1([
      { match: "SELECT MAX(updated_at) as latest FROM cache", rows: [], first: { latest: NOW - 60 } },
    ]));
    expect(freshness).toMatchObject({ safetyGrades: null, stablecoins: NOW - 60 });
    expect(freshness.unavailableReasons?.safetyGrades).toBe("missing-timestamp");
  });

  it.each(["v9", "held"] as const)("uses the canonical %s publication clock with the publication producer budget", async (kind) => {
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
    const freshness = await getDatasetFreshness(mockD1([
      { match: "SELECT MAX(updated_at) as latest FROM cache", rows: [], first: { latest: 0 } },
    ]));
    expect(freshness.stablecoins).toBe(0);
    expect(freshness.unavailableReasons?.stablecoins).toBeUndefined();
  });

  it.each([true, false])("uses only valid DEWS publication evidence: %s", async (published) => {
    const publishedAt = NOW - 300;
    const pointer = published ? publishedPointer(publishedAt) : null;
    const db = mockD1([
      { match: "FROM cache WHERE key = ?", matchBinds: ["dews:published-generation"],
        rows: pointer ? [pointer] : [], first: pointer },
      { match: "FROM stress_signals", first: { latest: NOW - 10 }, rows: [] },
    ]);
    const freshness = await getDatasetFreshness(db);
    expect(freshness.dews).toBe(published ? publishedAt : null);
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM stress_signals"))).toBe(false);
  });
});
