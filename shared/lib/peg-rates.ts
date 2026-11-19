import { FxReferenceEvidenceSchema, type FxReferenceEvidence } from "../types/fx-reference";
import type { StablecoinData } from "../types/supply";
import { getCommodityOuncesAtQuote, type CommodityQuoteUnit } from "./commodity-median";
import type { PegAssetBase } from "../types/price";
import type { ReferenceContributor, ReferenceAdmission } from "../types/reference-admission";
import type { StablecoinMeta } from "../types/stablecoin-meta-schemas";
import { normalizeLegacyPegType } from "./peg-price-bounds";
import { MIN_PEER_MEDIAN_CONTRIBUTORS } from "./peg-reference-trust";
import { getPegTaxonomyByType, PEG_TAXONOMY, pegTypeFromCurrency } from "./peg-taxonomy";
import { median } from "./stats";
import { getCirculatingRawOrNull } from "./supply";
import { isObservedPrice } from "./pricing-source-policy";
import { getPricingSourceRegistryEntry } from "./pricing-source-registry";
import { normalizePricingSourceKeys } from "./pricing-sources";
import { isClosureBullionContributor, REFERENCE_INTRADAY_BUDGET_SEC } from "./reference-admission";
import { getReferenceSessionState, type ReferenceSessionState } from "./reference-market-hours";
import { isRecord } from "./type-guards";

/**
 * Coins excluded from the commodity peer-median reference.
 * DGLD's CoinGecko price is ~2× gold spot (likely a data error), which
 * poisons the median used as peg reference for all gold tokens.
 */
export const COMMODITY_MEDIAN_EXCLUDES = new Set(["dgld-gold-token-sa"]);

export type PegRateSource = Exclude<ReferenceAdmission["kind"], "none">;

type PegRateAsset = PegAssetBase & Pick<StablecoinData, "commodityEntitlement" | "priceDerivation" | "parityQuoteUnit">;
type SelectedContributor = ReferenceContributor & { assetId?: string };
type LocalMedianRow = { price: number; contributor: ReferenceContributor & { assetId: string } };

type PegRateMeta = Pick<StablecoinMeta, "commodityOunces"> & {
  flags?: Partial<Pick<StablecoinMeta["flags"], "navToken" | "pegCurrency">>;
};

export interface PegRatesResult {
  rates: Record<string, number>;
  sources: Record<string, PegRateSource>;
  counts: Record<string, number>;
  observations?: Partial<Record<string, FxReferenceEvidence>>;
  contributors?: Partial<Record<string, readonly SelectedContributor[]>>;
}

export function normalizePegType(pegType: string | undefined): string | undefined {
  return pegType ? normalizeLegacyPegType(pegType) : undefined;
}

function normalizeFallbackRates(fallbackRates: Record<string, number> | undefined): Record<string, number> {
  const normalized: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [pegType, rate] of Object.entries(fallbackRates ?? {})) {
    const peg = normalizePegType(pegType);
    if (!peg || typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) continue;
    normalized[peg] = rate;
  }
  return normalized;
}

function addPegRateAliases(result: Required<PegRatesResult>): void {
  for (const entry of Object.values(PEG_TAXONOMY)) {
    const canonical = entry.canonicalPegType;
    if (!canonical || result.rates[canonical] == null) continue;
    for (const alias of entry.pegTypeAliases ?? []) {
      if (result.rates[alias] == null) result.rates[alias] = result.rates[canonical];
      if (result.sources[canonical] != null && result.sources[alias] == null) {
        result.sources[alias] = result.sources[canonical];
      }
      if (result.counts[canonical] != null && result.counts[alias] == null) {
        result.counts[alias] = result.counts[canonical];
      }
      result.observations[alias] = result.observations[canonical];
      result.contributors[alias] = result.contributors[canonical];
    }
  }
}

function isBullionPeg(peg: string): boolean {
  return peg === "peggedGOLD" || peg === "peggedSILVER";
}

function isEligibleBullionContributor(row: ReferenceContributor, session: ReferenceSessionState, now: number): boolean {
  const at = row.observedAtSec;
  if (at === null || !Number.isSafeInteger(at) || at <= 0 || at > now || now - at > REFERENCE_INTRADAY_BUDGET_SEC) return false;
  if (!session.open) return at >= session.closureStartSec && isClosureBullionContributor(row);
  return at > session.sessionOpenedAtSec &&
    (row.observedAtMode === "upstream" || (row.observedAtMode === undefined && row.derivation === "traded-market"));
}

function distinctAssetRows(rows: LocalMedianRow[]): LocalMedianRow[] {
  const byAsset = new Map<string, LocalMedianRow | null>();
  for (const row of rows) {
    const member = row.contributor;
    const prior = byAsset.get(member.assetId);
    if (prior === undefined) {
      byAsset.set(member.assetId, row);
    } else if (prior && (prior.price !== row.price || prior.contributor.observedAtSec !== member.observedAtSec ||
      prior.contributor.provenanceKey !== member.provenanceKey || prior.contributor.derivation !== member.derivation ||
      prior.contributor.observedAtMode !== member.observedAtMode)) {
      // Conflicting rows cannot establish one price and receipt for this asset.
      byAsset.set(member.assetId, null);
    }
  }
  return [...byAsset.values()].filter((row) => row !== null);
}

/** The selected price must measure the token in the same unit as parity. */
export function isParityPrice(asset: PegRateAsset): boolean {
  if (!isObservedPrice(asset)) return false;
  if (asset.id !== "xofm-mento" && asset.id !== "susd-solayer") return true;
  if (asset.id === "susd-solayer") {
    if (asset.parityQuoteUnit === undefined) return true;
    if (asset.parityQuoteUnit !== "accrued-token") return false;
  }
  if (!Number.isSafeInteger(asset.priceObservedAt) || (asset.priceObservedAt ?? 0) <= 0) return false;
  const selected = normalizePricingSourceKeys(asset.priceSource);
  const sources = selected.length === 1 && selected[0] === "cached"
    ? normalizePricingSourceKeys(asset.agreeSources?.length ? asset.agreeSources : asset.consensusSources)
    : selected;
  const valuationSource = asset.id === "xofm-mento" ? "mento-broker" : "protocol-redeem";
  return sources.length > 0 && sources.every((key) => {
    if (key === valuationSource) return false;
    const source = getPricingSourceRegistryEntry(key);
    return source && !source.isProtocolOverride && (source.trustTier === "hard_market"
      || source.trustTier === "soft_dex" || source.trustTier === "soft_aggregator");
  });
}

export function selectedFxMedianContributor(
  asset: PegRateAsset,
  observedAtSec = asset.priceObservedAt ?? null,
): ReferenceContributor & { assetId: string } {
  const sources = normalizePricingSourceKeys(asset.priceSource);
  const source = sources.length === 1 ? getPricingSourceRegistryEntry(sources[0]) : undefined;
  const family = source?.depegSourceFamily;
  return {
    assetId: asset.id,
    observedAtSec,
    ...(asset.priceObservedAt != null && asset.priceObservedAtMode ? { observedAtMode: asset.priceObservedAtMode } : {}),
    provenanceKey: family ?? asset.priceSource?.trim() ?? "",
    derivation: asset.priceDerivation?.navMethod || family?.endsWith("-nav") ? "nav"
      : source?.trustTier === "hard_oracle" || source?.key.endsWith("-oracle") ? "oracle"
      : !asset.priceDerivation && source?.trustTier === "hard_market" && family?.startsWith("market:")
        && source.supportsUpstreamObservedAt && asset.priceObservedAt != null && asset.priceObservedAtMode === "upstream"
        ? "traded-market" : "spot-derived",
  };
}

/**
 * Derive peg reference rates from the DefiLlama data itself.
 * For each pegType, compute the median price of coins with mcap > $1M.
 * This gives us live FX rates (e.g. peggedEUR -> ~1.19 USD).
 *
 * For gold-pegged tokens, prices are normalized to "per troy ounce" using
 * the commodityOunces field from StablecoinMeta, since some tokens represent
 * 1 gram (KAU) while others represent 1 troy ounce (XAUT, PAXG).
 *
 * @param fallbackRates  Optional live FX/commodity rates from sync-fx-rates.
 *                       Fiat rates are authoritative current references;
 *                       commodity rates remain fallbacks for thin groups.
 *
 * Returns a map of pegType -> USD value of 1 unit of the peg currency.
 */
export function derivePegRates(
  assets: PegRateAsset[],
  metaById?: ReadonlyMap<string, PegRateMeta>,
  fallbackRates?: Record<string, number>,
  fxReferenceObservations?: unknown,
  decisionAtSec = Math.floor(Date.now() / 1000),
  legacyBullionPegs?: readonly string[],
): PegRatesResult {
  const groups = new Map<string, LocalMedianRow[]>();
  const clocked = isRecord(fxReferenceObservations);
  const metalSession = clocked ? getReferenceSessionState("metal", decisionAtSec) : null;
  const fiatSession = clocked ? getReferenceSessionState("fx", decisionAtSec) : null;

  for (const asset of assets) {
    const meta = metaById?.get(asset.id);
    const flags = meta?.flags;
    if (flags?.navToken || flags?.pegCurrency === "OTHER" || flags?.pegCurrency === "VAR"
      || !isParityPrice(asset)) continue;
    const peg = normalizePegType(asset.pegType);
    const registryPeg = pegTypeFromCurrency(flags?.pegCurrency);
    if (registryPeg && peg !== registryPeg) continue;
    let price = asset.price;
    if (!peg || price == null || typeof price !== "number" || !Number.isFinite(price) || price <= 0) continue;

    // Only use coins with meaningful supply to avoid garbage data
    const supply = getCirculatingRawOrNull(asset);
    if (supply === null || supply < 1_000_000) continue;

    // For gold/silver tokens, normalize price to "per troy ounce"
    if (isBullionPeg(peg)) {
      if (COMMODITY_MEDIAN_EXCLUDES.has(asset.id)) continue;
      const oz = getCommodityOuncesAtQuote(meta?.commodityOunces, {
        assetId: asset.id, commodityEntitlement: asset.commodityEntitlement, quoteObservedAtSec: asset.priceObservedAt,
      });
      if (oz == null || !Number.isFinite(oz) || oz <= 0) continue;
      price /= oz;
    }

    if (!Number.isFinite(price)) continue;
    const rows = groups.get(peg) ?? [];
    rows.push({ price, contributor: selectedFxMedianContributor(asset) });
    groups.set(peg, rows);
  }

  // Use only live cached FX rates — no stale hardcoded defaults.
  // On fresh deploy before first FX sync, fallbackRates is undefined
  // and thin-group validation is skipped for one cycle.
  const mergedFallbacks = normalizeFallbackRates(fallbackRates);

  const rates: Record<string, number> = Object.create(null) as Record<string, number>;
  const sources: Record<string, PegRateSource> = Object.create(null) as Record<string, PegRateSource>;
  const counts: Record<string, number> = Object.create(null) as Record<string, number>;
  const observations: NonNullable<PegRatesResult["observations"]> = Object.create(null) as NonNullable<PegRatesResult["observations"]>;
  const contributors: NonNullable<PegRatesResult["contributors"]> = Object.create(null) as NonNullable<PegRatesResult["contributors"]>;
  const selectedObservations = new Map<string, FxReferenceEvidence>();
  if (clocked) {
    for (const [peg, raw] of Object.entries(fxReferenceObservations)) {
      if (getPegTaxonomyByType(peg)?.canonicalPegType !== peg) continue;
      const parsed = FxReferenceEvidenceSchema.safeParse(raw);
      if (!parsed.success || parsed.data.pegKey !== peg) continue;
      const observation = parsed.data;
      mergedFallbacks[peg] ??= observation.usdPerUnit;
      if (mergedFallbacks[peg] !== observation.usdPerUnit) continue;
      if (metalSession && isBullionPeg(peg) && observation.source === "peer-median") {
        // The producer's aggregate cannot be repriced from a partial list of receipts.
        const cohort = observation.contributors ?? [];
        if (cohort.length < MIN_PEER_MEDIAN_CONTRIBUTORS || (observation.publishedAtSec ?? 0) > decisionAtSec ||
          !cohort.every((member) => isEligibleBullionContributor(member, metalSession, decisionAtSec))) {
          delete mergedFallbacks[peg];
          continue;
        }
      }
      selectedObservations.set(peg, observation);
    }
  }
  for (const [peg, group] of groups) {
    const bullion = isBullionPeg(peg);
    const fallback = mergedFallbacks[peg];
    const producer = selectedObservations.get(peg);
    const clockedBullion = bullion && metalSession !== null && !legacyBullionPegs?.includes(peg);
    const clockedFiat = fiatSession !== null && !fallback && getPegTaxonomyByType(peg)?.pegClass === "fiat_fx";
    let rows = group;
    if (clockedBullion) {
      rows = distinctAssetRows(rows.filter(({ contributor }) => isEligibleBullionContributor(contributor, metalSession, decisionAtSec)));
    } else if (clockedFiat) {
      const earliest = Math.max(1, decisionAtSec - REFERENCE_INTRADAY_BUDGET_SEC,
        fiatSession.open ? fiatSession.sessionOpenedAtSec + 1 : fiatSession.closureStartSec);
      rows = distinctAssetRows(rows.filter(({ contributor: { observedAtSec: at, observedAtMode, provenanceKey } }) =>
        observedAtMode === "upstream" && provenanceKey !== "" && provenanceKey !== "cached" &&
        at !== null && Number.isSafeInteger(at) && at >= earliest && at <= decisionAtSec));
    }
    if (bullion && producer?.source === "peer-median") {
      rows = rows.filter(({ contributor }) => contributor.observedAtSec !== null && contributor.observedAtSec > producer.observedAtSec);
    }
    counts[peg] = rows.length;
    if ((clockedFiat || clockedBullion || (bullion && fallback)) && rows.length < MIN_PEER_MEDIAN_CONTRIBUTORS) continue;
    if (fallback && !bullion) continue;
    // Keep the scoring reference unrounded; display medians round at the API edge.
    rates[peg] = median(rows.map(({ price }) => price))!;
    sources[peg] = "median";
    contributors[peg] = rows.map(({ contributor }) => contributor);
  }

  for (const [peg, fallback] of Object.entries(mergedFallbacks)) {
    if (peg in rates) continue;
    rates[peg] = fallback;
    const observation = selectedObservations.get(peg);
    if (observation) observations[peg] = observation;
    if (observation?.source === "peer-median") {
      sources[peg] = "median";
      contributors[peg] = observation.contributors ?? [];
      counts[peg] = contributors[peg].length;
    } else {
      sources[peg] = isBullionPeg(peg) ? "fallback" : "fx";
      counts[peg] ??= 0;
    }
  }

  // Fallback: USD is always 1
  if (!rates["peggedUSD"]) rates["peggedUSD"] = 1;
  if (!sources["peggedUSD"]) sources["peggedUSD"] = "median";

  const result = { rates, sources, counts, observations, contributors };
  addPegRateAliases(result);
  return result;
}

/**
 * Get the expected USD price for a coin given its pegType and the derived rates.
 * Returns null when a non-USD reference is unavailable; USD remains fixed at 1.
 * For gold-pegged tokens, adjusts the per-ounce reference by commodityOunces
 * so that gram-denominated tokens get the correct per-gram reference.
 */
export function getPegReference(
  pegType: string | undefined,
  rates: Record<string, number>,
  commodityOunces?: number,
  unit?: CommodityQuoteUnit,
): number | null {
  if (!pegType) return null;
  const peg = normalizePegType(pegType);
  if (!peg) return null;
  if (peg === "peggedUSD") return 1;
  const rate = rates[peg];
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return null;
  // For gold/silver tokens, scale the per-ounce rate by the token's weight
  if (peg === "peggedGOLD" || peg === "peggedSILVER") {
    const ounces = getCommodityOuncesAtQuote(commodityOunces, unit);
    return ounces != null && ounces > 0 && Number.isFinite(ounces) ? rate * ounces : null;
  }
  return rate;
}
