import { getCommodityOuncesAtQuote } from "@shared/lib/commodity-median";
import { DEPEG_EVENT_MIN_SUPPLY_USD, DEPEG_PRIMARY_PRICE_MAX_AGE_SEC, DEPEG_SEVERITY_BPS } from "@shared/lib/depeg-config";
import { COMMODITY_MEDIAN_EXCLUDES, derivePegRates, getPegReference, isParityPrice, normalizePegType, type PegRatesResult, type PegRateSource } from "@shared/lib/peg-rates";
import { computePeerRelativeDeviation, type PeerRelativeQuote } from "@shared/lib/peer-relative-deviation";
import { getPegTaxonomyByType, pegTypeFromCurrency } from "@shared/lib/peg-taxonomy";
import { getLegacyReferenceClosureStart, getReferenceMarket, getReferenceSessionState, isReferenceMarketClosed, type ReferenceMarket } from "@shared/lib/reference-market-hours";
import { admittedDeviationBps, evaluateReferenceAdmission, getClosureBenchmarkBandBps, REFERENCE_INTRADAY_BUDGET_SEC, type ReferenceAdmissionInput } from "@shared/lib/reference-admission";
import { HOUR_SECONDS } from "@shared/lib/time-constants";
import { classifyDirectionalSignal, deriveDepegSignal, signalCrossesThreshold, type DepegSignal } from "@shared/lib/depeg-signals";
import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import { REVIEWED_COINGECKO_KRAKEN_MIRRORS } from "@shared/lib/pricing-provider-config";
import { getPrimaryTrustSources } from "@shared/lib/depeg-primary-trust";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { FxReferenceObservationSchema } from "@shared/types/fx-reference";
import { asRawDeviationBps, type ReferenceAdmission, type ReferenceContributor } from "@shared/types/reference-admission";
import type { PegAssetBase } from "@shared/types/price";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import { getDepegRecoveryThresholdBps } from "../../lib/depeg-threshold-policy";
import { COINGECKO_NATIVE_IMPLIED_SOURCE } from "../../lib/native-peg-implied-prices";
import { hasVerifiedLegacyRate, loadFxRateState, type FxRateState, type LegacyFxRepricingByPeg } from "../../lib/fx-rate-state";
import type { NativePegQuote } from "../../lib/native-peg-quotes";
import { classifyNativeQuoteImplausibility } from "../../lib/native-quote-plausibility";
import { dexPoolIndependentGroupKey, dexProtocolGroupKey, readDexPriceLineage } from "../../lib/depeg-helpers";
import { isFreshDexPoolObservation, resolveDepegSourceFamily } from "../../lib/depeg-trust-policy";
import { divergingProtocolGroupsOutvote, POOL_CHALLENGE_HIGH_TVL_USD } from "../../lib/price-depeg-voting-policy";
import { median } from "@shared/lib/stats";
import { selectIndependentChallengerPools } from "../dex-liquidity/price-lineage";
import type { DepegPricingAsset, DexPoolChallenger } from "./types";

type ReferenceGroup = { peers: PeerRelativeQuote[]; contributors: ReferenceContributor[]; prices: number[] };
export interface DetectionReferenceContext {
  /** Enable only after every supported rollback Worker reads peer-relative event and pending bases. */
  rollbackSupportsPeerEvents?: boolean;
  generation?: string;
  selected?: Pick<PegRatesResult, "observations" | "contributors">;
  groups: Map<string, ReferenceGroup>;
  fxState: FxRateState | null;
  repricing?: RepricingByPeg;
}

// The confirmer also accepts the original rates object while callers migrate to the explicit run context.
const runContext = Symbol("depeg-reference-run");
type DetectionRates = Record<string, number> & { [runContext]?: DetectionReferenceContext };

export function canPersistPeerEvents(input: { pegRates: DetectionRates; referenceContext?: DetectionReferenceContext }): boolean {
  return (input.referenceContext ?? input.pegRates[runContext])?.rollbackSupportsPeerEvents === true;
}

export type RepricingByPeg = LegacyFxRepricingByPeg;

/** These two selected marks measure sale proceeds or accrued value per raw token, respectively. */
export function hasIncompatibleParityPrice(asset: PegAssetBase): boolean {
  return !isParityPrice(asset);
}

export function sourceObservationClock(asset: PegAssetBase | undefined): number | null {
  const clock = asset?.priceObservedAt;
  return asset?.priceObservedAtMode === "upstream" && Number.isSafeInteger(clock) && clock! > 0 &&
    asset.priceSource !== "cached" ? clock! : null;
}

export function observationPegMeta(asset: DepegPricingAsset, meta: StablecoinMeta | undefined) {
  if (!meta || asset.id !== "xagm-matrixdock") return meta;
  const receipt = asset.commodityEntitlement;
  const quoteObservedAtSec = sourceObservationClock(asset);
  const ounces = getCommodityOuncesAtQuote(meta.commodityOunces, {
    assetId: asset.id, commodityEntitlement: receipt, quoteObservedAtSec,
  });
  return ounces == null ? undefined : { ...meta, commodityOunces: ounces };
}

export function independentPrimaryTrustInput(asset: PegAssetBase): PegAssetBase {
  if (!REVIEWED_COINGECKO_KRAKEN_MIRRORS.has(asset.id)) return asset;
  const sources = getPrimaryTrustSources(asset);
  if (!sources.includes("kraken") || !sources.includes("coingecko")) return asset;
  const agreeSources = sources.filter((source) => source !== "coingecko");
  return { ...asset, agreeSources, priceConfidence: asset.priceConfidence === "high" && agreeSources.length === 1
    ? "single-source" : asset.priceConfidence };
}

export function primaryVenueKeys(asset: PegAssetBase): Set<string> | null {
  const sources = [...getPrimaryTrustSources(asset), ...(asset.priceSource?.split("+") ?? [])];
  const keys = new Set(sources.map((source) => independenceKey(source, asset.id)));
  if (keys.has("") || !keys.size) return null;
  const upstream = readDexPriceLineage(asset).upstreamKeys;
  if (upstream) for (const key of upstream) if (key.startsWith("venue:")) keys.add(independenceKey(key.slice(6), asset.id));
  if (["aggregate", "pool-tvl-weighted", "dex-promoted"].some((key) => keys.has(key))) {
    if (!upstream?.length) return null;
  }
  return keys;
}

export function isIndependentVenue(asset: PegAssetBase | undefined, ...identities: Array<string | undefined>): boolean {
  if (!identities.some((identity) => independenceKey(identity))) return false;
  if (!asset) return true;
  const used = primaryVenueKeys(asset);
  return used != null && !identities.some((identity) => used.has(independenceKey(identity, asset.id)));
}

export function isIndependentDexObservation(asset: PegAssetBase | undefined, sample: {
  protocol?: string; sourceFamily?: string; upstreamKeys?: readonly string[]; pricePoolKeys?: readonly string[];
}, excludedVenue?: string): boolean {
  const lineage = readDexPriceLineage(sample);
  if (lineage.upstreamKeys?.length === 0 || lineage.pricePoolKeys?.length === 0) return false;
  const upstreamVenues = (lineage.upstreamKeys ?? []).filter((key) => key.startsWith("venue:")).map((key) => key.slice(6));
  const venues = [sample.protocol, sample.sourceFamily, ...upstreamVenues].filter((key): key is string => !!key);
  if (excludedVenue && venues.some((venue) => independenceKey(venue, asset?.id) === excludedVenue)) return false;
  if (!asset) return true;
  const primary = readDexPriceLineage(asset);
  if (primary.upstreamKeys?.length === 0 || primary.pricePoolKeys?.length === 0) return false;
  const own = primary.upstreamKeys ?? primary.pricePoolKeys;
  const other = lineage.upstreamKeys ?? lineage.pricePoolKeys;
  // Legacy USD rows used the DEX protocol quorum before either writer published pool ancestry.
  if (!excludedVenue && normalizePegType(asset.pegType) === "peggedUSD" && (own == null || other == null)) {
    const sources = [...getPrimaryTrustSources(asset), ...(asset.priceSource?.split("+") ?? [])];
    return !upstreamVenues.some((venue) =>
      sources.some((source) => independenceKey(source, asset.id) === independenceKey(venue, asset.id)));
  }
  if (venues.length && !isIndependentVenue(asset, ...venues)) return false;
  const poolPriced = [...getPrimaryTrustSources(asset), ...(asset.priceSource?.split("+") ?? [])]
    .some((source) => resolveDepegSourceFamily(source)?.startsWith("dex:") || source === "curve-onchain");
  if (own?.some((key) => other?.includes(key))) return false;
  return !poolPriced || (!!own?.length && !!other?.length);
}

export function independenceKey(source: string | undefined, assetId?: string): string {
  const family = resolveDepegSourceFamily(source) ?? "";
  const name = family.slice(family.lastIndexOf(":") + 1).replace(/[-_ ](?:exchange|spot|pro)$/, "");
  if (name === "coingecko" && assetId && REVIEWED_COINGECKO_KRAKEN_MIRRORS.has(assetId)) return "kraken";
  if (name === "cg_onchain" || name === "gecko_terminal" || name === "geckoterminal") return "coingecko";
  if (name === "dl") return "defillama";
  if (name === "unknown" || name === "legacy-challenger-pools") return "";
  return name;
}

function restoreDirectClosureReferences(
  derived: ReturnType<typeof derivePegRates>, fxState: FxRateState, now: number,
): void {
  const { observations, contributors } = derived;
  if (!observations || !contributors) return;
  // Probe denominator eligibility at the severe boundary. Each decision still checks its actual quote and move.
  const probe = { quoteObservedAtSec: now, decisionAtSec: now, rawDeviationBps: asRawDeviationBps(DEPEG_SEVERITY_BPS.severe), purpose: "detection" } as const;
  const samples = Object.values(fxState.referenceSourceSamples ?? {})
    .sort((a, b) => b.observation.observedAtSec - a.observation.observedAtSec);
  for (const { observation } of samples) {
    const { pegKey, source, observedAtSec, publishedAtSec, usdPerUnit } = observation;
    if (source === "peer-median" || (publishedAtSec ?? observedAtSec) > fxState.usableSyncAt ||
      (!fxState.selectedReferenceEvidence?.[pegKey] && !fxState.omittedCloseCarryPegs?.includes(pegKey))) continue;
    const peg = getPegTaxonomyByType(pegKey);
    const market = getReferenceMarket(peg?.currency);
    if (!market || !isReferenceMarketClosed(market, now)) continue;
    const kind = market === "metal" ? "fallback" : "fx";
    const selected = observations[pegKey];
    const current = derived.sources[pegKey] === "median"
      ? evaluateReferenceAdmission({ ...probe, kind: "median", pegKey, contributors: contributors[pegKey] ?? [] })
      : selected && evaluateReferenceAdmission({ ...probe, kind, observation: selected });
    if (current?.status === "admitted" ||
      evaluateReferenceAdmission({ ...probe, kind, observation }).status !== "admitted") continue;
    for (const key of [pegKey, ...(peg?.pegTypeAliases ?? [])]) {
      derived.rates[key] = usdPerUnit;
      derived.sources[key] = kind;
      derived.counts[key] ??= 0;
      observations[key] = observation;
      delete contributors[key];
    }
  }
}

export async function deriveDetectionPegRates(
  db: D1Database,
  assets: PegAssetBase[],
  metaById: ReadonlyMap<string, StablecoinMeta>,
  openIds: ReadonlySet<string>,
  fallbackRates?: Record<string, number>,
  detectionFxState?: FxRateState | null,
  decisionAtSec?: number,
) {
  const xagm = assets.find((asset) => asset.id === "xagm-matrixdock");
  const silverMeta = xagm && observationPegMeta(xagm, metaById.get(xagm.id));
  const selectedMeta = xagm && silverMeta ? new Map(metaById).set(xagm.id, silverMeta) : metaById;
  const eligible = assets.filter((asset) => (asset.id !== "xagm-matrixdock" || silverMeta != null) &&
    !metaById.get(asset.id)?.flags.navToken && !hasIncompatibleParityPrice(asset));
  const hasScheduledPeg = eligible.some((asset) => getReferenceMarket(metaById.get(asset.id)?.flags.pegCurrency) != null);
  const fxState = detectionFxState === undefined && hasScheduledPeg ? await loadFxRateState(db) : detectionFxState ?? null;
  // Keep the dated close available to the admission predicate even when the
  // pricing stage no longer uses it as a current validation reference.
  const selectedRates = { ...fallbackRates };
  if (fxState?.metadataIdentity === "verified") {
    for (const [peg, rate] of Object.entries(fxState.rates)) {
      if (fxState.observations?.[peg] || (fxState.observations === undefined && fxState.sources?.[peg])) {
        selectedRates[peg] = rate;
      }
    }
  }
  const selected = fxState?.metadataIdentity === "verified" ? fxState.observations : undefined;
  const observations = selected && Object.fromEntries(Object.entries(selected).map(([peg, row]) => [peg, {
    ...row, contributors: fxState?.referenceMedianContributorsByPeg?.[peg],
    repricing: fxState?.referenceSessionEvidenceByPeg?.[peg] && {
      ...fxState.referenceSessionEvidenceByPeg[peg],
      preCloseUsdPerUnit: fxState.referenceSessionEvidenceByPeg[peg].preCloseUsdPerUnit ?? undefined,
    },
  }]));
  const legacyBullionPegs = fxState?.legacyDetectionPegs?.filter((peg) => hasVerifiedLegacyRate(fxState, peg));
  const derived = derivePegRates(eligible, selectedMeta, selectedRates, fxState?.selectedReferenceEvidence ?? observations, decisionAtSec, legacyBullionPegs);
  if (fxState?.metadataIdentity === "verified") {
    restoreDirectClosureReferences(derived, fxState, decisionAtSec ?? Math.floor(Date.now() / 1000));
  }
  const referenceContext = attachDetectionReferenceContext(derived.rates, eligible, metaById, openIds, fxState, fxState?.legacyRepricingByPeg, derived.counts, derived);
  return { ...derived, referenceContext };
}

export function attachDetectionReferenceContext(
  rates: DetectionRates,
  assets: PegAssetBase[],
  metaById: ReadonlyMap<string, StablecoinMeta>,
  openIds: ReadonlySet<string>,
  fxState: FxRateState | null,
  repricing?: RepricingByPeg,
  selectedCounts?: Record<string, number>,
  selected?: DetectionReferenceContext["selected"],
): DetectionReferenceContext {
  const groups = new Map<string, ReferenceGroup>();
  for (const asset of assets) {
    const pegKey = normalizePegType(asset.pegType);
    const { price } = asset;
    if (!pegKey || hasIncompatibleParityPrice(asset) || !isObservedPrice(asset) || price == null || !Number.isFinite(price) || price <= 0) continue;
    const supply = getCirculatingRawOrNull(asset);
    if (supply == null || supply < DEPEG_EVENT_MIN_SUPPLY_USD ||
      ((pegKey === "peggedGOLD" || pegKey === "peggedSILVER") && COMMODITY_MEDIAN_EXCLUDES.has(asset.id))) continue;
    const meta = observationPegMeta(asset, metaById.get(asset.id));
    if (asset.id === "xagm-matrixdock" && !meta) continue;
    if (meta && pegTypeFromCurrency(meta.flags.pegCurrency) !== pegKey) continue;
    const group = groups.get(pegKey) ?? { peers: [], contributors: [], prices: [] };
    const oz = meta?.commodityOunces;
    group.prices.push((pegKey === "peggedGOLD" || pegKey === "peggedSILVER") && oz && oz > 0 ? price / oz : price);
    groups.set(pegKey, group);

    // Use the primary price's own provenance, never the intersection-free spelling of
    // a composite. A composite with overlapping providers cannot supply a new vote.
    const sources = getPrimaryTrustSources(asset);
    const entries = sources.map(getPricingSourceRegistryEntry);
    const entry = entries[0];
    const singleSource = entries.length === 1 ? entry : undefined;
    const clock = sourceObservationClock(asset);
    const traded = meta != null && !meta.flags.navToken && singleSource != null && !singleSource.isSearchDerived &&
      (singleSource.trustTier === "hard_market" || (singleSource.trustTier === "soft_dex" &&
        !["dex:aggregate", "dex:pool-tvl-weighted"].includes(singleSource.depegSourceFamily)));
    group.contributors.push({
      observedAtSec: clock,
      provenanceKey: traded ? independenceKey(singleSource.depegSourceFamily, asset.id) : "",
      derivation: traded ? "traded-market" : meta?.flags.navToken ? "nav" : "spot-derived",
    });
    if (traded && clock != null) {
      group.peers.push({ id: asset.id, pegKey, priceUsd: price / (meta.commodityOunces ?? 1),
        observedAtSec: clock, provenanceKey: independenceKey(singleSource.depegSourceFamily, asset.id), hasOpenEvent: openIds.has(asset.id) });
    }
  }
  if (selectedCounts) {
    for (const [key, group] of groups) {
      if (selectedCounts[key] !== group.contributors.length || median(group.prices) !== rates[key]) group.contributors = [];
    }
  }
  const context = { groups, fxState, repricing, selected };
  Object.defineProperty(rates, runContext, { value: context, configurable: true });
  return context;
}

function isSameOpenLegacySession(market: ReferenceMarket, discoveredAt: number, now: number): boolean {
  if (discoveredAt > now) return false;
  // Legacy boundaries align to UTC hours, and every Saturday interrupts the session.
  const discoveryHour = Math.floor(discoveredAt / HOUR_SECONDS) * HOUR_SECONDS;
  for (let hour = Math.floor(now / HOUR_SECONDS) * HOUR_SECONDS; hour >= discoveryHour; hour -= HOUR_SECONDS) {
    if (getLegacyReferenceClosureStart(market, hour) != null) return false;
  }
  return true;
}

export function assessDetectionReference(input: {
  asset?: PegAssetBase;
  meta: StablecoinMeta;
  pegRates: DetectionRates;
  pegRateSources: Record<string, PegRateSource>;
  now: number;
  signal: DepegSignal | null;
  quoteObservedAt?: number | null;
  quoteMaxAgeSec?: number;
  legacyPending?: { discoveredAt: number; pegReference: number };
  cohort?: { reference: number; contributors: PeerRelativeQuote[] } | null;
  referenceContext?: DetectionReferenceContext;
}) {
  const { meta, asset, pegRates, pegRateSources, now, signal } = input;
  const market = getReferenceMarket(meta.flags.pegCurrency);
  if (market == null) return null;
  const session = getReferenceSessionState(market, now);
  const pegKey = asset ? normalizePegType(asset.pegType) : pegTypeFromCurrency(meta.flags.pegCurrency);
  const run = input.referenceContext ?? pegRates[runContext];
  const group = pegKey ? run?.groups.get(pegKey) : undefined;
  const fxState = run?.fxState;
  const quoteObservedAtSec = input.quoteObservedAt === undefined ? sourceObservationClock(asset) : input.quoteObservedAt;
  const args = { quoteObservedAtSec, decisionAtSec: now, purpose: "detection" as const,
    rawDeviationBps: signal == null ? null : asRawDeviationBps(signal.rawBps) };
  const kind = pegKey ? pegRateSources[pegKey] : undefined;
  const contributors = pegKey && run?.selected?.contributors ? run.selected.contributors[pegKey] ?? [] : group?.contributors ?? [];
  const legacyWriter = !fxState || (fxState.observations === undefined &&
    (fxState.metadataIdentity === "legacy-timestamp" || fxState.metadataIdentity === "verified") &&
    fxState.legacyRepricingByPeg === undefined && (!pegKey || !fxState.sources?.[pegKey]));
  const legacyBullionMedian = market === "metal" && pegKey != null && hasVerifiedLegacyRate(fxState, pegKey);
  // A median made solely from the pending asset cannot replace its denominator.
  const subjectOnlyMedian = kind === "median" && asset != null &&
    contributors.length === 1 && contributors[0]?.assetId === asset.id;
  const missingLegacyReference = legacyWriter && pegKey &&
      (subjectOnlyMedian || (kind === undefined && !Object.prototype.hasOwnProperty.call(pegRates, pegKey))) &&
      !Object.prototype.hasOwnProperty.call(fxState?.rates ?? {}, pegKey) && fxState?.selectedReferenceEvidence === undefined &&
      run?.selected?.observations?.[pegKey] === undefined;
  let legacyReference = (legacyWriter || legacyBullionMedian) && (!kind || kind === "median");
  let firstProviderSample = false;
  let referenceInput: ReferenceAdmissionInput;
  if (kind === "median" && pegKey && !legacyBullionMedian) {
    referenceInput = { ...args, kind, pegKey, contributors };
  } else {
    const verified = pegKey != null && fxState?.metadataIdentity === "verified" && fxState.rates[pegKey] === pegRates[pegKey];
    const selected = pegKey ? run?.selected?.observations?.[pegKey] : undefined;
    const legacy = verified && fxState.observations === undefined ? {
      pegKey, usdPerUnit: fxState.rates[pegKey], source: fxState.sources?.[pegKey],
      cadence: fxState.sourceCadenceByPeg[pegKey], observedAtSec: fxState.sourceUpdatedAtByPeg[pegKey],
    } : undefined;
    const parsed = FxReferenceObservationSchema.safeParse(selected ?? (verified && fxState.selectedReferenceEvidence === undefined
      ? fxState.observations?.[pegKey] ?? legacy : undefined));
    const selectedAnchor = selected?.repricing ?? (verified ? fxState.referenceSessionEvidenceByPeg?.[pegKey] : undefined);
    const legacyAnchor = pegKey ? run?.repricing?.[pegKey] : undefined;
    const anchor = selectedAnchor
      ? (session.open && selectedAnchor.sessionOpenedAtSec === session.sessionOpenedAtSec ? selectedAnchor : undefined)
      : legacy && legacyAnchor?.source === legacy.source ? legacyAnchor : undefined;
    if ((kind === "fx" || kind === "fallback") && pegKey && pegRates[pegKey] > 0) {
      // Main stored one status per provider, without a per-peg observation. Its ordinary
      // numeric reference is usable only when selected by the legacy freshness path.
      legacyReference = legacyWriter || (verified && !selected && !parsed.success && fxState.legacyDetectionPegs?.includes(pegKey) === true);
      firstProviderSample = (legacy !== undefined && run?.repricing === undefined) ||
        (verified && fxState.legacyDetectionPegs?.includes(pegKey) === true && anchor != null &&
          anchor.preCloseUsdPerUnit == null && anchor.firstInSessionObservedAtSec === parsed.data?.observedAtSec);
    }
    referenceInput = (kind === "fx" || kind === "fallback") && parsed.success && pegKey &&
      parsed.data.pegKey === pegKey && parsed.data.usdPerUnit === pegRates[pegKey]
      ? { ...args, kind, observation: parsed.data,
        generation: run?.generation ?? (fxState?.metadataIdentity === "verified" ? String(fxState.usableSyncAt) : undefined),
        preCloseUsdPerUnit: anchor?.preCloseUsdPerUnit, firstInSessionObservedAtSec: anchor?.firstInSessionObservedAtSec }
      : { ...args, kind: "none" };
  }
  const { legacyPending } = input;
  if (legacyPending && (missingLegacyReference ||
      (asset?.price == null && legacyReference && (kind === "fx" || kind === "fallback") &&
        referenceInput.kind === "none" && getPegReference(pegKey, pegRates, meta.commodityOunces) === legacyPending.pegReference)) &&
      isSameOpenLegacySession(market, legacyPending.discoveredAt, now)) return null;
  const verdict: ReferenceAdmission = evaluateReferenceAdmission(referenceInput);
  legacyReference ||= firstProviderSample && verdict.reason === "reference-not-repriced";
  if (!session.open && kind === "median" && verdict.status === "admitted") legacyReference = false;
  const legacyClosureStart = legacyReference ? getLegacyReferenceClosureStart(market, now) : null;
  const legacyClosureHeld = legacyClosureStart != null && !(signal && signal.absRawBps >= DEPEG_SEVERITY_BPS.severe);
  if (legacyReference && signal && legacyClosureStart == null) return null;

  // Closure calibration measures a move against the last eligible close. The live
  // age budget is applied at the closure boundary for this exceptional path.
  const quoteMaxAgeSec = input.quoteMaxAgeSec ?? (verdict.reason === "severe-deviation"
    ? REFERENCE_INTRADAY_BUDGET_SEC : DEPEG_PRIMARY_PRICE_MAX_AGE_SEC);
  const quoteInSession = quoteObservedAtSec != null && Number.isSafeInteger(quoteObservedAtSec) &&
    quoteObservedAtSec > 0 && quoteObservedAtSec <= now && now - quoteObservedAtSec <= quoteMaxAgeSec &&
    quoteObservedAtSec >= (session.open ? session.sessionOpenedAtSec : session.closureStartSec);
  const eligibleClose = !session.open && quoteInSession &&
    verdict.referenceObservedAtSec != null && verdict.budgetSec != null &&
    verdict.referenceObservedAtSec <= session.closureStartSec &&
    session.closureStartSec - verdict.referenceObservedAtSec <= verdict.budgetSec;
  const inClosureMedian = !session.open && kind === "median" && quoteInSession && verdict.referenceObservedAtSec != null &&
    verdict.budgetSec != null && verdict.referenceObservedAtSec >= session.closureStartSec && now - verdict.referenceObservedAtSec <= verdict.budgetSec;
  const closureHeld = (eligibleClose || inClosureMedian) && verdict.status === "held-closed-session";
  // For large moves the shared verdict reports the severe reason first. A traded
  // median still qualifies as a live denominator if it would admit at ordinary size.
  const closedTradedMedian = !session.open && kind === "median" && quoteInSession &&
    (verdict.reason === "closed-session-traded-median" || (verdict.reason === "severe-deviation" && pegKey != null &&
      evaluateReferenceAdmission({ ...args, kind, pegKey, contributors,
        rawDeviationBps: asRawDeviationBps(0) }).status === "admitted"));

  const subject = asset?.price;
  const primarySources = asset ? getPrimaryTrustSources(asset) : [];
  const primaryFamilies = asset ? primaryVenueKeys(asset) : null;
  const tradedSubject = primarySources.length > 0 && primarySources.every((source) => {
    const entry = getPricingSourceRegistryEntry(source);
    return entry != null && source !== COINGECKO_NATIVE_IMPLIED_SOURCE && entry.trustTier !== "cached_replay" &&
      entry.trustTier !== "hard_oracle" && entry.trustTier !== "hard_protocol";
  });
  const boundary = legacyClosureStart ?? (session.open ? session.sessionOpenedAtSec : session.closureStartSec);
  const subjectClock = sourceObservationClock(asset);
  const peer = input.cohort === undefined && primaryFamilies != null && tradedSubject && asset != null && pegKey && group && subject != null &&
    subjectClock != null && subjectClock >= boundary &&
    isObservedPrice(asset) && asset.priceSource !== "cached"
    ? computePeerRelativeDeviation({
      subject: { id: asset.id, pegKey, priceUsd: subject / (meta.commodityOunces ?? 1), observedAtSec: subjectClock },
      peers: group.peers.filter((row) => !primaryFamilies.has(row.provenanceKey) &&
        row.observedAtSec >= boundary),
      nowSec: now, maxAgeSec: DEPEG_PRIMARY_PRICE_MAX_AGE_SEC,
    })
    : null;
  const units = meta.commodityOunces ?? 1;
  const independentCohort = input.cohort ?? (peer?.ok ? { reference: peer.medianUsd * units, contributors: peer.contributors } : null);
  const cohortPegReference = independentCohort?.reference ?? null;
  const band = session.open ? null : getClosureBenchmarkBandBps(meta.flags.pegCurrency, session.nextOpenSec - session.closureStartSec, cohortPegReference != null);
  // Once a cohort exists, a shifted median cannot attest the magnitude against Friday's close.
  // Its own token-relative move can still be admitted below on the peer basis.
  const cohortMove = pegKey && cohortPegReference != null ? deriveDepegSignal(cohortPegReference, pegRates[pegKey] * units) : null;
  const cohortNearBenchmark = cohortPegReference == null || (cohortMove != null && cohortMove.absRawBps <= getDepegRecoveryThresholdBps(pegKey));
  const cohort = cohortPegReference == null ? "missing" as const : cohortNearBenchmark ? "near-benchmark" as const : "shifted" as const;
  return {
    legacyClosureHeld,
    legacySevere: legacyClosureStart != null && !legacyClosureHeld && cohort !== "shifted",
    verdict,
    band,
    referenceInput,
    cohort,
    independentCohort,
    closedTradedMedian,
    closureHeld,
    quoteInSession,
    closed: legacyReference ? legacyClosureStart != null : !session.open,
    boundary,
    peer: peer?.ok && quoteInSession && subject != null
      ? { reference: peer.medianUsd * (meta.commodityOunces ?? 1), contributors: peer.contributors }
      : null,
  };
}

export function benchmarkAdmission(
  reference: ReturnType<typeof assessDetectionReference>,
  signal: DepegSignal | null,
  independentNative: ReturnType<typeof getTradedNativeEvidence>,
  ordinaryThreshold: number,
): { threshold: number; admission?: ReferenceAdmission } | null {
  if (!reference) return { threshold: ordinaryThreshold };
  if (reference.legacyClosureHeld) return null;
  if (reference.legacySevere && signal && signal.absRawBps >= DEPEG_SEVERITY_BPS.severe) {
    return { threshold: DEPEG_SEVERITY_BPS.severe };
  }
  if (!reference.quoteInSession || signal == null) return null;
  if ((reference.closedTradedMedian || !reference.closed) &&
      admittedDeviationBps(asRawDeviationBps(signal.rawBps), reference.verdict) != null) {
    return { threshold: ordinaryThreshold, admission: reference.verdict };
  }
  if (reference.closed && reference.cohort !== "shifted" && reference.verdict.reason === "severe-deviation" &&
      signal.absRawBps >= DEPEG_SEVERITY_BPS.severe) {
    return { threshold: DEPEG_SEVERITY_BPS.severe, admission: reference.verdict };
  }
  if (reference.band != null && independentNative != null &&
      !reference.independentCohort?.contributors.some((row) => row.provenanceKey === independentNative.venue)) {
    const verdict = evaluateReferenceAdmission({ ...reference.referenceInput, closureBenchmark: {
      cohort: reference.cohort, nativeObservedAtSec: independentNative.quote.updatedAt,
      nativeDeviationBps: independentNative.signal.rawBps, triggerBps: ordinaryThreshold,
    } });
    if (verdict.reason === "closure-move-above-band" && admittedDeviationBps(asRawDeviationBps(signal.rawBps), verdict) != null) {
      return { threshold: reference.band, admission: verdict };
    }
  }
  return null;
}

export function getClockedTradedNativeQuote(quote: NativePegQuote | undefined, now: number, boundary = 0) {
  return quote?.derivation?.kind === "traded-pair" && !!quote.derivation.lineage.pair?.trim() && independenceKey(quote.derivation.lineage.venue) && Number.isSafeInteger(quote.updatedAt) &&
    quote.updatedAt > 0 && quote.updatedAt >= boundary && quote.updatedAt <= now &&
    now - quote.updatedAt <= DEPEG_PRIMARY_PRICE_MAX_AGE_SEC ? quote : undefined;
}

export function getTradedNativeEvidence(quote: NativePegQuote | undefined, now: number, pendingOnly = false) {
  const traded = getClockedTradedNativeQuote(quote, now);
  const venue = independenceKey(traded?.derivation?.lineage.venue);
  if (!traded || !venue) return null;
  const implausible = classifyNativeQuoteImplausibility(traded);
  if (implausible && !(pendingOnly && implausible.corroborationCanAdmit)) return null;
  const signal = deriveDepegSignal(traded.price, 1);
  return signal == null ? null : { signal, quote: traded, venue };
}

export function findIndependentPool(
  pools: DexPoolChallenger[] | undefined,
  asset: PegAssetBase,
  contributors: readonly PeerRelativeQuote[],
  reference: number,
  signal: DepegSignal,
  threshold: number,
  now: number,
  boundary: number,
  recoveryThreshold?: number,
  excludedVenue?: string,
) {
  const used = new Set(contributors.map((row) => row.provenanceKey));
  if (excludedVenue) used.add(excludedVenue);
  const agreeing = new Map<string, DexPoolChallenger>();
  const opposing = new Set<string>();
  const eligible = (pools ?? []).filter((pool) => {
    const venue = knownPoolVenue(pool);
    const family = dexProtocolGroupKey(pool);
    return venue && !used.has(venue) && !used.has(independenceKey(family)) &&
      isIndependentDexObservation(asset, pool, excludedVenue) && isFreshDexPoolObservation(pool.observedAt, now) &&
      pool.observedAt >= boundary;
  });
  for (const pool of selectIndependentChallengerPools(eligible)) {
    const venue = knownPoolVenue(pool);
    const sample = deriveDepegSignal(pool.price, reference);
    const status = classifyDirectionalSignal(sample, threshold, signal.direction, recoveryThreshold ?? threshold / 2);
    const supports = recoveryThreshold != null ? status === "recover" : status === "confirm";
    if (supports) {
      if ((agreeing.get(venue)?.tvlUsd ?? 0) < pool.tvlUsd) agreeing.set(venue, pool);
    } else if (status !== "insufficient") {
      opposing.add(venue);
    }
  }
  for (const venue of opposing) agreeing.delete(venue);
  const strongest = [...agreeing.values()].sort((a, b) => b.tvlUsd - a.tvlUsd)[0];
  if (!strongest) return undefined;
  // The subject and peer quorum already support this path. Apply the pool vote
  // when a second pool venue disagrees with the independent corroborator.
  if (opposing.size === 0 || (strongest.tvlUsd >= POOL_CHALLENGE_HIGH_TVL_USD && agreeing.size >= opposing.size) ||
    divergingProtocolGroupsOutvote({ divergingCount: agreeing.size, corroboratingCount: opposing.size })) return strongest;
  return undefined;
}

export function knownPoolVenue(pool: Pick<DexPoolChallenger, "protocol" | "sourceFamily">): string {
  return independenceKey(pool.sourceFamily) ? independenceKey(pool.protocol) : "";
}

export function buildPeerReceipt(
  asset: PegAssetBase,
  contributors: readonly PeerRelativeQuote[],
  native: ReturnType<typeof getTradedNativeEvidence>,
  pool: DexPoolChallenger | undefined,
) {
  return JSON.stringify({
    basis: "peer-relative",
    confidence: "low",
    quoteObservedAt: asset.priceObservedAt,
    subjectPriceUsd: asset.price,
    contributors: contributors.map(({ id, observedAtSec, provenanceKey, priceUsd }) => ({ id, observedAtSec, provenanceKey, priceUsd })),
    corroborator: pool ? { source: `pool:${dexPoolIndependentGroupKey(pool)}`, observedAtSec: pool.observedAt, priceUsd: pool.price, venue: knownPoolVenue(pool) }
      : native ? { source: `native:${native.venue}`, observedAtSec: native.quote.updatedAt, price: native.quote.price, venue: native.venue } : null,
  });
}

export function assessIndependentPeerMove(input: {
  reference: NonNullable<ReturnType<typeof assessDetectionReference>>;
  asset: PegAssetBase;
  native: ReturnType<typeof getTradedNativeEvidence>;
  pools?: DexPoolChallenger[];
  excludedVenue?: string;
  threshold: number;
  recoveryThreshold?: number;
  now: number;
}) {
  const { reference, asset, native, pools, threshold, recoveryThreshold, now } = input;
  if (!reference.peer || asset.price == null) return null;
  const { contributors, reference: pegReference } = reference.peer;
  const signal = deriveDepegSignal(asset.price, pegReference);
  if (!signal) return null;
  const inBand = recoveryThreshold != null && signal.absRawBps <= recoveryThreshold;
  if (!inBand && !signalCrossesThreshold(signal, threshold)) return null;
  const venueUsed = native && (!isIndependentVenue(asset, native.venue) ||
    contributors.some((peer) => peer.provenanceKey === independenceKey(native.venue)));
  const independentNative = native?.venue && !venueUsed && native.quote.updatedAt >= reference.boundary &&
    (inBand ? native.signal.absRawBps <= recoveryThreshold : native.signal.direction === signal.direction &&
      signalCrossesThreshold(native.signal, threshold)) ? native : null;
  const pool = findIndependentPool(pools, asset, contributors, pegReference, signal, threshold, now,
    reference.boundary, inBand ? recoveryThreshold : undefined, input.excludedVenue);
  if (!independentNative && !pool) return null;

  return { signal, pegReference, price: asset.price, receipt: buildPeerReceipt(asset, contributors, independentNative, pool),
    source: pool ? `pool:${dexPoolIndependentGroupKey(pool)}` : `native:${independentNative!.quote.pegCurrency.toLowerCase()}` };
}
