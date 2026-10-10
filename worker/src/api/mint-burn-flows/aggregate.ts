import { DAY_SECONDS } from "@shared/lib/time-constants";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { getPressureShiftState } from "@shared/lib/mint-burn-signals";
import {
  addMintBurnValuationTally,
  emptyMintBurnValuationTally,
  provenNetFlowDirection24h,
  summarizeMintBurnValuation,
  type MintBurnValuationTally,
} from "@shared/lib/mint-burn-valuation";
import type { MintBurnValuation, MintBurnValuationCompleteness } from "@shared/types/mint-burn";
import { getLatestSuccessfulCronTimestampResult, type CronTimestampLookupResult } from "../../lib/api-freshness";
import type { FlightToQualityClassification } from "../../lib/flight-to-quality-classification";
import {
  buildMintBurnSyncHealth,
} from "../../lib/mint-burn-health-config";
import {
  buildMintBurnScope,
  getMintBurnTrackedPairs,
  MINT_BURN_CONFIGS,
} from "../../lib/mint-burn-contracts";
import { readMintBurnSyncStateBatch } from "../../lib/mint-burn-pipeline/sync-state";
import {
  computeFlowIntensity,
  detectFlightToQuality,
  FLOW_INTENSITY_MIN_DATA_DAYS,
  detectFlightToQualityFromValuedNets,
  type FlightToQualityResult,
  type ValuedNetFlow24h,
} from "../../lib/mint-burn-scoring";
import { buildMintBurnFirstHourSeekStatements } from "../../lib/mint-burn-hourly-queries";
import {
  MINT_BURN_HOURLY_BUCKET_COLUMNS_SQL,
  MINT_BURN_HOURLY_VALUATION_TALLY_SQL,
  type MintBurnValuationTallyRow,
  readMintBurnValuationTallyRow,
} from "../../lib/mint-burn-hourly-valuation";
import {
  aggregateHourlyRowsByStablecoin,
  BASELINE_WINDOW_DAYS,
  buildBaselineMap,
  buildCoinCoverageMap,
  bucketDay,
  type DailyBaselineRow,
  type EventRow,
  type FirstSeenRow,
  FLOW_DEFAULT_WINDOW_HOURS,
  type HourlyRow,
  MINT_BURN_CRON_JOB,
  mintBurnPairKey,
  mintBurnHourlyWindow,
  readMintBurnCronSnapshotResult,
  selectLargestEvents,
} from "../../lib/mint-burn-flows-service";

const ACTIVE_MINT_BURN_CONFIGS = MINT_BURN_CONFIGS.filter((config) => ACTIVE_IDS.has(config.stablecoinId));
export const TRACKED_IDS = new Set(ACTIVE_MINT_BURN_CONFIGS.map((config) => config.stablecoinId));

export interface CoinFlowSummary {
  stablecoinId: string;
  symbol: string;
  pressureShiftScore: number | null;
  pressureShiftState: "improving" | "stable" | "worsening" | "nr";
  netFlowDirection24h: "minting" | "burning" | "flat" | "inactive" | null;
  has24hActivity: boolean;
  baselineDailyNetUsd: number | null;
  baselineDailyAbsUsd: number | null;
  baselineDataDays: number | null;
  netFlow24hUsd: number | null;
  mintVolume24hUsd: number;
  burnVolume24hUsd: number;
  mintCount24h: number;
  burnCount24h: number;
  netFlow7dUsd: number | null;
  netFlow30dUsd: number | null;
  netFlow90dUsd: number | null;
  largestEvent24h: {
    direction: string;
    amountUsd: number;
    txHash: string;
    timestamp: number;
  } | null;
  coverage: {
    startBlock: number;
    lastSyncedBlock: number | null;
    lagBlocks: number | null;
    historyStartAt: number | null;
    has24hWindow: boolean;
    has30dWindow: boolean;
    has90dWindow: boolean;
    isPartial: boolean;
    adapterKinds?: string[];
    startBlockSource?: string;
    startBlockConfidence?: "high" | "medium" | "low";
    status: "full" | "partial-history" | "lagging" | "bootstrapping" | "unknown" | "disabled";
    unavailableReason?: "cron-snapshot-unavailable" | null;
  };
  valuation: CoinFlowValuation;
}

/** Mirrors the public per-coin `valuation` block (see `shared/types/mint-burn.ts`). */
export interface CoinFlowValuation {
  window24h: MintBurnValuation;
  baseline: MintBurnValuationCompleteness;
  netFlow7d: MintBurnValuationCompleteness;
  netFlow30d: MintBurnValuationCompleteness;
  netFlow90d: MintBurnValuationCompleteness;
}

/** Known-valuation window net with its valuation tally. */
interface WindowNetFlow {
  netUsd: number;
  valuation: MintBurnValuationTally;
}

export interface AggregateQueryParams {
  nowSec: number;
  windowStart: number;
  window24h: number;
  windowEnd: number;
  window7d: number;
  window30d: number;
  window90d: number;
  nowDayTs: number;
  baselineWindowStart: number;
}

export interface AggregateData {
  hourlyRows: HourlyRow[];
  hourly24hRows: HourlyRow[];
  net7dMap: Map<string, WindowNetFlow>;
  net30dMap: Map<string, WindowNetFlow>;
  net90dMap: Map<string, WindowNetFlow>;
  baselineMap: ReturnType<typeof buildBaselineMap>;
  largestEventMap: ReturnType<typeof selectLargestEvents>;
  coverageMap: ReturnType<typeof buildCoinCoverageMap>;
  sync: ReturnType<typeof buildMintBurnSyncHealth>;
  latestSuccessfulSyncAt: number | null;
  freshnessLookup: CronTimestampLookupResult;
  freshnessLookupWarning: string | null;
}

interface GroupedNetFlowRow extends MintBurnValuationTallyRow {
  stablecoin_id: string;
  chain_id: string;
  net_flow_usd: number;
}

export function appendSyncWarning(baseWarning: string | null, extraWarning: string | null): string | null {
  if (!baseWarning) return extraWarning;
  if (!extraWarning) return baseWarning;
  return `${baseWarning} ${extraWarning}`;
}

function filterRowsToTrackedPairs<T extends { stablecoin_id: string; chain_id: string }>(
  rows: T[],
  trackedPairs: Set<string>,
): T[] {
  return rows.filter((row) => trackedPairs.has(mintBurnPairKey(row.stablecoin_id, row.chain_id)));
}

function buildGroupedNetFlowMap(
  rows: GroupedNetFlowRow[],
  trackedPairs: Set<string>,
): Map<string, WindowNetFlow> {
  const netMap = new Map<string, WindowNetFlow>();
  for (const row of rows) {
    if (!trackedPairs.has(mintBurnPairKey(row.stablecoin_id, row.chain_id))) continue;
    let entry = netMap.get(row.stablecoin_id);
    if (!entry) {
      entry = { netUsd: 0, valuation: emptyMintBurnValuationTally() };
      netMap.set(row.stablecoin_id, entry);
    }
    entry.netUsd += row.net_flow_usd;
    addMintBurnValuationTally(entry.valuation, readMintBurnValuationTallyRow(row));
  }
  return netMap;
}

function filterRowsByWindow(rows: HourlyRow[], windowStart: number, windowEnd: number): HourlyRow[] {
  return rows.filter((row) => row.hour_ts >= windowStart && row.hour_ts < windowEnd);
}

export function buildAggregateQueryParams(nowSec: number, hours: number): AggregateQueryParams {
  const nowDayTs = bucketDay(nowSec);
  const window = mintBurnHourlyWindow(nowSec, hours);
  return {
    nowSec,
    windowStart: window.start,
    windowEnd: window.end,
    window24h: mintBurnHourlyWindow(nowSec, FLOW_DEFAULT_WINDOW_HOURS).start,
    window7d: mintBurnHourlyWindow(nowSec, 7 * 24).start,
    window30d: mintBurnHourlyWindow(nowSec, 30 * 24).start,
    window90d: mintBurnHourlyWindow(nowSec, 90 * 24).start,
    nowDayTs,
    baselineWindowStart: nowDayTs - BASELINE_WINDOW_DAYS * DAY_SECONDS,
  };
}

export async function fetchAggregateData(
  db: D1Database,
  params: AggregateQueryParams,
): Promise<AggregateData> {
  const trackedPairs = getMintBurnTrackedPairs(ACTIVE_MINT_BURN_CONFIGS);
  const trackedPairsJson = JSON.stringify([...trackedPairs].map((pair) => pair.split("|")));
  const hourlyScanStart = Math.min(params.windowStart, params.window24h);
  const firstHourSeekStatements = buildMintBurnFirstHourSeekStatements(
    db,
    ACTIVE_MINT_BURN_CONFIGS.map((config) => ({
      stablecoinId: config.stablecoinId,
      chainId: config.chain.chainId,
    })),
    "flows",
  );
  const eventResultIndex = 5 + firstHourSeekStatements.length;

  // Tracked-pair membership is expressed as a row-value IN over json_each so
  // SQLite drives each (chain, coin) prefix of idx_mbh_chain_coin_hour /
  // idx_mbe_coin_chain_ts directly. A correlated EXISTS (SELECT ... FROM
  // json_each(...)) re-scans the whole pair array for every index row and made
  // these the hottest reads in D1 insights (~1.6M rows read per net-90d call).
  const hourlyPairFilter = `(chain_id, stablecoin_id) IN (
             SELECT json_extract(value, '$[1]'), json_extract(value, '$[0]')
               FROM json_each(?)
           )`;
  const eventPairFilter = `(stablecoin_id, chain_id) IN (
               SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]')
                 FROM json_each(?)
             )`;

  const [batchResults, [lastBlocks, latestCronSnapshotResult]] = await Promise.all([
    db.batch([
      db
        .prepare(
           `SELECT stablecoin_id, chain_id, hour_ts,
                   /* pharos:mint-burn-flows:window-rows */
                   ${MINT_BURN_HOURLY_BUCKET_COLUMNS_SQL}
            FROM mint_burn_hourly INDEXED BY idx_mbh_chain_coin_hour
           WHERE ${hourlyPairFilter}
             AND hour_ts >= ? AND hour_ts < ?
            ORDER BY hour_ts ASC`,
        )
        .bind(trackedPairsJson, hourlyScanStart, params.windowEnd),
      db
        .prepare(
          `SELECT stablecoin_id, chain_id,
                  /* pharos:mint-burn-flows:net-7d */
                  SUM(net_flow_usd) as net_flow_usd,
                  ${MINT_BURN_HOURLY_VALUATION_TALLY_SQL}
           FROM mint_burn_hourly INDEXED BY idx_mbh_chain_coin_hour
           WHERE ${hourlyPairFilter}
             AND hour_ts >= ? AND hour_ts < ?
           GROUP BY stablecoin_id, chain_id`,
        )
        .bind(trackedPairsJson, params.window7d, params.windowEnd),
      db
        .prepare(
          `SELECT stablecoin_id, chain_id,
                  /* pharos:mint-burn-flows:net-30d */
                  SUM(net_flow_usd) as net_flow_usd,
                  ${MINT_BURN_HOURLY_VALUATION_TALLY_SQL}
           FROM mint_burn_hourly INDEXED BY idx_mbh_chain_coin_hour
           WHERE ${hourlyPairFilter}
             AND hour_ts >= ? AND hour_ts < ?
           GROUP BY stablecoin_id, chain_id`,
        )
        .bind(trackedPairsJson, params.window30d, params.windowEnd),
      db
        .prepare(
          `SELECT stablecoin_id, chain_id,
                  /* pharos:mint-burn-flows:net-90d */
                  SUM(net_flow_usd) as net_flow_usd,
                  ${MINT_BURN_HOURLY_VALUATION_TALLY_SQL}
           FROM mint_burn_hourly INDEXED BY idx_mbh_chain_coin_hour
           WHERE ${hourlyPairFilter}
             AND hour_ts >= ? AND hour_ts < ?
           GROUP BY stablecoin_id, chain_id`,
        )
        .bind(trackedPairsJson, params.window90d, params.windowEnd),
      db
        .prepare(
          `SELECT stablecoin_id, chain_id,
                  /* pharos:mint-burn-flows:baseline-days */
                  (hour_ts / 86400) * 86400 as day_ts,
                  SUM(net_flow_usd) as daily_net,
                  SUM(mint_volume_usd + burn_volume_usd) as daily_abs,
                  ${MINT_BURN_HOURLY_VALUATION_TALLY_SQL}
           FROM mint_burn_hourly INDEXED BY idx_mbh_chain_coin_hour
           WHERE ${hourlyPairFilter}
             AND hour_ts >= ? AND hour_ts < ?
           GROUP BY stablecoin_id, chain_id, day_ts`,
        )
        .bind(trackedPairsJson, params.baselineWindowStart, params.nowDayTs),
      ...firstHourSeekStatements,
      db
        .prepare(
          `WITH ranked_events AS (
             SELECT id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd,
                    counterparty, tx_hash, block_number, timestamp, explorer_tx_url,
                    ROW_NUMBER() OVER (
                      PARTITION BY stablecoin_id
                      ORDER BY amount_usd DESC, timestamp DESC, block_number DESC, id DESC
                    ) AS row_num
             FROM mint_burn_events AS e INDEXED BY idx_mbe_coin_chain_ts
             WHERE ${eventPairFilter}
               AND e.timestamp >= ? AND e.timestamp < ?
               AND (e.direction = 'mint' OR e.burn_type = 'effective_burn')
               AND e.flow_type = 'standard'
               AND e.amount_usd IS NOT NULL
           )
           SELECT id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd,
                  counterparty, tx_hash, block_number, timestamp, explorer_tx_url
           FROM ranked_events
           WHERE row_num = 1`,
        )
        .bind(trackedPairsJson, params.window24h, params.windowEnd),
    ]),
    Promise.all([
      readMintBurnSyncStateBatch(db, ACTIVE_MINT_BURN_CONFIGS),
      readMintBurnCronSnapshotResult(db),
    ]),
  ]);

  const scannedHourlyRows = filterRowsToTrackedPairs((batchResults[0].results ?? []) as HourlyRow[], trackedPairs);
  const hourlyRows = filterRowsByWindow(scannedHourlyRows, params.windowStart, params.windowEnd);
  const hourly24hRows = filterRowsByWindow(scannedHourlyRows, params.window24h, params.windowEnd);
  const baselineRows = filterRowsToTrackedPairs((batchResults[4].results ?? []) as DailyBaselineRow[], trackedPairs);
  const firstSeenRows = filterRowsToTrackedPairs(
    batchResults
      .slice(5, eventResultIndex)
      .flatMap((result) => (result.results ?? []) as Array<FirstSeenRow & { first_hour_ts: number | null }>)
      .filter((row): row is FirstSeenRow => row.first_hour_ts != null),
    trackedPairs,
  );
  const largestEventRows = filterRowsToTrackedPairs(
    (batchResults[eventResultIndex]?.results ?? []) as EventRow[],
    trackedPairs,
  );
  const latestCronSnapshot = latestCronSnapshotResult.value;
  const latestSuccessfulSyncLookup = await getLatestSuccessfulCronTimestampResult(db, MINT_BURN_CRON_JOB);
  const latestSuccessfulSyncAt = latestSuccessfulSyncLookup.timestamp;
  const freshnessLookupWarning = latestSuccessfulSyncLookup.status === "lookup_failed"
    ? "Mint/burn freshness lookup failed; producer observation is unavailable."
    : null;

  return {
    hourlyRows,
    hourly24hRows,
    net7dMap: buildGroupedNetFlowMap((batchResults[1].results ?? []) as GroupedNetFlowRow[], trackedPairs),
    net30dMap: buildGroupedNetFlowMap((batchResults[2].results ?? []) as GroupedNetFlowRow[], trackedPairs),
    net90dMap: buildGroupedNetFlowMap((batchResults[3].results ?? []) as GroupedNetFlowRow[], trackedPairs),
    baselineMap: buildBaselineMap(params.nowSec, baselineRows, firstSeenRows),
    largestEventMap: selectLargestEvents(largestEventRows),
    coverageMap: buildCoinCoverageMap(
      params.nowSec,
      firstSeenRows,
      lastBlocks,
      latestCronSnapshot.chainHeads,
      latestCronSnapshotResult.error ? "cron-snapshot-unavailable" : null,
    ),
    sync: buildMintBurnSyncHealth(params.nowSec, latestSuccessfulSyncAt, latestCronSnapshot.status),
    latestSuccessfulSyncAt,
    freshnessLookup: latestSuccessfulSyncLookup,
    freshnessLookupWarning,
  };
}

/**
 * `mcapById` carries only observed tracked-chain weights. A tracked coin absent
 * from it has an unavailable weight: it is excluded from the gauge inputs and
 * from `trackedMcapUsd` (never counted as a measured `0`) and is counted in
 * `mcapUnavailableCoins`. Its flow row is still published.
 *
 * Valuation gating (D11-2): a signed net whose window valuation is `partial` is
 * published as `null` (a partial net is not a bound); `unknown` legacy windows
 * keep their known-valuation net, labelled through `valuation`. Direction and
 * flight-to-quality are published only when missing valuation cannot alter
 * them. Pressure needs a complete 24h window and a baseline that is not
 * partial. A weighted coin whose pressure is withheld for that reason (and
 * could otherwise score: 24h activity and at least the minimum baseline
 * history) leaves the gauge, which then re-weights over the scored coins. It is
 * disclosed in `partialValuationInputs` with its weight in
 * `partialValuationMcapUsd`, beside the weight actually scored
 * (`scoredMcapUsd`), so consumers can bound what the withheld weight could do
 * to the score.
 */
export function buildCoinSummaries(
  data: AggregateData,
  mcapById: Map<string, number>,
  gradeClassification: FlightToQualityClassification | null,
): {
  coins: CoinFlowSummary[];
  gaugeInputs: Array<{ intensity: number | null; mcap: number }>;
  /** `null` when missing valuation can alter the decision; inactive when classification is unavailable. */
  flightToQuality: FlightToQualityResult | null;
  trackedMcapUsd: number;
  mcapUnavailableCoins: number;
  /** Weighted coins that could score but whose pressure was withheld for incomplete valuation. */
  partialValuationInputs: number;
  /** Sum of those coins' observed weights. */
  partialValuationMcapUsd: number;
  /** Sum of the weights of coins whose pressure entered the gauge score. */
  scoredMcapUsd: number;
} {
  const coinAgg = aggregateHourlyRowsByStablecoin(data.hourly24hRows);
  const coins: CoinFlowSummary[] = [];
  const gaugeInputs: Array<{ intensity: number | null; mcap: number }> = [];
  const safeFlows: ValuedNetFlow24h[] = [];
  const riskyFlows: ValuedNetFlow24h[] = [];
  let trackedMcapUsd = 0;
  let mcapUnavailableCoins = 0;
  let partialValuationInputs = 0;
  let partialValuationMcapUsd = 0;
  let scoredMcapUsd = 0;

  const seenCoinIds = new Set<string>();
  for (const config of ACTIVE_MINT_BURN_CONFIGS) {
    const id = config.stablecoinId;
    if (seenCoinIds.has(id)) continue;
    seenCoinIds.add(id);
    const agg = coinAgg.get(id);
    const baseline = data.baselineMap.get(id);
    const mcap = mcapById.get(id) ?? null;
    if (mcap === null) {
      mcapUnavailableCoins += 1;
    } else {
      trackedMcapUsd += mcap;
    }

    const knownNetFlow24h = agg?.netFlow ?? 0;
    const has24hActivity = (agg?.mintCount ?? 0) > 0
      || (agg?.burnCount ?? 0) > 0
      || (agg?.mintVolume ?? 0) > 0
      || (agg?.burnVolume ?? 0) > 0;
    const valuation24h = summarizeMintBurnValuation(agg?.valuation ?? emptyMintBurnValuationTally());
    // No baseline means no pressure input from it: vacuously complete.
    const baselineValuation = baseline?.valuation ?? "complete";
    const valuationAdmitsPressure = valuation24h.completeness === "complete" && baselineValuation !== "partial";
    const pressureShiftScore = has24hActivity && baseline && valuationAdmitsPressure
      ? computeFlowIntensity({
          currentDailyNet: knownNetFlow24h,
          baselineDailyNet: baseline.avgNet,
          baselineDailyAbs: baseline.avgAbs,
          dataAgeDays: baseline.dataDays,
          currentDailyAbs: (agg?.mintVolume ?? 0) + (agg?.burnVolume ?? 0),
        })
      : null;

    if (mcap !== null) {
      gaugeInputs.push({ intensity: pressureShiftScore, mcap });
      if (pressureShiftScore !== null) scoredMcapUsd += mcap;
      // A baseline shorter than the minimum history is NR whatever the valuation.
      if (has24hActivity && baseline && baseline.dataDays >= FLOW_INTENSITY_MIN_DATA_DAYS && !valuationAdmitsPressure) {
        partialValuationInputs += 1;
        partialValuationMcapUsd += mcap;
      }
    }

    if (gradeClassification) {
      const flow = { knownNetUsd: knownNetFlow24h, valuation: valuation24h };
      if (gradeClassification.safeIds.has(id)) {
        safeFlows.push(flow);
      } else if (gradeClassification.riskyIds.has(id)) {
        riskyFlows.push(flow);
      }
    }

    const largest = data.largestEventMap.get(id);
    const coverage = data.coverageMap.get(id) ?? {
      startBlock: 0,
      lastSyncedBlock: null,
      lagBlocks: null,
      historyStartAt: null,
      has24hWindow: false,
      has30dWindow: false,
      has90dWindow: false,
      isPartial: true,
      status: "bootstrapping" as const,
    };
    const net7d = data.net7dMap.get(id);
    const net30d = data.net30dMap.get(id);
    const net90d = data.net90dMap.get(id);
    // A window without buckets is genuinely empty, hence complete.
    const net7dValuation = summarizeMintBurnValuation(net7d?.valuation ?? emptyMintBurnValuationTally()).completeness;
    const net30dValuation = summarizeMintBurnValuation(net30d?.valuation ?? emptyMintBurnValuationTally()).completeness;
    const net90dValuation = summarizeMintBurnValuation(net90d?.valuation ?? emptyMintBurnValuationTally()).completeness;
    coins.push({
      stablecoinId: id,
      symbol: config.symbol,
      pressureShiftScore,
      pressureShiftState: getPressureShiftState(pressureShiftScore),
      netFlowDirection24h: provenNetFlowDirection24h({
        knownNetUsd: knownNetFlow24h,
        has24hActivity,
        valuation: valuation24h,
      }),
      has24hActivity,
      baselineDailyNetUsd: baseline?.avgNet ?? null,
      baselineDailyAbsUsd: baseline?.avgAbs ?? null,
      baselineDataDays: baseline?.dataDays ?? null,
      netFlow24hUsd: valuation24h.completeness === "partial" ? null : knownNetFlow24h,
      mintVolume24hUsd: agg?.mintVolume ?? 0,
      burnVolume24hUsd: agg?.burnVolume ?? 0,
      mintCount24h: agg?.mintCount ?? 0,
      burnCount24h: agg?.burnCount ?? 0,
      netFlow7dUsd: net7dValuation === "partial" ? null : net7d?.netUsd ?? 0,
      netFlow30dUsd: net30dValuation === "partial" ? null : net30d?.netUsd ?? 0,
      netFlow90dUsd: net90dValuation === "partial" ? null : net90d?.netUsd ?? 0,
      largestEvent24h: largest && largest.amount_usd != null
        ? { direction: largest.direction, amountUsd: largest.amount_usd, txHash: largest.tx_hash, timestamp: largest.timestamp }
        : null,
      coverage,
      valuation: {
        window24h: valuation24h,
        baseline: baselineValuation,
        netFlow7d: net7dValuation,
        netFlow30d: net30dValuation,
        netFlow90d: net90dValuation,
      },
    });
  }

  const flightToQuality = gradeClassification
    ? detectFlightToQualityFromValuedNets({ safe: safeFlows, risky: riskyFlows })
    : detectFlightToQuality({ safeNet24h: 0, riskyNet24h: 0 });

  return {
    coins,
    gaugeInputs,
    flightToQuality,
    trackedMcapUsd,
    mcapUnavailableCoins,
    partialValuationInputs,
    partialValuationMcapUsd,
    scoredMcapUsd,
  };
}

export function buildAggregateScope() {
  return buildMintBurnScope(ACTIVE_MINT_BURN_CONFIGS);
}
