import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { toErrorMessage } from "@shared/lib/error-utils";
import { DASHBOARD_SOURCE_MAX_AGE_SEC } from "@shared/types/live-reserve-adapter-policy";
import { fetchEvmBlockTimestamp } from "../../lib/evm-rpc";
import type { AdapterContext, AdapterResult } from "./types";
import { decodeAbiWordAt, decodeStrictBoolWord, decodeUint256Word } from "./abi-decode";
import { runAdapterIo } from "./concurrency";
import { pinnedBlockPlan } from "./evm-observation-plan";
import { fetchOnchainLogs, fetchOnchainMulticall3, fetchOnchainUint256 } from "./onchain";
import {
  fetchJsonPostWithRetry,
  freshnessMetadataFromTimestamp,
  parseTimestampLikeToUnixSeconds,
  reserveDegradedWarning,
  reserveInfoWarning,
  requireJsonInputFromConfig,
  slicesFromValues,
  summarizeSourceTimestamps,
} from "./helpers";

interface M0GraphQlResponse {
  data?: {
    minterGateway_totalCollateralSnapshots?: Array<{
      timestamp?: string | number;
      value?: string | number;
    }>;
    minterGateway_minters?: Array<{
      id?: string;
      collateral?: string | number;
    }>;
    collateralUpdateds?: Array<{
      timestamp?: string | number;
      blockTimestamp?: string | number;
    }>;
    minterGateway_latestUpdateTimestampSnapshots?: Array<{
      timestamp?: string | number;
      value?: string | number;
    }>;
  };
  errors?: Array<{ message?: string }>;
}

// M0's Protocol API retired the off-chain CollateralCurrent composition feed in
// 2026-08 (the resolver survives in the schema but returns the gateway 500
// envelope). The supported replacement is the on-chain-indexed Minter Gateway
// total: minterGateway_totalCollateralSnapshots. Composition (cash vs treasury
// split) is no longer observable through the API, so the adapter publishes one
// protocol-constrained slice; curated reserve evidence carries the detail.
const M0_TOTAL_COLLATERAL_QUERY = `
  query LiveReserveTotalCollateral {
    minterGateway_totalCollateralSnapshots(first: 1, orderBy: timestamp, orderDirection: desc) {
      timestamp
      value
    }
    minterGateway_minters {
      id
      collateral
    }
    collateralUpdateds(first: 1, orderBy: timestamp, orderDirection: desc) {
      timestamp
      blockTimestamp
    }
    minterGateway_latestUpdateTimestampSnapshots(first: 1, orderBy: timestamp, orderDirection: desc) {
      timestamp
      value
    }
  }
`;

// Minter Gateway collateral values are 6-decimal token units (observed
// 277097642539488 -> $277.10M against the M0 dashboard on 2026-08-20).
const M0_COLLATERAL_DECIMALS_DIVISOR = 1_000_000;

// The total snapshot and the per-minter rows are written at slightly different
// index times, so an exact match is not expected (observed skew ~4e-6 of the
// total). A divergence beyond this ratio means the snapshot no longer describes
// the minter set and operators should look at the upstream indexer.
const M0_MINTER_RECONCILIATION_WARN_RATIO = 0.005;

// The published value comes from the latest total-collateral snapshot; the
// collateral-update event stream routinely runs ahead of it by an indexing
// cadence of ~2h (observed 2026-08-20), and production lag reached 27,000s on
// 2026-09-09. The degrade cap is widened to 12h by decision P11 (2026-09-09),
// accepting the risk that a stalled total may be admitted for up to 12h. Only
// a lag beyond the cap indicates the total has stopped tracking known
// collateral updates.
const M0_SNAPSHOT_LAG_DEGRADE_SEC = 12 * 60 * 60;
const M0_TOTAL_COLLATERAL_SOURCE_KEY = "m0:eligible-collateral";

// --- On-chain fallback (decision 2026-09-24) ------------------------------
//
// When the keyed Protocol API snapshot is older than the adapter's source-age
// cap (the `DASHBOARD_VALIDATION` policy in the adapter declaration), publish
// the MinterGateway's current collateral instead of the stale indexer total.
//
// The approved-minter set cannot be enumerated on-chain: the TTG Registrar
// implements membership (`listContains(bytes32,address)`) over a mapping with
// no list accessor, and the gateway exposes only per-minter views plus events.
// The fallback therefore derives the minter set from the gateway's own
// `CollateralUpdated` events over a window bounded by the protocol's update
// interval. That is complete for the quantity published: `collateralOf()`
// returns 0 once `updateTimestamp + updateCollateralInterval()` has elapsed
// (expired collateral is zero by the protocol's own rule) and every
// `updateCollateral` call emits `CollateralUpdated`, so any minter still
// contributing collateral at the pinned block must have an event inside the
// last interval. A minter outside the window contributes exactly zero, a
// partial discovery fails closed, and the observation's freshness is the
// OLDEST contributing update timestamp rather than an invented clock.
const M0_ONCHAIN_CHAIN = "ethereum";
const M0_ONCHAIN_GATEWAY_ADDRESS = "0xf7f9638cb444D65e5A40bF5ff98ebE4ff319F04E";
// keccak256("CollateralUpdated(address,uint240,uint240,bytes32,uint40)")
const M0_ONCHAIN_COLLATERAL_UPDATED_TOPIC0 = "0x8c7a373ea6d1cedfcb77f0e5520921cc5d5a1a16b960c0c13c0f96b8dc24caa8";
const M0_ONCHAIN_SELECTORS = {
  updateCollateralInterval: "0xa29b67ce",
  collateralOf: "0x1aefb107",
  collateralUpdateTimestampOf: "0x7efb685b",
  isMinterApproved: "0xf7a31df6",
} as const;

// Mirrors the `m0` declaration's DASHBOARD_VALIDATION policy: the fallback runs
// exactly when the published indexer snapshot would trip `stale-source-data`
// (or carry no verified timestamp at all). Keep this in step with the
// declaration's validation tier.
const M0_INDEXER_SOURCE_MAX_AGE_SEC = DASHBOARD_SOURCE_MAX_AGE_SEC;

// Ethereum slots are >= 12 s post-merge, so a 2x-interval block window is a
// lower bound of 2x the interval in wall time. The start block's timestamp is
// still read and verified against the pinned block, and the window is widened
// (bounded) before the scan if the estimate does not cover one interval.
const M0_ONCHAIN_WINDOW_INTERVAL_MULTIPLIER = 2;
const M0_ONCHAIN_WINDOW_WIDENING_ATTEMPTS = 2;
const M0_ONCHAIN_PINNED_BLOCK_NOMINAL_SEC = 12;
const M0_ONCHAIN_MINTER_CAP = 32;
// Provider calls the bounded range split may spend on the window scan before it
// fails closed. One call covers the 18,000-block window on the measured
// endpoint; the budget admits a provider that caps ranges at 10,000 or 5,000.
const M0_ONCHAIN_LOG_SCAN_MAX_CALLS = 4;
const M0_ONCHAIN_SOURCE = "minter-gateway-collateral-updated-window";
const M0_ONCHAIN_WARNING_CODE = "m0-onchain-collateral-fallback";
const M0_ONCHAIN_UNAVAILABLE_WARNING_CODE = "m0-onchain-fallback-unavailable";

function parseNumericValue(value: string | number | undefined): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function adaptM0Collateral(payload: M0GraphQlResponse): AdapterResult {
  const snapshot = payload.data?.minterGateway_totalCollateralSnapshots?.[0];
  if (!snapshot) {
    throw new Error("M0 GraphQL response missing minterGateway_totalCollateralSnapshots");
  }

  const rawTotal = parseNumericValue(snapshot.value);
  if (rawTotal == null || rawTotal < 0) {
    throw new Error(`M0 total collateral snapshot value is not a usable number: ${String(snapshot.value)}`);
  }
  const totalUsd = rawTotal / M0_COLLATERAL_DECIMALS_DIVISOR;

  const warnings = [];

  const minterCollaterals = (payload.data?.minterGateway_minters ?? [])
    .map((minter) => parseNumericValue(minter.collateral))
    .filter((value): value is number => value != null);
  const minterCollateralTotalUsd = minterCollaterals.length > 0
    ? minterCollaterals.reduce((acc, value) => acc + value, 0) / M0_COLLATERAL_DECIMALS_DIVISOR
    : null;
  if (
    minterCollateralTotalUsd != null
    && totalUsd > 0
    && Math.abs(minterCollateralTotalUsd - totalUsd) / totalUsd > M0_MINTER_RECONCILIATION_WARN_RATIO
  ) {
    warnings.push(reserveDegradedWarning(
      "minter-collateral-reconciliation",
      `M0 per-minter collateral sum ($${minterCollateralTotalUsd.toFixed(0)}) diverges from the total collateral snapshot ($${totalUsd.toFixed(0)})`,
    ));
  }

  const snapshotTimestamp = parseTimestampLikeToUnixSeconds(snapshot.timestamp);
  const updateTimestampSummary = summarizeSourceTimestamps([
    payload.data?.collateralUpdateds?.[0]?.timestamp,
    payload.data?.collateralUpdateds?.[0]?.blockTimestamp,
    payload.data?.minterGateway_latestUpdateTimestampSnapshots?.[0]?.value,
    payload.data?.minterGateway_latestUpdateTimestampSnapshots?.[0]?.timestamp,
  ]);
  const snapshotLagSec = snapshotTimestamp != null && updateTimestampSummary != null
    ? Math.max(0, updateTimestampSummary.latestSourceTimestamp - snapshotTimestamp)
    : null;
  if (snapshotLagSec != null && snapshotLagSec > M0_SNAPSHOT_LAG_DEGRADE_SEC) {
    warnings.push(reserveDegradedWarning(
      "total-collateral-snapshot-lag",
      `M0 total collateral snapshot lags the latest collateral update by ${snapshotLagSec}s`,
    ));
  }

  const freshnessMetadata = freshnessMetadataFromTimestamp(
    snapshotTimestamp,
    "protocol-api-graphql",
    "M0 total collateral snapshot did not expose a parseable timestamp",
  );

  const slices = slicesFromValues([
    {
      sourceKey: M0_TOTAL_COLLATERAL_SOURCE_KEY,
      name: "U.S. Treasury bills & cash (M0 eligible collateral)",
      value: totalUsd,
      risk: "very-low",
    },
  ]);

  return {
    slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...freshnessMetadata,
      collateralValueDivisor: M0_COLLATERAL_DECIMALS_DIVISOR,
      normalizedReserveTotal: totalUsd,
      ...(minterCollateralTotalUsd != null
        ? {
            minterCount: minterCollaterals.length,
            minterCollateralTotalUsd,
          }
        : {}),
      ...(updateTimestampSummary != null
        ? {
            earliestCollateralUpdateTimestamp: updateTimestampSummary.sourceTimestamp,
            latestCollateralUpdateTimestamp: updateTimestampSummary.latestSourceTimestamp,
          }
        : {}),
      ...(snapshotLagSec != null ? { snapshotLagSec } : {}),
      details: {
        ...("details" in freshnessMetadata ? freshnessMetadata.details : {}),
        ...(snapshotLagSec != null ? { collateralLagSec: snapshotLagSec } : {}),
        collateralLagCapSec: M0_SNAPSHOT_LAG_DEGRADE_SEC,
      },
    },
  };
}

export interface M0OnchainMinterRead {
  minter: string;
  approved: boolean;
  collateralRaw: bigint;
  updatedAtSec: number;
}

export interface M0OnchainObservation {
  reads: readonly M0OnchainMinterRead[];
  discoveredMinterCount: number;
  updateCollateralIntervalSec: number;
  windowFromBlock: number;
  windowCoverageSec: number;
  observedBlock: { chain: string; number: number; timestamp: number };
}

/**
 * Turns a verified on-chain window observation into the adapter result.
 *
 * Fails closed (throws) rather than publishing a partial, zero, or unverifiable
 * observation: an unreadable row, an unapproved discovered minter, a window
 * that does not cover one update interval, a future or expired update
 * timestamp, or a window with no unexpired collateral are all "unavailable",
 * never evidence that collateral is zero.
 */
export function adaptM0OnchainCollateral(observation: M0OnchainObservation): AdapterResult {
  const {
    reads,
    discoveredMinterCount,
    updateCollateralIntervalSec,
    windowFromBlock,
    windowCoverageSec,
    observedBlock,
  } = observation;

  if (!Number.isSafeInteger(updateCollateralIntervalSec) || updateCollateralIntervalSec <= 0) {
    throw new Error(`M0 on-chain collateral interval is not a usable number: ${String(updateCollateralIntervalSec)}`);
  }
  if (discoveredMinterCount !== reads.length) {
    throw new Error(
      `M0 on-chain collateral window discovered ${discoveredMinterCount} minters but only ${reads.length} were read`,
    );
  }
  if (reads.length === 0) {
    throw new Error("M0 on-chain collateral window discovered no minters");
  }
  if (reads.length > M0_ONCHAIN_MINTER_CAP) {
    throw new Error(`M0 on-chain collateral window discovered ${reads.length} minters, above the ${M0_ONCHAIN_MINTER_CAP} cap`);
  }
  if (windowCoverageSec < updateCollateralIntervalSec) {
    throw new Error(
      `M0 on-chain collateral window covers ${windowCoverageSec}s, less than the ${updateCollateralIntervalSec}s update interval`,
    );
  }

  const unapproved = reads.filter((read) => !read.approved);
  if (unapproved.length > 0) {
    throw new Error(
      `M0 on-chain collateral window found ${unapproved.length} minter(s) that are not approved by the TTG Registrar: ${
        unapproved.map((read) => read.minter).join(", ")
      }`,
    );
  }

  const contributing = reads.filter((read) => read.collateralRaw > 0n);
  if (contributing.length === 0) {
    throw new Error(
      "M0 on-chain collateral window found no minter with unexpired collateral; expired attestations are not a zero reserve claim",
    );
  }
  for (const read of contributing) {
    if (read.collateralRaw < 0n || !Number.isSafeInteger(read.updatedAtSec) || read.updatedAtSec <= 0) {
      throw new Error(`M0 on-chain collateral row for minter ${read.minter} is malformed`);
    }
    if (read.updatedAtSec > observedBlock.timestamp) {
      throw new Error(`M0 minter ${read.minter} reports a future collateral update timestamp`);
    }
    if (read.updatedAtSec <= observedBlock.timestamp - updateCollateralIntervalSec) {
      throw new Error(
        `M0 minter ${read.minter} holds collateral outside the ${updateCollateralIntervalSec}s update interval`,
      );
    }
  }

  const totalRaw = contributing.reduce((acc, read) => acc + read.collateralRaw, 0n);
  const totalUsd = Number(totalRaw) / M0_COLLATERAL_DECIMALS_DIVISOR;
  if (!Number.isFinite(totalUsd) || totalUsd <= 0) {
    throw new Error(`M0 on-chain collateral total is not a usable number: ${String(totalRaw)}`);
  }
  const earliest = Math.min(...contributing.map((read) => read.updatedAtSec));
  const latest = Math.max(...contributing.map((read) => read.updatedAtSec));

  return {
    slices: slicesFromValues([
      {
        sourceKey: M0_TOTAL_COLLATERAL_SOURCE_KEY,
        name: "U.S. Treasury bills & cash (M0 eligible collateral)",
        value: totalUsd,
        risk: "very-low",
      },
    ]),
    metadata: {
      ...freshnessMetadataFromTimestamp(
        earliest,
        "onchain-minter-gateway",
        "M0 on-chain collateral timestamps were unreadable",
      ),
      collateralValueDivisor: M0_COLLATERAL_DECIMALS_DIVISOR,
      normalizedReserveTotal: totalUsd,
      minterCount: contributing.length,
      minterCollateralTotalUsd: totalUsd,
      earliestCollateralUpdateTimestamp: earliest,
      latestCollateralUpdateTimestamp: latest,
      observedBlock,
      details: {
        collateralSource: M0_ONCHAIN_SOURCE,
        // The fallback only runs when the indexer snapshot exceeds the adapter's
        // source-age cap or carries no verified timestamp; the warning message
        // carries the precise age.
        fallbackReason: "indexer-snapshot-stale",
        discoveredMinterCount,
        nonContributingMinterCount: reads.length - contributing.length,
        updateCollateralIntervalSec,
        collateralWindowFromBlock: windowFromBlock,
        collateralWindowToBlock: observedBlock.number,
        collateralWindowBlocks: observedBlock.number - windowFromBlock + 1,
        collateralWindowCoverageSec: windowCoverageSec,
      },
    },
  };
}

/**
 * Reads the MinterGateway's current collateral over the CollateralUpdated
 * window derived from the gateway's own `updateCollateralInterval()`. Every
 * network step uses the shared onchain-evm plumbing under the adapter I/O
 * limiter (one block pin, one interval read, one window-start header read, one
 * bounded log scan, one Multicall3 batch).
 */
async function fetchM0OnchainCollateral(
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
): Promise<AdapterResult> {
  const plan = await pinnedBlockPlan({ chain: M0_ONCHAIN_CHAIN, signal, ctx });
  const pinnedCtx = plan.ctx;
  const { observedBlock } = plan;

  const intervalRaw = await fetchOnchainUint256({
    contract: M0_ONCHAIN_GATEWAY_ADDRESS,
    data: M0_ONCHAIN_SELECTORS.updateCollateralInterval,
    signal,
    ctx: pinnedCtx,
    chain: M0_ONCHAIN_CHAIN,
    rpcMode: "public-rpc",
  });
  const intervalSec = intervalRaw == null ? null : Number(intervalRaw);
  if (intervalSec == null || !Number.isSafeInteger(intervalSec) || intervalSec <= 0) {
    throw new Error(`M0 updateCollateralInterval() is not a usable number: ${String(intervalRaw)}`);
  }

  const windowBlocks = Math.ceil(
    (intervalSec * M0_ONCHAIN_WINDOW_INTERVAL_MULTIPLIER) / M0_ONCHAIN_PINNED_BLOCK_NOMINAL_SEC,
  );
  const rpcOptions = { signal, chainRpcs: pinnedCtx.chainRpcs };
  let windowFromBlock = Math.max(0, observedBlock.number - windowBlocks);
  let windowFromTimestamp: number | null = null;
  for (let attempt = 0; attempt <= M0_ONCHAIN_WINDOW_WIDENING_ATTEMPTS; attempt++) {
    const attemptBlock = windowFromBlock;
    const timestamp = await runAdapterIo(pinnedCtx, `m0-window-start:${M0_ONCHAIN_CHAIN}`, () =>
      fetchEvmBlockTimestamp(M0_ONCHAIN_CHAIN, attemptBlock, rpcOptions),
    );
    if (timestamp == null) {
      throw new Error(`M0 on-chain window start block ${attemptBlock} has no readable timestamp`);
    }
    if (timestamp <= observedBlock.timestamp - intervalSec) {
      windowFromTimestamp = timestamp;
      break;
    }
    windowFromBlock = Math.max(0, attemptBlock - windowBlocks);
  }
  if (windowFromTimestamp == null) {
    throw new Error(
      `M0 CollateralUpdated window could not be proven to cover ${intervalSec}s before block ${observedBlock.number}`,
    );
  }

  const scan = await fetchOnchainLogs({
    chain: M0_ONCHAIN_CHAIN,
    contract: M0_ONCHAIN_GATEWAY_ADDRESS,
    topics: [M0_ONCHAIN_COLLATERAL_UPDATED_TOPIC0],
    fromBlock: windowFromBlock,
    toBlock: observedBlock.number,
    signal,
    ctx: pinnedCtx,
    maxCalls: M0_ONCHAIN_LOG_SCAN_MAX_CALLS,
  });
  if (!scan?.complete) {
    throw new Error(`M0 CollateralUpdated window scan is incomplete (${scan?.failureReason ?? "no scan result"})`);
  }
  const minterTopics = scan.logs.map((log) => log.topics[1] ?? "");
  for (const topic of minterTopics) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(topic)) {
      throw new Error(`M0 CollateralUpdated log carries a malformed minter topic: ${topic}`);
    }
  }
  const minters = [...new Set(minterTopics.map((topic) => `0x${topic.slice(26)}`.toLowerCase()))].sort();
  if (minters.length === 0) throw new Error("M0 CollateralUpdated window returned no minter updates");
  if (minters.length > M0_ONCHAIN_MINTER_CAP) {
    throw new Error(`M0 on-chain window discovered ${minters.length} minters, above the ${M0_ONCHAIN_MINTER_CAP} cap`);
  }

  const calls = minters.flatMap((minter) => {
    const argument = minter.slice(2).padStart(64, "0");
    return [
      { label: `approved:${minter}`, contract: M0_ONCHAIN_GATEWAY_ADDRESS, data: M0_ONCHAIN_SELECTORS.isMinterApproved + argument },
      { label: `collateral:${minter}`, contract: M0_ONCHAIN_GATEWAY_ADDRESS, data: M0_ONCHAIN_SELECTORS.collateralOf + argument },
      { label: `updated:${minter}`, contract: M0_ONCHAIN_GATEWAY_ADDRESS, data: M0_ONCHAIN_SELECTORS.collateralUpdateTimestampOf + argument },
    ];
  });
  const results = await fetchOnchainMulticall3({ calls, signal, ctx: pinnedCtx, chain: M0_ONCHAIN_CHAIN });
  if (!results) throw new Error("M0 on-chain collateral Multicall3 batch failed");

  const byLabel = new Map(results.map((result) => [result.label, result]));
  const reads = minters.map((minter) => {
    const approvedResult = byLabel.get(`approved:${minter}`);
    const collateralResult = byLabel.get(`collateral:${minter}`);
    const updatedResult = byLabel.get(`updated:${minter}`);
    if (!approvedResult?.success || !collateralResult?.success || !updatedResult?.success) {
      throw new Error(`M0 on-chain collateral batch has an unreadable row for minter ${minter}`);
    }
    const approved = decodeStrictBoolWord(approvedResult.returnData);
    const collateralRaw = decodeUint256Word(decodeAbiWordAt(collateralResult.returnData, 0));
    const updatedRaw = decodeUint256Word(decodeAbiWordAt(updatedResult.returnData, 0));
    if (approved == null || collateralRaw == null || updatedRaw == null) {
      throw new Error(`M0 on-chain collateral row for minter ${minter} is malformed`);
    }
    return { minter, approved, collateralRaw, updatedAtSec: Number(updatedRaw) };
  });

  return adaptM0OnchainCollateral({
    reads,
    discoveredMinterCount: minters.length,
    updateCollateralIntervalSec: intervalSec,
    windowFromBlock,
    windowCoverageSec: observedBlock.timestamp - windowFromTimestamp,
    observedBlock,
  });
}

export async function fetchM0Reserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const apiKey = ctx?.m0ApiKey?.trim();
  if (!apiKey) {
    throw new Error("M0_API_KEY not configured; the M0 Protocol API requires keyed access");
  }
  const primaryInput = requireJsonInputFromConfig(config, "m0");
  const payload = await fetchJsonPostWithRetry<M0GraphQlResponse>(
    primaryInput.url,
    { query: M0_TOTAL_COLLATERAL_QUERY },
    signal,
    12_000,
    ctx,
    { headers: { Authorization: `ApiKey ${apiKey}` } },
  );
  if (payload.errors?.length) {
    const message = payload.errors.map((error) => error.message).filter(Boolean).join("; ");
    throw new Error(message || "M0 GraphQL returned errors");
  }

  const indexerResult = adaptM0Collateral(payload);
  const nowSec = ctx?.nowSec ?? Math.floor(Date.now() / 1000);
  const indexerSourceTimestamp = indexerResult.metadata?.sourceTimestamp;
  const indexerAgeSec = typeof indexerSourceTimestamp === "number" && Number.isFinite(indexerSourceTimestamp)
    ? nowSec - indexerSourceTimestamp
    : null;
  if (indexerAgeSec != null && indexerAgeSec <= M0_INDEXER_SOURCE_MAX_AGE_SEC) return indexerResult;

  const staleReason = indexerAgeSec == null
    ? `has no verified timestamp (source-age cap ${M0_INDEXER_SOURCE_MAX_AGE_SEC}s)`
    : `is ${indexerAgeSec}s old (source-age cap ${M0_INDEXER_SOURCE_MAX_AGE_SEC}s)`;
  try {
    const onchainResult = await fetchM0OnchainCollateral(signal, ctx);
    return {
      ...onchainResult,
      warnings: [
        ...(onchainResult.warnings ?? []),
        reserveInfoWarning(
          M0_ONCHAIN_WARNING_CODE,
          `M0 indexer snapshot ${staleReason}; published on-chain MinterGateway collateral instead`,
        ),
      ],
    };
  } catch (error) {
    const message = toErrorMessage(error);
    const truncated = message.length > 200 ? `${message.slice(0, 200)}…` : message;
    return {
      ...indexerResult,
      warnings: [
        ...(indexerResult.warnings ?? []),
        reserveInfoWarning(
          M0_ONCHAIN_UNAVAILABLE_WARNING_CODE,
          `M0 indexer snapshot ${staleReason} and the on-chain collateral fallback is unavailable: ${truncated}`,
        ),
      ],
    };
  }
}
