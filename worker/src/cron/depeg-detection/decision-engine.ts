import { DEX_PROTOCOL_SOURCE_FRESHNESS_SEC, DEX_FRESHNESS_SEC, DEPEG_CONFIRMATION_SUPPLY_THRESHOLD, DEPEG_DEX_PROTOCOL_CORROBORATION_MIN, DEPEG_EVENT_MIN_SUPPLY_USD, DEPEG_EXTREME_MOVE_BPS, DEPEG_PENDING_MIN_AGE_SEC, DEPEG_PRIMARY_PRICE_MAX_AGE_SEC, DEX_PRICE_CHECK_DEPEG_MIN_TVL_USD } from "@shared/lib/depeg-config";
import type { DepegPrimaryTrust } from "@shared/types/price";
import { logWorkerEventArgs } from "../../lib/structured-log";
import { DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC } from "@shared/lib/depeg-closure";
import { directUsdVenueKeys, readDexPriceLineage } from "../dex-liquidity/price-lineage";
import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import { getPrimaryPriceAgeSec, getPrimaryTrustSources } from "@shared/lib/depeg-primary-trust";
import { depegObservedIntervals, isCurrentPegReferenceHold, mergeDepegIntervals, scheduledPegClosures } from "@shared/lib/peg-utils";
import { getReferenceMarket, getReferenceSessionState } from "@shared/lib/reference-market-hours";
import { advanceDepegPriceCoverage } from "@shared/lib/depeg-price-coverage";
import { normalizePegTypeFromCurrency } from "@shared/lib/peg-price-bounds";
import { normalizePegType } from "@shared/lib/peg-rates";
import { normalizePricingSourceKeys } from "@shared/lib/pricing-sources";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { divergingProtocolGroupsOutvote, POOL_CHALLENGE_HIGH_TVL_USD } from "../../lib/price-depeg-voting-policy";
import { getDepegRecoveryThresholdBps, getDepegThresholdBps } from "../../lib/depeg-threshold-policy";
import {
  buildPendingReason,
  countDexProtocolCorroborations,
  dexPoolIndependentGroupKey,
  dexProtocolGroupKey,
  markNativeOriginPending,
  parsePendingReason,
  rowPriceCoverage,
  readDepegAdmittedCoverage,
  readDepegReferenceHold,
  rowToDepegEvent,
  type DepegRow,
  type DexPriceRow,
  type PendingDepegReason,
  type PendingDepegReasonFlag,
} from "../../lib/depeg-helpers";
import {
  classifyNativeQuoteImplausibility,
  type NativeQuoteImplausibility,
} from "../../lib/native-quote-plausibility";
import {
  classifyPrimaryDepegTrust,
  hasFreshMultiSourcePrimaryAgreement,
  isAffirmativeDexPriceRow,
  isFreshDexPoolObservation,
  isTrustedDexPriceRow,
} from "../../lib/depeg-trust-policy";
import {
  deriveDepegSignal,
  signalCrossesThreshold,
  signalIsWithinThreshold,
  signalsShareDirection,
  type DepegDirection,
  type DepegSignal,
} from "@shared/lib/depeg-signals";
import type {
  DepegAssetDecision,
  DepegAssetDecisionInput,
  DepegDiagnostic,
  DepegObservationOutcome,
  DepegPersistenceCommand,
  DexPoolChallenger,
  PendingDepegCommandPayload,
  DepegDetectionRow,
} from "./types";
import {
  applyNativeQuoteVeto,
  recoveryPriceForEvent,
  resolveDirectRecovery,
  resolvePeakUpdateCommand,
} from "./native-quote-policy";
import { deriveAuthoritativePegSignal } from "../authoritative-peg-signal";
import { isNativePegEvent } from "@shared/lib/depeg-quote-domain";
import { assessDetectionReference, assessIndependentPeerMove, benchmarkAdmission, canPersistPeerEvents, getClockedTradedNativeQuote, getTradedNativeEvidence, hasIncompatibleParityPrice, independentPrimaryTrustInput, observationPegMeta, independenceKey, isIndependentDexObservation, isIndependentVenue, sourceObservationClock } from "./reference-policy";

interface DecisionContext {
  trackedCoinId: string;
  now: number;
  asset: DepegAssetDecisionInput["asset"];
  price: number;
  primarySignal: DepegSignal;
  bps: number;
  absBps: number;
  rawAbsBps: number;
  direction: DepegDirection;
  threshold: number;
  nativeThreshold: number;
  recoveryThreshold: number;
  pegRef: number;
  supply: number;
  primaryTrust: DepegPrimaryTrust;
  dexRow: DexPriceRow | undefined;
  observedDexRow: DexPriceRow | undefined;
  dexAbsBps: number | null;
  dexDirectionProtocolCount: number;
  dexExistingDirectionProtocolCount: number;
  dexRecoveryProtocolCount: number;
  dexRecoveryChallenged: boolean;
  poolRecoveryVeto: boolean;
  poolRecoveryVetoGroupCount: number;
  poolRecoveryVetoCorroboratingGroupCount: number;
  poolRecoveryVetoHighTvl: boolean;
  dexSupportsDirection: boolean;
  dexSupportsExistingDirection: boolean;
  dexSupportsRecovery: boolean;
  primarySupportsRecovery: boolean;
  pendingReason: PendingDepegReason;
  benchmarkAdmission?: PendingDepegCommandPayload["referenceAdmission"];
  nativeSignal: DepegSignal | null;
  nativeVetoSignal: DepegSignal | null;
  nativePegPrice: number | null;
  nativePegCurrency: string | undefined;
  /** Set when this run's native quote was withheld from admission. */
  nativeQuoteImplausibility: NativeQuoteImplausibility | null;
  independentNativeOnset?: boolean;
  quoteObservedAt?: number | null;
  nativeObservedAt?: number;
  translatedUsdObservedAt?: number;
  nativeVenue?: string;
  independentNativeBasis: boolean;
  closedSessionEvidence: boolean;
  peerMove?: NonNullable<ReturnType<typeof assessIndependentPeerMove>>;
}

const DEPEG_CONFIRMATION_SOFT_SUPPLY_THRESHOLD = DEPEG_CONFIRMATION_SUPPLY_THRESHOLD * 0.75;
const DEPEG_CONFIRMATION_WEAK_SEVERE_SUPPLY_THRESHOLD = DEPEG_CONFIRMATION_SUPPLY_THRESHOLD * 0.5;
const DEPEG_TIERED_CONFIRMATION_SEVERITY_MULTIPLIER = 2;

type DecisionContextDerivation =
  | { kind: "skip"; decision: DepegAssetDecision }
  | { kind: "context"; ctx: DecisionContext };

function emptyDecision(trackedCoinId?: string, observation?: DepegObservationOutcome): DepegAssetDecision {
  return {
    trackedCoinId,
    ...(observation ? { observation } : {}),
    seenEventIds: [],
    commands: [],
    diagnostics: [],
  };
}

function withDiagnostic(level: DepegDiagnostic["level"], message: string): DepegDiagnostic {
  return { level, message };
}

/** Returns true when the DEX price row for this asset is fresh and trusted for depeg decisions. */
function isDexFresh(
  dexRow: DexPriceRow | undefined,
  dexAbsBps: number | null,
  now: number,
): boolean {
  return dexAbsBps != null && dexRow != null && isTrustedDexPriceRow(dexRow, now, "depeg");
}

function hasRecoveryChallenge(
  challengers: DexPoolChallenger[] | undefined,
  pegRef: number,
  threshold: number,
  depegDirection: DepegDirection,
): boolean {
  if (!challengers || challengers.length === 0) return false;
  return challengers.some((pool) => {
    const signal = deriveDepegSignal(pool.price, pegRef);
    return signal != null && signalCrossesThreshold(signal, threshold) && signal.direction === depegDirection;
  });
}

interface PoolChallengerEvidence {
  veto: boolean;
  groupCount: number;
  corroboratingGroupCount: number;
  highTvl: boolean;
}

/**
 * Derives conservative recovery vetoes from published challenger snapshots.
 * Pools inside the trigger threshold corroborate the recovered price for the
 * majority rule; the high-TVL single-pool carve-out is unchanged. Publication
 * timestamps do not establish fresh positive pool-price recovery evidence.
 */
function derivePoolChallengerEvidence(params: {
  challengers: DexPoolChallenger[] | undefined;
  pegRef: number;
  threshold: number;
  depegDirection: DepegDirection;
}): PoolChallengerEvidence {
  const divergingGroups = new Set<string>();
  const corroboratingGroups = new Set<string>();
  let highTvl = false;
  for (const pool of params.challengers ?? []) {
    const signal = deriveDepegSignal(pool.price, params.pegRef);
    if (signal == null) continue;
    const groupKey = dexPoolIndependentGroupKey(pool);
    if (signalCrossesThreshold(signal, params.threshold) && signal.direction === params.depegDirection) {
      divergingGroups.add(groupKey);
      if (pool.tvlUsd >= POOL_CHALLENGE_HIGH_TVL_USD) {
        highTvl = true;
      }
      continue;
    }
    if (signalIsWithinThreshold(signal, params.threshold)) {
      corroboratingGroups.add(groupKey);
    }
  }
  const groupCount = divergingGroups.size;
  return {
    veto: highTvl || divergingProtocolGroupsOutvote({
      divergingCount: groupCount,
      corroboratingCount: corroboratingGroups.size,
    }),
    groupCount,
    corroboratingGroupCount: corroboratingGroups.size,
    highTvl,
  };
}

function buildPendingCommand(
  asset: DepegAssetDecisionInput["asset"],
  now: number,
  quoteObservedAt: number | null | undefined,
  direction: DepegDirection,
  signal: DepegSignal,
  eventPrice: number,
  pegReference: number,
  reason: PendingDepegReason,
  peerBasis?: string,
  nativeVenue?: string,
  referenceAdmission?: PendingDepegCommandPayload["referenceAdmission"],
): DepegPersistenceCommand {
  const payload: PendingDepegCommandPayload = {
    stablecoinId: asset.id,
    symbol: asset.symbol,
    pegType: asset.pegType ?? "",
    direction,
    bps: signal.bps,
    rawBps: signal.rawBps,
    seenAt: now,
    ...(quoteObservedAt != null && quoteObservedAt !== now ? { quoteObservedAt } : {}),
    price: eventPrice,
    pegReference,
    reason,
    ...(peerBasis ? { peerBasis } : {}),
    ...(nativeVenue ? { nativeVenue } : {}),
    ...(referenceAdmission ? { referenceAdmission } : {}),
  };
  return { type: "upsert-pending", payload };
}

function getPrimarySourceDepth(asset: DepegAssetDecisionInput["asset"]): number {
  const sources = asset.agreeSources && asset.agreeSources.length > 0
    ? asset.agreeSources
    : asset.priceSource ?? "";
  return new Set(normalizePricingSourceKeys(sources)).size;
}

function requiresTieredMarketCapConfirmation(params: {
  supply: number;
  sourceDepth: number;
  absBps: number;
  threshold: number;
}): boolean {
  if (params.supply >= DEPEG_CONFIRMATION_SUPPLY_THRESHOLD) return true;
  const severe = params.absBps >= params.threshold * DEPEG_TIERED_CONFIRMATION_SEVERITY_MULTIPLIER;
  if (params.supply >= DEPEG_CONFIRMATION_SOFT_SUPPLY_THRESHOLD) {
    return params.sourceDepth < 2 || severe;
  }
  return params.supply >= DEPEG_CONFIRMATION_WEAK_SEVERE_SUPPLY_THRESHOLD && params.sourceDepth < 2 && severe;
}

interface DexEvidence {
  dexAbsBps: number | null;
  dexDirectionProtocolCount: number;
  dexExistingDirectionProtocolCount: number;
  dexRecoveryProtocolCount: number;
  dexRecoveryChallenged: boolean;
  poolRecoveryVeto: boolean;
  poolRecoveryVetoGroupCount: number;
  poolRecoveryVetoCorroboratingGroupCount: number;
  poolRecoveryVetoHighTvl: boolean;
  dexSupportsDirection: boolean;
  dexSupportsExistingDirection: boolean;
  dexSupportsRecovery: boolean;
}

/**
 * Derives the DEX-corroboration signals (direction/recovery support and the
 * recovery challenge veto) from the trusted DEX price row and protocol sources.
 */
function deriveDexEvidence(params: {
  input: DepegAssetDecisionInput;
  existing: DepegRow | undefined;
  now: number;
  pegRef: number;
  threshold: number;
  recoveryThreshold: number;
  direction: DepegDirection;
}): DexEvidence {
  const { input, existing, now, pegRef, threshold, recoveryThreshold, direction } = params;
  const dexSignal = input.dexRow && isTrustedDexPriceRow(input.dexRow, now, "depeg")
    ? deriveDepegSignal(input.dexRow.dex_price_usd, pegRef)
    : null;
  const independentSources = input.protocolSources?.filter((source) => isIndependentDexObservation(input.asset, source));
  const dexDirectionProtocolCount = countDexProtocolCorroborations(independentSources, pegRef, threshold, direction, "confirm");
  const existingDirection = existing?.direction === "above" || existing?.direction === "below"
    ? existing.direction
    : direction;
  const dexExistingDirectionProtocolCount = countDexProtocolCorroborations(
    input.protocolSources,
    pegRef,
    threshold,
    existingDirection,
    "confirm",
  );
  const freshRecoverySources = independentSources?.filter((source) =>
    isFreshDexPoolObservation(source.observedAt, now));
  const dexRecoveryProtocolCount = countDexProtocolCorroborations(freshRecoverySources, pegRef, recoveryThreshold, direction, "recover");
  const recoveryVetoDirection: DepegDirection = existingDirection;
  const dexRecoveryChallenged = hasRecoveryChallenge(input.challengerPools, pegRef, threshold, recoveryVetoDirection);
  const poolChallengerEvidence = derivePoolChallengerEvidence({
    challengers: input.challengerPools,
    pegRef,
    threshold,
    depegDirection: recoveryVetoDirection,
  });
  const independentAggregate = input.dexRow != null && isIndependentDexObservation(input.asset, input.dexRow);
  const dexSupportsDirection =
    independentAggregate && dexSignal != null &&
    input.dexRow != null && isAffirmativeDexPriceRow(input.dexRow, now, "depeg") &&
    signalCrossesThreshold(dexSignal, threshold) &&
    signalsShareDirection(dexSignal, direction) &&
    dexDirectionProtocolCount >= DEPEG_DEX_PROTOCOL_CORROBORATION_MIN;
  const dexSupportsExistingDirection =
    dexSignal != null &&
    signalCrossesThreshold(dexSignal, threshold) &&
    signalsShareDirection(dexSignal, existingDirection) &&
    dexExistingDirectionProtocolCount >= DEPEG_DEX_PROTOCOL_CORROBORATION_MIN;
  const dexSupportsRecovery =
    independentAggregate && dexSignal != null &&
    signalIsWithinThreshold(dexSignal, recoveryThreshold) &&
    dexRecoveryProtocolCount >= DEPEG_DEX_PROTOCOL_CORROBORATION_MIN &&
    !dexRecoveryChallenged;
  return {
    dexAbsBps: dexSignal?.absBps ?? null,
    dexDirectionProtocolCount,
    dexExistingDirectionProtocolCount,
    dexRecoveryProtocolCount,
    dexRecoveryChallenged,
    poolRecoveryVeto: poolChallengerEvidence.veto,
    poolRecoveryVetoGroupCount: poolChallengerEvidence.groupCount,
    poolRecoveryVetoCorroboratingGroupCount: poolChallengerEvidence.corroboratingGroupCount,
    poolRecoveryVetoHighTvl: poolChallengerEvidence.highTvl,
    dexSupportsDirection,
    dexSupportsExistingDirection,
    dexSupportsRecovery,
  };
}

/**
 * An implausible native quote may still stand when independent DEX protocols
 * show their own implausible move in the same direction. DEX prices are USD but
 * deviations are scale-invariant against the admitted peg reference, so each
 * source can be re-expressed in native units and classified by the same bound.
 */
function dexCorroboratesNativeImplausibleMove(params: {
  input: DepegAssetDecisionInput;
  pegRef: number;
  direction: DepegDirection;
  now: number;
  stablecoinId: string;
  pegType: string | undefined;
}): boolean {
  const { input, pegRef, direction, now, stablecoinId, pegType } = params;
  const venue = independenceKey(input.nativePegQuote?.derivation?.lineage.venue);
  if (input.dexRow == null || !isTrustedDexPriceRow(input.dexRow, now, "depeg") ||
    !isIndependentDexObservation(input.asset, input.dexRow, venue)) return false;
  const classifyNative = (price: number) =>
    classifyNativeQuoteImplausibility({ price, stablecoinId, pegType });
  const aggregateNativePrice = input.dexRow.dex_price_usd / pegRef;
  const aggregateSignal = deriveDepegSignal(aggregateNativePrice, 1);
  if (
    classifyNative(aggregateNativePrice)?.corroborationCanAdmit !== true ||
    aggregateSignal == null ||
    !signalsShareDirection(aggregateSignal, direction)
  ) {
    return false;
  }
  const groups = new Set<string>();
  for (const source of input.protocolSources ?? []) {
    if (!isIndependentDexObservation(input.asset, source, venue) || !isFreshDexPoolObservation(source.observedAt, now)) continue;
    const nativePrice = source.price / pegRef;
    const signal = deriveDepegSignal(nativePrice, 1);
    if (
      classifyNative(nativePrice)?.corroborationCanAdmit === true &&
      signal != null &&
      signalsShareDirection(signal, direction)
    ) {
      groups.add(dexProtocolGroupKey(source));
    }
  }
  return groups.size >= DEPEG_DEX_PROTOCOL_CORROBORATION_MIN;
}

function independentlyPricedUsdMark({ asset, dexRow, now }: DepegAssetDecisionInput): boolean {
  const sources = new Set([...getPrimaryTrustSources(asset), ...normalizePricingSourceKeys(asset.priceSource)]);
  if (!sources.size) return false;
  // Join a promoted aggregate only to the exact observation that priced this token.
  const joined = asset.priceSource === "dex-promoted" && dexRow?.stablecoin_id === asset.id &&
    dexRow.dex_price_usd === asset.price && dexRow.aggregateObservedAt === sourceObservationClock(asset) &&
    isAffirmativeDexPriceRow(dexRow, now, "depeg") ? dexRow : undefined;
  const lineage = readDexPriceLineage("upstreamKeys" in asset || "pricePoolKeys" in asset ? asset : joined);
  return [...sources].every((source) => {
    if (directUsdVenueKeys(source, asset.symbol)?.length) return true;
    const poolMarket = getPricingSourceRegistryEntry(source)?.trustTier === "soft_dex" || source === "curve-onchain";
    return poolMarket && !!lineage.pricePoolKeys?.length && !!lineage.upstreamKeys?.length;
  });
}

function deriveDecisionContext(input: DepegAssetDecisionInput): DecisionContextDerivation {
  const { now, asset, meta, existing } = input;
  if (!meta) return { kind: "skip", decision: emptyDecision() };
  if (meta.flags.navToken) return { kind: "skip", decision: emptyDecision() };

  const trackedCoinId = asset.id;
  const primaryEvidence = independentPrimaryTrustInput(asset);
  const primaryTrust = classifyPrimaryDepegTrust(primaryEvidence, now);
  const observedPrice = asset.price;
  const nativeQuote = input.nativePegQuote?.stablecoinId === asset.id &&
    normalizePegTypeFromCurrency(input.nativePegQuote.pegCurrency) === normalizePegType(asset.pegType)
    ? input.nativePegQuote : undefined;
  const native = getTradedNativeEvidence(nativeQuote, now);

  if (meta.flags.pegCurrency === "USD" && primaryTrust === "unusable" && !native) {
    return { kind: "skip", decision: emptyDecision(trackedCoinId, { kind: "unavailable", reason: "primary-unusable" }) };
  }
  // Unavailable supply (asset buckets absent/empty/invalid) cannot assess the live-event floor: keep an
  // open event open and unchanged, and open nothing new. Only an observed sub-floor supply (including an
  // explicit zero) closes with `coverage-lost-supply` (CR-13 / D03-2).
  const supply = getCirculatingRawOrNull(asset);
  if (supply == null) {
    const decision = emptyDecision(trackedCoinId, { kind: "unavailable", reason: "supply-unavailable" });
    if (existing) {
      decision.seenEventIds.push(existing.id);
      decision.diagnostics.push(withDiagnostic(
        "warn",
        `[depeg] Kept live event for ${asset.symbol} open: current supply is unavailable, ` +
        "so the live-event floor cannot be assessed",
      ));
    }
    return { kind: "skip", decision };
  }
  if (supply < DEPEG_EVENT_MIN_SUPPLY_USD && !existing) {
    return { kind: "skip", decision: emptyDecision(trackedCoinId, { kind: "below-floor" }) };
  }

  const pegSignal = deriveAuthoritativePegSignal({
    price: observedPrice,
    assetId: asset.id, commodityEntitlement: asset.commodityEntitlement, quoteObservedAtSec: sourceObservationClock(asset),
    pegCurrency: meta.flags.pegCurrency,
    pegType: asset.pegType,
    pegRates: input.pegRates,
    pegRateSources: input.pegRateSources,
    pegRateCounts: input.pegRateCounts,
    commodityOunces: meta.commodityOunces,
  });
  const defaultThreshold = getDepegThresholdBps(asset.pegType);
  const recoveryThreshold = getDepegRecoveryThresholdBps(asset.pegType);
  const reference = assessDetectionReference({ ...input, meta, signal: pegSignal.kind === "signal" ? pegSignal.signal : null });
  const existingNative = existing != null && isNativePegEvent(existing);
  const existingPeer = parsePendingReason(existing?.pending_reason).has("peer-relative");
  const observationBoundary = Math.max(reference?.boundary ?? 0, existing?.started_at ?? 0, existing?.last_trusted_price_at ?? 0);
  const usableNative = native && native.quote.updatedAt >= observationBoundary ? native : null;
  const independentNativeEvidence = usableNative && isIndependentVenue(asset, usableNative.venue) ? usableNative : null;
  const benchmark = benchmarkAdmission(reference, pegSignal.kind === "signal" ? pegSignal.signal : null,
    independentNativeEvidence, defaultThreshold);
  const directAdmitted = benchmark != null && pegSignal.kind === "signal";
  const peerMove = reference && canPersistPeerEvents(input) && (existingPeer || !directAdmitted) && !existingNative
    ? assessIndependentPeerMove({ reference, asset, native: usableNative, pools: input.challengerPools, threshold: defaultThreshold,
      recoveryThreshold: existing ? recoveryThreshold : undefined, now })
    : null;
  const independentNative = usableNative && (existingNative ||
    (!directAdmitted && !peerMove && (signalCrossesThreshold(usableNative.signal, defaultThreshold) ||
      (existing != null && signalIsWithinThreshold(usableNative.signal, recoveryThreshold)))))
    ? usableNative : null;
  const scheduledReferenceUnusable = reference != null && !directAdmitted && !peerMove && !independentNative;
  if (scheduledReferenceUnusable) {
    if (reference.legacyClosureHeld) {
      const decision = emptyDecision(trackedCoinId, { kind: "unavailable", reason: "reference-market-closed" });
      if (existing) decision.seenEventIds.push(existing.id);
      return { kind: "skip", decision };
    }
    // Keep a clocked extreme trade as a candidate. It has no lifecycle vote until independently confirmed.
    const extreme = !existing && reference.closed && !reference.peer
      ? getTradedNativeEvidence(nativeQuote, now, true) : null;
    if (extreme && extreme.quote.updatedAt >= reference.boundary && !native) {
      const flags: PendingDepegReasonFlag[] = ["confirmation-window", "low-confidence"];
      if (supply >= DEPEG_CONFIRMATION_SUPPLY_THRESHOLD) flags.push("large-cap");
      if (signalCrossesThreshold(extreme.signal, DEPEG_EXTREME_MOVE_BPS)) flags.push("extreme-move");
      const decision = emptyDecision(trackedCoinId, { kind: "observed" });
      decision.commands.push(buildPendingCommand(asset, now, extreme.quote.updatedAt, extreme.signal.direction, extreme.signal,
        extreme.quote.price, 1, markNativeOriginPending(buildPendingReason(flags)), undefined, extreme.venue));
      return { kind: "skip", decision };
    }
    const reason = existingNative ? "native-quote-unavailable"
      : reference?.closureHeld ? "reference-market-closed"
      : pegSignal.kind === "rejected" ? pegSignal.reason : "invalid-reference";
    const decision = emptyDecision(trackedCoinId, supply < DEPEG_EVENT_MIN_SUPPLY_USD
      ? { kind: "below-floor" } : { kind: "unavailable", reason });
    if (existing && reference.quoteInSession && decision.observation?.kind === "unavailable") {
      const market = getReferenceMarket(meta.flags.pegCurrency);
      const session = market && getReferenceSessionState(market, now);
      const fx = reference.verdict;
      const prior = readDepegReferenceHold(existing);
      const previous = rowPriceCoverage(existing);
      if (prior && session && isCurrentPegReferenceHold(prior.hold, now) && fx.source === prior.source &&
        (session.open ? session.sessionOpenedAtSec : session.nextOpenSec) === prior.reopenAt &&
        ((fx.referenceObservedAtSec === prior.referenceAt && ["reference-market-closed", "reference-over-budget",
          "quote-reference-unpaired", "reference-before-reopen"].includes(fx.reason)) || fx.reason === "reference-not-repriced")) {
        decision.referenceHold = { ...prior, hold: { ...prior.hold, refreshedAtSec: now } };
      } else if (reason === "reference-market-closed" && session && !session.open && fx.source && fx.referenceObservedAtSec &&
        previous?.lastTrustedObservationAt != null && previous.gapStartedAt == null && previous.lastObservationKind !== "trusted-at-par" &&
        now >= previous.lastTrustedObservationAt && now - previous.lastTrustedObservationAt <= DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC) {
        decision.referenceHold = { source: fx.source, referenceAt: fx.referenceObservedAtSec, reopenAt: session.nextOpenSec,
          hold: { reason: "reference-market-closed", declaredAtSec: now, lastTrustedAtSec: previous.lastTrustedObservationAt,
            lastTrustedPeakBps: existing.peak_deviation_bps } };
      }
    }
    if (reference && !reference.closureHeld && reason === "invalid-reference") {
      decision.diagnostics.push(withDiagnostic("warn", `[depeg] Withheld reference for ${asset.symbol}: ${reference.verdict.reason}`));
    }
    if (reason === "non-authoritative-reference") {
      decision.diagnostics.push(withDiagnostic("warn", `[depeg] Skipped live-state mutation for ${asset.symbol}: ` +
        `thin ${meta.flags.pegCurrency} peg reference lacks FX fallback`));
    }
    if (existing) {
      decision.seenEventIds.push(existing.id);
      if (existing.recovery_first_seen_at != null || existing.recovery_last_seen_at != null) {
        decision.commands.push({ type: "clear-recovery", id: existing.id });
      }
    }
    return { kind: "skip", decision };
  }
  if (primaryTrust === "unusable" && !independentNative) {
    return { kind: "skip", decision: emptyDecision(trackedCoinId, { kind: "unavailable", reason: "primary-unusable" }) };
  }
  if (existing && supply < DEPEG_EVENT_MIN_SUPPLY_USD && (reference == null ||
    (reference.verdict.status === "admitted" && (!reference.closed || reference.closedTradedMedian)))) {
    const decision = emptyDecision(trackedCoinId, { kind: "below-floor" });
    decision.commands.push({
      type: "close-event",
      id: existing.id,
      endedAt: now,
      recoveryPrice: null,
      closeReason: "coverage-lost-supply",
    });
    decision.diagnostics.push(withDiagnostic(
      "log",
      `[depeg] Closing live event for ${asset.symbol}: ` +
      `supply $${Math.round(supply).toLocaleString("en-US")} is below the live-event floor`,
    ));
    return { kind: "skip", decision };
  }

  if (pegSignal.kind === "rejected" && !peerMove && !independentNative) {
    return { kind: "skip", decision: emptyDecision(trackedCoinId, { kind: "unavailable", reason: pegSignal.reason }) };
  }

  const threshold = peerMove || independentNative || existingNative ? defaultThreshold : benchmark?.threshold ?? defaultThreshold;
  const pegRef = independentNative ? 1 : peerMove?.pegReference ?? (pegSignal.kind === "signal" ? pegSignal.pegReference : 1);
  const primarySignal = independentNative?.signal ?? peerMove?.signal ?? (pegSignal.kind === "signal" ? pegSignal.signal : independentNative!.signal);
  const price = independentNative?.quote.price ?? peerMove?.price ?? observedPrice;
  const { bps, absBps, direction } = primarySignal;
  const rawAbsBps = primarySignal.absRawBps;
  const observedNative = getClockedTradedNativeQuote(nativeQuote, now, observationBoundary);
  const clockedNative = observedNative && (existingNative || independentNative || isIndependentVenue(asset, observedNative.derivation?.lineage.venue))
    ? observedNative : undefined;
  const rawNativeSignal = clockedNative ? deriveDepegSignal(clockedNative.price, 1) : null;
  const isUsdObservationAdmitted = (value: number, observedAt: number | null | undefined, quoteMaxAgeSec: number) => {
    if (asset.id === "xagm-matrixdock" && observedAt !== asset.commodityEntitlement?.quoteObservedAtSec) return false;
    if (!reference) return true;
    const signal = deriveDepegSignal(value, pegRef);
    const verdict = assessDetectionReference({ ...input, meta, signal, quoteObservedAt: observedAt ?? null,
      quoteMaxAgeSec, cohort: reference.peer });
    return benchmarkAdmission(verdict, signal, independentNativeEvidence, defaultThreshold) != null;
  };
  // Independent quotes have already been assessed on their own basis. USD DEX quotes
  // against a held reference cannot veto or extend their lifecycle.
  const dexInput = peerMove || !directAdmitted || independentNative
    ? { ...input, dexRow: undefined, protocolSources: undefined, challengerPools: undefined }
    : reference ? {
      ...input,
      dexRow: input.dexRow && isUsdObservationAdmitted(input.dexRow.dex_price_usd, input.dexRow.aggregateObservedAt, DEX_FRESHNESS_SEC) ? input.dexRow : undefined,
      protocolSources: input.protocolSources?.filter((row) => isUsdObservationAdmitted(row.price, row.observedAt, DEX_PROTOCOL_SOURCE_FRESHNESS_SEC)),
      challengerPools: input.challengerPools?.filter((row) => isUsdObservationAdmitted(row.price, row.observedAt, DEX_PROTOCOL_SOURCE_FRESHNESS_SEC)),
    } : input;
  const dexEvidence = deriveDexEvidence({ input: dexInput, existing, now, pegRef, threshold, recoveryThreshold, direction });
  const {
    dexAbsBps,
    dexDirectionProtocolCount,
    dexExistingDirectionProtocolCount,
    dexRecoveryProtocolCount,
    dexRecoveryChallenged,
    poolRecoveryVeto,
    poolRecoveryVetoGroupCount,
    poolRecoveryVetoCorroboratingGroupCount,
    poolRecoveryVetoHighTvl,
    dexSupportsDirection,
    dexSupportsExistingDirection,
    dexSupportsRecovery,
  } = dexEvidence;
  const sourceDepth = getPrimarySourceDepth(primaryEvidence);
  const nativeQuoteImplausibility = clockedNative
    ? classifyNativeQuoteImplausibility({
        price: clockedNative.price,
        stablecoinId: trackedCoinId,
        pegCurrency: meta.flags.pegCurrency,
        pegType: asset.pegType,
      })
    : null;
  const nativeQuoteCorroborated =
    nativeQuoteImplausibility?.corroborationCanAdmit === true &&
    rawNativeSignal != null &&
    dexCorroboratesNativeImplausibleMove({
      input: dexInput,
      pegRef,
      direction: rawNativeSignal.direction,
      now,
      stablecoinId: trackedCoinId,
      pegType: asset.pegType,
    });
  const withheldNativeQuote =
    nativeQuoteImplausibility != null && !(nativeQuoteCorroborated && input.dexRow != null &&
      isAffirmativeDexPriceRow(input.dexRow, now, "depeg")) ? nativeQuoteImplausibility : null;
  // Legacy events recorded in native units can recover when a separately traded
  // USD mark and this unit's admitted FX rate measure the same observation.
  const fx = reference?.verdict;
  const translatedRecovery = existingNative && !clockedNative && !existingPeer && !reference?.closed &&
    fx?.status === "admitted" && fx.reason === "live-reference" && fx.kind === "fx" &&
    normalizePegType(existing.peg_type) === normalizePegType(asset.pegType) &&
    normalizePegType(asset.pegType) === normalizePegTypeFromCurrency(meta.flags.pegCurrency) &&
    pegSignal.kind === "signal" && observedPrice != null &&
    independentlyPricedUsdMark(input) &&
    signalIsWithinThreshold(pegSignal.signal, recoveryThreshold) &&
    now - Math.min(fx.referenceObservedAtSec, fx.quoteObservedAtSec) <= DEPEG_PRIMARY_PRICE_MAX_AGE_SEC
    ? { price: observedPrice / pegSignal.pegReference, observedAt: Math.min(fx.quoteObservedAtSec, fx.referenceObservedAtSec),
        usdObservedAt: fx.quoteObservedAtSec }
    : null;
  const nativeSignal = translatedRecovery ? deriveDepegSignal(translatedRecovery.price, 1)
    : withheldNativeQuote == null ? rawNativeSignal : null;
  const nativeVetoSignal = nativeQuoteImplausibility == null || nativeQuoteCorroborated ? rawNativeSignal : null;
  const tieredMarketCapRequiresConfirmation = requiresTieredMarketCapConfirmation({
    supply,
    sourceDepth,
    absBps: rawAbsBps,
    threshold,
  });
  const primarySupportsRecovery =
    primaryTrust === "authoritative" ||
    hasFreshMultiSourcePrimaryAgreement(primaryEvidence, now);
  const reasonFlags: PendingDepegReasonFlag[] = ["confirmation-window"];
  if (primaryTrust !== "unusable" && rawAbsBps >= DEPEG_EXTREME_MOVE_BPS) reasonFlags.push("extreme-move");
  if (tieredMarketCapRequiresConfirmation) reasonFlags.push("large-cap");
  if (primaryTrust === "confirm_required") reasonFlags.push("low-confidence");
  if (peerMove) reasonFlags.push("peer-relative", "low-confidence");
  const pendingReason: PendingDepegReason = buildPendingReason(reasonFlags);

  return {
    kind: "context",
    ctx: {
      trackedCoinId,
      now,
      asset,
      primarySignal,
      price: price!,
      bps,
      absBps,
      rawAbsBps,
      direction,
      threshold,
      nativeThreshold: defaultThreshold,
      recoveryThreshold,
      pegRef,
      supply,
      primaryTrust,
      dexRow: dexInput.dexRow,
      observedDexRow: input.dexRow,
      dexAbsBps,
      dexDirectionProtocolCount,
      dexExistingDirectionProtocolCount,
      dexRecoveryProtocolCount,
      dexRecoveryChallenged,
      poolRecoveryVeto,
      poolRecoveryVetoGroupCount,
      poolRecoveryVetoCorroboratingGroupCount,
      poolRecoveryVetoHighTvl,
      dexSupportsDirection,
      dexSupportsExistingDirection,
      dexSupportsRecovery,
      primarySupportsRecovery: peerMove != null || primarySupportsRecovery,
      pendingReason,
      benchmarkAdmission: peerMove || independentNative ? undefined : benchmark?.admission,
      nativeSignal: peerMove ? null : nativeSignal,
      nativeVetoSignal: peerMove ? null : nativeVetoSignal,
      nativePegPrice: peerMove || nativeSignal == null ? null : translatedRecovery?.price ?? clockedNative?.price ?? null,
      independentNativeOnset: !existing && independentNative != null,
      quoteObservedAt: sourceObservationClock(asset),
      nativeObservedAt: translatedRecovery?.observedAt ?? clockedNative?.updatedAt,
      translatedUsdObservedAt: translatedRecovery?.usdObservedAt,
      nativeVenue: independenceKey(clockedNative?.derivation?.lineage.venue) || undefined,
      independentNativeBasis: independentNative != null,
      closedSessionEvidence: reference?.closed === true && (independentNative != null || peerMove != null || directAdmitted),
      peerMove: peerMove ?? undefined,
      nativePegCurrency: input.nativePegQuote?.pegCurrency ?? meta.flags.pegCurrency,
      nativeQuoteImplausibility: withheldNativeQuote,
    },
  };
}

/**
 * Allows fresh native-fiat quotes to initiate supported non-USD pending
 * depeg state when the USD-vs-reference primary path is still inside threshold.
 */
function decideNewNativePegDepeg(ctx: DecisionContext): Omit<DepegAssetDecision, "trackedCoinId"> | null {
  if (
    ctx.nativeSignal == null ||
    ctx.nativePegPrice == null ||
    !signalCrossesThreshold(ctx.nativeSignal, ctx.threshold) ||
    (!ctx.independentNativeOnset && ctx.rawAbsBps >= ctx.threshold)
  ) {
    return null;
  }

  const commands: DepegPersistenceCommand[] = [];
  const diagnostics: DepegDiagnostic[] = [];
  const reasonFlags: PendingDepegReasonFlag[] = ["confirmation-window"];
  if (ctx.independentNativeOnset) reasonFlags.push("low-confidence");
  if (ctx.supply >= DEPEG_CONFIRMATION_SUPPLY_THRESHOLD) reasonFlags.push("large-cap");
  if (signalCrossesThreshold(ctx.nativeSignal, DEPEG_EXTREME_MOVE_BPS)) reasonFlags.push("extreme-move");

  const pendingReason = markNativeOriginPending(buildPendingReason(reasonFlags));
  commands.push(buildPendingCommand(
    ctx.asset,
    ctx.now,
    ctx.nativeObservedAt,
    ctx.nativeSignal.direction,
    ctx.nativeSignal,
    ctx.nativePegPrice,
    1,
    pendingReason,
    undefined,
    ctx.nativeVenue,
  ));
  diagnostics.push(withDiagnostic(
    "log",
    `[depeg] Pending native-peg confirmation for ${ctx.asset.symbol}: ` +
    `${ctx.nativeSignal.bps}bps against ${ctx.nativePegCurrency ?? "native"} quote`,
  ));
  return { seenEventIds: [], commands, diagnostics };
}

/**
 * Handles an existing open event where deviation still exceeds threshold.
 * Covers same-direction peak updates and direction changes.
 */
function decideExistingEvent(
  ctx: DecisionContext,
  existing: DepegDetectionRow,
): Omit<DepegAssetDecision, "trackedCoinId"> {
  const {
    now,
    asset,
    price,
    threshold,
    primaryTrust,
    dexRow,
    dexAbsBps,
    dexSupportsDirection,
    pendingReason,
  } = ctx;
  const commands: DepegPersistenceCommand[] = [];
  const seenEventIds: number[] = [];
  const diagnostics: DepegDiagnostic[] = [];
  const nativeEvent = isNativePegEvent(existing) || ctx.independentNativeBasis;
  const eventSignal = nativeEvent ? ctx.nativeSignal : ctx.primarySignal;
  const eventPrice = nativeEvent ? ctx.nativePegPrice : price;
  if (eventSignal == null || eventPrice == null) {
    return { seenEventIds: [existing.id], commands, diagnostics };
  }
  const quoteClock = nativeEvent ? ctx.nativeObservedAt : ctx.quoteObservedAt;
  if (quoteClock != null && (quoteClock < Math.max(existing.started_at, existing.last_trusted_price_at ?? 0) ||
      (existing.direction !== eventSignal.direction && quoteClock === existing.started_at))) return { seenEventIds: [existing.id], commands, diagnostics };
  const observedAt = quoteClock ?? now;
  const { bps, direction } = eventSignal;
  const pegRef = nativeEvent ? 1 : ctx.pegRef;

  // Direction change: retire the live row only on authoritative contradiction
  // or corroborated same-direction DEX support for the replacement move.
  if (existing.direction !== direction) {
    if (nativeEvent || ctx.peerMove || primaryTrust === "authoritative" || dexSupportsDirection) {
      commands.push({
        type: "close-event",
        id: existing.id,
        endedAt: observedAt,
        recoveryPrice: null,
        closeReason: "superseded-direction",
      });
      commands.push(buildPendingCommand(
        asset,
        now,
        observedAt,
        direction,
        eventSignal,
        eventPrice,
        pegRef,
        nativeEvent ? markNativeOriginPending(pendingReason) : pendingReason,
        ctx.peerMove?.receipt,
        nativeEvent ? ctx.nativeVenue : undefined,
        nativeEvent ? undefined : ctx.benchmarkAdmission,
      ));
    } else if (primaryTrust === "confirm_required") {
      seenEventIds.push(existing.id);
      diagnostics.push(withDiagnostic(
        "warn",
        `[depeg] Kept live event for ${asset.symbol} (id=${existing.id}) through ` +
        `confirm-required opposite reading: existing=${existing.direction}, ` +
        `primary=${direction} (${bps}bps)`,
      ));
    } else {
      seenEventIds.push(existing.id);
    }
    return { seenEventIds, commands, diagnostics };
  }

  // Same direction - event stays open.
  seenEventIds.push(existing.id);
  if (existing.recovery_first_seen_at != null || existing.recovery_last_seen_at != null) {
    commands.push({ type: "clear-recovery", id: existing.id });
  }
  const peakUpdate = resolvePeakUpdateCommand({
    existing,
    nativeObservation: nativeEvent,
    nativeSignal: ctx.nativeSignal,
    nativePegPrice: ctx.nativePegPrice,
    primarySignal: ctx.primarySignal,
    primaryPrice: price,
    primaryTrust,
    dexSupportsDirection: ctx.peerMove != null || dexSupportsDirection,
  });
  const peakObservedAt = nativeEvent ? ctx.nativeObservedAt : ctx.quoteObservedAt;
  if (peakUpdate && nativeEvent === isNativePegEvent(existing)) commands.push({
    ...peakUpdate,
    peakPegReference: pegRef,
    peakQuoteDomain: nativeEvent ? "native-peg" : "usd",
    ...((ctx.peerMove || nativeEvent || existing.peer_basis_json) ? { peakReceipt: JSON.stringify(peakObservedAt == null ? null : {
      basis: nativeEvent ? "native-peg" : ctx.peerMove ? "peer-relative" : "benchmark",
      observedAt: peakObservedAt,
      price: eventPrice,
      pegReference: pegRef,
      bps: eventSignal.rawBps,
      ...(nativeEvent ? { venue: ctx.nativeVenue }
        : ctx.peerMove ? { corroboration: JSON.parse(ctx.peerMove.receipt) as unknown } : {}),
    }) } : {}),
  });

  // Keep the event open when the current primary sample still shows a same-direction depeg.
  // Aggregate DEX disagreement can still suppress brand-new events and confirm recoveries,
  // but it should not manufacture a recovery boundary on an already-open event.
  if (isDexFresh(dexRow, dexAbsBps, now) && dexRow && dexAbsBps != null && dexAbsBps < threshold) {
    const eventAge = now - existing.started_at;
    diagnostics.push(withDiagnostic(
      "warn",
      `[depeg] DEX disagrees with ongoing event for ${asset.symbol}: ` +
      `primary=${bps}bps vs DEX=${dexAbsBps}bps (event age ${Math.round(eventAge / 60)}min); ` +
      "keeping event open until the recovery path confirms resolution",
    ));
  }

  return { seenEventIds, commands, diagnostics };
}

/**
 * Handles opening a new depeg event when no existing event is open.
 * Applies DEX cross-validation, then routes every onset through pending confirmation.
 */
function decideNewDepeg(ctx: DecisionContext): Omit<DepegAssetDecision, "trackedCoinId"> {
  const {
    now,
    asset,
    bps,
    direction,
    pegRef,
    dexRow,
    dexAbsBps,
    dexSupportsRecovery,
    pendingReason,
  } = ctx;
  const commands: DepegPersistenceCommand[] = [];
  const diagnostics: DepegDiagnostic[] = [];

  if (isDexFresh(dexRow, dexAbsBps, ctx.now) && dexRow && dexSupportsRecovery) {
    diagnostics.push(withDiagnostic(
      "log",
      `[depeg] Suppressed new event for ${asset.symbol}: ` +
      `primary=${bps}bps but DEX=${dexAbsBps}bps (${dexRow.source_pool_count} pools, ` +
      `$${(dexRow.source_total_tvl / 1e6).toFixed(1)}M TVL)`,
    ));
    return { seenEventIds: [], commands, diagnostics };
  }

  commands.push(buildPendingCommand(asset, now, ctx.quoteObservedAt, direction, ctx.primarySignal, ctx.price, pegRef, pendingReason,
    ctx.peerMove?.receipt, undefined, ctx.benchmarkAdmission));
  diagnostics.push(withDiagnostic("log", `[depeg] Pending confirmation for ${asset.symbol}: ${bps}bps (${pendingReason})`));
  return { seenEventIds: [], commands, diagnostics };
}

/**
 * How long a confirm-required single-source primary must stay inside the recovery
 * band before it may retire an event that has no trusted corroboration at all.
 */
const DEPEG_SUSTAINED_PRIMARY_RECOVERY_SEC = 24 * 3_600;

/**
 * A CoinGecko-only primary can never be depeg-authoritative and its DEX liquidity may
 * stay below the aggregate floor, so neither trusted recovery lane can ever fire. A
 * full day of continuous in-band observations is the only admissible evidence there;
 * any contradiction (a fresh trusted DEX price outside the band, any challenger pool still
 * past the threshold in the event's direction, or an admitted native quote outside the band)
 * keeps today's clear-recovery behaviour.
 */
function isSustainedPrimaryRecoveryEligible(ctx: DecisionContext, existing: DepegDetectionRow): boolean {
  const { asset, now, primaryTrust, recoveryThreshold } = ctx;
  return !isNativePegEvent(existing) &&
    primaryTrust === "confirm_required" &&
    asset.priceSource !== "cached" && asset.priceObservedAtMode === "upstream" &&
    (asset.priceConfidence === "single-source" || asset.priceConfidence === "high") &&
    getPrimaryPriceAgeSec(asset, now) <= DEPEG_PRIMARY_PRICE_MAX_AGE_SEC &&
    signalIsWithinThreshold(ctx.primarySignal, recoveryThreshold) &&
    // A liquid DEX lane whose evidence is stale or unclocked is missing evidence, not an
    // absence of contradiction.
    !(ctx.observedDexRow != null && ctx.observedDexRow.source_total_tvl >= DEX_PRICE_CHECK_DEPEG_MIN_TVL_USD &&
      (ctx.dexRow == null || !isAffirmativeDexPriceRow(ctx.dexRow, now, "depeg"))) &&
    !(ctx.dexRow != null && isDexFresh(ctx.dexRow, ctx.dexAbsBps, now) &&
      !signalIsWithinThreshold(deriveDepegSignal(ctx.dexRow.dex_price_usd, ctx.pegRef), recoveryThreshold)) &&
    !ctx.poolRecoveryVeto && !ctx.dexRecoveryChallenged &&
    (ctx.nativeSignal == null || signalIsWithinThreshold(ctx.nativeSignal, recoveryThreshold));
}

/**
 * Handles an existing open event where price has recovered below threshold.
 * Closes via an authoritative/multi-source primary, a corroborated aggregate
 * DEX row, a corroborating challenger-pool majority, or a day of sustained
 * single-source recovery; otherwise keeps open.
 */
function decideRecovery(
  ctx: DecisionContext,
  existing: DepegDetectionRow,
): Omit<DepegAssetDecision, "trackedCoinId"> {
  const {
    now,
    asset,
    price,
    primarySupportsRecovery,
    recoveryThreshold,
    dexRow,
    dexAbsBps,
    dexExistingDirectionProtocolCount,
    dexRecoveryProtocolCount,
    dexRecoveryChallenged,
    poolRecoveryVeto,
    poolRecoveryVetoGroupCount,
    poolRecoveryVetoCorroboratingGroupCount,
    poolRecoveryVetoHighTvl,
    dexSupportsExistingDirection,
    dexSupportsRecovery,
  } = ctx;
  const commands: DepegPersistenceCommand[] = [];
  const seenEventIds: number[] = [];
  const diagnostics: DepegDiagnostic[] = [];
  const directRecovery = resolveDirectRecovery({
    existing,
    nativeSignal: ctx.nativeSignal,
    nativePegPrice: ctx.nativePegPrice,
    primarySignal: ctx.primarySignal,
    primaryPrice: price,
    recoveryThreshold,
    primarySupportsRecovery: primarySupportsRecovery && !ctx.independentNativeBasis,
    primaryRecoveryContradicted:
      (isDexFresh(dexRow, dexAbsBps, now) && dexSupportsExistingDirection) || poolRecoveryVeto,
  });

  // Publication-fresh aggregates retain vetoes, but only original clocks can prove recovery.
  const trustedAggregateDexLane = dexRow != null && isAffirmativeDexPriceRow(dexRow, now, "depeg");
  const aggregateDexRecovery = trustedAggregateDexLane && dexSupportsRecovery && dexRow.aggregateObservedAt != null &&
    dexRow.aggregateObservedAt >= Math.max(existing.started_at, existing.last_trusted_price_at ?? 0);
  // Challenger snapshots retain their publication clock, not the original
  // pool-price observation clock. They can veto recovery conservatively but
  // cannot establish fresh positive recovery evidence.
  const sustainedPrimary = isSustainedPrimaryRecoveryEligible(ctx, existing);
  const primaryObservedAt = ctx.quoteObservedAt ?? now;
  const primaryLastAt = existing.recovery_last_seen_at;
  const primaryFirstAt = existing.recovery_first_seen_at;
  const primaryContinues = existing.recovery_evidence_source == null && existing.recovery_usd_observed_at == null &&
    existing.recovery_usd_first_seen_at == null && primaryFirstAt != null && primaryLastAt != null &&
    primaryObservedAt - primaryLastAt <= DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC;
  const primaryReady = sustainedPrimary && primaryContinues && (ctx.quoteObservedAt == null || primaryObservedAt > primaryLastAt) &&
    primaryObservedAt - primaryFirstAt >= DEPEG_SUSTAINED_PRIMARY_RECOVERY_SEC;
  const recovery = directRecovery ?? (
    aggregateDexRecovery && dexRow && !primaryReady
      ? {
          recoveryPrice: recoveryPriceForEvent(existing, dexRow.dex_price_usd),
          closeReason: "recovered-dex" as const,
        }
      : null
  );

  if (recovery) {
    const source = recovery.closeReason === "recovered-dex" ? "dex"
      : recovery.closeReason === "recovered-native" ? "native" : null;
    const quoteClock = source === "dex" ? dexRow?.aggregateObservedAt
      : source === "native" ? ctx.nativeObservedAt : ctx.quoteObservedAt;
    if ((source != null && quoteClock == null) ||
        (quoteClock != null && quoteClock < Math.max(existing.started_at, existing.last_trusted_price_at ?? 0))) {
      return { seenEventIds: [existing.id], commands, diagnostics };
    }
    const observedAt = quoteClock ?? now;
    const usdObservedAt = source === "native" ? ctx.translatedUsdObservedAt : undefined;
    const firstUsdAt = existing.recovery_usd_first_seen_at;
    const lastUsdAt = existing.recovery_usd_observed_at;
    const sameLane = source === (existing.recovery_evidence_source ?? null)
      && (usdObservedAt == null ? firstUsdAt == null && lastUsdAt == null
        : firstUsdAt != null && lastUsdAt != null && firstUsdAt <= lastUsdAt);
    const recoveryFirstSeenAt = sameLane ? existing.recovery_first_seen_at : null;
    const recoveryLastSeenAt = sameLane ? existing.recovery_last_seen_at : null;
    // A new FX round cannot turn one token trade into two recovery observations.
    if (sameLane && usdObservedAt != null && lastUsdAt != null && (usdObservedAt <= lastUsdAt
      || (recoveryLastSeenAt != null && observedAt <= recoveryLastSeenAt))) {
      return { seenEventIds: [existing.id], commands, diagnostics };
    }
    const continuousWithPrevious =
      recoveryLastSeenAt != null && observedAt - recoveryLastSeenAt <= DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC
      && (usdObservedAt == null || (lastUsdAt != null && usdObservedAt - lastUsdAt <= DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC));
    if (recoveryFirstSeenAt == null || !continuousWithPrevious) {
      commands.push({ type: "begin-recovery", id: existing.id, firstSeenAt: observedAt, lastSeenAt: observedAt,
        ...(source ? { source } : {}), ...(usdObservedAt != null ? { usdObservedAt } : {}) });
      seenEventIds.push(existing.id);
    } else if (quoteClock != null && observedAt <= recoveryLastSeenAt) {
      seenEventIds.push(existing.id);
    } else if (observedAt - recoveryFirstSeenAt >= DEPEG_PENDING_MIN_AGE_SEC
      && (usdObservedAt == null || (firstUsdAt != null && usdObservedAt - firstUsdAt >= DEPEG_PENDING_MIN_AGE_SEC))) {
      commands.push({
        type: "close-event",
        id: existing.id,
        endedAt: now,
        ...recovery,
        recoveryPegReference: recovery.recoveryPrice == null ? null : isNativePegEvent(existing) ? 1 : ctx.pegRef,
      });
    } else {
      commands.push({ type: "continue-recovery", id: existing.id, lastSeenAt: observedAt,
        ...(usdObservedAt != null ? { usdObservedAt } : {}) });
      seenEventIds.push(existing.id);
    }
  } else if (sustainedPrimary) {
    const observedAt = primaryObservedAt;
    if (ctx.quoteObservedAt != null && observedAt < Math.max(existing.started_at, existing.last_trusted_price_at ?? 0)) {
      return { seenEventIds: [existing.id], commands, diagnostics };
    }
    if (!primaryContinues) {
      commands.push({ type: "begin-recovery", id: existing.id, firstSeenAt: observedAt, lastSeenAt: observedAt });
      seenEventIds.push(existing.id);
    } else if (ctx.quoteObservedAt != null && observedAt <= primaryLastAt) {
      seenEventIds.push(existing.id);
    } else if (primaryReady) {
      commands.push({
        type: "close-event",
        id: existing.id,
        endedAt: now,
        recoveryPrice: recoveryPriceForEvent(existing, price),
        recoveryPegReference: isNativePegEvent(existing) ? null : ctx.pegRef,
        closeReason: "recovered-primary",
      });
      diagnostics.push(withDiagnostic(
        "log",
        `[depeg] Closing live event for ${asset.symbol} after ` +
        `${DEPEG_SUSTAINED_PRIMARY_RECOVERY_SEC / 3_600} h of sustained single-source recovery`,
      ));
    } else {
      commands.push({ type: "continue-recovery", id: existing.id, lastSeenAt: observedAt });
      seenEventIds.push(existing.id);
    }
  } else {
    seenEventIds.push(existing.id);
    if (existing.recovery_first_seen_at != null || existing.recovery_last_seen_at != null) {
      commands.push({ type: "clear-recovery", id: existing.id });
    }
    if (isDexFresh(dexRow, dexAbsBps, now) && dexSupportsExistingDirection) {
      diagnostics.push(withDiagnostic(
        "warn",
        `[depeg] Kept ${asset.symbol} open despite primary recovery: ` +
        `primary recovery is contradicted by ${dexExistingDirectionProtocolCount} ` +
        `DEX protocol group(s) still showing the ${existing.direction} depeg`,
      ));
    } else if (poolRecoveryVeto) {
      diagnostics.push(withDiagnostic(
        "warn",
        `[depeg] Kept ${asset.symbol} open despite primary recovery: ` +
        `pool challengers still show the ${existing.direction} depeg ` +
        `(groups=${poolRecoveryVetoGroupCount}, corroborating=${poolRecoveryVetoCorroboratingGroupCount}, ` +
        `highTvl=${poolRecoveryVetoHighTvl})`,
      ));
    } else if (isDexFresh(dexRow, dexAbsBps, now) && dexRow && dexAbsBps != null && dexAbsBps <= recoveryThreshold) {
      diagnostics.push(withDiagnostic(
        "warn",
        `[depeg] Ignored aggregate DEX recovery for ${asset.symbol}: ` +
        `${dexRecoveryProtocolCount} corroborating protocol group(s), ` +
        `challenged=${dexRecoveryChallenged}; keeping event open until corroborated recovery appears`,
      ));
    }
  }

  return { seenEventIds, commands, diagnostics };
}

function decideRecoveryDeadband(existing: DepegDetectionRow): Omit<DepegAssetDecision, "trackedCoinId"> {
  return {
    seenEventIds: [existing.id],
    commands: existing.recovery_first_seen_at == null && existing.recovery_last_seen_at == null
      ? []
      : [{ type: "clear-recovery", id: existing.id }],
    diagnostics: [],
  };
}

function withPriceCoverage(
  decision: DepegAssetDecision,
  input: DepegAssetDecisionInput,
  ctx?: DecisionContext,
): DepegAssetDecision {
  if (!input.existing) return decision;
  const native = isNativePegEvent(input.existing) || ctx?.independentNativeBasis === true;
  const signal = native ? ctx?.nativeSignal : ctx?.primarySignal;
  const trustedOffPeg = ctx != null && signal != null &&
    signal.direction === input.existing.direction &&
    !signalIsWithinThreshold(signal, ctx.recoveryThreshold) &&
    (native || ctx.primarySupportsRecovery || (ctx.dexSupportsExistingDirection &&
      ctx.dexRow != null && isAffirmativeDexPriceRow(ctx.dexRow, input.now, "depeg"))) &&
    // A native quote that contradicts the USD reading cannot sustain that reading.
    (native || ctx.nativeSignal == null || !signalIsWithinThreshold(ctx.nativeSignal, ctx.recoveryThreshold));
  const trustedAtPar = ctx != null && signal != null &&
    signalIsWithinThreshold(signal, ctx.recoveryThreshold) &&
    (native || (
      (ctx.primarySupportsRecovery || (ctx.dexSupportsRecovery && ctx.dexRow != null &&
        isAffirmativeDexPriceRow(ctx.dexRow, input.now, "depeg"))) &&
      !ctx.poolRecoveryVeto && !(ctx.dexSupportsExistingDirection && isDexFresh(ctx.dexRow, ctx.dexAbsBps, input.now))
    )) &&
    (native || ctx.nativeSignal == null || signalIsWithinThreshold(ctx.nativeSignal, ctx.recoveryThreshold));
  const trusted = trustedOffPeg || trustedAtPar;
  const observedAt = trusted && ctx
    ? native ? ctx.nativeObservedAt : ctx.primarySupportsRecovery ? ctx.quoteObservedAt ?? input.now : ctx.dexRow?.aggregateObservedAt
    : null;
  const repeatedUsdTrade = ctx?.translatedUsdObservedAt != null && input.existing.recovery_evidence_source === "native"
    && input.existing.recovery_usd_observed_at != null && ctx.translatedUsdObservedAt <= input.existing.recovery_usd_observed_at;
  const eligibleClock = !repeatedUsdTrade && observedAt != null && observedAt >= input.existing.started_at && observedAt <= input.now;
  const previous = rowPriceCoverage(input.existing);
  decision.priceCoverage = repeatedUsdTrade && previous ? previous : advanceDepegPriceCoverage(
    previous, eligibleClock ? observedAt : input.now,
    eligibleClock ? trustedOffPeg ? "trusted-off-peg" : "trusted-at-par" : "blind",
  );
  const recorded = readDepegAdmittedCoverage(input.existing);
  const closedAt = decision.commands.find((command) => command.type === "close-event" && command.id === input.existing!.id);
  if (trustedOffPeg && eligibleClock && decision.priceCoverage !== previous && decision.priceCoverage.lastTrustedObservationAt === observedAt &&
      (recorded !== undefined || ctx?.closedSessionEvidence)) {
    const market = getReferenceMarket(input.meta?.flags.pegCurrency);
    // When first instrumenting a legacy row, carry its measured, open-session intervals.
    const prior = recorded?.map(({ fromSec, toSec }): [number, number] => [fromSec, toSec]) ??
      depegObservedIntervals(rowToDepegEvent(input.existing),
        (previous?.intervals ?? []).flatMap(([start, end]) => scheduledPegClosures(market, start, end)));
    const lastTrusted = previous?.lastTrustedObservationAt;
    const continues = previous != null && lastTrusted != null && previous.gapStartedAt == null && previous.lastObservationKind !== "trusted-at-par" &&
      observedAt >= lastTrusted && observedAt - lastTrusted <= DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC &&
      prior.some(([start, end]) => start <= lastTrusted && end >= lastTrusted);
    decision.admittedCoverage = mergeDepegIntervals([...prior, [continues ? lastTrusted : observedAt, observedAt + 1]])
      .filter(([start, end]) => end > start).map(([fromSec, toSec]) => ({ fromSec, toSec }));
  }
  if (closedAt?.type === "close-event" && (decision.admittedCoverage || recorded)) {
    decision.admittedCoverage = (decision.admittedCoverage ?? recorded ?? []).filter(({ fromSec }) => fromSec < closedAt.endedAt)
      .map(({ fromSec, toSec }) => ({ fromSec, toSec: Math.min(toSec, closedAt.endedAt) }));
    delete decision.referenceHold;
  }
  // A notice cannot grant trust, close an event or mask a lifecycle command.
  const row = input.dexRow;
  const fallbackPeg = decision.observation?.kind !== "below-floor" && row && input.meta && !input.meta.flags.navToken
    ? deriveAuthoritativePegSignal({ assetId: input.asset.id, commodityEntitlement: input.asset.commodityEntitlement,
      quoteObservedAtSec: row.aggregateObservedAt, price: row.dex_price_usd, pegCurrency: input.meta.flags.pegCurrency,
      pegType: input.asset.pegType, pegRates: input.pegRates, pegRateSources: input.pegRateSources,
      pegRateCounts: input.pegRateCounts, commodityOunces: input.meta.commodityOunces }) : null;
  const fallbackAdmission = fallbackPeg?.kind === "signal" && input.meta
    ? assessDetectionReference({ ...input, meta: input.meta, signal: fallbackPeg.signal,
      quoteObservedAt: row?.aggregateObservedAt ?? null }) : null;
  const pegRef = fallbackPeg?.kind === "signal" && (fallbackAdmission == null ||
    (fallbackAdmission.verdict.status === "admitted" && (!fallbackAdmission.closed || fallbackAdmission.closedTradedMedian)))
    ? fallbackPeg.pegReference : null;
  const dex = row && pegRef ? deriveDepegSignal(row.dex_price_usd, pegRef) : null;
  if (!trustedOffPeg && !trustedAtPar && !native && pegRef && row && dex &&
    !decision.commands.some((command) => command.type === "close-event" || command.type === "delete-event") &&
    isAffirmativeDexPriceRow(row, input.now, "depeg") &&
    !signalIsWithinThreshold(dex, getDepegRecoveryThresholdBps(input.asset.pegType)) &&
    !signalCrossesThreshold(dex, getDepegThresholdBps(input.asset.pegType))) {
    const contributors = (input.protocolSources ?? []).flatMap((source) => {
      const signal = deriveDepegSignal(source.price, pegRef);
      if (!signal || !Number.isFinite(source.tvl) || source.tvl < 0 ||
        source.observedAt == null || source.observedAt <= 0 || source.observedAt > input.now ||
        input.now - source.observedAt > DEX_PROTOCOL_SOURCE_FRESHNESS_SEC ||
        source.aggregateObservedAt == null || source.aggregateObservedAt <= 0 || source.aggregateObservedAt > input.now ||
        input.now - source.aggregateObservedAt > DEX_FRESHNESS_SEC) return [];
      if (input.asset.id === "xagm-matrixdock" && source.observedAt !== input.asset.commodityEntitlement?.quoteObservedAtSec) return [];
      const admission = input.meta && assessDetectionReference({ ...input, meta: input.meta, signal, quoteObservedAt: source.observedAt });
      if (admission && (admission.verdict.status !== "admitted" || (admission.closed && !admission.closedTradedMedian))) return [];
      return [{ family: dexProtocolGroupKey(source), protocol: source.protocol, chain: source.chain,
        price: source.price, deviationBps: signal.rawBps, tvlUsd: source.tvl,
        observedAt: source.observedAt, aggregateObservedAt: source.aggregateObservedAt }];
    });
    if (new Set(contributors.map((source) => source.family)).size >= DEPEG_DEX_PROTOCOL_CORROBORATION_MIN) {
      decision.deadBandNotice = { eventId: input.existing.id, stablecoinId: input.asset.id,
        evidenceKind: "dex-aggregate", evaluatedAt: input.now, price: row.dex_price_usd,
        deviationBps: dex.rawBps, publishedAt: row.updated_at, aggregateObservedAt: row.aggregateObservedAt!,
        pricedTvlUsd: row.source_total_tvl, contributorCount: contributors.length, contributors };
    }
  }
  return decision;
}

function withheldNativeQuoteDiagnostic(ctx: DecisionContext): DepegDiagnostic | null {
  if (ctx.nativeQuoteImplausibility == null) return null;
  return withDiagnostic(
    "warn",
    `[depeg] Withheld implausible ${ctx.nativePegCurrency ?? "native"} native quote for ${ctx.asset.symbol}: ` +
    `reason=${ctx.nativeQuoteImplausibility.reason}`,
  );
}

export function decideDepegAsset(input: DepegAssetDecisionInput): DepegAssetDecision {
  const meta = observationPegMeta(input.asset, input.meta);
  if (input.meta && (!meta || normalizePegType(input.asset.pegType) !== normalizePegTypeFromCurrency(meta.flags.pegCurrency))) {
    const decision = emptyDecision(input.asset.id, { kind: "unavailable", reason: "invalid-reference" });
    if (input.existing) decision.seenEventIds.push(input.existing.id);
    return withPriceCoverage(decision, { ...input, meta: undefined });
  }
  if (input.asset.id === "xagm-matrixdock") {
    // A raw native silver quote is oz/token and needs its own dated entitlement, too.
    input = { ...input, meta, nativePegQuote: undefined };
  }
  if (hasIncompatibleParityPrice(input.asset)) {
    input = { ...input, asset: { ...input.asset, price: null, priceObservedAt: null } };
  }
  const derived = deriveDecisionContext(input);
  if (derived.kind === "skip") return withPriceCoverage(derived.decision, input);

  const { ctx } = derived;
  const withheldNativeDiagnostic = withheldNativeQuoteDiagnostic(ctx);
  if (input.existing && isNativePegEvent(input.existing) && ctx.nativeSignal == null) {
    return withPriceCoverage({
      trackedCoinId: ctx.trackedCoinId,
      observation: {
        kind: "unavailable",
        reason: ctx.nativeQuoteImplausibility != null ? "native-quote-implausible" : "native-quote-unavailable",
      },
      seenEventIds: [input.existing.id],
      commands: [],
      diagnostics: withheldNativeDiagnostic ? [withheldNativeDiagnostic] : [],
    }, input);
  }
  // A usable context is an observation, not proof of recovery or of a trusted event.
  const observed: DepegObservationOutcome = ctx.supply < DEPEG_EVENT_MIN_SUPPLY_USD ? { kind: "below-floor" } : { kind: "observed" };
  // The native-quote veto protects the USD primary path. A native-domain row is
  // decided by its own native quote, so it must still reach the existing-event
  // peak, direction and recovery rules.
  const nativeVetoContext = { ...ctx, nativeSignal: ctx.nativeVetoSignal };
  const nativeVeto = ctx.independentNativeBasis || (input.existing != null && isNativePegEvent(input.existing))
    ? null
    : applyNativeQuoteVeto(nativeVetoContext, input.existing);
  if (nativeVeto) {
    return withPriceCoverage({
      ...nativeVeto,
      observation: observed,
      diagnostics: withheldNativeDiagnostic
        ? [withheldNativeDiagnostic, ...nativeVeto.diagnostics]
        : nativeVeto.diagnostics,
    }, input, nativeVetoContext);
  }

  const nativeOpening = input.existing ? null : decideNewNativePegDepeg(ctx);
  const existingSignal = input.existing && isNativePegEvent(input.existing)
    ? ctx.nativeSignal
    : ctx.primarySignal;
  const nativeShowsRecovery = signalIsWithinThreshold(ctx.nativeSignal, ctx.recoveryThreshold);
  const shouldEvaluateRecovery = input.existing != null && (
    signalIsWithinThreshold(existingSignal, ctx.recoveryThreshold) || nativeShowsRecovery
  );
  const decision = input.existing
    ? shouldEvaluateRecovery
      ? decideRecovery(ctx, input.existing)
      : signalCrossesThreshold(existingSignal, ctx.threshold)
        ? decideExistingEvent(ctx, input.existing)
        : decideRecoveryDeadband(input.existing)
    : nativeOpening
      ? nativeOpening
    : ctx.rawAbsBps >= ctx.threshold
      ? decideNewDepeg(ctx)
      : emptyDecision();

  return withPriceCoverage({
    trackedCoinId: ctx.trackedCoinId,
    observation: observed,
    seenEventIds: decision.seenEventIds,
    commands: decision.commands,
    diagnostics: withheldNativeDiagnostic
      ? [withheldNativeDiagnostic, ...decision.diagnostics]
      : decision.diagnostics,
  }, input, ctx);
}

export function emitDepegDiagnostics(diagnostics: DepegDiagnostic[]): void {
  for (const diagnostic of diagnostics) {
    if (diagnostic.level === "warn") {
      logWorkerEventArgs("handler", "warn", diagnostic.message);
    } else {
      logWorkerEventArgs("handler", "info", diagnostic.message);
    }
  }
}
