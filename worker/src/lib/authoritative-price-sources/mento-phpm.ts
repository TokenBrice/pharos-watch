import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import { fetchEvmCallHexAtBlock } from "../evm-rpc";
import { getPublicFallbackRpcUrls } from "../public-rpc-registry";
import {
  decodeUint256WordBigInt,
  encodeAddress,
  encodeUint256,
  PROTOCOL_REDEEM_SOURCE,
  resolveTrustedOverrideParent,
  type CurrentPriceOverride,
  type LivePriceContext,
  type PriceSourceProvider,
} from "./helpers";

const PHPM_ID = "phpm-mento";
const USDM_ID = "cusd-celo";
const CELO_CHAIN = "celo";
const MENTO_BROKER = "0x777a8255ca72412f0d706dc03c9d1987306b4cad";
const MENTO_BIPOOL_MANAGER = "0x22d9db95e6ae61c104a7b6f6c78d7993b94ec901";
const PHPM_TOKEN = "0x105d4a9306d2e55a71d2eb95b81553ae1dc20d7b";
const USDM_TOKEN = "0x765de816845861e75a25fca122bb6898b8b1282a";
const PHPM_USDM_EXCHANGE_ID = "7952984d7278ca3417febf52815c321984ac3147ced2c02bb6a02b0bcab08413";
const GET_POOL_EXCHANGE_SELECTOR = "0x278488a4";
const BROKER_GET_AMOUNT_OUT_SELECTOR = "0xa20f2305";
const QUOTE_NOTIONAL_TOKENS = 1_000;
const TOKEN_DECIMALS = 18;
const MIN_COUNTER_CAPACITY = 1_000_000;

function decodeAddressWord(value: `0x${string}`, wordIndex: number): string | null {
  const start = 2 + wordIndex * 64;
  const end = start + 64;
  if (value.length < end) return null;
  return `0x${value.slice(end - 40, end)}`.toLowerCase();
}

function decimalFromRaw(value: bigint, decimals: number): number {
  const scale = 10n ** BigInt(decimals);
  return Number(value / scale) + Number(value % scale) / Number(scale);
}

function buildBrokerQuoteCall(inputRaw: bigint): string {
  return [
    BROKER_GET_AMOUNT_OUT_SELECTOR,
    encodeAddress(MENTO_BIPOOL_MANAGER),
    PHPM_USDM_EXCHANGE_ID,
    encodeAddress(PHPM_TOKEN),
    encodeAddress(USDM_TOKEN),
    encodeUint256(inputRaw),
  ].join("");
}

export async function fetchMentoPhpmPrice(
  context: LivePriceContext,
  signal?: AbortSignal,
): Promise<CurrentPriceOverride | null> {
  const usdMParent = resolveTrustedOverrideParent(
    context,
    USDM_ID,
    () => `[authoritative-price-sources] ${PHPM_ID}: trusted USDm quote dependency unavailable`,
    {
      allowFreshNonReplaySafeParent: true,
      allowFreshReplaySafeSingleSourceParent: true,
    },
  );
  if (!usdMParent) return null;

  const inputRaw = BigInt(QUOTE_NOTIONAL_TOKENS) * 10n ** BigInt(TOKEN_DECIMALS);
  const options = {
    signal,
    extraRpcUrls: getPublicFallbackRpcUrls(CELO_CHAIN),
  };
  const [poolRaw, quoteRaw] = await Promise.all([
    fetchEvmCallHexAtBlock(
      CELO_CHAIN,
      MENTO_BIPOOL_MANAGER,
      `${GET_POOL_EXCHANGE_SELECTOR}${PHPM_USDM_EXCHANGE_ID}`,
      "latest",
      options,
    ),
    fetchEvmCallHexAtBlock(
      CELO_CHAIN,
      MENTO_BROKER,
      buildBrokerQuoteCall(inputRaw),
      "latest",
      options,
    ),
  ]);
  if (!poolRaw || !quoteRaw) return null;

  const asset0 = decodeAddressWord(poolRaw, 0);
  const asset1 = decodeAddressWord(poolRaw, 1);
  const expectedAssets = new Set([PHPM_TOKEN, USDM_TOKEN]);
  if (!asset0 || !asset1 || !expectedAssets.has(asset0) || !expectedAssets.has(asset1) || asset0 === asset1) {
    return null;
  }

  const bucket0 = decodeUint256WordBigInt(poolRaw, 3);
  const bucket1 = decodeUint256WordBigInt(poolRaw, 4);
  const outputRaw = decodeUint256WordBigInt(quoteRaw, 0);
  if (bucket0 == null || bucket1 == null || outputRaw == null || outputRaw <= 0n) return null;

  const counterBucketRaw = asset0 === USDM_TOKEN ? bucket0 : bucket1;
  const counterCapacity = decimalFromRaw(counterBucketRaw, TOKEN_DECIMALS);
  if (!Number.isFinite(counterCapacity) || counterCapacity < MIN_COUNTER_CAPACITY) return null;

  const outputAmount = decimalFromRaw(outputRaw, TOKEN_DECIMALS);
  const price = (outputAmount / QUOTE_NOTIONAL_TOKENS) * usdMParent.trustedParent.price;
  if (!Number.isFinite(price) || price <= 0) return null;

  return {
    price,
    source: PROTOCOL_REDEEM_SOURCE,
    confidence: "high",
    observedAt: Math.floor(Date.now() / 1000),
    observedAtMode: "local_fetch",
  };
}

export const mentoPhpmProvider: PriceSourceProvider = {
  source: PROTOCOL_REDEEM_SOURCE,
  livePriority: 1,
  matches(stablecoinId: string): boolean {
    return stablecoinId === PHPM_ID;
  },
  async fetchLivePrice(
    _asset: PeggedAsset,
    context: LivePriceContext,
    signal?: AbortSignal,
  ): Promise<CurrentPriceOverride | null> {
    return fetchMentoPhpmPrice(context, signal);
  },
};
