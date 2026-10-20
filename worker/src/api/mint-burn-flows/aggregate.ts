import { DAY_SECONDS } from "@shared/lib/time-constants";
import { WORKER_ACTIVE_IDS as ACTIVE_IDS } from "@shared/lib/stablecoins/worker-runtime-registry";
import { getPressureShiftState } from "@shared/lib/mint-burn-signals";
import {
  addMintBurnValuationTally,
  emptyMintBurnValuationTally,
  mintBurnSignedNetBound,
  provenNetFlowDirection24h,
  summarizeMintBurnValuation,
  type MintBurnValuationTally,
} from "@shared/lib/mint-burn-valuation";
import type { MintBurnCoinFlow, MintBurnValuation } from "@shared/types/mint-burn";
import { decodeMintBurnScanCoverage, prepareMintBurnScanCoverage, type MintBurnScanSegment } from "../../lib/mint-burn-pipeline/scan-coverage";
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
  FLOW_INTENSITY_MIN_DATA_DAYS,
  detectFlightToQualityFromValuedNets,
  type FlightToQualityResult,
  type ValuedNetFlow24h,
} from "../../lib/mint-burn-scoring";
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

export const ACTIVE_MINT_BURN_CONFIGS = MINT_BURN_CONFIGS.filter((config) => ACTIVE_IDS.has(config.stablecoinId));
export const TRACKED_IDS = new Set(ACTIVE_MINT_BURN_CONFIGS.map((config) => config.stablecoinId));

export type CoinFlowSummary = MintBurnCoinFlow & Required<Pick<MintBurnCoinFlow, "coverage" | "valuation">>;

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
  scanSegments: Map<string, MintBurnScanSegment[]>;
  windowEnd: number;
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
  const eventResultIndex = 5;

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
      prepareMintBurnScanCoverage(db, ACTIVE_MINT_BURN_CONFIGS, params.window90d, params.windowEnd),
    ]),
    Promise.all([
      readMintBurnSyncStateBatch(db, ACTIVE_MINT_BURN_CONFIGS),
      readMintBurnCronSnapshotResult(db),
    ]),
  ]);
  const scanSegments = decodeMintBurnScanCoverage(batchResults[6] as D1Result<MintBurnScanSegment>);

  const scannedHourlyRows = filterRowsToTrackedPairs((batchResults[0].results ?? []) as HourlyRow[], trackedPairs);
  const hourlyRows = filterRowsByWindow(scannedHourlyRows, params.windowStart, params.windowEnd);
  const hourly24hRows = filterRowsByWindow(scannedHourlyRows, params.window24h, params.windowEnd);
  const baselineRows = filterRowsToTrackedPairs((batchResults[4].results ?? []) as DailyBaselineRow[], trackedPairs);
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
  const coverageMap = buildCoinCoverageMap(
    params.nowSec, scanSegments, lastBlocks, latestCronSnapshot.chainHeads,
    latestCronSnapshotResult.error ? "cron-snapshot-unavailable" : null, ACTIVE_MINT_BURN_CONFIGS,
  );
  // Baseline denominators start at the first fully proven day, never at the first event.
  const baselineStarts: FirstSeenRow[] = [];
  for (const [stablecoinId, coverage] of coverageMap) {
    if (coverage.historyStartAt != null) baselineStarts.push({
      stablecoin_id: stablecoinId, chain_id: "", first_hour_ts: Math.ceil(coverage.historyStartAt / DAY_SECONDS) * DAY_SECONDS,
    });
  }

  return {
    hourlyRows,
    hourly24hRows,
    net7dMap: buildGroupedNetFlowMap((batchResults[1].results ?? []) as GroupedNetFlowRow[], trackedPairs),
    net30dMap: buildGroupedNetFlowMap((batchResults[2].results ?? []) as GroupedNetFlowRow[], trackedPairs),
    net90dMap: buildGroupedNetFlowMap((batchResults[3].results ?? []) as GroupedNetFlowRow[], trackedPairs),
    baselineMap: buildBaselineMap(params.nowSec, baselineRows, baselineStarts),
    largestEventMap: selectLargestEvents(largestEventRows),
    coverageMap,
    scanSegments,
    windowEnd: params.windowEnd,
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
  /** `null` when classification is unavailable or missing valuation can alter the decision. */
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

    const coverage = data.coverageMap.get(id);
    const has24hWindow = coverage?.has24hWindow === true;
    const knownNetFlow24h = agg?.netFlow ?? 0;
    const observedActivity = (agg?.mintCount ?? 0) > 0
      || (agg?.burnCount ?? 0) > 0
      || (agg?.mintVolume ?? 0) > 0
      || (agg?.burnVolume ?? 0) > 0;
    const has24hActivity = observedActivity ? true : has24hWindow ? false : null;
    const valuation24h = summarizeMintBurnValuation(agg?.valuation ?? emptyMintBurnValuationTally());
    // No baseline means no pressure input from it: vacuously complete.
    const baselineValuation = baseline?.valuation ?? "complete";
    const valuationAdmitsPressure = valuation24h.completeness === "complete" && baselineValuation !== "partial";
    const pressureShiftScore = has24hWindow && has24hActivity && baseline && valuationAdmitsPressure
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
      if (has24hWindow && has24hActivity && baseline && baseline.dataDays >= FLOW_INTENSITY_MIN_DATA_DAYS && !valuationAdmitsPressure) {
        partialValuationInputs += 1;
        partialValuationMcapUsd += mcap;
      }
    }

    if (gradeClassification) {
      const flow = { knownNetUsd: has24hWindow ? knownNetFlow24h : null, valuation: valuation24h };
      if (gradeClassification.safeIds.has(id)) {
        safeFlows.push(flow);
      } else if (gradeClassification.riskyIds.has(id)) {
        riskyFlows.push(flow);
      }
    }

    const largest = data.largestEventMap.get(id);
    if (!coverage) throw new Error(`Missing mint/burn coverage for ${id}`);
    const net7d = data.net7dMap.get(id);
    const net30d = data.net30dMap.get(id);
    const net90d = data.net90dMap.get(id);
    // Empty observed buckets are valuation-complete; scan completeness is independent.
    const net7dSummary = summarizeMintBurnValuation(net7d?.valuation ?? emptyMintBurnValuationTally());
    const net30dSummary = summarizeMintBurnValuation(net30d?.valuation ?? emptyMintBurnValuationTally());
    const net90dSummary = summarizeMintBurnValuation(net90d?.valuation ?? emptyMintBurnValuationTally());
    const net7dValuation = net7dSummary.completeness;
    const net30dValuation = net30dSummary.completeness;
    const net90dValuation = net90dSummary.completeness;
    // A withheld (partial) net publishes only its proven one-sided bound, never the known net itself.
    const windowBound = (window: WindowNetFlow | undefined, summary: MintBurnValuation, admitted: boolean) =>
      admitted && window && summary.completeness === "partial" ? mintBurnSignedNetBound(window.netUsd, summary) : null;
    coins.push({
      stablecoinId: id,
      symbol: config.symbol,
      pressureShiftScore,
      pressureShiftState: getPressureShiftState(pressureShiftScore),
      netFlowDirection24h: has24hWindow ? provenNetFlowDirection24h({
        knownNetUsd: knownNetFlow24h,
        has24hActivity: has24hActivity === true,
        valuation: valuation24h,
      }) : null,
      // PR-B readers use this null gate before reconstructing bounds from gross subtotals.
      has24hActivity: has24hWindow ? has24hActivity : null,
      observed24hActivity: observedActivity,
      baselineDailyNetUsd: baseline?.avgNet ?? null,
      baselineDailyAbsUsd: baseline?.avgAbs ?? null,
      baselineDataDays: baseline?.dataDays ?? null,
      gaugeWeightUsd: mcap,
      netFlow24hUsd: !has24hWindow || valuation24h.completeness === "partial" ? null : knownNetFlow24h,
      mintVolume24hUsd: agg?.mintVolume ?? 0,
      burnVolume24hUsd: agg?.burnVolume ?? 0,
      mintCount24h: agg?.mintCount ?? 0,
      burnCount24h: agg?.burnCount ?? 0,
      totalsSemantics: "observed-subtotals",
      netFlow7dUsd: !coverage.has7dWindow || net7dValuation === "partial" ? null : net7d?.netUsd ?? 0,
      netFlow30dUsd: !coverage.has30dWindow || net30dValuation === "partial" ? null : net30d?.netUsd ?? 0,
      netFlow90dUsd: !coverage.has90dWindow || net90dValuation === "partial" ? null : net90d?.netUsd ?? 0,
      largestEvent24h: largest && largest.amount_usd != null && (largest.direction === "mint" || largest.direction === "burn")
        ? { direction: largest.direction, amountUsd: largest.amount_usd, txHash: largest.tx_hash, timestamp: largest.timestamp }
        : null,
      coverage,
      valuation: {
        window24h: valuation24h,
        baseline: baselineValuation,
        netFlow7d: net7dValuation,
        netFlow30d: net30dValuation,
        netFlow90d: net90dValuation,
        netFlow7dBound: windowBound(net7d, net7dSummary, coverage.has7dWindow === true),
        netFlow30dBound: windowBound(net30d, net30dSummary, coverage.has30dWindow),
        netFlow90dBound: windowBound(net90d, net90dSummary, coverage.has90dWindow),
      },
    });
  }

  const flightToQuality = gradeClassification
    ? detectFlightToQualityFromValuedNets({ safe: safeFlows, risky: riskyFlows })
    : null;

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
