import { CIRCUIT_SOURCE } from "../constants";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import type { PriceCacheEntry } from "../price-cache";
import { classifyPrimaryDepegTrust } from "../depeg-trust-policy";
import { fetchEvmBlockNumber, fetchEvmBlockTimestamp, fetchEvmRpcBatch } from "../evm-rpc";
import { hasPublishableCurrentPrice } from "../price-publication-state";
import { getPublicFallbackRpcUrls } from "../public-rpc-registry";
import {
  encodeUint256,
  resolveTrustedOverrideParent,
  type CurrentPriceOverride,
  type LivePriceContext,
  type PriceSourceProvider,
} from "./helpers";

const USD3_ID = "usd3-reserve-protocol";
const SCRVUSD_ID = "scrvusd-curve";
const POOL = "0xe99810cd5adcd7b13455ae1be678b382d61f2d1e";
const USD3 = "0x0d86883faf4ffd7aeb116390af37746f45b6f378";
const SCRVUSD = "0x0655977feb2f289a4ab78af67bab0d17aab84367";
const SOURCE = "curve-thin-onchain";
const CHAIN = "ethereum";
const UNIT = 10n ** 18n;
const MIN_BALANCE = 1_000n * UNIT;
const MAX_AGE_SEC = 5 * 60;
const MAX_QUOTE_IMPACT_RATIO = 0.05;
// USD3 NAV accrues slowly; a 3% daily move needs evidence beyond this thin pool.
const MAX_NAV_DEVIATION_RATIO = 0.03;
const MAX_REFERENCE_AGE_SEC = 24 * 60 * 60;

export interface Usd3PriceContext extends LivePriceContext {
  previousAssetsById?: ReadonlyMap<string, PeggedAsset>;
  priceCache?: ReadonlyMap<string, PriceCacheEntry>;
}

/** Missing-only sell proceeds, bounded by an original-clock trusted USD3 reference. */
async function fetchUsd3CurvePoolPrice(
  context: Usd3PriceContext,
  signal?: AbortSignal,
): Promise<CurrentPriceOverride | null> {
  const reject = (reason: string): null => {
    context.lastRejectionReason = reason;
    return null;
  };
  const nowSec = Math.floor(Date.now() / 1000);
  const cached = context.priceCache?.get(USD3_ID);
  const references = [context.previousAssetsById?.get(USD3_ID), cached?.hasExplicitClocks === true && {
    price: cached.price, priceSource: cached.source, priceConfidence: cached.confidence,
    priceObservedAt: cached.observedAt, priceObservedAtMode: cached.observedAtMode,
    priceSyncedAt: cached.syncedAt, agreeSources: cached.agreeSources,
  }];
  let reference: { price: number; observedAt: number } | null = null;
  let referenceReason = cached && cached.hasExplicitClocks !== true ? "usd3-reference-clock-invalid" : "usd3-reference-missing";
  for (const previous of references) {
    if (!previous) continue;
    const observedAt = previous.priceObservedAt;
    const publishedAt = previous.priceSyncedAt;
    if (observedAt == null || publishedAt == null || !Number.isSafeInteger(observedAt) ||
      !Number.isSafeInteger(publishedAt) || observedAt <= 0 || observedAt > publishedAt || publishedAt > nowSec) {
      referenceReason = "usd3-reference-clock-invalid";
    } else if (nowSec - observedAt > MAX_REFERENCE_AGE_SEC) {
      referenceReason = "usd3-reference-stale";
    } else if (previous.priceSource === SOURCE || classifyPrimaryDepegTrust(previous, publishedAt) !== "authoritative") {
      referenceReason = "usd3-reference-untrusted";
    } else if (previous.price != null && (!reference || observedAt > reference.observedAt)) {
      reference = { price: previous.price, observedAt };
    }
  }
  if (!reference) return reject(referenceReason);

  const parent = resolveTrustedOverrideParent(context, SCRVUSD_ID,
    () => `[authoritative-price-sources] ${USD3_ID}: trusted scrvUSD quote dependency unavailable`,
    { allowFreshNonReplaySafeParent: true, allowFreshReplaySafeSingleSourceParent: true },
  );
  if (!parent || Math.floor(Date.now() / 1000) - parent.trustedParent.observedAt > MAX_AGE_SEC) return null;

  const options = { signal, chainRpcs: context.chainRpcs, extraRpcUrls: getPublicFallbackRpcUrls(CHAIN) };
  const block = await fetchEvmBlockNumber(CHAIN, options);
  if (block == null) return null;
  const timestamp = await fetchEvmBlockTimestamp(CHAIN, block, options);
  const now = Math.floor(Date.now() / 1000);
  if (timestamp == null || timestamp > now + 60 || now - timestamp > MAX_AGE_SEC) return null;

  // Direct calls share one block and one body-consumed RPC batch per lane.
  const calls = [
    `0xc6610657${encodeUint256(0)}`, // coins(uint256)
    `0xc6610657${encodeUint256(1)}`,
    `0x4903b0d1${encodeUint256(0)}`, // balances(uint256)
    `0x4903b0d1${encodeUint256(1)}`,
    ...[1n, 10n].map((amount) =>
      `0x5e0d443f${encodeUint256(0)}${encodeUint256(1)}${encodeUint256(amount * UNIT)}`), // get_dy(int128,int128,uint256)
  ];
  const results = await fetchEvmRpcBatch(CHAIN, calls.map((data) => ({
    method: "eth_call", params: [{ to: POOL, data }, `0x${block.toString(16)}`],
  })), options);
  if (!results || results.length !== calls.length || results.some((value) =>
    typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value))) return null;
  const [coin0, coin1, balance0, balance1, small, large] = results.map((value) => BigInt(value as string));
  if (coin0 !== BigInt(USD3) || coin1 !== BigInt(SCRVUSD)) return null;
  if (balance0 < MIN_BALANCE || balance1 < MIN_BALANCE || small <= 0n || large <= 0n) return null;
  const smallPrice = Number(small) / Number(UNIT);
  const largePrice = Number(large) / (10 * Number(UNIT));
  if (Math.abs(largePrice - smallPrice) / smallPrice > MAX_QUOTE_IMPACT_RATIO) return null;

  const observedAt = Math.min(timestamp, parent.trustedParent.observedAt);
  if (Math.floor(Date.now() / 1000) - observedAt > MAX_AGE_SEC) return null;
  const price = smallPrice * parent.trustedParent.price;
  if (!Number.isFinite(price) || price <= 0) return null;
  if (Math.floor(Date.now() / 1000) - reference.observedAt > MAX_REFERENCE_AGE_SEC) return reject("usd3-reference-stale");
  if (price < reference.price * (1 - MAX_NAV_DEVIATION_RATIO) || price > reference.price * (1 + MAX_NAV_DEVIATION_RATIO)) {
    return reject("usd3-nav-deviation");
  }
  return {
    price, source: SOURCE, confidence: "fallback", observedAt,
    observedAtMode: parent.trustedParent.observedAt < timestamp
      ? parent.trustedParent.observedAtMode ?? "upstream" : "upstream",
  };
}

export const usd3CurvePoolProvider: PriceSourceProvider = {
  source: SOURCE,
  liveMissingOnly: true,
  liveCircuitSource: CIRCUIT_SOURCE.USD3_CURVE_POOL,
  livePriority: 1,
  liveTimeoutMs: 6_000,
  liveParentByAssetId: { [USD3_ID]: SCRVUSD_ID },
  matches: (id) => id === USD3_ID,
  async fetchLivePrice(asset, context, signal) {
    return hasPublishableCurrentPrice(asset) ? null : fetchUsd3CurvePoolPrice(context, signal);
  },
};
