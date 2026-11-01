import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { canonicalTronAddress } from "@shared/lib/tron-address";
import { WORKER_ACTIVE_IDS } from "@shared/lib/stablecoins/worker-runtime-registry";
import { MintBurnConservationRecordSchema, type MintBurnConservationRecord, type MintBurnReconciliationRow, type MintBurnReconciliationSummary, type StatusResponse } from "@shared/types/status";
import { buildInClause } from "../db";
import { buildCoinCoverageMap, readMintBurnCronSnapshot, readMintBurnWindowContext, type MintBurnCronSnapshot } from "../mint-burn-flows-service";
import { readMintBurnSyncStateBatch } from "../mint-burn-pipeline/sync-state";
import { MINT_BURN_PUBLIC_FRESHNESS_MAX_AGE_SEC } from "../mint-burn-health-config";
import { MINT_BURN_CONFIGS, type MintBurnContractConfig } from "../mint-burn-contracts";
import { conservationIdentityAddress, mintBurnConservationCacheKey, mintBurnConservationFingerprint, readMintBurnConservationRecords, getMintBurnConservationEligibility } from "../mint-burn-conservation";
import { emptyReserveCompositionOverview } from "@shared/types/live-reserves";
import { logWorkerEvent } from "../structured-log";
import type { MintBurnScanSegment } from "../mint-burn-pipeline/scan-coverage";
import { readDewsPublishedGenerationResult } from "../dews-publication-pointer";
import { loadActiveSafetyScoreIndex } from "../safety-score-index";
import { CONFIRMED_CRON_OUTPUT_AT_SQL } from "../cron-output";
import { STATUS_DATASET_FRESHNESS } from "@shared/lib/status-dataset-freshness";
import type { DatasetFreshnessKey } from "@shared/types/status/core";
import { assessFreshnessTimestamp } from "../api-freshness-age";
import {
  DEPEG_CENSUS_PRODUCER_JOB,
  loadLatestDepegLedgerRunAt,
} from "../depeg-ledger-clock";

export function emptyDatasetFreshness(): StatusResponse["datasetFreshness"] {
  return {
    stablecoins: null,
    blacklist: null,
    mintBurn: null,
    supply: null,
    safetyGrades: null,
    yield: null,
    depegs: null,
    dews: null,
    digest: null,
  };
}

export function emptyReserveComposition(): Exclude<StatusResponse["reserveComposition"], { status: "unavailable" }> {
  return {
    ...emptyReserveCompositionOverview(),
    status: "healthy",
    freshCoverageRatio: 0,
    authoritativeFreshCoverageRatio: 0,
  };
}

type DatasetFreshnessTarget =
  | {
      type: "table";
      table: string;
      column: string;
      where?: string;
    }
  | {
      type: "cron";
      jobs: readonly string[];
    }
  | {
      type: "dews-publication";
    }
  | {
      type: "depeg-ledger";
    }
  | {
      type: "report-card-publication";
    };

const DATASET_FRESHNESS_TARGETS: Record<DatasetFreshnessKey, DatasetFreshnessTarget> = {
  stablecoins: { type: "table", table: "cache", column: "updated_at", where: "key = 'stablecoins'" },
  blacklist: { type: "cron", jobs: STATUS_DATASET_FRESHNESS.blacklist.owners },
  mintBurn: { type: "cron", jobs: STATUS_DATASET_FRESHNESS.mintBurn.owners },
  supply: { type: "table", table: "supply_history", column: "snapshot_date" },
  safetyGrades: { type: "report-card-publication" },
  yield: {
    type: "table",
    table: "yield_data",
    column: "updated_at",
    where: "is_best = 1 AND (publication_generation_id IS NULL OR publication_state = 'published')",
  },
  // The depeg ledger's clock is detection output, not the stablecoins cache that
  // is published even when the detection pass fails or is held.
  depegs: { type: "depeg-ledger" },
  dews: { type: "dews-publication" },
  digest: { type: "table", table: "daily_digest", column: "generated_at" },
};

const TABLE_TARGETS = Object.values(DATASET_FRESHNESS_TARGETS).filter(
  (t): t is Extract<DatasetFreshnessTarget, { type: "table" }> => t.type === "table",
);
const ALLOWED_DATASET_TABLES = new Set(TABLE_TARGETS.map((t) => t.table));
const ALLOWED_DATASET_COLUMNS = new Set(TABLE_TARGETS.map((t) => t.column));
const ALLOWED_DATASET_WHERE_CLAUSES = new Set(TABLE_TARGETS.map((t) => t.where).filter(Boolean));

async function getLastTableUpdate(
  db: D1Database,
  target: Extract<DatasetFreshnessTarget, { type: "table" }>,
): Promise<number | null> {
  if (!ALLOWED_DATASET_TABLES.has(target.table)) {
    throw new Error(`Invalid dataset table: ${target.table}`);
  }
  if (!ALLOWED_DATASET_COLUMNS.has(target.column)) {
    throw new Error(`Invalid dataset column: ${target.column}`);
  }
  if (target.where && !ALLOWED_DATASET_WHERE_CLAUSES.has(target.where)) {
    throw new Error(`Invalid dataset where clause: ${target.where}`);
  }
  const where = target.where ? ` WHERE ${target.where}` : "";
  try {
    const row = await db
      // SAFETY: target table/column/where each pass the registry-derived allowlists above.
      .prepare(`SELECT MAX(${target.column}) as latest FROM ${target.table}${where}`)
      .first<{ latest: number | null }>();
    return row?.latest ?? null;
  } catch (err) {
    logWorkerEvent({
      scope: "status",
      level: "error",
      event: "dataset_table_freshness_query_failed",
      route: "status",
      source: target.table,
      message: "Failed dataset freshness query",
      error: err,
      metadata: { column: target.column },
    });
    return null;
  }
}

async function getLastSuccessfulCronRun(db: D1Database, jobs: readonly string[]): Promise<number | null> {
  try {
    const jobInClause = buildInClause(jobs);
    const row = await db
      .prepare(
        `SELECT MAX(${CONFIRMED_CRON_OUTPUT_AT_SQL}) as latest
         FROM cron_runs
         WHERE job IN (${jobInClause.sql})`,
      )
      .bind(...jobInClause.binds)
      .first<{ latest: number | null }>();
    return row?.latest ?? null;
  } catch (err) {
    logWorkerEvent({
      scope: "status",
      level: "error",
      event: "dataset_cron_freshness_query_failed",
      route: "status",
      message: "Failed dataset freshness query for cron jobs",
      error: err,
      metadata: { jobs },
    });
    return null;
  }
}

async function getLastUpdate(db: D1Database, target: DatasetFreshnessTarget, now: number): Promise<number | null> {
  if (target.type === "cron") {
    return getLastSuccessfulCronRun(db, target.jobs);
  }
  if (target.type === "depeg-ledger") {
    try {
      return await loadLatestDepegLedgerRunAt(db);
    } catch (err) {
      logWorkerEvent({
        scope: "status",
        level: "warn",
        event: "depeg_ledger_freshness_unavailable",
        route: "status",
        source: DEPEG_CENSUS_PRODUCER_JOB,
        message: "Failed to read the completed depeg detection census for dataset freshness",
        error: err,
      });
      return null;
    }
  }
  if (target.type === "dews-publication") {
    const published = await readDewsPublishedGenerationResult(db, now);
    if (published.status === "ok") return published.computedAt;
    logWorkerEvent({
      scope: "status",
      level: "warn",
      event: "dews_publication_freshness_unavailable",
      route: "status",
      source: "dews:published-generation",
      message: "Failed to validate the DEWS published generation for dataset freshness",
      metadata: { status: published.status },
    });
    return null;
  }
  if (target.type === "report-card-publication") {
    let active;
    try {
      active = await loadActiveSafetyScoreIndex(db);
    } catch (err) {
      logWorkerEvent({
        scope: "status",
        level: "error",
        event: "report_card_publication_freshness_read_failed",
        route: "status",
        source: "safety_score_index",
        message: "Failed to resolve the expected active Safety Score source for dataset freshness",
        error: err,
      });
      return null;
    }
    if (active.kind !== "error") return active.snapshot.updatedAt;
    logWorkerEvent({
      scope: "status",
      level: "warn",
      event: "report_card_publication_freshness_unavailable",
      route: "status",
      source: "safety_score_index",
      message: "Failed to validate the canonical V9 publication for dataset freshness",
      metadata: {
        reason: active.reason,
      },
    });
    return null;
  }
  return getLastTableUpdate(db, target);
}

export async function getDatasetFreshness(db: D1Database): Promise<StatusResponse["datasetFreshness"]> {
  const now = Math.floor(Date.now() / 1000);
  const keys = Object.keys(STATUS_DATASET_FRESHNESS) as DatasetFreshnessKey[];
  const clocks = await Promise.all(keys.map((key) => getLastUpdate(db, DATASET_FRESHNESS_TARGETS[key], now)));
  const freshness = emptyDatasetFreshness();
  const unavailableReasons: NonNullable<StatusResponse["datasetFreshness"]["unavailableReasons"]> = {};
  keys.forEach((key, index) => {
    // Dataset clocks describe observed output, never a future generation.
    const assessment = assessFreshnessTimestamp(now, clocks[index], 0);
    freshness[key] = assessment.reason == null ? clocks[index] : null;
    if (assessment.reason != null) unavailableReasons[key] = assessment.reason;
  });
  return { ...freshness, unavailableReasons };
}


const CONSERVATION_PASS_MAX_AGE_SEC = 75 * 60;

function validateConservationRecord(
  config: MintBurnContractConfig,
  value: unknown,
  now: number,
): MintBurnConservationRecord {
  const unavailable = (reason: string): MintBurnConservationRecord => ({
    version: 1, key: mintBurnConservationCacheKey(config),
    configFingerprint: mintBurnConservationFingerprint(config),
    stablecoinId: config.stablecoinId, chainId: config.chain.chainId,
    address: config.contractAddress, decimals: config.decimals,
    checkedAt: now, status: "unavailable", reason, fromBlock: null, toBlock: null,
  });
  const eligibility = getMintBurnConservationEligibility(config);
  if (!eligibility.supported) return { ...unavailable(eligibility.reason ?? "Conservation is unsupported for this contract."), status: "unsupported" };
  const parsed = MintBurnConservationRecordSchema.safeParse(value);
  if (!parsed.success) return unavailable(value == null ? "Conservation evidence is not available." : "Conservation evidence is malformed.");
  const record = parsed.data;
  if (record.key !== mintBurnConservationCacheKey(config)
    || record.configFingerprint !== mintBurnConservationFingerprint(config)
    || record.stablecoinId !== config.stablecoinId || record.chainId !== config.chain.chainId
    || conservationIdentityAddress(config.chain.chainId, record.address) !== conservationIdentityAddress(config.chain.chainId, config.contractAddress)
    || (config.chain.chainId === "tron" && canonicalTronAddress(record.address) == null)
    || record.decimals !== config.decimals || record.checkedAt > now) {
    return unavailable("Conservation evidence does not match the current contract configuration or clock.");
  }
  if (record.status === "unavailable" || record.status === "unsupported") return record;
  if (record.fromBlock == null || record.toBlock == null || record.fromBlock >= record.toBlock
    || record.fromBlock < config.startBlock - 1
    || !record.fromBlockHash || !record.toBlockHash
    || /^0x0{64}$/i.test(record.fromBlockHash) || /^0x0{64}$/i.test(record.toBlockHash)
    || record.fromBlockHash.toLowerCase() === record.toBlockHash.toLowerCase()
    || record.fromTimestamp == null || record.toTimestamp == null
    || record.fromTimestamp >= record.toTimestamp || record.toTimestamp > record.checkedAt
    || record.mintRaw == null || record.burnRaw == null || record.supplyDeltaRaw == null
    || record.residualRaw == null || record.logCount == null) {
    return unavailable("Conservation evidence has invalid block boundaries or incomplete arithmetic.");
  }
  const residual = BigInt(record.mintRaw) - BigInt(record.burnRaw) - BigInt(record.supplyDeltaRaw);
  if (residual !== BigInt(record.residualRaw)
    || (record.status === "ok") !== (residual === 0n)
    || (record.logCount === 0 && (record.mintRaw !== "0" || record.burnRaw !== "0"))) {
    return unavailable("Conservation evidence has inconsistent arithmetic or status.");
  }
  // A proven mismatch remains unresolved until a verified pass replaces it.
  if (record.status === "ok" && (now - record.checkedAt > CONSERVATION_PASS_MAX_AGE_SEC
    || now - record.toTimestamp > CONSERVATION_PASS_MAX_AGE_SEC)) {
    return { ...record, status: "unavailable", reason: "Conservation evidence is stale." };
  }
  return record;
}

export async function getMintBurnReconciliation(
  db: D1Database,
  now: number,
): Promise<MintBurnReconciliationSummary> {
  const activeConfigs = MINT_BURN_CONFIGS.filter((config) => WORKER_ACTIVE_IDS.has(config.stablecoinId));
  let admittedConfigs: MintBurnContractConfig[];
  let lastBlocks: Map<string, number>;
  let cronSnapshot: MintBurnCronSnapshot;
  let extendedSnapshot: MintBurnCronSnapshot;
  let scanSegments: Map<string, MintBurnScanSegment[]>;
  let conservationRecords: Map<string, unknown>;
  try {
    const context = await readMintBurnWindowContext(db, now, activeConfigs);
    admittedConfigs = context.configs;
    scanSegments = context.segments;
    [lastBlocks, cronSnapshot, extendedSnapshot, conservationRecords] = await Promise.all([
      readMintBurnSyncStateBatch(db, admittedConfigs),
      readMintBurnCronSnapshot(db),
      readMintBurnCronSnapshot(db, "sync-mint-burn-extended"),
      readMintBurnConservationRecords(db, admittedConfigs),
    ]);
  } catch (err) {
    logWorkerEvent({
      scope: "status",
      level: "error",
      event: "mint_burn_reconciliation_query_failed",
      route: "status",
      source: "mint_burn_hourly",
      message: "Failed mint-burn reconciliation query",
      error: err,
    });
    // Rethrow so the call site surfaces sectionErrors.mintBurnReconciliation,
    // keeping a transient D1 failure distinguishable from the legitimate
    // bootstrap case where no mint-burn data exists yet (returns rows: []).
    throw err;
  }

  const configsByStablecoin = new Map<string, MintBurnContractConfig[]>();
  for (const config of admittedConfigs) {
    const configs = configsByStablecoin.get(config.stablecoinId) ?? [];
    configs.push(config);
    configsByStablecoin.set(config.stablecoinId, configs);
  }

  const freshHeads = new Map<string, number>();
  for (const snapshot of [cronSnapshot, extendedSnapshot]) {
    if (snapshot.startedAt == null || now - snapshot.startedAt > MINT_BURN_PUBLIC_FRESHNESS_MAX_AGE_SEC) continue;
    for (const [chainId, head] of snapshot.chainHeads) {
      freshHeads.set(chainId, Math.max(freshHeads.get(chainId) ?? 0, head));
    }
  }
  const conservationConfigs = admittedConfigs.filter((config) => getMintBurnConservationEligibility(config).supported);
  const coverageMap = buildCoinCoverageMap(now, scanSegments, lastBlocks, freshHeads, null, conservationConfigs);

  const rows = [...configsByStablecoin.entries()]
    .map<MintBurnReconciliationRow>(([stablecoinId, configs]) => {
      const coverageStatus = coverageMap.get(stablecoinId)?.status ?? "unknown";
      const conservation = configs.map((config) => {
        const record = validateConservationRecord(config, conservationRecords.get(mintBurnConservationCacheKey(config)), now);
        if (record.status !== "ok") return record;
        const snapshot = config.tier === "extended" ? extendedSnapshot : cronSnapshot;
        // The gate certifies the audited window, not the coin's current sync backlog. The row-level
        // `coverageStatus` folds in "lagging" (a config's cursor more than coverageLagThresholdBlocks
        // behind the head merged across both lanes), which the extended lane's budget deferral produces
        // by design while the deferred config's own audited window was still covered. The record-scoped
        // clauses below decide the verdict; `coverageStatus` stays published on the row for display.
        const freshScan = snapshot.startedAt != null && snapshot.startedAt <= now
          && now - snapshot.startedAt <= MINT_BURN_PUBLIC_FRESHNESS_MAX_AGE_SEC
          && (snapshot.status === "ok" || snapshot.status === "degraded")
          && (lastBlocks.get(`${config.chain.chainId}-${config.contractAddress}`) ?? -1) >= record.fromBlock!
          && (snapshot.chainHeads.get(config.chain.chainId) ?? -1) >= record.toBlock!;
        return freshScan ? record : { ...record, status: "unavailable" as const, reason: "A fresh scan covering the audited blocks is required." };
      });
      // Unsupported laws stay visible with their reason but cannot invalidate another leg's proof.
      const supported = conservation.filter((record) => record.status !== "unsupported");
      const status: MintBurnReconciliationRow["status"] = supported.some((record) => record.status === "mismatch")
        ? "critical" : supported.length > 0 && supported.every((record) => record.status === "ok")
          ? "ok" : "insufficient-source";
      const conservationIssue = status === "ok" ? undefined
        : supported.find((record) => record.status !== "ok")?.reason ?? conservation[0]?.reason ?? "Conservation evidence is incomplete.";

      return {
        stablecoinId,
        symbol: TRACKED_META_BY_ID.get(stablecoinId)?.symbol ?? stablecoinId,
        status,
        coverageStatus,
        conservationIssue,
        // Validate against the full cached fingerprint above; never publish its bulky config JSON.
        conservation: conservation.map(({ configFingerprint: _configFingerprint, ...record }) => record),
      };
    })
    .sort((a, b) => {
      const severityOrder: Record<MintBurnReconciliationRow["status"], number> = {
        critical: 0,
        "insufficient-source": 2,
        ok: 3,
      };
      return severityOrder[a.status] - severityOrder[b.status];
    });

  return {
    conservationVersion: 1,
    checkedAt: now,
    criticalCount: rows.filter((row) => row.status === "critical").length,
    rows,
  };
}
