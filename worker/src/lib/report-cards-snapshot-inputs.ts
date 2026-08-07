import { getCache } from "./db-cache";
import {
  DEX_LIQUIDITY_PUBLISHED_ROW_FILTER,
  loadDexLiquiditySnapshot,
  type DexLiquidityLoadResult,
} from "./dex-liquidity";
import { loadFreshIndependentLiveReserveMap } from "./live-reserves-store";
import {
  loadRedemptionBackstopSnapshot,
  RedemptionBackstopSnapshotUnavailableError,
} from "./redemption-backstops-store";
import {
  loadStablecoinsCache,
  type StablecoinsCacheLoadOk,
  type StablecoinsCacheLoadResult,
} from "./stablecoins-cache";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { CHAIN_META, resolveChainId } from "@shared/lib/chains";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { DexDeploymentSupplyCoverage } from "@shared/lib/report-card-peg-liquidity";
import type { ReserveSlice } from "@shared/types/core";
import type { StablecoinData } from "@shared/types/market";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import type { LiveReserveSnapshotProvenance } from "./live-reserves-store";
import { parseJsonObject } from "./json-parse";
import type { V9PublicationInputHealth } from "./safety-score-v9-publication-assessment";

export class ReportCardsSnapshotUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportCardsSnapshotUnavailableError";
  }
}

export interface ReportCardsSnapshotInputs {
  stablecoinsCached: StablecoinsCacheLoadOk;
  bluechipCached: Awaited<ReturnType<typeof getCache>> | null;
  dexLiquiditySnapshot: DexLiquidityLoadResult;
  redemptionBackstopMap: Record<string, RedemptionBackstopEntry>;
  redemptionSnapshotProvenance: {
    runId: string | null;
    methodologyVersion: string | null;
    latestUpdatedAt: number | null;
  };
  liveReserveMap: Map<string, ReserveSlice[]>;
  liveReserveProvenanceMap: ReadonlyMap<string, LiveReserveSnapshotProvenance>;
  liquidityStale: boolean;
  redemptionStale: boolean;
  inputFreshness: ReportCardsInputFreshness;
  v9PublicationInputHealth: V9PublicationInputHealth;
}

export interface LoadReportCardsSnapshotInputsOptions {
  preloadedStablecoinsCache?: StablecoinsCacheLoadResult;
  /**
   * Bluechip ratings feed the V8 report-card projection only. The native V9
   * capture never reads them, so it skips the load rather than spending one of
   * the six connections a cron trigger gets from Cloudflare's pool.
   */
  includeBluechipRatings?: boolean;
}

const EMPTY_DEX_LIQUIDITY_SNAPSHOT: DexLiquidityLoadResult = {
  map: {},
  latestUpdatedAt: null,
};

const REPORT_CARD_DEX_LIQUIDITY_FRESHNESS_SEC = CRON_INTERVALS["sync-dex-liquidity"] * 2;
const REPORT_CARD_REDEMPTION_FRESHNESS_SEC = CRON_INTERVALS["sync-redemption-backstops"] * 2;
const HAS_APPLICABLE_LIVE_RESERVE_CONFIG = ACTIVE_STABLECOINS.some(
  (coin) => coin.liveReservesConfig !== undefined,
);

type DeploymentOutcome = "observed_pools" | "verified_no_pools" | "provider_inaccessible";

interface DexDeploymentJoinDbRow {
  stablecoin_id: string;
  chain: string | null;
  contract_address: string | null;
  outcome: string | null;
  outcome_observed_at: number | null;
  chain_tvl_json: string | null;
}

export interface DexDeploymentSupplyJoinRow {
  chain: string;
  contractAddress: string;
  outcome: DeploymentOutcome;
  observedAt?: number;
}

export interface ReportCardsInputFreshnessEntry {
  updatedAt: number | null;
  ageSeconds: number | null;
  stale: boolean;
}

export interface ReportCardsInputFreshness {
  dexLiquidity: ReportCardsInputFreshnessEntry;
  redemptionBackstops: ReportCardsInputFreshnessEntry;
}

function buildFreshnessEntry(
  updatedAt: number | null,
  nowSec: number,
  maxAgeSec: number,
  forceStale = false,
): ReportCardsInputFreshnessEntry {
  const futureDated = updatedAt != null && updatedAt > nowSec;
  const ageSeconds = updatedAt == null || futureDated ? null : nowSec - updatedAt;
  return {
    updatedAt,
    ageSeconds,
    stale: forceStale || futureDated || ageSeconds == null || ageSeconds > maxAgeSec,
  };
}

function canonicalChain(value: string): string {
  return resolveChainId(value) ?? value.trim().toLowerCase();
}

function canonicalContractAddress(value: string): string {
  const trimmed = value.trim();
  return /^0x[0-9a-f]+$/i.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

function supersedeLegacyLowercaseDeploymentRows(
  rows: readonly DexDeploymentSupplyJoinRow[],
): DexDeploymentSupplyJoinRow[] {
  const correctedObservedAtByKey = new Map<string, number>();
  const keyFor = (row: DexDeploymentSupplyJoinRow) => {
    const chain = canonicalChain(row.chain);
    if (CHAIN_META[chain]?.type === "evm") return null;
    return `${chain}\u0000${row.contractAddress.trim().toLowerCase()}`;
  };
  for (const row of rows) {
    const key = keyFor(row);
    if (!key || row.contractAddress === row.contractAddress.toLowerCase() || row.observedAt == null) continue;
    correctedObservedAtByKey.set(key, Math.max(correctedObservedAtByKey.get(key) ?? 0, row.observedAt));
  }

  return rows.filter((row) => {
    const key = keyFor(row);
    if (!key || row.contractAddress !== row.contractAddress.toLowerCase() || row.observedAt == null) return true;
    return (correctedObservedAtByKey.get(key) ?? 0) <= row.observedAt;
  });
}

function addFiniteSupply(current: number, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return current;
  return current + value;
}

function parseChainTvl(value: string | null): Map<string, number> {
  const parsed = parseJsonObject(value);
  if (parsed == null) return new Map();
  const result = new Map<string, number>();
  for (const [chain, rawTvl] of Object.entries(parsed)) {
    if (typeof rawTvl !== "number" || !Number.isFinite(rawTvl) || rawTvl < 0) continue;
    const canonical = canonicalChain(chain);
    result.set(canonical, (result.get(canonical) ?? 0) + rawTvl);
  }
  return result;
}

function isDeploymentOutcome(value: string | null): value is DeploymentOutcome {
  return value === "observed_pools" || value === "verified_no_pools" || value === "provider_inaccessible";
}

async function loadDexDeploymentSupplyJoin(db: D1Database): Promise<{
  rowsById: Map<string, DexDeploymentSupplyJoinRow[]>;
  chainTvlById: Map<string, Map<string, number>>;
}> {
  const rows = await db
    .prepare(
      `SELECT dl.stablecoin_id, ddo.chain, ddo.contract_address, ddo.outcome,
              ddo.observed_at AS outcome_observed_at, dl.chain_tvl_json
       FROM dex_liquidity dl
       LEFT JOIN dex_deployment_outcomes ddo ON ddo.stablecoin_id = dl.stablecoin_id
       WHERE ${DEX_LIQUIDITY_PUBLISHED_ROW_FILTER.replaceAll("publication_generation_id", "dl.publication_generation_id")}`,
    )
    .all<DexDeploymentJoinDbRow>();

  const rowsById = new Map<string, DexDeploymentSupplyJoinRow[]>();
  const chainTvlById = new Map<string, Map<string, number>>();
  for (const row of rows.results ?? []) {
    if (!chainTvlById.has(row.stablecoin_id)) {
      chainTvlById.set(row.stablecoin_id, parseChainTvl(row.chain_tvl_json));
    }
    if (!row.chain || !row.contract_address || !isDeploymentOutcome(row.outcome)) continue;
    rowsById.set(row.stablecoin_id, [
      ...(rowsById.get(row.stablecoin_id) ?? []),
      {
        chain: row.chain,
        contractAddress: row.contract_address,
        outcome: row.outcome,
        ...(row.outcome_observed_at != null ? { observedAt: row.outcome_observed_at } : {}),
      },
    ]);
  }
  return { rowsById, chainTvlById };
}

export function computeDexDeploymentSupplyCoverage(
  asset: Pick<StablecoinData, "chainCirculating" | "contracts">,
  deploymentRows: readonly DexDeploymentSupplyJoinRow[],
  chainTvl: ReadonlyMap<string, number>,
  options?: { asOfSec: number; maxOutcomeAgeSec: number },
): DexDeploymentSupplyCoverage | null {
  const supplyByChain = new Map<string, number>();
  for (const [chain, point] of Object.entries(asset.chainCirculating ?? {})) {
    const canonical = canonicalChain(chain);
    supplyByChain.set(canonical, addFiniteSupply(supplyByChain.get(canonical) ?? 0, point?.current));
  }
  const totalSupplyUsd = [...supplyByChain.values()].reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(totalSupplyUsd) || totalSupplyUsd <= 0) return null;

  const contractsByChain = new Map<string, string[]>();
  for (const contract of asset.contracts ?? []) {
    const chain = canonicalChain(contract.chain);
    contractsByChain.set(chain, [...(contractsByChain.get(chain) ?? []), canonicalContractAddress(contract.address)]);
  }
  const outcomesByChain = new Map<string, DexDeploymentSupplyJoinRow[]>();
  for (const row of supersedeLegacyLowercaseDeploymentRows(deploymentRows)) {
    const chain = canonicalChain(row.chain);
    outcomesByChain.set(chain, [...(outcomesByChain.get(chain) ?? []), row]);
  }

  let observedSupplyUsd = 0;
  let verifiedNoPoolsSupplyUsd = 0;
  let providerInaccessibleSupplyUsd = 0;
  let unknownSupplyUsd = 0;
  const unknownChains: string[] = [];

  for (const [chain, supplyUsd] of [...supplyByChain.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (supplyUsd <= 0) continue;
    const contracts = contractsByChain.get(chain) ?? [];
    const outcomes = outcomesByChain.get(chain) ?? [];
    const matching =
      contracts.length === 1
        ? outcomes.filter((row) => canonicalContractAddress(row.contractAddress) === contracts[0])
        : [];
    const freshMatching = matching.filter(
      (row) =>
        !options ||
        (row.observedAt != null &&
          Number.isFinite(row.observedAt) &&
          row.observedAt <= options.asOfSec &&
          options.asOfSec - row.observedAt <= options.maxOutcomeAgeSec),
    );
    if (contracts.length !== 1 || freshMatching.length !== 1 || outcomes.length !== 1) {
      unknownSupplyUsd += supplyUsd;
      unknownChains.push(chain);
      continue;
    }

    const chainTvlUsd = chainTvl.get(chain) ?? 0;
    switch (freshMatching[0]!.outcome) {
      case "observed_pools":
        if (chainTvlUsd > 0) observedSupplyUsd += supplyUsd;
        else {
          unknownSupplyUsd += supplyUsd;
          unknownChains.push(chain);
        }
        break;
      case "verified_no_pools":
        if (chainTvlUsd <= 0) verifiedNoPoolsSupplyUsd += supplyUsd;
        else {
          unknownSupplyUsd += supplyUsd;
          unknownChains.push(chain);
        }
        break;
      case "provider_inaccessible":
        if (chainTvlUsd <= 0) providerInaccessibleSupplyUsd += supplyUsd;
        else {
          unknownSupplyUsd += supplyUsd;
          unknownChains.push(chain);
        }
        break;
    }
  }

  const ratio = (value: number) => Math.max(0, Math.min(1, value / totalSupplyUsd));
  return {
    totalSupplyUsd,
    observedSupplyUsd,
    verifiedNoPoolsSupplyUsd,
    providerInaccessibleSupplyUsd,
    unknownSupplyUsd,
    observedSupplyRatio: ratio(observedSupplyUsd),
    verifiedNoPoolsSupplyRatio: ratio(verifiedNoPoolsSupplyUsd),
    providerInaccessibleSupplyRatio: ratio(providerInaccessibleSupplyUsd),
    unknownSupplyRatio: ratio(unknownSupplyUsd),
    unknownChains,
  };
}

function attachDexDeploymentSupplyCoverage(
  snapshot: DexLiquidityLoadResult,
  assets: readonly StablecoinData[],
  join: Awaited<ReturnType<typeof loadDexDeploymentSupplyJoin>>,
  asOfSec: number,
): DexLiquidityLoadResult {
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  const map = { ...snapshot.map };
  for (const [stablecoinId, dexRow] of Object.entries(map)) {
    const asset = assetsById.get(stablecoinId);
    if (!asset) continue;
    const coverage = computeDexDeploymentSupplyCoverage(
      asset,
      join.rowsById.get(stablecoinId) ?? [],
      join.chainTvlById.get(stablecoinId) ?? new Map(),
      { asOfSec, maxOutcomeAgeSec: REPORT_CARD_DEX_LIQUIDITY_FRESHNESS_SEC },
    );
    if (coverage) {
      const enriched = { ...dexRow, deploymentSupplyCoverage: coverage } as typeof dexRow & {
        deploymentSupplyCoverage: DexDeploymentSupplyCoverage;
      };
      map[stablecoinId] = enriched;
    }
  }
  return { ...snapshot, map };
}

export async function loadReportCardsSnapshotInputs(
  db: D1Database,
  options: LoadReportCardsSnapshotInputsOptions = {},
): Promise<ReportCardsSnapshotInputs> {
  const [
    stablecoinsCachedResult,
    bluechipCachedResult,
    dexLiquiditySnapshotResult,
    dexDeploymentSupplyJoinResult,
    redemptionBackstopMapResult,
    liveReserveMapResult,
  ] = await Promise.allSettled([
    options.preloadedStablecoinsCache
      ? Promise.resolve(options.preloadedStablecoinsCache)
      : loadStablecoinsCache(db, { mode: "strict", contract: "published", allowLegacyArray: false }),
    options.includeBluechipRatings === false ? Promise.resolve(null) : getCache(db, "bluechip-ratings"),
    loadDexLiquiditySnapshot(db),
    loadDexDeploymentSupplyJoin(db),
    loadRedemptionBackstopSnapshot(db),
    loadFreshIndependentLiveReserveMap(db),
  ]);

  if (stablecoinsCachedResult.status === "rejected") {
    throw stablecoinsCachedResult.reason;
  }
  const stablecoinsCached = stablecoinsCachedResult.value;
  if (stablecoinsCached.kind !== "ok") {
    throw new ReportCardsSnapshotUnavailableError("Cached stablecoins data is corrupt");
  }

  let redemptionBackstopSnapshot: Awaited<ReturnType<typeof loadRedemptionBackstopSnapshot>>;
  let redemptionSnapshotUnavailable = false;
  if (redemptionBackstopMapResult.status === "fulfilled") {
    redemptionBackstopSnapshot = redemptionBackstopMapResult.value;
  } else {
    if (!(redemptionBackstopMapResult.reason instanceof RedemptionBackstopSnapshotUnavailableError)) {
      throw redemptionBackstopMapResult.reason;
    }
    console.warn(
      "[report-cards] Redemption backstop snapshot unavailable; suppressing redemption inputs:",
      redemptionBackstopMapResult.reason,
    );
    redemptionSnapshotUnavailable = true;
    redemptionBackstopSnapshot = { map: {}, latestUpdatedAt: null };
  }

  const bluechipCached =
    bluechipCachedResult.status === "fulfilled"
      ? bluechipCachedResult.value
      : (() => {
          console.warn(
            "[report-cards] Bluechip ratings unavailable; continuing without bluechip overlay:",
            bluechipCachedResult.reason,
          );
          return null;
        })();

  let dexLiquiditySnapshot = EMPTY_DEX_LIQUIDITY_SNAPSHOT;
  let liquidityStale = false;
  const nowSec = Math.floor(Date.now() / 1000);
  if (dexLiquiditySnapshotResult.status === "fulfilled") {
    dexLiquiditySnapshot =
      dexDeploymentSupplyJoinResult.status === "fulfilled"
        ? attachDexDeploymentSupplyCoverage(
            dexLiquiditySnapshotResult.value,
            stablecoinsCached.payload.peggedAssets,
            dexDeploymentSupplyJoinResult.value,
            nowSec,
          )
        : dexLiquiditySnapshotResult.value;
    if (dexDeploymentSupplyJoinResult.status === "rejected") {
      console.warn(
        "[report-cards] DEX deployment supply join unavailable; leaving materiality unknown:",
        dexDeploymentSupplyJoinResult.reason,
      );
    }
    if (dexLiquiditySnapshot.latestUpdatedAt != null) {
      const ageSec = nowSec - dexLiquiditySnapshot.latestUpdatedAt;
      if (ageSec < 0) {
        console.warn(`[report-cards] Liquidity data is future-dated (ahead: ${-ageSec}s)`);
        liquidityStale = true;
      } else if (ageSec > REPORT_CARD_DEX_LIQUIDITY_FRESHNESS_SEC) {
        console.warn(`[report-cards] Liquidity data is stale (age: ${ageSec}s)`);
        liquidityStale = true;
      }
    }
  } else {
    console.warn(
      "[report-cards] DEX liquidity snapshot unavailable; suppressing liquidity inputs:",
      dexLiquiditySnapshotResult.reason,
    );
    liquidityStale = true;
  }

  const liveReserveMap =
    liveReserveMapResult.status === "fulfilled"
      ? liveReserveMapResult.value
      : (() => {
          console.warn(
            "[report-cards] Live reserve snapshot unavailable; falling back to curated reserves:",
            liveReserveMapResult.reason,
          );
          return new Map<string, ReserveSlice[]>();
        })();
  const liveReserveProvenanceMap =
    liveReserveMapResult.status === "fulfilled" && "provenanceById" in liveReserveMapResult.value
      ? liveReserveMapResult.value.provenanceById
      : new Map<string, LiveReserveSnapshotProvenance>();

  const redemptionFreshness = buildFreshnessEntry(
    redemptionBackstopSnapshot.latestUpdatedAt,
    nowSec,
    REPORT_CARD_REDEMPTION_FRESHNESS_SEC,
    redemptionSnapshotUnavailable,
  );
  const redemptionStale = redemptionFreshness.stale;
  const redemptionBackstopMap = redemptionStale ? {} : redemptionBackstopSnapshot.map;
  if (redemptionStale) {
    console.warn(
      `[report-cards] Redemption backstop data is stale or missing` +
        (redemptionFreshness.ageSeconds != null ? ` (age: ${redemptionFreshness.ageSeconds}s)` : ""),
    );
  }

  const dexFreshness = buildFreshnessEntry(
    dexLiquiditySnapshot.latestUpdatedAt,
    nowSec,
    REPORT_CARD_DEX_LIQUIDITY_FRESHNESS_SEC,
    dexLiquiditySnapshotResult.status === "rejected",
  );
  const dexState: V9PublicationInputHealth["dex"]["state"] =
    dexLiquiditySnapshotResult.status === "rejected"
      ? "unavailable"
      : dexFreshness.stale
        ? "stale"
        : "current";
  const hasApplicableRedemption =
    redemptionSnapshotUnavailable ||
    Object.keys(redemptionBackstopSnapshot.map).length > 0;
  const redemptionState: V9PublicationInputHealth["redemption"]["state"] =
    !hasApplicableRedemption
      ? "not-applicable"
      : redemptionSnapshotUnavailable
        ? "unavailable"
        : redemptionFreshness.stale
          ? "stale"
          : "current";

  return {
    stablecoinsCached,
    bluechipCached,
    dexLiquiditySnapshot,
    redemptionBackstopMap,
    redemptionSnapshotProvenance: {
      runId: redemptionBackstopSnapshot.runId ?? null,
      methodologyVersion: redemptionBackstopSnapshot.methodologyVersion ?? null,
      latestUpdatedAt: redemptionBackstopSnapshot.latestUpdatedAt,
    },
    liveReserveMap,
    liveReserveProvenanceMap,
    liquidityStale,
    redemptionStale,
    inputFreshness: {
      dexLiquidity: dexFreshness,
      redemptionBackstops: redemptionFreshness,
    },
    v9PublicationInputHealth: {
      dex: {
        state: dexState,
        generationId:
          dexLiquiditySnapshot.latestUpdatedAt === null
            ? null
            : `dex-liquidity-${dexLiquiditySnapshot.latestUpdatedAt}`,
        updatedAtSec: dexLiquiditySnapshot.latestUpdatedAt,
      },
      redemption: {
        state: redemptionState,
        generationId: redemptionBackstopSnapshot.runId ?? null,
        updatedAtSec: redemptionBackstopSnapshot.latestUpdatedAt,
      },
      liveReserves: {
        state:
          HAS_APPLICABLE_LIVE_RESERVE_CONFIG &&
          liveReserveMapResult.status === "rejected"
            ? "unavailable"
            : "available",
      },
    },
  };
}
