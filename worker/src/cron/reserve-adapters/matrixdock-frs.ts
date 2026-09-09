import { z } from "zod";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { DECIMALS_SELECTOR, LATEST_ROUND_DATA_SELECTOR, TOTAL_SUPPLY_SELECTOR } from "../../lib/evm-selectors";
import { requireChainlinkLatestRoundData } from "../../lib/chainlink-round-data";
import type { AdapterContext, AdapterResult } from "./types";
import { decodeUint256Word } from "./abi-decode";
import { pinnedBlockPlan } from "./evm-observation-plan";
import {
  buildCoverageShortfallWarnings,
  decimalNumberFromBigInt,
  fetchJsonPostWithRetry,
  fetchOnchainMulticall3,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
  reserveDegradedWarning,
} from "./helpers";

const ADAPTER_KEY = "matrixdock-frs";
const SILVER_SOURCE_KEY = "matrixdock-frs:silver";

// The FallbackReserveFeed answer is fine troy-oz with the MToken's 9 decimals;
// ozPerToken() converts oz to token units. Matrixdock maintains
// totalSupply == totalReserves / ozPerToken, so this constant pins the answer
// unit: a grains/grams/scaled-unit feed would diverge far beyond this share.
const UNIT_PIN_TOLERANCE_PCT = 0.5;
const EXPECTED_DECIMALS = 9;
const MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC = 600;

const OZ_PER_TOKEN_SELECTOR = "0x73b16bc7"; // ozPerToken()
const SUI_GRAPHQL_ENDPOINT = "https://graphql.mainnet.sui.io/graphql";

const SuiCoinMetadataResponseSchema = z.object({
  checkpoint: z.object({
    sequenceNumber: z.number().int().nonnegative().safe(),
    timestamp: z.string().datetime(),
  }),
  coinMetadata: z.object({
    decimals: z.number().int().nonnegative(),
    supply: z.string(),
    symbol: z.string(),
  }).nullable(),
});

interface MatrixdockFrsParams {
  label: string;
  risk: ReserveSlice["risk"];
  feedAddress: string;
  tokenAddress: string;
  suiCoinType: string;
  rpcUrl?: string;
  fallbackRpcUrl?: string;
}

interface MatrixdockFrsState {
  reserveRaw: bigint;
  feedDecimals: number;
  roundId: bigint;
  feedUpdatedAt: number;
  ethSupplyRaw: bigint;
  ozPerTokenRaw: bigint;
  tokenDecimals: number;
  suiSupplyRaw: bigint;
  suiDecimals: number;
  suiCheckpoint: number;
  suiCheckpointTimestamp: number;
  observedBlock: { chain: string; number: number; timestamp: number };
  nowSec: number;
}

function readParams(config: LiveReservesConfig): MatrixdockFrsParams {
  return parseLiveReserveAdapterParams(ADAPTER_KEY, config.params);
}

/** Bounded single-query read of a Sui coin's total supply plus the latest
 *  checkpoint, used to aggregate XAGm supply across its Ethereum and Sui legs. */
async function fetchSuiCoinSupply(
  coinType: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<{ supplyRaw: bigint; decimals: number; checkpoint: number; checkpointTimestamp: number }> {
  const query = `query($coinType: String!) {
    checkpoint { sequenceNumber timestamp }
    coinMetadata(coinType: $coinType) { decimals supply symbol }
  }`;
  const result = await fetchJsonPostWithRetry<{ data?: unknown; errors?: unknown[] }>(
    SUI_GRAPHQL_ENDPOINT,
    { query, variables: { coinType } },
    signal,
    10_000,
    ctx,
    { maxRetries: 0, maxResponseBytes: 2 * 1024 * 1024 },
  );
  if (result.errors?.length || !result.data) {
    throw new Error(`${ADAPTER_KEY}: Sui GraphQL error: ${JSON.stringify(result.errors)}`);
  }
  const parsed = SuiCoinMetadataResponseSchema.safeParse(result.data);
  if (!parsed.success) {
    throw new Error(`${ADAPTER_KEY}: Sui coinMetadata response failed schema validation`);
  }
  const { checkpoint, coinMetadata } = parsed.data;
  if (coinMetadata == null) {
    throw new Error(`${ADAPTER_KEY}: Sui coinMetadata returned no metadata for ${coinType}`);
  }
  let supplyRaw: bigint;
  try {
    supplyRaw = BigInt(coinMetadata.supply);
  } catch {
    throw new Error(`${ADAPTER_KEY}: Sui coinMetadata supply is not an integer string`);
  }
  return {
    supplyRaw,
    decimals: coinMetadata.decimals,
    checkpoint: checkpoint.sequenceNumber,
    checkpointTimestamp: Date.parse(checkpoint.timestamp) / 1000,
  };
}

export function adaptMatrixdockFrsState(state: MatrixdockFrsState, params: MatrixdockFrsParams): AdapterResult {
  const warnings: LiveReserveWarning[] = [];

  // ── Feed freshness sanity (the read itself is latest-state; the round
  //    timestamp is surfaced as diagnostics rather than a verified age gate). ─
  if (state.feedUpdatedAt > state.nowSec + MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC) {
    throw new Error(`${ADAPTER_KEY}: feed round timestamp is in the future (${state.feedUpdatedAt - state.nowSec}s)`);
  }

  if (state.feedDecimals !== EXPECTED_DECIMALS || state.tokenDecimals !== EXPECTED_DECIMALS) {
    throw new Error(`${ADAPTER_KEY}: unexpected decimals (feed ${state.feedDecimals}, token ${state.tokenDecimals})`);
  }

  const reserveOz = decimalNumberFromBigInt(state.reserveRaw, state.feedDecimals);
  const ethSupply = decimalNumberFromBigInt(state.ethSupplyRaw, state.tokenDecimals);
  const suiSupply = decimalNumberFromBigInt(state.suiSupplyRaw, state.suiDecimals);
  const ozPerToken = decimalNumberFromBigInt(state.ozPerTokenRaw, state.tokenDecimals);

  if (!Number.isFinite(reserveOz) || reserveOz <= 0) {
    throw new Error(`${ADAPTER_KEY}: reserve feed answer is not a finite positive oz quantity`);
  }
  if (!Number.isFinite(ozPerToken) || ozPerToken <= 0) {
    throw new Error(`${ADAPTER_KEY}: ozPerToken is not a finite positive value`);
  }
  if (!Number.isFinite(ethSupply) || ethSupply < 0 || !Number.isFinite(suiSupply) || suiSupply < 0) {
    throw new Error(`${ADAPTER_KEY}: token supply is not a finite non-negative value`);
  }

  const totalSupply = ethSupply + suiSupply;
  if (totalSupply <= 0) {
    throw new Error(`${ADAPTER_KEY}: summed Ethereum + Sui supply is not positive`);
  }

  // ── Unit pin: reserve oz / ozPerToken must reproduce the measured supply. ─
  const derivedSupply = reserveOz / ozPerToken;
  const unitDivergencePct = Math.abs(derivedSupply - totalSupply) / totalSupply * 100;
  if (unitDivergencePct > UNIT_PIN_TOLERANCE_PCT) {
    warnings.push(reserveDegradedWarning(
      "reserve-unit-mismatch",
      `${ADAPTER_KEY}: reserve/ozPerToken implies ${derivedSupply} tokens but ${totalSupply} are minted (${unitDivergencePct.toFixed(2)}% divergence)`,
    ));
  }

  // Silver coverage of the token's one-troy-oz claim (ozPerToken drifts slightly
  // below one ounce, so the ratio reads just under 1.0 without being material).
  const collateralizationRatio = reserveOz / totalSupply;
  const coverageWarnings = buildCoverageShortfallWarnings({
    code: "reserve-undercollateralized",
    message: (pct) => `Matrixdock XAGm reserve covers ${pct}% of token supply in fine silver oz`,
    coverageRatio: collateralizationRatio,
  });
  warnings.push(...coverageWarnings);

  const slices: ReserveSlice[] = [{
    sourceKey: SILVER_SOURCE_KEY,
    name: params.label,
    pct: 100,
    risk: params.risk,
  }];

  return {
    slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...notApplicableFreshnessMetadata(),
      observedBlock: state.observedBlock,
      totalReserveQuantity: reserveOz,
      supplyTokens: totalSupply,
      collateralizationRatio,
      details: {
        proofKind: "matrixdock-frs-fallback-reserve-feed",
        reserveUnit: "troy-oz",
        reserveOz,
        ozPerToken,
        ethereumSupply: ethSupply,
        suiSupply,
        suiCoinType: params.suiCoinType,
        suiCheckpoint: state.suiCheckpoint,
        suiCheckpointTimestamp: state.suiCheckpointTimestamp,
        feedAddress: params.feedAddress,
        tokenAddress: params.tokenAddress,
        feedRoundId: state.roundId.toString(),
        feedUpdatedAt: state.feedUpdatedAt,
        unitDivergencePct,
      },
    },
  };
}

export async function fetchMatrixdockFrsReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, ADAPTER_KEY);
  const params = readParams(config);
  const nowSec = ctx?.nowSec ?? Math.floor(Date.now() / 1_000);

  const plan = await pinnedBlockPlan({
    chain: input.chain,
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
  });

  const feedReads = await fetchOnchainMulticall3({
    calls: [
      { label: "feed-round", contract: params.feedAddress, data: LATEST_ROUND_DATA_SELECTOR },
      { label: "feed-decimals", contract: params.feedAddress, data: DECIMALS_SELECTOR },
      { label: "token-supply", contract: params.tokenAddress, data: TOTAL_SUPPLY_SELECTOR },
      { label: "token-oz-per-token", contract: params.tokenAddress, data: OZ_PER_TOKEN_SELECTOR },
      { label: "token-decimals", contract: params.tokenAddress, data: DECIMALS_SELECTOR },
    ],
    chain: input.chain,
    signal,
    ctx: plan.ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
  });
  const resultData = (label: string) => {
    const result = feedReads?.find((entry) => entry.label === label);
    return result?.success ? result.returnData : null;
  };

  const rawRoundData = resultData("feed-round");
  if (rawRoundData == null) {
    throw new Error(`${ADAPTER_KEY}: latestRoundData() call failed`);
  }
  const { roundId, answer, updatedAt } = requireChainlinkLatestRoundData(rawRoundData, ADAPTER_KEY);

  const rawFeedDecimals = decodeUint256Word(resultData("feed-decimals"));
  const rawTokenDecimals = decodeUint256Word(resultData("token-decimals"));
  const rawSupply = decodeUint256Word(resultData("token-supply"));
  const rawOzPerToken = decodeUint256Word(resultData("token-oz-per-token"));
  if (rawFeedDecimals == null || rawTokenDecimals == null || rawSupply == null || rawOzPerToken == null) {
    throw new Error(`${ADAPTER_KEY}: one or more on-chain reserve reads failed`);
  }

  const sui = await fetchSuiCoinSupply(params.suiCoinType, signal, ctx);

  return adaptMatrixdockFrsState({
    reserveRaw: answer,
    feedDecimals: Number(rawFeedDecimals),
    roundId,
    feedUpdatedAt: updatedAt,
    ethSupplyRaw: rawSupply,
    ozPerTokenRaw: rawOzPerToken,
    tokenDecimals: Number(rawTokenDecimals),
    suiSupplyRaw: sui.supplyRaw,
    suiDecimals: sui.decimals,
    suiCheckpoint: sui.checkpoint,
    suiCheckpointTimestamp: sui.checkpointTimestamp,
    observedBlock: plan.observedBlock,
    nowSec,
  }, params);
}
