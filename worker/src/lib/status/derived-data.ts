import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { getCirculatingRaw } from "@shared/lib/supply";
import { resolveChainId } from "@shared/lib/chains";
import { MintBurnConservationRecordSchema, type MintBurnConservationRecord, type MintBurnReconciliationRow, type MintBurnReconciliationSummary, type StatusResponse } from "@shared/types/status";
import { buildInClause } from "../db";
import { buildCoinCoverageMap, readMintBurnCronSnapshot, type MintBurnCronSnapshot } from "../mint-burn-flows-service";
import { readMintBurnSyncStateBatch } from "../mint-burn-pipeline/sync-state";
import { MINT_BURN_PUBLIC_FRESHNESS_MAX_AGE_SEC } from "../mint-burn-health-config";
import { MINT_BURN_CONFIGS, type MintBurnContractConfig } from "../mint-burn-contracts";
import { mintBurnConservationCacheKey, mintBurnConservationFingerprint, readMintBurnConservationRecords, getMintBurnConservationEligibility } from "../mint-burn-conservation";
import {
  hasUsableStablecoinsPayload,
  loadStablecoinsCache,
  type StablecoinsCacheLoadResult,
} from "../stablecoins-cache";
import { emptyReserveCompositionOverview } from "@shared/types/live-reserves";
import { logWorkerEvent } from "../structured-log";
import { loadMintBurnFirstHourRows } from "../mint-burn-hourly-queries";
import { readDewsPublishedGenerationResult } from "../dews-publication-pointer";
import { loadActiveSafetyScoreSource } from "../safety-score-active-source";

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

export function emptyReserveComposition(): StatusResponse["reserveComposition"] {
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
      type: "report-card-publication";
    };

const DATASET_FRESHNESS_TARGETS: Record<keyof StatusResponse["datasetFreshness"], DatasetFreshnessTarget> = {
  stablecoins: { type: "table", table: "cache", column: "updated_at", where: "key = 'stablecoins'" },
  blacklist: { type: "cron", jobs: ["sync-blacklist"] },
  mintBurn: { type: "cron", jobs: ["sync-mint-burn", "sync-mint-burn-extended"] },
  supply: { type: "table", table: "supply_history", column: "snapshot_date" },
  safetyGrades: { type: "report-card-publication" },
  yield: {
    type: "table",
    table: "yield_data",
    column: "updated_at",
    where: "is_best = 1 AND (publication_generation_id IS NULL OR publication_state = 'published')",
  },
  depegs: { type: "cron", jobs: ["sync-stablecoins"] },
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
    const successStatuses = buildInClause(["ok", "degraded"]);
    const row = await db
      .prepare(
        `SELECT MAX(started_at) as latest
         FROM cron_runs
         WHERE job IN (${jobInClause.sql})
           AND status IN (${successStatuses.sql})`,
      )
      .bind(...jobInClause.binds, ...successStatuses.binds)
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
      active = await loadActiveSafetyScoreSource(db);
    } catch (err) {
      logWorkerEvent({
        scope: "status",
        level: "error",
        event: "report_card_publication_freshness_read_failed",
        route: "status",
        source: "safety_score_active_source",
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
      source: "safety_score_active_source",
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
  const [stablecoins, blacklist, mintBurn, supply, safetyGrades, yieldTs, depegs, dews, digest] =
    await Promise.all([
      getLastUpdate(db, DATASET_FRESHNESS_TARGETS.stablecoins, now),
      getLastUpdate(db, DATASET_FRESHNESS_TARGETS.blacklist, now),
      getLastUpdate(db, DATASET_FRESHNESS_TARGETS.mintBurn, now),
      getLastUpdate(db, DATASET_FRESHNESS_TARGETS.supply, now),
      getLastUpdate(db, DATASET_FRESHNESS_TARGETS.safetyGrades, now),
      getLastUpdate(db, DATASET_FRESHNESS_TARGETS.yield, now),
      getLastUpdate(db, DATASET_FRESHNESS_TARGETS.depegs, now),
      getLastUpdate(db, DATASET_FRESHNESS_TARGETS.dews, now),
      getLastUpdate(db, DATASET_FRESHNESS_TARGETS.digest, now),
    ]);

  return {
    stablecoins,
    blacklist,
    mintBurn,
    supply,
    safetyGrades,
    yield: yieldTs,
    depegs,
    dews,
    digest,
  };
}

// Reviewed upstream definitions, not exceptions based on the size of a gap.
// Evidence and restoration criteria: docs/status-dashboard.md#mintburn-reconciliation-card.
const DEFILLAMA_RECONCILIATION_SCOPE_ISSUES: Readonly<Record<string, string>> = {
  "dai-makerdao": "Upstream supply includes internal DSR balances that ERC-20 mint/burn events do not measure.",
  "usdd-tron-dao-reserve": "Upstream supply includes internal savings balances and legacy USDD outside the tracked token.",
  "crvusd-curve": "Upstream supply measures circulating protocol debt, not the pre-minted token supply.",
  "jpyc-jpyc": "Upstream supply excludes issuer and redemption wallet balances; ordinary transfers change circulation.",
  "eurcv-societe-generale-forge": "Upstream supply excludes unreleased wallet balances; ordinary transfers change circulation.",
  "alusd-alchemix": "Upstream supply excludes an unreleased wallet balance; ordinary transfers change circulation.",
  "tryb-bilira": "Upstream supply excludes an unreleased wallet balance; ordinary transfers change circulation.",
  "frxusd-frax": "Upstream supply excludes a treasury balance; ordinary transfers change circulation.",
  "fxusd-f-x-protocol": "Upstream supply combines fxUSD with fstETH and ffrxETH; tracked events cover fxUSD only.",
};
const REBASING_RECONCILIATION_SCOPE_ISSUES: Readonly<Record<string, string>> = {
  "m-m0": "Earning-index accrual changes token supply without mint/burn events.",
  "ousd-origin-protocol": "Rebases change token supply without mint/burn events.",
};

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
    || record.address.toLowerCase() !== config.contractAddress.toLowerCase()
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
  preloadedCache?: StablecoinsCacheLoadResult,
): Promise<MintBurnReconciliationSummary | null> {
  const stablecoinsCacheResult =
    preloadedCache ?? (await loadStablecoinsCache(db, { mode: "lenient" }));
  if (!hasUsableStablecoinsPayload(stablecoinsCacheResult)) {
    return null;
  }

  const configChainsByStablecoin = new Map<string, Set<string>>();
  for (const config of MINT_BURN_CONFIGS) {
    const chains = configChainsByStablecoin.get(config.stablecoinId) ?? new Set<string>();
    chains.add(config.chain.chainId);
    configChainsByStablecoin.set(config.stablecoinId, chains);
  }
  const trackedIds = new Set(configChainsByStablecoin.keys());
  const assets = (
    stablecoinsCacheResult.payload.peggedAssets as Array<{
      id: string;
      symbol: string;
      supplySource?: string;
      circulating?: Record<string, number>;
      chainCirculating?: Record<
        string,
        {
          chainId?: string;
          current?: number;
          circulatingPrevDay?: number;
        }
      >;
    }>
  ).filter((asset) => trackedIds.has(asset.id));

  const windowEnd = Math.floor(now / 3600) * 3600;
  const windowStart = windowEnd - 24 * 3600;
  let lastBlocks: Map<string, number>;
  let cronSnapshot: MintBurnCronSnapshot;
  let extendedSnapshot: MintBurnCronSnapshot;
  let flowRows: D1Result<{ stablecoin_id: string; chain_id: string; net_flow_usd: number }>;
  let firstSeenRows: Array<{ stablecoin_id: string; chain_id: string; first_hour_ts: number }>;
  let conservationRecords: Map<string, unknown>;
  try {
    [flowRows, firstSeenRows, lastBlocks, cronSnapshot, extendedSnapshot, conservationRecords] = await Promise.all([
      db
        .prepare(
          `SELECT /* pharos:status-derived:mint-burn-24h */
             stablecoin_id, chain_id, SUM(net_flow_usd) as net_flow_usd
           FROM mint_burn_hourly INDEXED BY idx_mbh_ts
           WHERE hour_ts >= ? AND hour_ts < ?
           GROUP BY stablecoin_id, chain_id`,
        )
        .bind(windowStart, windowEnd)
        .all<{ stablecoin_id: string; chain_id: string; net_flow_usd: number }>(),
      loadMintBurnFirstHourRows(
        db,
        MINT_BURN_CONFIGS.map((config) => ({
          stablecoinId: config.stablecoinId,
          chainId: config.chain.chainId,
        })),
        "status",
      ),
      readMintBurnSyncStateBatch(db, MINT_BURN_CONFIGS),
      readMintBurnCronSnapshot(db),
      readMintBurnCronSnapshot(db, "sync-mint-burn-extended"),
      readMintBurnConservationRecords(db, MINT_BURN_CONFIGS),
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

  const flowMap = new Map(
    (flowRows.results ?? []).map((row) => [`${row.stablecoin_id}|${row.chain_id}`, row.net_flow_usd]),
  );
  const freshHeads = new Map<string, number>();
  for (const snapshot of [cronSnapshot, extendedSnapshot]) {
    if (snapshot.startedAt == null || now - snapshot.startedAt > MINT_BURN_PUBLIC_FRESHNESS_MAX_AGE_SEC) continue;
    for (const [chainId, head] of snapshot.chainHeads) {
      freshHeads.set(chainId, Math.max(freshHeads.get(chainId) ?? 0, head));
    }
  }
  const coverageMap = buildCoinCoverageMap(now, firstSeenRows, lastBlocks, freshHeads);

  const rows = assets
    .map<MintBurnReconciliationRow>((asset) => {
      const canonicalChains = configChainsByStablecoin.get(asset.id) ?? new Set<string>();
      const canonicalChainId = canonicalChains.size === 1 ? [...canonicalChains][0]! : null;
      const flowNet24hUsd = canonicalChainId ? (flowMap.get(`${asset.id}|${canonicalChainId}`) ?? 0) : 0;
      const coverageStatus = coverageMap.get(asset.id)?.status ?? "unknown";

      const matchingSupply = canonicalChainId
        ? Object.entries(asset.chainCirculating ?? {}).filter(([label, data]) =>
          data && ((typeof data.chainId === "string" ? resolveChainId(data.chainId) : null)
            ?? resolveChainId(label)) === canonicalChainId)
        : [];
      // Ambiguous aliases must not double-count supply or invent missing history.
      const chainSupply = matchingSupply.length === 1 ? matchingSupply[0]![1] : undefined;
      const current = chainSupply?.current;
      // These producers only observe current supply. Legacy cache versions used
      // synthetic zero histories; provenance, not a zero-value heuristic, rejects them.
      const currentOnlySupply = asset.supplySource === "onchain-total-supply"
        || asset.supplySource === "onchain-circulating-supply";
      const prevDay = currentOnlySupply ? undefined : chainSupply?.circulatingPrevDay;
      const contextIssue = REBASING_RECONCILIATION_SCOPE_ISSUES[asset.id]
        ?? (asset.supplySource === "defillama" ? DEFILLAMA_RECONCILIATION_SCOPE_ISSUES[asset.id] : undefined);
      const chainSupplyDelta24hUsd = typeof current === "number" && Number.isFinite(current) && current >= 0
        && typeof prevDay === "number" && Number.isFinite(prevDay) && prevDay >= 0 ? current - prevDay : null;
      const absoluteDiffUsd = chainSupplyDelta24hUsd == null ? null : Math.abs(flowNet24hUsd - chainSupplyDelta24hUsd);
      const denominator = Math.max(Math.abs(chainSupplyDelta24hUsd ?? 0), Math.abs(flowNet24hUsd), Math.max(getCirculatingRaw(asset), 1) * 0.005);
      const diffRatio = absoluteDiffUsd == null ? null : absoluteDiffUsd / denominator;
      const configs = MINT_BURN_CONFIGS.filter((config) => config.stablecoinId === asset.id);
      const conservation = configs.map((config) => {
        const record = validateConservationRecord(config, conservationRecords.get(mintBurnConservationCacheKey(config)), now);
        if (record.status !== "ok") return record;
        const snapshot = config.tier === "extended" ? extendedSnapshot : cronSnapshot;
        const freshScan = snapshot.startedAt != null && snapshot.startedAt <= now
          && now - snapshot.startedAt <= MINT_BURN_PUBLIC_FRESHNESS_MAX_AGE_SEC
          && (snapshot.status === "ok" || snapshot.status === "degraded")
          && (coverageStatus === "full" || coverageStatus === "partial-history")
          && (lastBlocks.get(`${config.chain.chainId}-${config.contractAddress}`) ?? -1) >= record.fromBlock!
          && (snapshot.chainHeads.get(config.chain.chainId) ?? -1) >= record.toBlock!;
        return freshScan ? record : { ...record, status: "unavailable" as const, reason: "A fresh scan covering the audited blocks is required." };
      });
      const status: MintBurnReconciliationRow["status"] = conservation.some((record) => record.status === "mismatch")
        ? "critical" : conservation.length > 0 && conservation.every((record) => record.status === "ok")
          ? "ok" : "insufficient-source";
      const comparisonIssue = [
        status === "insufficient-source" ? conservation.find((record) => record.status !== "ok")?.reason ?? "Conservation evidence is incomplete." : undefined,
        contextIssue,
        "USD flow and source-supply differences are indicative only; their observation windows and scopes may differ.",
      ].filter(Boolean).join(" ");

      return {
        stablecoinId: asset.id,
        symbol: TRACKED_META_BY_ID.get(asset.id)?.symbol ?? asset.symbol,
        flowNet24hUsd,
        chainSupplyDelta24hUsd,
        absoluteDiffUsd,
        diffRatio,
        status,
        coverageStatus,
        comparisonIssue,
        conservation,
      };
    })
    .sort((a, b) => {
      const severityOrder: Record<MintBurnReconciliationRow["status"], number> = {
        critical: 0,
        "insufficient-source": 2,
        ok: 3,
      };
      return severityOrder[a.status] - severityOrder[b.status]
        || (b.absoluteDiffUsd ?? 0) - (a.absoluteDiffUsd ?? 0);
    });

  return {
    conservationVersion: 1,
    checkedAt: now,
    comparedCoins: rows.filter((row) => row.status !== "insufficient-source").length,
    criticalCount: rows.filter((row) => row.status === "critical").length,
    insufficientCount: rows.filter((row) => row.status === "insufficient-source").length,
    rows,
  };
}
