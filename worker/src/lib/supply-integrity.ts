import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import {
  STATUS_SUPPLY_VALUE_THRESHOLDS,
} from "@shared/lib/status-thresholds";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { parseSupplyObservationProvenance } from "@shared/lib/supply-provenance";
import { startOfUtcDaySec } from "@shared/lib/time-buckets";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { getCache, setCache } from "./db-cache";
import {
  STABLECOIN_PUBLICATION_GAP_ROUTINE_MAX_SHARE,
  classifyStablecoinPublicationGap,
  type StablecoinPublicationGapBand,
} from "./stablecoin-publication-coverage";
import {
  hasUsableStablecoinsPayload,
  loadStablecoinsCache,
} from "./stablecoins-cache";
import { getCompletedSupplySnapshot } from "./supply-snapshot-completion";

/** Confirmation memory for the operator watchdog: a finding must persist across two runs. */
export const SUPPLY_INTEGRITY_CONFIRM_KEY = "cron-staleness-watchdog:supply-confirm:v1";
const SUPPLY_INTEGRITY_CONFIRM_RUNS = 2;
const MAX_REPORTED_IDS = 20;
const CHARTS_PUBLICATION_MAX_AGE_SEC = 2 * CRON_INTERVALS["sync-stablecoin-charts"];
/** Bound the held drift baselines kept in confirmation state. */
const MAX_HELD_DRIFT_BASELINES = 50;
/** Reviewed levels move daily inside this band; anything wider is an ordinary finding. */
const REVIEWED_REBASELINE_TOLERANCE = 0.02;

/**
 * Reviewed one-shot re-baselines for verified real moves. A redemption or a
 * corrected vault perimeter leaves no in-band value to return to, so the
 * pre-move baseline would hold the drift finding forever. While a review is
 * active, an observed value within tolerance of the reviewed level is the
 * accepted level: it is not a fresh finding and its held baseline is dropped.
 * Any other value, or an expired review, keeps the ordinary 0.5-2x band.
 */
const REVIEWED_SUPPLY_VALUE_REBASELINES: readonly {
  stablecoinId: string;
  baselineUsd: number;
  reviewedAt: number;
  expiresAt: number;
  evidenceUrls: readonly string[];
  reason: string;
}[] = [
  {
    stablecoinId: "iauon-ondo",
    baselineUsd: 1_747_207.06,
    reviewedAt: Date.parse("2026-11-04T00:00:00Z") / 1000,
    expiresAt: Date.parse("2026-11-18T00:00:00Z") / 1000,
    evidenceUrls: [
      "https://defillama.com/rwa/asset/IAUon",
      "https://www.coingecko.com/en/coins/ishares-gold-trust-ondo-tokenized-stock",
    ],
    reason: "Verified redemptions (Ondo GM token burns) took the CoinGecko market cap from $3.90M to $1.76M on Nov 2-3; DefiLlama on-chain AUM now reads $1.75M.",
  },
  {
    stablecoinId: "gtusdtp-gauntlet",
    baselineUsd: 386_800.93,
    reviewedAt: Date.parse("2026-11-04T00:00:00Z") / 1000,
    expiresAt: Date.parse("2026-11-18T00:00:00Z") / 1000,
    evidenceUrls: ["https://eth.blockscout.com/token/0xf3557AD5E984211ac8A0874A670344f2C3376471"],
    reason: "The pre-move baseline covered a different vault perimeter; Blockscout values the current Gauntlet USDT Prime V2 stock at $386.8k.",
  },
  {
    stablecoinId: "usdq-quantoz",
    baselineUsd: 3_001_518.8,
    reviewedAt: Date.parse("2026-11-04T12:30:00Z") / 1000,
    expiresAt: Date.parse("2026-11-18T12:30:00Z") / 1000,
    evidenceUrls: ["https://etherscan.io/token/0xc83e27f270cce0a3a3a29521173a83f402c1768b"],
    reason: "Reviewed collapse release: finalized Ethereum block 26340352 confirms 2M USDQ, down from the frozen 7M carry; with XRPL and Polygon the published total is $3.00M.",
  },
  {
    stablecoinId: "usdglo-glo",
    baselineUsd: 852_329.33,
    reviewedAt: Date.parse("2026-11-04T12:30:00Z") / 1000,
    expiresAt: Date.parse("2026-11-18T12:30:00Z") / 1000,
    evidenceUrls: ["https://basescan.org/token/0x4f604735c1cf31399c6e711d5962b2b3e0225ad3"],
    reason: "Reviewed collapse release: finalized Base block 53496375 confirms 91.4k USDGLO, down from the $1.018M carry; the eight-chain published total is $852.3k.",
  },
  ...[
    {
      stablecoinId: "sparkusdtbc-spark",
      baselineUsd: 850_692.45,
      evidenceUrls: [
        "https://eth.blockscout.com/tx/0xe0a239b8708cc3955a18e4e568fc1b972369ae8e7fc2958abdb289ee9b8fc8ff",
        "https://eth.blockscout.com/token/0xb0c424116172b55cbb6dd3136f5989f7959e5b91",
      ],
      reason: "Verified November 6 vault redemptions: Ethereum block 26365071 confirms 835,854.472234 shares and 851,338.899178 USDT totalAssets, supporting the published $850.7k rather than the pre-redemption $50.3M baseline.",
    },
    {
      stablecoinId: "frnt-wyoming",
      baselineUsd: 397_773.24,
      evidenceUrls: [
        "https://stablecoins.llama.fi/stablecoin/441",
        "https://etherscan.io/token/0x5e817f2abccb9095585d26c2a3ce234a440574fc?a=0x3994d1bBb6a96671804D996915AAbE8b1569712E",
      ],
      reason: "Corrected DefiLlama circulating perimeter: six pinned EVM reads confirm 569,895 FRNT in its configured unreleased wallet. Net EVM stock plus finalized Solana supply is 398,052.919913 FRNT; the old $967.4k daily row counted that inventory.",
    },
    {
      stablecoinId: "wmxn-ripio",
      baselineUsd: 176_488.15,
      evidenceUrls: [
        "https://stablecoins.llama.fi/stablecoin/383",
        "https://etherscan.io/token/0x337e7456b420bd3481e7fa61fa9850343d610d34?a=0xB6C9e6451A4B4F65249f60dE4fD12Da1088A2807",
      ],
      reason: "Corrected DefiLlama circulating perimeter: seven hash-pinned native totals minus its configured unreleased wallet reconcile to 3,269,392.897505 MXN, excluding 9,092,861.065585 MXN. The old $663.1k daily level reflected gross stock, not a 73% circulating redemption.",
    },
    {
      stablecoinId: "wcop-ripio",
      baselineUsd: 193_650.25,
      evidenceUrls: [
        "https://stablecoins.llama.fi/stablecoin/382",
        "https://etherscan.io/token/0x8a1d45e102e886510e891d2ec656a708991e2d76?a=0xB6C9e6451A4B4F65249f60dE4fD12Da1088A2807",
      ],
      reason: "Corrected DefiLlama circulating perimeter: seven hash-pinned native totals minus its configured unreleased wallet reconcile to 620,785,461.758091 COP, excluding 1,132,848,349.038808 COP. The old $544.9k daily level reflected gross stock, not a 64% circulating redemption.",
    },
  ].map((review) => ({
    ...review,
    reviewedAt: Date.parse("2026-11-07T19:48:00Z") / 1000,
    expiresAt: Date.parse("2026-11-14T19:48:00Z") / 1000,
  })),
  {
    stablecoinId: "tryb-bilira",
    baselineUsd: 698_792.67,
    reviewedAt: Date.parse("2026-11-07T20:27:00Z") / 1000,
    expiresAt: Date.parse("2026-11-14T20:27:00Z") / 1000,
    evidenceUrls: [
      "https://cs.bilira.co/hc/bilira-kripto-yardim-merkezi/articles/1742983312-tryb-yaratma-ve-yakma-surecinin-seffafligi",
      "https://github.com/DefiLlama/peggedassets-server/blob/66e24e7adc31b49c37b7fe03c98996ef40546030/src/peggedData/peggedData.ts",
      "https://stablecoins.llama.fi/stablecoin/300",
    ],
    reason: "Corrected DefiLlama circulating perimeter: BiLira identifies 0x75950B957009fe615c8AE02fBAac8AaA6da91B2D as its redemption sweep awaiting burn. Pinned Ethereum block 26365294 and the other nine deployments net to 36,124,961.095158 TRYB ($698,792.67); the newly excluded sweep holds 17,676,620.201490 TRYB across Ethereum/BSC/Avalanche, not a fresh circulating redemption against the old $2.22M daily baseline.",
  },
];

export interface ReviewedSupplyCarry {
  stablecoinId: string;
  reviewedAt: number;
  expiresAt: number;
  reason: "defillama-list-fill-default-carry" | "nav-parent-price-gap";
  evidence: string;
}

/** Operational acknowledgement only; publication and its carry ceiling are unchanged. */
export const REVIEWED_SUPPLY_CARRIES: readonly ReviewedSupplyCarry[] = [
  ...["doc-money-on-chain", "nusd-nexus", "usdnr-nerona"].map((stablecoinId): ReviewedSupplyCarry => ({
    stablecoinId,
    reviewedAt: Date.UTC(2026, 10, 4, 16) / 1000,
    expiresAt: Date.UTC(2026, 10, 11, 16) / 1000,
    reason: "defillama-list-fill-default-carry",
    evidence: "DefiLlama stablecoins list fill-price rescale (~5.5e-5) since 2026-11-03 ~02:35Z. The 2026-11-04 native-repair review found bridge custody in raw supply, so no native replacement is admissible (docs/supply-snapshot.md, Coverage Decisions). Owner D1 retains the bounded carried-baseline until expiry or provider recovery.",
  })),
  {
    stablecoinId: "said-gaib",
    reviewedAt: Date.UTC(2026, 10, 4, 16) / 1000,
    expiresAt: Date.UTC(2026, 10, 11, 16) / 1000,
    reason: "nav-parent-price-gap",
    evidence: "NAV parent aid-gaib has no admissible price; STABLECOIN_PRICE_GAP_REVIEWS in stablecoin-publication-coverage.ts reviews that gap until 2026-11-14T12:37Z. No par valuation or fresh supply is admitted by this acknowledgement.",
  },
];

/**
 * A review covers only the carry mechanism it was written for: a chain-dropout
 * quarantine carry, or a tracked native-supply restore. A carry produced by any
 * other path stays unacknowledged.
 */
function carryMatchesReview(
  asset: { supplyChainGuard?: { reason: string; status: string } | null; supplySource?: string | null },
  review: ReviewedSupplyCarry,
): boolean {
  const guard = asset.supplyChainGuard ?? null;
  return review.reason === "defillama-list-fill-default-carry"
    ? guard?.reason === "supply-chain-dropout" && guard.status === "quarantined"
    : guard == null && asset.supplySource === "onchain-total-supply";
}

function isReviewedValueRebaseline(stablecoinId: string, currentUsd: number, nowSec: number): boolean {
  return REVIEWED_SUPPLY_VALUE_REBASELINES.some((review) =>
    review.stablecoinId === stablecoinId
    && nowSec >= review.reviewedAt
    && nowSec <= review.expiresAt
    && Math.abs(currentUsd - review.baselineUsd) <= review.baselineUsd * REVIEWED_REBASELINE_TOLERANCE);
}

export interface SupplyValueDriftFinding {
  stablecoinId: string;
  currentUsd: number;
  previousUsd: number;
  ratio: number;
}

export interface SupplyValueIntegrityReport {
  status: "ok" | "unknown";
  reason: string | null;
  checkedCount: number;
  excludedCount: number;
  driftFindings: SupplyValueDriftFinding[];
  /**
   * Findings still outside the band against the pre-rollover daily baseline.
   * They stay raised while the daily snapshot advances onto the drifted value.
   */
  heldDriftFindings: SupplyValueDriftFinding[];
  /** Pre-rollover baselines retained for the next run (active or not re-evaluable). */
  heldDriftBaselines: Record<string, number>;
  /** A held baseline could not be re-evaluated this run (unreadable current value or state). */
  heldDriftUnknownReason: string | null;
  aggregateCurrentUsd: number | null;
  aggregatePreviousUsd: number | null;
  aggregateRatio: number | null;
  frozen: boolean;
  carryIds: string[];
  carryOldestAgeSec: number | null;
  carryUnclockedCount: number;
  acknowledgedCarryReviews: ReviewedSupplyCarry[];
  expiredCarryReviewIds: string[];
  unacknowledgedCarryIds: string[];
  unacknowledgedCarryOldestAgeSec: number | null;
  unacknowledgedCarryUnclockedCount: number;
  expectedActiveCount: number;
  cacheUpdatedAt: number | null;
  historyFromDate: number | null;
}

export interface SupplyAvailabilityIntegrityReport {
  status: "ok" | "unknown";
  reason: string | null;
  observedCount: number | null;
  unavailableCount: number | null;
  share: number | null;
  consecutiveGenerations: number;
  latestRunStartedAt: number | null;
  charts: {
    status: "ok" | "unknown" | "truncated";
    reason: string | null;
    runStartedAt: number | null;
    codes: string[];
    maxAgeSec: number;
  };
}

export interface SupplySnapshotIntegrityReport {
  status: "ok" | "unknown";
  reason: string | null;
  expectedDate: number;
  snapshotDate: number | null;
  due: boolean;
  current: boolean;
  identityVerified: boolean;
  expectedActiveCount: number | null;
  accountedActiveCount: number | null;
  writtenRows: number | null;
  persistedRows: number | null;
  unavailableActiveIds: string[] | null;
  band: StablecoinPublicationGapBand | null;
}

export interface SupplyIntegrityReport {
  observedAt: number;
  value: SupplyValueIntegrityReport;
  availability: SupplyAvailabilityIntegrityReport;
  snapshot: SupplySnapshotIntegrityReport;
}

interface SupplyHistoryRow {
  stablecoin_id: string;
  snapshot_date: number;
  circulating_usd: number;
  supply_provenance: string | null;
}

interface SyncStablecoinsRunRow {
  started_at: number;
  status: string;
  metadata: string | null;
}

interface ChartsRunRow {
  started_at: number;
  status: string;
  metadata: string | null;
}

interface ChartsContinuityEvidence {
  status: "ok" | "unknown" | "truncated";
  reason: string | null;
  runStartedAt: number | null;
  codes: string[];
}

function parseChartsRuns(rows: ChartsRunRow[], nowSec: number): ChartsContinuityEvidence {
  const row = rows[0];
  if (!row) return { status: "unknown", reason: "sync-stablecoin-charts-run-unavailable", runStartedAt: null, codes: [] };
  let parsed: unknown;
  try {
    parsed = row.metadata ? JSON.parse(row.metadata) : null;
  } catch {
    return { status: "unknown", reason: "sync-stablecoin-charts-metadata-unreadable", runStartedAt: row.started_at, codes: [] };
  }
  if (!parsed || typeof parsed !== "object") {
    return { status: "unknown", reason: "sync-stablecoin-charts-metadata-unavailable", runStartedAt: row.started_at, codes: [] };
  }
  const metadata = parsed as {
    reason?: unknown;
    cacheWriteMode?: unknown;
    lastWriteAdvanced?: unknown;
    quality?: { reason?: unknown; codes?: unknown };
  };
  const reason = typeof metadata.reason === "string"
    ? metadata.reason
    : typeof metadata.quality?.reason === "string" ? metadata.quality.reason : null;
  const codes = Array.isArray(metadata.quality?.codes)
    ? metadata.quality.codes.filter((code): code is string => typeof code === "string").slice(0, 10)
    : [];
  if (reason === "chart-history-truncated") {
    return { status: "truncated", reason, runStartedAt: row.started_at, codes };
  }
  // Completed buckets carry no publishing-run identity; only these successful
  // no-ops may defer to earlier evidence, without crossing a failed read/run.
  if (row.status === "ok" && reason === "cadence_bucket_completed" && rows.length > 1) {
    return parseChartsRuns(rows.slice(1), nowSec);
  }
  // Only a run that actually published (or confirmed a newer canonical cache)
  // is recovery evidence. A cadence skip, error, or unconfirmed CAS skip is
  // unknown, never a healthy chart generation (R2).
  const published = reason !== "cadence_bucket_completed"
    && (metadata.cacheWriteMode === "published" || metadata.lastWriteAdvanced === true);
  if ((row.status === "ok" || row.status === "degraded") && published) {
    if (row.started_at > nowSec || nowSec - row.started_at > CHARTS_PUBLICATION_MAX_AGE_SEC) {
      return { status: "unknown", reason: "sync-stablecoin-charts-publication-stale", runStartedAt: row.started_at, codes };
    }
    return { status: "ok", reason: null, runStartedAt: row.started_at, codes };
  }
  return {
    status: "unknown",
    reason: row.status === "error" ? "sync-stablecoin-charts-run-error" : "sync-stablecoin-charts-no-publication-evidence",
    runStartedAt: row.started_at,
    codes,
  };
}

function unknownValueIntegrity(reason: string): SupplyValueIntegrityReport {
  return {
    status: "unknown",
    reason,
    checkedCount: 0,
    excludedCount: 0,
    driftFindings: [],
    heldDriftFindings: [],
    heldDriftBaselines: {},
    heldDriftUnknownReason: null,
    aggregateCurrentUsd: null,
    aggregatePreviousUsd: null,
    aggregateRatio: null,
    frozen: false,
    carryIds: [],
    carryOldestAgeSec: null,
    carryUnclockedCount: 0,
    acknowledgedCarryReviews: [],
    expiredCarryReviewIds: [],
    unacknowledgedCarryIds: [],
    unacknowledgedCarryOldestAgeSec: null,
    unacknowledgedCarryUnclockedCount: 0,
    expectedActiveCount: ACTIVE_IDS.size,
    cacheUpdatedAt: null,
    historyFromDate: null,
  };
}

function unknownAvailabilityIntegrity(reason: string): SupplyAvailabilityIntegrityReport {
  return {
    status: "unknown",
    reason,
    observedCount: null,
    unavailableCount: null,
    share: null,
    consecutiveGenerations: 0,
    latestRunStartedAt: null,
    charts: { status: "unknown", reason: null, runStartedAt: null, codes: [], maxAgeSec: CHARTS_PUBLICATION_MAX_AGE_SEC },
  };
}

function unknownSnapshotIntegrity(reason: string, expectedDate: number, due: boolean): SupplySnapshotIntegrityReport {
  return {
    status: "unknown",
    reason,
    expectedDate,
    snapshotDate: null,
    due,
    current: false,
    identityVerified: false,
    expectedActiveCount: null,
    accountedActiveCount: null,
    writtenRows: null,
    persistedRows: null,
    unavailableActiveIds: null,
    band: null,
  };
}

/**
 * Compare each active cached `circulating` value with the latest daily
 * `supply_history` row. Only rows with matching, non-repair provenance enter
 * the comparison; carried and repaired values are counted as exclusions, never
 * as observed drift (ADR-8 / ADR-28).
 */
async function loadSupplyValueIntegrity(
  db: D1Database,
  nowSec: number,
): Promise<SupplyValueIntegrityReport> {
  const cache = await loadStablecoinsCache(db, { mode: "lenient" });
  if (!hasUsableStablecoinsPayload(cache)) {
    return unknownValueIntegrity(`stablecoins-cache-${cache.reason}`);
  }

  const today = startOfUtcDaySec(new Date(nowSec * 1000));
  const fromDate = today - STATUS_SUPPLY_VALUE_THRESHOLDS.historyWindowDays * 24 * 3600;
  let previousByAsset: Map<string, SupplyHistoryRow> | null = null;
  try {
    const rows = await runWithOverloadRetry(() =>
      db
        .prepare(
          `SELECT /* supply-integrity-previous-rows */
                  stablecoin_id, snapshot_date, circulating_usd, supply_provenance
             FROM (
               SELECT stablecoin_id, snapshot_date, circulating_usd, supply_provenance,
                      ROW_NUMBER() OVER (PARTITION BY stablecoin_id ORDER BY snapshot_date DESC) AS row_number
                 FROM supply_history
                WHERE snapshot_date >= ? AND snapshot_date < ?
             )
            WHERE row_number = 1`,
        )
        .bind(fromDate, today)
        .all<SupplyHistoryRow>(),
    );
    previousByAsset = new Map((rows.results ?? []).map((row) => [row.stablecoin_id, row]));
  } catch {
    // The carry signal comes from the cache and survives a history read
    // failure; the value comparison itself stays unknown (R2/R7).
  }

  const report = unknownValueIntegrity("stablecoins-cache-usable");
  report.status = "ok";
  report.reason = null;
  report.cacheUpdatedAt = cache.updatedAt;
  const driftFindings: SupplyValueDriftFinding[] = [];
  const currentValues: Record<string, number> = {};
  const quarantinedIds = new Set<string>();
  const carryIds: string[] = [];
  let carryOldestAgeSec: number | null = null;
  let carryUnclockedCount = 0;
  let checkedCount = 0;
  let excludedCount = 0;
  let currentSum = 0;
  let previousSum = 0;

  for (const asset of cache.payload.peggedAssets) {
    if (!ACTIVE_IDS.has(asset.id)) continue;

    const currentUsd = getCirculatingRawOrNull(asset);
    if (currentUsd === null && asset.supplyUnavailableReason != null) quarantinedIds.add(asset.id);
    // A carry publishes an older value. A restored row with no value (its carry
    // window expired) is unavailable supply, counted by the availability read.
    if (asset.supplyRestored === true && currentUsd !== null) {
      carryIds.push(asset.id);
      const review = REVIEWED_SUPPLY_CARRIES.find((entry) => entry.stablecoinId === asset.id);
      const acknowledged = review != null && nowSec >= review.reviewedAt && nowSec < review.expiresAt
        && carryMatchesReview(asset, review);
      if (acknowledged) report.acknowledgedCarryReviews.push(review);
      else {
        report.unacknowledgedCarryIds.push(asset.id);
        if (review != null && nowSec >= review.expiresAt) report.expiredCarryReviewIds.push(asset.id);
      }
      const observedAt = asset.supplyObservedAt;
      if (typeof observedAt === "number" && Number.isSafeInteger(observedAt) && observedAt > 0) {
        const ageSec = Math.max(0, nowSec - observedAt);
        carryOldestAgeSec = carryOldestAgeSec == null ? ageSec : Math.max(carryOldestAgeSec, ageSec);
        if (!acknowledged) report.unacknowledgedCarryOldestAgeSec = Math.max(report.unacknowledgedCarryOldestAgeSec ?? 0, ageSec);
      } else {
        carryUnclockedCount++;
        if (!acknowledged) report.unacknowledgedCarryUnclockedCount++;
      }
    }

    if (currentUsd !== null
      && asset.supplyRestored !== true
      && asset.supplyGapFill == null
      && asset.supplyChainGuard == null
      && asset.supplyUnavailableReason == null
      && typeof asset.supplySource === "string" && asset.supplySource.length > 0) {
      currentValues[asset.id] = currentUsd;
    }
    const previous = previousByAsset?.get(asset.id);
    if (currentUsd === null || previous == null) {
      excludedCount++;
      continue;
    }
    if (asset.supplyRestored === true || asset.supplyGapFill != null || asset.supplyChainGuard != null
      || asset.supplyUnavailableReason != null) {
      excludedCount++;
      continue;
    }
    if (typeof asset.supplySource !== "string" || asset.supplySource.length === 0) {
      excludedCount++;
      continue;
    }
    const parsedProvenance = parseSupplyObservationProvenance(previous.supply_provenance);
    const provenance = parsedProvenance.provenance;
    if (parsedProvenance.invalid || provenance == null || provenance.supplyChainGuard != null
      || provenance.supplySource !== asset.supplySource) {
      excludedCount++;
      continue;
    }
    const previousUsd = previous.circulating_usd;
    if (!Number.isFinite(previousUsd) || previousUsd <= 0) {
      excludedCount++;
      continue;
    }

    checkedCount++;
    currentSum += currentUsd;
    previousSum += previousUsd;
    const ratio = currentUsd / previousUsd;
    if ((ratio < STATUS_SUPPLY_VALUE_THRESHOLDS.perAssetRatioFloor
      || ratio > STATUS_SUPPLY_VALUE_THRESHOLDS.perAssetRatioCeiling)
      && !isReviewedValueRebaseline(asset.id, currentUsd, nowSec)) {
      driftFindings.push({ stablecoinId: asset.id, currentUsd, previousUsd, ratio });
    }
  }

  // A finding raised against yesterday's daily row must survive the midnight
  // rollover that moves that row's value onto the cache: recovery needs the
  // current value back inside the band, not just a newer snapshot baseline.
  const heldDriftFindings: SupplyValueDriftFinding[] = [];
  const heldDriftBaselines: Record<string, number> = {};
  const recoveredFromHeld = new Set<string>();
  let heldDriftUnknownReason: string | null = null;
  try {
    const state = parseConfirmationState(
      (await getCache(db, SUPPLY_INTEGRITY_CONFIRM_KEY))?.value ?? null,
    );
    const held = state["value-drift"]?.held ?? {};
    const freshIds = new Set(driftFindings.map((finding) => finding.stablecoinId));
    const unresolvedIds: string[] = [];
    for (const [stablecoinId, baselineUsd] of Object.entries(held)) {
      if (!ACTIVE_IDS.has(stablecoinId)) continue;
      const currentUsd = currentValues[stablecoinId];
      if (currentUsd == null) {
        heldDriftBaselines[stablecoinId] = baselineUsd;
        // A named quarantine publishes no value to drift (R8) and the
        // availability read owns it; the baseline waits for its return.
        if (!quarantinedIds.has(stablecoinId)) unresolvedIds.push(stablecoinId);
        continue;
      }
      // A reviewed real move supersedes the pre-move baseline: the observed
      // level is the accepted one, so no return to the old baseline is due.
      if (isReviewedValueRebaseline(stablecoinId, currentUsd, nowSec)) continue;
      const ratio = currentUsd / baselineUsd;
      if (ratio < STATUS_SUPPLY_VALUE_THRESHOLDS.perAssetRatioFloor
        || ratio > STATUS_SUPPLY_VALUE_THRESHOLDS.perAssetRatioCeiling) {
        heldDriftBaselines[stablecoinId] = baselineUsd;
        if (!freshIds.has(stablecoinId)) {
          heldDriftFindings.push({ stablecoinId, currentUsd, previousUsd: baselineUsd, ratio });
        }
      } else {
        // The value returned to the pre-rollover level: this run's move back
        // from the bad snapshot is recovery, not a new drift finding.
        recoveredFromHeld.add(stablecoinId);
      }
    }
    if (unresolvedIds.length > 0) heldDriftUnknownReason = "held-drift-value-unavailable";
  } catch {
    heldDriftUnknownReason = "supply-confirmation-state-read-failed";
  }
  const effectiveDriftFindings = recoveredFromHeld.size === 0
    ? driftFindings
    : driftFindings.filter((finding) => !recoveredFromHeld.has(finding.stablecoinId));

  effectiveDriftFindings.sort((a, b) => a.ratio - b.ratio || a.stablecoinId.localeCompare(b.stablecoinId));
  heldDriftFindings.sort((a, b) => a.ratio - b.ratio || a.stablecoinId.localeCompare(b.stablecoinId));
  carryIds.sort();
  report.unacknowledgedCarryIds.sort();
  report.expiredCarryReviewIds.sort();
  report.acknowledgedCarryReviews.sort((a, b) => a.expiresAt - b.expiresAt || a.stablecoinId.localeCompare(b.stablecoinId));
  report.checkedCount = checkedCount;
  report.excludedCount = excludedCount;
  report.driftFindings = effectiveDriftFindings;
  report.heldDriftFindings = heldDriftFindings;
  report.heldDriftBaselines = heldDriftBaselines;
  report.heldDriftUnknownReason = heldDriftUnknownReason;
  report.carryIds = carryIds;
  report.carryOldestAgeSec = carryOldestAgeSec;
  report.carryUnclockedCount = carryUnclockedCount;
  report.historyFromDate = fromDate;
  if (previousByAsset == null) {
    report.status = "unknown";
    report.reason = "supply-history-read-failed";
    return report;
  }
  if (checkedCount < STATUS_SUPPLY_VALUE_THRESHOLDS.minComparableAssets || previousSum <= 0) {
    report.status = "unknown";
    report.reason = "insufficient-comparable-history";
    return report;
  }
  report.aggregateCurrentUsd = currentSum;
  report.aggregatePreviousUsd = previousSum;
  report.aggregateRatio = currentSum / previousSum;
  // A whole-feed freeze is only meaningful when most of the active cohort is
  // comparable; a small static remainder can legitimately repeat.
  report.frozen = checkedCount >= Math.ceil(
    ACTIVE_IDS.size * STATUS_SUPPLY_VALUE_THRESHOLDS.frozenMinComparableShare,
  ) && Math.abs(currentSum - previousSum)
    <= previousSum * STATUS_SUPPLY_VALUE_THRESHOLDS.aggregateFrozenTolerance;
  return report;
}

function parseActiveSupplyCoverage(metadata: string | null): { observed: number; unavailable: number } | null {
  if (!metadata) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as {
    priceSourceHealth?: { active?: { supplyCoverage?: unknown; totalAssets?: unknown }; supplyCoverage?: unknown };
    supplyChainGuard?: { unavailableAssetCount?: unknown };
  };
  const coverage = record.priceSourceHealth?.active?.supplyCoverage
    ?? record.priceSourceHealth?.supplyCoverage;
  if (!coverage || typeof coverage !== "object") return null;
  const { observedCount, unavailableCount } = coverage as { observedCount?: unknown; unavailableCount?: unknown };
  if (!Number.isInteger(observedCount) || !Number.isInteger(unavailableCount)
    || Number(observedCount) < 0 || Number(unavailableCount) < 0) {
    return null;
  }
  // Guard quarantines publish a carry (graded as carried supply), so they are
  // not unavailable supply. The guard's own unavailable count stays a floor:
  // the final coverage tallies priced assets only.
  const guardUnavailable = record.supplyChainGuard?.unavailableAssetCount;
  return {
    observed: Number(observedCount),
    unavailable: Math.max(Number(unavailableCount),
      Number.isInteger(guardUnavailable) && Number(guardUnavailable) >= 0 ? Number(guardUnavailable) : 0),
  };
}

/**
 * Read the last two published `sync-stablecoins` generations and grade the
 * active supply-unavailable share. Two consecutive generations above the
 * routine band are required before this is an operator condition.
 */
async function loadSupplyAvailabilityIntegrity(
  db: D1Database,
  nowSec: number,
): Promise<SupplyAvailabilityIntegrityReport> {
  // Sibling reads are independent: a failed charts read must not discard valid
  // supply-coverage evidence, and vice versa (R2/R7).
  const [rows, chartsRows] = await Promise.all([
    runWithOverloadRetry(() =>
      db
        .prepare(
          `SELECT started_at, status, metadata
             FROM cron_runs
            WHERE job = 'sync-stablecoins'
            ORDER BY started_at DESC, id DESC
            LIMIT 2`,
        )
        .all<SyncStablecoinsRunRow>(),
    ).catch(() => null),
    runWithOverloadRetry(() =>
      db
        .prepare(
          `SELECT started_at, status, metadata
             FROM cron_runs
            WHERE job = 'sync-stablecoin-charts'
            ORDER BY started_at DESC, id DESC
            LIMIT 8`,
        )
        .all<ChartsRunRow>(),
    ).catch(() => null),
  ]);
  const chartsEvidence = chartsRows == null
    ? { status: "unknown" as const, reason: "sync-stablecoin-charts-read-failed", runStartedAt: null, codes: [] }
    : parseChartsRuns(chartsRows.results ?? [], nowSec);
  const charts = { ...chartsEvidence, maxAgeSec: CHARTS_PUBLICATION_MAX_AGE_SEC };
  if (rows == null) return { ...unknownAvailabilityIntegrity("sync-stablecoins-runs-read-failed"), charts };
  const runs = rows.results ?? [];
  const latest = runs[0];
  if (!latest) return { ...unknownAvailabilityIntegrity("sync-stablecoins-runs-unavailable"), charts };
  const latestCoverage = parseActiveSupplyCoverage(latest.metadata);
  if (!latestCoverage || latestCoverage.observed + latestCoverage.unavailable <= 0) {
    return { ...unknownAvailabilityIntegrity("sync-stablecoins-supply-coverage-unavailable"), charts };
  }
  const total = latestCoverage.observed + latestCoverage.unavailable;
  const share = latestCoverage.unavailable / total;
  const previous = runs[1];
  const previousCoverage = previous ? parseActiveSupplyCoverage(previous.metadata) : null;
  const previousShare = previousCoverage && previousCoverage.observed + previousCoverage.unavailable > 0
    ? previousCoverage.unavailable / (previousCoverage.observed + previousCoverage.unavailable)
    : null;
  const threshold = STATUS_SUPPLY_VALUE_THRESHOLDS.activeSupplyShareThreshold;
  const consecutiveGenerations = share < threshold
    ? 0
    : previousShare != null && previousShare >= threshold ? 2 : 1;
  return {
    status: "ok",
    reason: null,
    observedCount: latestCoverage.observed,
    unavailableCount: latestCoverage.unavailable,
    share,
    consecutiveGenerations,
    latestRunStartedAt: latest.started_at,
    charts,
  };
}

async function loadSupplySnapshotIntegrity(
  db: D1Database,
  nowSec: number,
): Promise<SupplySnapshotIntegrityReport> {
  const expectedDate = startOfUtcDaySec(new Date(nowSec * 1000));
  const due = nowSec - expectedDate >= STATUS_SUPPLY_VALUE_THRESHOLDS.snapshotDueGraceSec;
  const marker = await getCompletedSupplySnapshot(db);
  if (!marker) {
    // Absence cannot distinguish a fresh deployment from a stopped producer;
    // it stays unknown rather than claiming an overdue generation. A marker
    // dated before today is positive evidence the producer ran and stopped.
    return unknownSnapshotIntegrity("snapshot-completion-marker-missing", expectedDate, due);
  }
  const current = marker.snapshotDate === expectedDate;
  const report: SupplySnapshotIntegrityReport = {
    status: "ok",
    reason: null,
    expectedDate,
    snapshotDate: marker.snapshotDate,
    due,
    current,
    identityVerified: marker.coverageIdentityVerified,
    expectedActiveCount: marker.expectedActiveCount,
    accountedActiveCount: marker.accountedActiveCount,
    writtenRows: marker.ownedRowIds?.length ?? null,
    persistedRows: null,
    unavailableActiveIds: marker.unavailableActiveIds,
    band: null,
  };
  if (!current) return report;

  const row = await runWithOverloadRetry(() =>
    db
      .prepare("SELECT COUNT(*) AS count FROM supply_history WHERE snapshot_date = ?")
      .bind(marker.snapshotDate)
      .first<{ count: number | null }>(),
  );
  if (row?.count == null || !Number.isInteger(row.count) || row.count < 0) {
    return { ...report, status: "unknown", reason: "supply-history-row-count-unavailable" };
  }
  report.persistedRows = row.count;
  if (report.unavailableActiveIds != null && report.expectedActiveCount != null) {
    report.band = classifyStablecoinPublicationGap({
      expectedActiveCount: report.expectedActiveCount,
      missingActiveIds: report.unavailableActiveIds,
    });
  }
  return report;
}

export interface SupplyIntegrityReadOptions {
  signal?: AbortSignal;
}

async function settle<T>(
  load: () => Promise<T>,
  fallback: (reason: string) => T,
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await load();
  } catch (error) {
    if (signal?.aborted) throw error;
    return fallback(error instanceof Error ? error.message : String(error));
  }
}

/** Load every supply-integrity dimension independently; a failed read stays unknown. */
export async function loadSupplyIntegrityReport(
  db: D1Database,
  nowSec: number,
  options: SupplyIntegrityReadOptions = {},
): Promise<SupplyIntegrityReport> {
  const expectedDate = startOfUtcDaySec(new Date(nowSec * 1000));
  const [value, availability, snapshot] = await Promise.all([
    settle(() => loadSupplyValueIntegrity(db, nowSec), unknownValueIntegrity, options.signal),
    settle(() => loadSupplyAvailabilityIntegrity(db, nowSec), unknownAvailabilityIntegrity, options.signal),
    settle(
      () => loadSupplySnapshotIntegrity(db, nowSec),
      (reason) => unknownSnapshotIntegrity(
        reason,
        expectedDate,
        nowSec - expectedDate >= STATUS_SUPPLY_VALUE_THRESHOLDS.snapshotDueGraceSec,
      ),
      options.signal,
    ),
  ]);
  return { observedAt: nowSec, value, availability, snapshot };
}

export type SupplyIntegrityConditionId =
  | "value-drift"
  | "availability"
  | "carry"
  | "snapshot-overdue"
  | "snapshot-partial"
  | "charts-history";

export interface SupplyIntegrityCondition {
  id: SupplyIntegrityConditionId;
  label: string;
  active: boolean;
  unknown: boolean;
  /** Stable across runs while the same finding persists; confirmation resets when it changes. */
  signature: string;
  /**
   * Pre-rollover evidence retained while the condition stays raised, so a
   * changing snapshot baseline is not mistaken for recovery. Omitted when the
   * evidence read failed and the previous state must stand.
   */
  held?: Record<string, number>;
}

function formatIds(ids: readonly string[]): string {
  return ids.slice(0, 3).join(", ") + (ids.length > 3 ? `, +${ids.length - 3} more` : "");
}

function formatShare(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

function isoDay(seconds: number | null): string {
  return seconds == null ? "none" : new Date(seconds * 1000).toISOString().slice(0, 10);
}

/**
 * Translate a read report into operator-watch conditions. `unknown` marks a
 * detector whose own evidence could not be read; the transition machine keeps
 * its prior state instead of treating that as recovery (R2).
 */
export function buildSupplyIntegrityConditions(report: SupplyIntegrityReport): SupplyIntegrityCondition[] {
  const value = report.value;
  const valueDrift = value.driftFindings;
  const heldDrift = value.heldDriftFindings;
  const aggregateBreached = value.aggregateRatio != null
    && (value.aggregateRatio < STATUS_SUPPLY_VALUE_THRESHOLDS.aggregateRatioFloor
      || value.aggregateRatio > STATUS_SUPPLY_VALUE_THRESHOLDS.aggregateRatioCeiling);
  const valueActive = valueDrift.length > 0 || heldDrift.length > 0 || value.frozen || aggregateBreached;
  const valueLabel = [
    valueDrift.length > 0
      ? `${valueDrift.length} asset(s) outside ${STATUS_SUPPLY_VALUE_THRESHOLDS.perAssetRatioFloor}-${STATUS_SUPPLY_VALUE_THRESHOLDS.perAssetRatioCeiling}x (${formatIds(valueDrift.map((finding) => `${finding.stablecoinId} ${finding.ratio.toFixed(2)}x`))})`
      : null,
    heldDrift.length > 0
      ? `${heldDrift.length} asset(s) still outside ${STATUS_SUPPLY_VALUE_THRESHOLDS.perAssetRatioFloor}-${STATUS_SUPPLY_VALUE_THRESHOLDS.perAssetRatioCeiling}x of the pre-rollover daily baseline (${formatIds(heldDrift.map((finding) => `${finding.stablecoinId} ${finding.ratio.toFixed(2)}x`))})`
      : null,
    aggregateBreached && value.aggregateRatio != null
      ? `total ${value.aggregateRatio.toFixed(2)}x outside ${STATUS_SUPPLY_VALUE_THRESHOLDS.aggregateRatioFloor}-${STATUS_SUPPLY_VALUE_THRESHOLDS.aggregateRatioCeiling}x`
      : null,
    value.frozen ? "cohort total unchanged across generations" : null,
  ].filter((part): part is string => part != null).join("; ");
  // Keep every retained pre-rollover baseline, then add the latest daily row
  // for assets that started drifting this run. Membership never keys the
  // condition; it changes only the label.
  const nextHeld: Record<string, number> = { ...value.heldDriftBaselines };
  for (const finding of valueDrift) {
    if (nextHeld[finding.stablecoinId] == null) nextHeld[finding.stablecoinId] = finding.previousUsd;
  }
  const heldState = Object.fromEntries(
    Object.entries(nextHeld)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, MAX_HELD_DRIFT_BASELINES),
  );
  const expectedActive = value.expectedActiveCount;
  const carryThreshold = Math.max(
    1,
    Math.ceil(expectedActive * STATUS_SUPPLY_VALUE_THRESHOLDS.activeSupplyShareThreshold),
  );
  const carryActive = value.unacknowledgedCarryIds.length >= carryThreshold
    || (value.unacknowledgedCarryOldestAgeSec != null && value.unacknowledgedCarryOldestAgeSec > STATUS_SUPPLY_VALUE_THRESHOLDS.carryStaleAfterSec);
  const carryLabel = [
    `${value.unacknowledgedCarryIds.length} carried asset(s)`,
    value.unacknowledgedCarryOldestAgeSec != null ? `oldest ${Math.floor(value.unacknowledgedCarryOldestAgeSec / 3600)}h` : null,
    value.unacknowledgedCarryUnclockedCount > 0 ? `${value.unacknowledgedCarryUnclockedCount} without an observation clock` : null,
    value.unacknowledgedCarryIds.length > 0 ? formatIds(value.unacknowledgedCarryIds) : null,
  ].filter((part): part is string => part != null).join(", ");

  const availability = report.availability;
  const availabilityActive = availability.status === "ok" && availability.consecutiveGenerations >= 2;
  const availabilityLabel = availability.status === "ok" && availability.share != null
    ? `${formatShare(availability.share)} unavailable (${availability.unavailableCount}/${(availability.observedCount ?? 0) + (availability.unavailableCount ?? 0)}) `
      + `for ${availability.consecutiveGenerations} generation(s); budget ${formatShare(STATUS_SUPPLY_VALUE_THRESHOLDS.activeSupplyShareThreshold)}; `
      + `producer sync-stablecoins, generation ${availability.latestRunStartedAt != null ? new Date(availability.latestRunStartedAt * 1000).toISOString() : "unknown"}`
    : "supply availability evidence unavailable";

  const snapshot = report.snapshot;
  const snapshotOverdue = snapshot.status === "ok" && snapshot.due && !snapshot.current;
  const snapshotRowsMissing = snapshot.current
    && snapshot.persistedRows != null
    && snapshot.writtenRows != null
    && snapshot.persistedRows < snapshot.writtenRows;
  const snapshotBandActive = snapshot.band === "elevated" || snapshot.band === "systemic";
  const snapshotPartial = snapshot.current && (snapshotRowsMissing || snapshotBandActive);
  const snapshotPartialLabel = [
    snapshot.expectedActiveCount != null && snapshot.unavailableActiveIds != null
      ? `${snapshot.unavailableActiveIds.length}/${snapshot.expectedActiveCount} active asset(s) have unavailable supply; budget ${formatShare(STABLECOIN_PUBLICATION_GAP_ROUTINE_MAX_SHARE)}`
      : null,
    snapshot.unavailableActiveIds != null && snapshot.unavailableActiveIds.length > 0
      ? formatIds(snapshot.unavailableActiveIds)
      : null,
    snapshotRowsMissing ? `persisted ${snapshot.persistedRows} of ${snapshot.writtenRows} written row(s)` : null,
  ].filter((part): part is string => part != null).join("; ");
  const snapshotOverdueLabel = snapshot.snapshotDate == null
    ? `snapshot overdue: producer snapshot-supply has no completion marker; budget ${STATUS_SUPPLY_VALUE_THRESHOLDS.snapshotDueGraceSec / 60}m after UTC midnight`
    : `snapshot overdue: producer snapshot-supply last wrote ${isoDay(snapshot.snapshotDate)} (today ${isoDay(snapshot.expectedDate)}); `
      + `budget ${STATUS_SUPPLY_VALUE_THRESHOLDS.snapshotDueGraceSec / 60}m after UTC midnight`;

  return [
    {
      id: "value-drift",
      label: valueActive ? valueLabel : "value drift",
      active: valueActive,
      // A persisted finding whose current value could not be re-read holds its
      // prior state instead of claiming recovery (R2).
      unknown: !valueActive && (value.status === "unknown" || value.heldDriftUnknownReason != null),
      // Constant identity: membership and ratios stay in the label, so a
      // changing drift cohort never resets confirmation.
      signature: "value-drift",
      ...(value.heldDriftUnknownReason === "supply-confirmation-state-read-failed"
        ? {}
        : { held: heldState }),
    },
    {
      id: "availability",
      label: availabilityLabel,
      active: availabilityActive,
      unknown: availability.status === "unknown",
      signature: "unavailable-supply",
    },
    {
      id: "carry",
      label: carryActive ? `carried supply: ${carryLabel}` : "carried supply",
      active: carryActive,
      // Carry is read from the cache alone; only a failed cache read is unknown.
      unknown: value.cacheUpdatedAt == null,
      // Constant identity: membership and age stay in the label, so a coin
      // entering or leaving the carried cohort never resets confirmation.
      signature: "carried-supply",
    },
    {
      id: "snapshot-overdue",
      label: snapshotOverdueLabel,
      active: snapshotOverdue,
      unknown: snapshot.status === "unknown",
      signature: snapshot.snapshotDate == null ? "none" : String(snapshot.snapshotDate),
    },
    {
      id: "snapshot-partial",
      label: snapshotPartial ? `partial supply snapshot: ${snapshotPartialLabel}` : "partial supply snapshot",
      active: snapshotPartial,
      // A current marker without the unavailable-evidence field (legacy) or a
      // failed row read cannot certify a complete snapshot (R2).
      unknown: snapshot.current && (snapshot.status === "unknown" || snapshot.unavailableActiveIds == null),
      signature: `${snapshot.unavailableActiveIds?.join(",") ?? ""}|${snapshot.persistedRows ?? ""}/${snapshot.writtenRows ?? ""}`,
    },
    {
      id: "charts-history",
      label: availability.charts.status === "truncated"
        ? `producer sync-stablecoin-charts published a discontinuous history on generation `
          + `${availability.charts.runStartedAt != null ? new Date(availability.charts.runStartedAt * 1000).toISOString() : "unknown"}`
          + `${availability.charts.codes.length > 0 ? ` (${availability.charts.codes.join(", ")})` : ""}; budget 80% of prior points`
        : "chart history continuity",
      active: availability.charts.status === "truncated",
      unknown: availability.charts.status === "unknown",
      signature: "chart-history-truncated",
    },
  ];
}

interface ConfirmationEntry {
  signature: string;
  runs: number;
  /** Drift baselines retained while the value-drift condition stays raised. */
  held?: Record<string, number>;
}

function parseHeldBaselines(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value)
    .filter((entry): entry is [string, number] =>
      typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] > 0)
    .slice(0, MAX_HELD_DRIFT_BASELINES);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function parseConfirmationState(value: string | null): Record<string, ConfirmationEntry> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([id, entry]) => {
        if (!entry || typeof entry !== "object") return [];
        const record = entry as { signature?: unknown; runs?: unknown; held?: unknown };
        if (typeof record.signature !== "string" || !Number.isInteger(record.runs)) return [];
        const held = parseHeldBaselines(record.held);
        return [[id, {
          signature: record.signature,
          runs: Number(record.runs),
          ...(held ? { held } : {}),
        }] as const];
      }),
    );
  } catch {
    return {};
  }
}

/**
 * Require the same finding signature on consecutive watchdog runs before it is
 * raised. A confirmation-state read/write failure marks every condition
 * unknown so the caller keeps prior transition state instead of claiming
 * recovery.
 */
export async function confirmSupplyIntegrityConditions(
  db: D1Database,
  conditions: readonly SupplyIntegrityCondition[],
  options: { signal?: AbortSignal } = {},
): Promise<SupplyIntegrityCondition[]> {
  let previous: Record<string, ConfirmationEntry>;
  try {
    previous = parseConfirmationState((await getCache(db, SUPPLY_INTEGRITY_CONFIRM_KEY, options.signal))?.value ?? null);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return conditions.map((condition) => ({ ...condition, unknown: true }));
  }
  const next: Record<string, ConfirmationEntry> = {};
  const confirmed = conditions.map((condition) => {
    if (condition.unknown) {
      if (previous[condition.id] != null) next[condition.id] = previous[condition.id];
      return condition;
    }
    if (!condition.active) return condition;
    const runs = previous[condition.id]?.signature === condition.signature
      ? previous[condition.id].runs + 1
      : 1;
    // An unreadable hold leaves the prior baselines standing; an empty map
    // explicitly clears them because every held value recovered.
    const held = condition.held ?? previous[condition.id]?.held;
    next[condition.id] = { signature: condition.signature, runs, ...(held ? { held } : {}) };
    return runs >= SUPPLY_INTEGRITY_CONFIRM_RUNS ? condition : { ...condition, active: false };
  });
  try {
    await setCache(db, SUPPLY_INTEGRITY_CONFIRM_KEY, JSON.stringify(next), options.signal);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return conditions.map((condition) => ({ ...condition, unknown: true }));
  }
  return confirmed;
}

/** Compact operator metadata; bounded IDs keep the sentinel row inside its persistence budget. */
export function compactSupplyIntegrityReport(report: SupplyIntegrityReport): Record<string, unknown> {
  return {
    observedAt: report.observedAt,
    value: {
      status: report.value.status,
      reason: report.value.reason,
      checkedCount: report.value.checkedCount,
      excludedCount: report.value.excludedCount,
      driftCount: report.value.driftFindings.length,
      driftIds: report.value.driftFindings.slice(0, MAX_REPORTED_IDS).map((finding) => finding.stablecoinId),
      heldDriftCount: report.value.heldDriftFindings.length,
      heldDriftIds: report.value.heldDriftFindings.slice(0, MAX_REPORTED_IDS).map((finding) => finding.stablecoinId),
      heldDriftUnknownReason: report.value.heldDriftUnknownReason,
      aggregateRatio: report.value.aggregateRatio,
      frozen: report.value.frozen,
      carryCount: report.value.carryIds.length,
      carryIds: report.value.carryIds.slice(0, MAX_REPORTED_IDS),
      carryOldestAgeSec: report.value.carryOldestAgeSec,
      carryUnclockedCount: report.value.carryUnclockedCount,
      acknowledgedCarryReviews: report.value.acknowledgedCarryReviews,
      expiredCarryReviewIds: report.value.expiredCarryReviewIds,
      unacknowledgedCarryCount: report.value.unacknowledgedCarryIds.length,
      unacknowledgedCarryIds: report.value.unacknowledgedCarryIds.slice(0, MAX_REPORTED_IDS),
      unacknowledgedCarryOldestAgeSec: report.value.unacknowledgedCarryOldestAgeSec,
      unacknowledgedCarryUnclockedCount: report.value.unacknowledgedCarryUnclockedCount,
      cacheUpdatedAt: report.value.cacheUpdatedAt,
    },
    availability: {
      status: report.availability.status,
      reason: report.availability.reason,
      observedCount: report.availability.observedCount,
      unavailableCount: report.availability.unavailableCount,
      share: report.availability.share,
      consecutiveGenerations: report.availability.consecutiveGenerations,
      latestRunStartedAt: report.availability.latestRunStartedAt,
      charts: report.availability.charts,
    },
    snapshot: {
      status: report.snapshot.status,
      reason: report.snapshot.reason,
      expectedDate: report.snapshot.expectedDate,
      snapshotDate: report.snapshot.snapshotDate,
      due: report.snapshot.due,
      current: report.snapshot.current,
      identityVerified: report.snapshot.identityVerified,
      expectedActiveCount: report.snapshot.expectedActiveCount,
      accountedActiveCount: report.snapshot.accountedActiveCount,
      writtenRows: report.snapshot.writtenRows,
      persistedRows: report.snapshot.persistedRows,
      unavailableCount: report.snapshot.unavailableActiveIds?.length ?? null,
      unavailableActiveIds: report.snapshot.unavailableActiveIds?.slice(0, MAX_REPORTED_IDS) ?? null,
      band: report.snapshot.band,
    },
  };
}
