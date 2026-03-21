import { DEX_PRICE_OBSERVATION_MIN_TVL_USD } from "../../lib/constants";
import type { PriceValidationReferences } from "../../lib/price-validation";
import { isPlausibleDexObservationPrice } from "./price-sanity";
import type { DexPriceObs } from "./types";

export interface TokenBatchTrackedToken {
  chain: string;
  address: string;
  stablecoinId: string;
}

interface AppendTokenBatchPriceObservationsArgs<TToken> {
  priceObs: Map<string, DexPriceObs[]>;
  batch: TokenBatchTrackedToken[];
  tokens: TToken[];
  sourceLabel: string;
  references?: PriceValidationReferences;
  getAddress(token: TToken): string | null | undefined;
  getPriceUsd(token: TToken): number;
  getTvlUsd(token: TToken): number;
}

export function appendTokenBatchPriceObservations<TToken>({
  priceObs,
  batch,
  tokens,
  sourceLabel,
  references,
  getAddress,
  getPriceUsd,
  getTvlUsd,
}: AppendTokenBatchPriceObservationsArgs<TToken>): void {
  const trackedByAddress = new Map(
    batch.map((trackedToken) => [trackedToken.address.toLowerCase(), trackedToken]),
  );

  for (const token of tokens) {
    const tokenAddress = getAddress(token);
    if (!tokenAddress) continue;

    const trackedToken = trackedByAddress.get(tokenAddress.toLowerCase());
    if (!trackedToken) continue;

    const price = getPriceUsd(token);
    const tvl = getTvlUsd(token);

    if (!Number.isFinite(price) || price <= 0) continue;
    if (!Number.isFinite(tvl) || tvl < DEX_PRICE_OBSERVATION_MIN_TVL_USD) continue;
    if (!isPlausibleDexObservationPrice(trackedToken.stablecoinId, price, references)) continue;

    const existing = priceObs.get(trackedToken.stablecoinId) ?? [];
    existing.push({
      price,
      tvl,
      chain: trackedToken.chain,
      protocol: sourceLabel,
    });
    priceObs.set(trackedToken.stablecoinId, existing);
  }
}
