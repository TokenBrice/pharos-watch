import { z } from "zod";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import { CIRCUIT_SOURCE } from "../constants";
import { fetchJsonWithRetry } from "../fetch-retry";
import { getRpcAuthHeaders, registryRpcUrls } from "../chain-registry";
import { throwIfAborted } from "../abort";
import {
  PROTOCOL_REDEEM_SOURCE,
  type CurrentPriceOverride,
  type LivePriceContext,
  type PriceSourceProvider,
} from "./helpers";

/**
 * Solayer sUSD (`susd-solayer`) is a Solana Token-2022 interest-bearing
 * stablecoin: balances accrue through the mint's `interestBearingConfig`
 * extension, and the accrued UI amount is the token's USD value. The market
 * lanes are unusable (DefiLlama list stopped pricing the asset, CoinGecko's
 * ticker is a stale thin-market print, and the only DEX pool sits far below
 * the $50K liquidity floors), so the executable price is the protocol's own
 * exchange rate: raw balance × exchange rate = accrued USD value, i.e. the
 * redemption conversion from raw sUSD into USD at par per accrued unit.
 */
const SUSD_SOLAYER_ID = "susd-solayer";
const SUSD_SOLAYER_MINT = "susdabGDNbhrnCa6ncrYo81u4s9GM8ecK2UwMyZiq4X";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SUSD_SOLAYER_DECIMALS = 6;

// SPL token-2022 interest-bearing accrual constant: a 365-day year in seconds.
const SPL_INTEREST_SECONDS_PER_YEAR = 31_536_000;

// Mirror the ERC-4626 NAV ratio bounds: an exchange rate outside this band is
// never published, so a compromised rate authority cannot stamp a wild NAV.
const SUSD_NAV_MIN_EXCHANGE_RATE = 0.5;
const SUSD_NAV_MAX_EXCHANGE_RATE = 10;

const SUSD_RPC_TIMEOUT_MS = 2_500;
const SUSD_MINT_RESPONSE_MAX_BYTES = 32_768;
const SUSD_BLOCK_TIME_MAX_BYTES = 4_096;
// Block-time freshness ceiling for the confirmed mint read (same window the
// USDv Jupiter route uses for its Solana slot evidence).
const SUSD_OBSERVATION_MAX_AGE_SEC = 5 * 60;
const SUSD_MAX_FUTURE_SKEW_SEC = 60;

export interface Token2022InterestBearingState {
  currentRateBps: number;
  initializationTimestampSec: number;
  lastUpdateTimestampSec: number;
  preUpdateAverageRateBps: number;
}

const InterestBearingStateSchema = z.object({
  currentRate: z.number().int().nonnegative(),
  initializationTimestamp: z.number().int().positive(),
  lastUpdateTimestamp: z.number().int().positive(),
  preUpdateAverageRate: z.number().int().nonnegative(),
  rateAuthority: z.string(),
});

const SolanaMintAccountSchema = z.object({
  context: z.object({ slot: z.number().int().positive() }),
  value: z.object({
    owner: z.string(),
    data: z.object({
      parsed: z.object({
        type: z.literal("mint"),
        info: z.object({
          decimals: z.number().int(),
          extensions: z.array(z.object({ extension: z.string(), state: z.unknown() })),
        }),
      }),
    }),
  }),
});

/**
 * Replicates the SPL token-2022 interest-bearing exchange rate exactly,
 * including the on-chain rounding of the average rate to whole basis points:
 * `exchange_rate = e^(average_rate × elapsed)` where the average rate is the
 * natural log of the two accrual segments (`preUpdateAverageRate` until the
 * last rate update, `currentRate` after it) rescaled to basis points.
 */
export function computeToken2022InterestBearingExchangeRate(
  state: Token2022InterestBearingState,
  atTimestampSec: number,
): number | null {
  const { currentRateBps, initializationTimestampSec, lastUpdateTimestampSec, preUpdateAverageRateBps } = state;
  if (!Number.isInteger(currentRateBps) || !Number.isInteger(preUpdateAverageRateBps)) return null;
  if (currentRateBps < 0 || preUpdateAverageRateBps < 0) return null;
  if (!Number.isInteger(atTimestampSec) || atTimestampSec <= 0) return null;
  if (initializationTimestampSec <= 0 || lastUpdateTimestampSec < initializationTimestampSec) return null;
  if (atTimestampSec < lastUpdateTimestampSec) return null;

  const preUpdateAccrual = Math.exp(
    (preUpdateAverageRateBps / 10_000) *
      ((lastUpdateTimestampSec - initializationTimestampSec) / SPL_INTEREST_SECONDS_PER_YEAR),
  );
  const currentAccrual = Math.exp(
    (currentRateBps / 10_000) *
      ((atTimestampSec - lastUpdateTimestampSec) / SPL_INTEREST_SECONDS_PER_YEAR),
  );
  const totalAccrual = preUpdateAccrual * currentAccrual;
  if (!Number.isFinite(totalAccrual) || totalAccrual <= 0) return null;

  const totalDeltaSec = atTimestampSec - initializationTimestampSec;
  const averageRateBps = Math.round(
    (Math.log(totalAccrual) * SPL_INTEREST_SECONDS_PER_YEAR) / totalDeltaSec * 10_000,
  );
  const exchangeRate = Math.exp(
    (averageRateBps / 10_000) * (totalDeltaSec / SPL_INTEREST_SECONDS_PER_YEAR),
  );
  return Number.isFinite(exchangeRate) && exchangeRate > 0 ? exchangeRate : null;
}

/**
 * Validates a `getAccountInfo` jsonParsed response for the pinned sUSD mint:
 * Token-2022 program ownership, mint type, 6 decimals, and a complete
 * interest-bearing config. Returns null on any drift so callers fail closed.
 */
export function parseSusdSolayerMintState(
  payload: unknown,
): { slot: number; interest: Token2022InterestBearingState } | null {
  const parsed = SolanaMintAccountSchema.safeParse(payload);
  if (!parsed.success) return null;
  const { context, value } = parsed.data;
  if (value.owner !== TOKEN_2022_PROGRAM) return null;
  if (value.data.parsed.info.decimals !== SUSD_SOLAYER_DECIMALS) return null;

  const extension = value.data.parsed.info.extensions.find(
    (entry) => entry.extension === "interestBearingConfig",
  );
  if (!extension) return null;

  const state = InterestBearingStateSchema.safeParse(extension.state);
  if (!state.success) return null;
  return {
    slot: context.slot,
    interest: {
      currentRateBps: state.data.currentRate,
      initializationTimestampSec: state.data.initializationTimestamp,
      lastUpdateTimestampSec: state.data.lastUpdateTimestamp,
      preUpdateAverageRateBps: state.data.preUpdateAverageRate,
    },
  };
}

export async function fetchSusdSolayerNavPrice(
  context: LivePriceContext,
  signal?: AbortSignal,
): Promise<CurrentPriceOverride | null> {
  const reject = (reason: string): null => {
    context.lastRejectionReason = `susd-nav:${reason}`;
    return null;
  };
  const configured = context.chainRpcs?.get("solana");
  const urls = [...new Set([...registryRpcUrls(configured), "https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"])];

  // Keep these reads serial with consumed bodies, preserving the cron trigger's
  // shared connection budget (docs/worker-and-api-limits.md).
  async function rpc<T>(method: string, params: unknown[], maxResponseBytes: number): Promise<T | null> {
    for (const url of urls) {
      throwIfAborted(signal);
      const result = await fetchJsonWithRetry<{ result?: T; error?: { code?: number } }>(
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...getRpcAuthHeaders(url) },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal,
        },
        0,
        { timeoutMs: SUSD_RPC_TIMEOUT_MS, maxResponseBytes },
      );
      if (result?.response.ok && !result.body.error && result.body.result != null) return result.body.result;
    }
    return null;
  }

  const mint = await rpc<unknown>(
    "getAccountInfo",
    [SUSD_SOLAYER_MINT, { encoding: "jsonParsed", commitment: "confirmed" }],
    SUSD_MINT_RESPONSE_MAX_BYTES,
  );
  const state = parseSusdSolayerMintState(mint);
  if (!state) return reject("mint-state");

  const blockTime = await rpc<number>("getBlockTime", [state.slot], SUSD_BLOCK_TIME_MAX_BYTES);
  if (blockTime == null || !Number.isInteger(blockTime) || blockTime <= 0) return reject("block-time");

  const nowSec = Math.floor(Date.now() / 1000);
  if (blockTime > nowSec + SUSD_MAX_FUTURE_SKEW_SEC) return reject("future-block");
  if (nowSec - blockTime > SUSD_OBSERVATION_MAX_AGE_SEC) return reject("stale-block");
  if (state.interest.lastUpdateTimestampSec > blockTime + SUSD_MAX_FUTURE_SKEW_SEC) return reject("rate-timestamp");

  const exchangeRate = computeToken2022InterestBearingExchangeRate(state.interest, blockTime);
  if (exchangeRate == null) return reject("rate-invalid");
  if (exchangeRate < SUSD_NAV_MIN_EXCHANGE_RATE || exchangeRate > SUSD_NAV_MAX_EXCHANGE_RATE) {
    return reject("rate-band");
  }

  return {
    price: exchangeRate,
    source: PROTOCOL_REDEEM_SOURCE,
    confidence: "high",
    observedAt: blockTime,
    observedAtMode: "upstream",
  };
}

export const susdSolayerNavProvider: PriceSourceProvider = {
  source: PROTOCOL_REDEEM_SOURCE,
  liveCircuitSource: CIRCUIT_SOURCE.SUSD_SOLAYER_NAV,
  livePriority: 1,
  // Two serial body-consumed Solana RPC reads (mint state + block time) must
  // fit inside the candidate deadline.
  liveTimeoutMs: 6_000,
  recordNullLiveResultAsCircuitFailure: true,
  matches(stablecoinId: string): boolean {
    return stablecoinId === SUSD_SOLAYER_ID;
  },
  async fetchLivePrice(
    _asset: PeggedAsset,
    context: LivePriceContext,
    signal?: AbortSignal,
  ): Promise<CurrentPriceOverride | null> {
    return fetchSusdSolayerNavPrice(context, signal);
  },
};
