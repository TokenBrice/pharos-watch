import { DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC } from "@shared/lib/depeg-closure";
import { DIVERGENCE_THRESHOLD_BPS } from "@shared/lib/pricing-pipeline-constants";
import { pricesAgreeWithinBps } from "../lib/price-divergence";
import { getPendingExpiryLimitSec, readPendingObservationReceipt, type DepegObservationReceipt } from "../lib/depeg-pending";
import {
  DEPEG_PENDING_MIN_AGE_SEC,
  DEPEG_PRIMARY_PRICE_MAX_AGE_SEC,
  DEPEG_SEVERITY_BPS,
} from "@shared/lib/depeg-config";
import { logWorkerEventArgs } from "../lib/structured-log";
import { PSI_ELIGIBLE_META_BY_ID } from "@shared/lib/psi-eligible";
import { getPegReference, normalizePegType, type PegRateSource } from "@shared/lib/peg-rates";
import { getLegacyReferenceClosureStart, getReferenceMarket, getReferenceSessionState } from "@shared/lib/reference-market-hours";
import { getCommodityOuncesAtQuote } from "@shared/lib/commodity-median";
import { assessDetectionReference, assessIndependentPeerMove, benchmarkAdmission, canPersistPeerEvents, getClockedTradedNativeQuote, getTradedNativeEvidence, hasIncompatibleParityPrice, independentPrimaryTrustInput, observationPegMeta, independenceKey, isIndependentVenue, sourceObservationClock } from "./depeg-detection/reference-policy";
import { normalizePegTypeFromCurrency } from "@shared/lib/peg-price-bounds";
import { getDepegRecoveryThresholdBps, getDepegThresholdBps } from "../lib/depeg-threshold-policy";
import {
  buildPendingReason,
  dexPoolIndependentGroupKey,
  isNativeOriginPending,
  isExtremeMovePending,
  parsePendingReason,
  loadDexPoolChallengers,
  type DexPriceRow,
  type DexPoolSource,
} from "../lib/depeg-helpers";
import {
  classifyPrimaryDepegTrust,
  getFreshIndependentPrimarySourceFamilies,
  getPrimaryDepegSourceFamilies,
  hasFreshMultiSourcePrimaryAgreement,
  isAuthoritativeDepegPegReference,
} from "../lib/depeg-trust-policy";
import {
  classifyDirectionalSignal,
  deriveDepegSignal,
  pickMoreSevereBps,
  signalCrossesThreshold,
  type DepegSignal,
} from "@shared/lib/depeg-signals";
import type {
  PendingDepegRow,
  PendingDepegState,
} from "../lib/depeg-pending";
import type { DepegPricingAsset, DexPoolChallenger } from "./depeg-detection/types";
import { normalizeSupportedPegCurrency, type NativePegQuote } from "../lib/native-peg-quotes";
import {
  classifyNativeQuoteImplausibility,
  type NativeQuoteImplausibility,
} from "../lib/native-quote-plausibility";

const CONFIRMATION_TIMESTAMP_FUTURE_SKEW_SEC = 5 * 60;

export const SELECT_PENDING_CONFIRMATION_SQL = `SELECT pending.*, (
  SELECT MAX(event.ended_at) FROM depeg_events event
  WHERE event.stablecoin_id = pending.stablecoin_id
    AND (event.source = 'live' OR (event.source = 'backfill'
      AND event.close_reason IN ('recovered-primary', 'recovered-dex', 'recovered-native')))
) AS last_live_event_end_at FROM depeg_pending pending`;

export type DirectionalSignalStatus = ReturnType<typeof classifyDirectionalSignal>;
export type ConfirmationTimestampStatus = "fresh" | "missing" | "invalid" | "future" | "stale";
type PendingOutcome = "promoted" | "rejected" | "expired" | "recovered" | "superseded" | "unconfirmed-severe";

export type DexPriceRowsByCoin = Map<string, DexPriceRow>;
export type DexPriceSourcesByCoin = Map<string, DexPoolSource[]>;
export type DexPoolChallengersByCoin = Awaited<ReturnType<typeof loadDexPoolChallengers>>;

export type PeakQuoteDomain = "usd" | `native:${string}`;

export interface PeakCandidate {
  bps: number | null | undefined;
  /** Canonical quote identity; native fiat prices cannot enter a USD peak. */
  quoteDomain: PeakQuoteDomain;
  pegReference?: number | null;
  price: number | null | undefined;
  receipt?: DepegObservationReceipt | null;
}

export interface PendingOutcomeEvidence {
  confirmingSources?: string[];
  opposingSources?: string[];
  unavailableSources?: string[];
  circuitOpenSources?: string[];
}

export interface PoolConfirmation {
  key: string;
  pool: {
    price: number;
    tvlUsd: number;
    protocol: string;
    sourceFamily?: string;
    chain?: string;
  };
  signal: DepegSignal;
}

export interface CollectedConfirmationEvidence {
  confirmingSources: string[];
  opposingSources: string[];
  unavailableSources: string[];
  circuitOpenSources: string[];
  hardOpposingSources: string[];
  offchainStatus: DirectionalSignalStatus;
  offchainSourceKey: string | null;
  offchainPeakCandidate: PeakCandidate | null;
  dexStatus: DirectionalSignalStatus;
  dexConfirmationVeto?: boolean;
  dexPeakCandidates: PeakCandidate[];
  dexConfirmationKeys: string[];
  cexStatus: DirectionalSignalStatus;
  cexPeakCandidate: PeakCandidate | null;
  poolStatus: DirectionalSignalStatus;
  poolConfirmations: PoolConfirmation[];
}

export interface ConfirmationPlanInput {
  db: D1Database;
  row: PendingDepegRow;
  pendingState: PendingDepegState;
  asset: DepegPricingAsset | undefined;
  meta: ReturnType<typeof PSI_ELIGIBLE_META_BY_ID.get>;
  pegRates: Record<string, number>;
  pegRateSources: Record<string, PegRateSource>;
  pegRateCounts: Record<string, number>;
  nativePegQuote: NativePegQuote | undefined;
  openSet: ReadonlySet<string>;
  challengerPools?: DexPoolChallenger[];
  referenceContext?: import("./depeg-detection/reference-policy").DetectionReferenceContext;
  now: number;
}

export type ConfirmationPlan =
  | {
      kind: "mutate";
      statements: D1PreparedStatement[];
    }
  | {
      kind: "wait";
      reason: "too-young" | "peg-reference-unavailable" | "reference-market-closed";
      legacyClosure?: true;
    }
  | ConfirmationPlanReady;

export interface ConfirmationPlanReady {
  kind: "ready";
  row: PendingDepegRow;
  pendingState: PendingDepegState;
  outcomeState: PendingDepegState;
  asset: DepegPricingAsset | undefined;
  meta: ReturnType<typeof PSI_ELIGIBLE_META_BY_ID.get>;
  pegReference: number;
  threshold: number;
  recoveryThreshold?: number;
  independentConfirmation?: { source: string; peerReceipt?: string; nativeReceipt?: DepegObservationReceipt };
  independentBasis?: boolean;
  eventStartedAt?: number;
  hasPendingOnsetSourceKeys: boolean;
  pendingSourceKeys?: ReadonlySet<string>;
  allowsUsdObservation?: (price: number, observedAt: number | null | undefined, maxAgeSec?: number) => boolean;
  nativeSignal: DepegSignal | null;
  nativePegQuote: NativePegQuote | undefined;
  /** Machine reason a native sample was withheld from this run's admission. */
  nativeQuoteImplausibility: NativeQuoteImplausibility | null;
  nativeSourceKey: string;
  authoritativePrice: number | null;
  primaryStatus: DirectionalSignalStatus;
  primarySameDirectionDepegged: boolean;
  primaryConfirmationSources: string[];
  temporalSameDirectionConfirmed: boolean;
  trustedObservationAt?: number;
  preserveUntilReopen?: boolean;
  age: number;
  evidence: CollectedConfirmationEvidence;
}

export interface ConfirmationEvidenceInput extends ConfirmationPlanReady {
  db: D1Database;
  dexPriceRows: DexPriceRowsByCoin;
  dexPriceSources: DexPriceSourcesByCoin;
  poolChallengers: DexPoolChallengersByCoin;
  cexAllowed: boolean;
  cexPrices: Map<string, number> | null;
  coingeckoAllowed: boolean;
  coingeckoApiKey: string | null | undefined;
  signal: AbortSignal | undefined;
  now: number;
}

export interface PromotionDecisionInput {
  db: D1Database;
  plan: ConfirmationPlanReady;
  evidence: CollectedConfirmationEvidence;
  now: number;
}

export function classifyConfirmationTimestamp(timestamp: number | null | undefined, nowSec: number): ConfirmationTimestampStatus {
  if (timestamp == null) return "missing";
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "invalid";
  if (timestamp - nowSec > CONFIRMATION_TIMESTAMP_FUTURE_SKEW_SEC) return "future";
  if (nowSec - timestamp > DEPEG_PRIMARY_PRICE_MAX_AGE_SEC) return "stale";
  return "fresh";
}

export function pendingPeakQuoteDomain(row: PendingDepegRow, state: PendingDepegState): PeakQuoteDomain {
  return isNativeOriginPending(state.reason) ? `native:${normalizePegType(row.peg_type)}` : "usd";
}

export function isNativeQuoteForPending(row: PendingDepegRow, quote: NativePegQuote | undefined): boolean {
  return quote != null && quote.stablecoinId === row.stablecoin_id &&
    normalizePegTypeFromCurrency(quote.pegCurrency) === normalizePegType(row.peg_type);
}

export function pickPeakCandidate(candidates: PeakCandidate[], fallback: PeakCandidate & { bps: number; price: number }) {
  const comparable = candidates.filter((candidate) => candidate.quoteDomain === fallback.quoteDomain && candidate.price != null);
  const peakBps = pickMoreSevereBps(...comparable.map((candidate) => candidate.bps)) ?? fallback.bps;
  const first = comparable.find((candidate) => candidate.bps === peakBps);
  // Exact ties can add a paired reference to the same quote without replacing a historical peak.
  const matching = first?.pegReference != null ? first : comparable.find((candidate) =>
    candidate.bps === peakBps && candidate.price === first?.price && candidate.pegReference != null) ?? first;
  return {
    bps: peakBps,
    price: matching?.price ?? fallback.price ?? null,
    quoteDomain: matching?.quoteDomain ?? fallback.quoteDomain,
    ...(matching?.pegReference != null ? { pegReference: matching.pegReference } : {}),
    ...(matching?.receipt != null ? { receipt: matching.receipt } : {}),
  };
}

export function confirmationSourceList(...groups: Array<Array<string | null | undefined> | string | null | undefined>): string {
  const keys: string[] = [];
  for (const group of groups) {
    const values = Array.isArray(group) ? group : [group];
    for (const value of values) {
      if (value && !keys.includes(value)) keys.push(value);
    }
  }
  return keys.join("+");
}

export function addSource(target: string[], source: string | null | undefined): void {
  if (source && !target.includes(source)) target.push(source);
}

export function addSources(target: string[], sources: Iterable<string | null | undefined>): void {
  for (const source of sources) addSource(target, source);
}

export function buildPendingOutcomeStmt(
  db: D1Database,
  row: PendingDepegRow,
  state: PendingDepegState,
  outcome: PendingOutcome,
  outcomeAt: number,
  evidence: PendingOutcomeEvidence,
  finalDecisionReason: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO depeg_pending_outcomes (
         pending_id,
         stablecoin_id,
         symbol,
         peg_type,
         direction,
         reason,
         first_seen_bps,
         first_seen_at,
         first_price,
         last_seen_bps,
         last_seen_at,
         last_price,
         peak_seen_bps,
         peak_price,
         peg_reference,
         outcome,
         outcome_at,
         confirming_sources,
         opposing_sources,
         unavailable_sources,
         circuit_open_sources,
         final_decision_reason,
         created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id ?? null,
      row.stablecoin_id,
      row.symbol,
      row.peg_type,
      state.direction,
      state.reason,
      state.firstSeenBps,
      state.firstSeenAt,
      state.firstPrice,
      state.lastSeenBps,
      state.lastSeenAt,
      state.lastPrice,
      state.peakSeenBps,
      state.peakPrice,
      state.pegReference,
      outcome,
      outcomeAt,
      confirmationSourceList(evidence.confirmingSources ?? []) || null,
      confirmationSourceList(evidence.opposingSources ?? []) || null,
      confirmationSourceList(evidence.unavailableSources ?? []) || null,
      confirmationSourceList(evidence.circuitOpenSources ?? []) || null,
      finalDecisionReason,
      outcomeAt,
    );
}

export function buildDeletePendingStmt(db: D1Database, row: PendingDepegRow): D1PreparedStatement {
  return db.prepare("DELETE FROM depeg_pending WHERE id = ?").bind(row.id);
}

export function buildOutcomeAndDeleteStmts(
  db: D1Database,
  row: PendingDepegRow,
  state: PendingDepegState,
  outcome: PendingOutcome,
  outcomeAt: number,
  evidence: PendingOutcomeEvidence,
  finalDecisionReason: string,
): D1PreparedStatement[] {
  return [
    buildPendingOutcomeStmt(db, row, state, outcome, outcomeAt, evidence, finalDecisionReason),
    buildDeletePendingStmt(db, row),
  ];
}

export function isOpposingConfirmationStatus(status: DirectionalSignalStatus): boolean {
  return status === "recover" || status === "contradict";
}

function buildNativeConfirmationKey(pegCurrency: string | null | undefined): string {
  return `native:${(pegCurrency ?? "native").toLowerCase()}`;
}

export function buildDexConfirmationKeys(protocolKeys: string[]): string[] {
  return protocolKeys.map((key) => `dex:${key}`);
}

export function buildPoolConfirmationKey(pool: { protocol: string; sourceFamily?: string }): string {
  return `pool:${dexPoolIndependentGroupKey(pool)}`;
}

export function buildPoolGroupKey(groupKey: string): string {
  return `pool:${groupKey}`;
}

function expectsNativePegQuote(meta: ReturnType<typeof PSI_ELIGIBLE_META_BY_ID.get>): boolean {
  return (
    typeof meta?.geckoId === "string" &&
    meta.geckoId.length > 0 &&
    normalizeSupportedPegCurrency(meta.flags.pegCurrency) != null
  );
}

function unavailableReferencePlan(
  db: D1Database, row: PendingDepegRow, state: PendingDepegState, now: number, reason: string,
): ConfirmationPlan {
  const age = now - row.first_seen_at;
  const unavailableSources = [`reference:${reason}`];
  const extreme = isExtremeMovePending(state.reason);
  const limit = getPendingExpiryLimitSec({ primarySameDirectionDepegged: false, isExtremeMove: extreme,
    unavailableSources, circuitOpenSources: [] });
  if (age > limit) return { kind: "mutate", statements: buildOutcomeAndDeleteStmts(
    db, row, state, extreme ? "unconfirmed-severe" : "expired", now,
    { unavailableSources }, `expired-after:${age}s;limit:${limit}s`,
  ) };
  return { kind: "wait", reason: "peg-reference-unavailable" };
}

export function buildConfirmationPlan(input: ConfirmationPlanInput): ConfirmationPlan {
  const {
    db,
    row,
    pendingState: seenState,
    asset: suppliedAsset,
    meta: suppliedMeta,
    pegRates,
    pegRateSources,
    pegRateCounts,
    nativePegQuote: inputNativePegQuote,
    openSet,
    now,
  } = input;
  const age = now - seenState.firstSeenAt;
  const registryMeta = suppliedMeta ?? PSI_ELIGIBLE_META_BY_ID.get(row.stablecoin_id);
  const registryPeg = normalizePegTypeFromCurrency(registryMeta?.flags.pegCurrency);
  if (!registryPeg || normalizePegType(row.peg_type) !== registryPeg ||
      (suppliedAsset && normalizePegType(suppliedAsset.pegType) !== registryPeg)) {
    return unavailableReferencePlan(db, row, seenState, now, "unsupported-peg");
  }
  const silverEntitlementRequired = row.stablecoin_id === "xagm-matrixdock";
  const meta = suppliedAsset ? observationPegMeta(suppliedAsset, registryMeta) : registryMeta;
  const hasSecondaryQuoteUnit = (observedAt: number | null | undefined) =>
    !silverEntitlementRequired || getCommodityOuncesAtQuote(meta?.commodityOunces, {
      assetId: row.stablecoin_id, commodityEntitlement: suppliedAsset?.commodityEntitlement, quoteObservedAtSec: observedAt,
    }) != null;
  const suppliedNativePegQuote = silverEntitlementRequired ? undefined : inputNativePegQuote;
  const incompatibleParity = suppliedAsset != null && hasIncompatibleParityPrice(suppliedAsset);
  const asset = incompatibleParity ? { ...suppliedAsset, price: null, priceObservedAt: null } : suppliedAsset;
  const pegType = registryPeg;
  const market = getReferenceMarket(registryMeta?.flags.pegCurrency);
  const native = isNativeQuoteForPending(row, suppliedNativePegQuote) ? getTradedNativeEvidence(suppliedNativePegQuote, now) : null;
  const nativePegQuote = isNativeQuoteForPending(row, suppliedNativePegQuote)
    ? getClockedTradedNativeQuote(suppliedNativePegQuote, now) : undefined;
  const refreshedPegReferenceIsAuthoritative =
    meta && (asset || (market && !silverEntitlementRequired))
      ? isAuthoritativeDepegPegReference({
        pegCurrency: meta.flags.pegCurrency,
        pegType,
        pegRateSource: pegType ? pegRateSources[pegType] : undefined,
        pegRateContributorCount: pegType ? pegRateCounts[pegType] : undefined,
      })
      : false;
  const refreshedPegRef =
    meta && refreshedPegReferenceIsAuthoritative
      ? getPegReference(pegType, pegRates, meta.commodityOunces, { assetId: row.stablecoin_id,
        commodityEntitlement: asset?.commodityEntitlement, quoteObservedAtSec: sourceObservationClock(asset) }) ?? Number.NaN
      : Number.NaN;
  const pendingReceipt = readPendingObservationReceipt(row.peer_basis_json);
  const onset = pendingReceipt?.onset;
  const latest = pendingReceipt?.latest;
  const onsetMatches = onset?.seenAt === seenState.firstSeenAt && onset.price === seenState.firstPrice;
  const latestMatches = latest?.seenAt === seenState.lastSeenAt && latest.price === seenState.lastPrice;
  // Persistence and expiry start at discovery. Evidence ordering still uses the original quote clocks.
  const pendingState = {
    ...seenState,
    firstSeenAt: onsetMatches ? onset.observedAt : seenState.firstSeenAt,
    lastSeenAt: latestMatches ? latest.observedAt : seenState.lastSeenAt,
  };
  const isNativeOrigin = isNativeOriginPending(pendingState.reason);
  const onsetNativeVenue = isNativeOrigin && onset?.basis === "native-peg" && onset.observedAt === pendingState.firstSeenAt
    ? independenceKey(onset.venue) : "";
  const isPeerRelative = onset?.basis === "peer-relative" || parsePendingReason(pendingState.reason).has("peer-relative");
  const outcomeState = pendingState;
  const legacyOnset = onsetMatches && onset.basis === "benchmark" && onset.referenceAdmission == null;
  const legacyClosureMismatch = market != null && legacyOnset &&
    getLegacyReferenceClosureStart(market, pendingState.firstSeenAt) !== getLegacyReferenceClosureStart(market, seenState.firstSeenAt);
  const onsetSession = market == null || legacyOnset ? null : getReferenceSessionState(market, seenState.firstSeenAt);
  const onsetBoundary = onsetSession?.open ? onsetSession.sessionOpenedAtSec : onsetSession?.closureStartSec;
  const eventStartedAt =
    pendingState.firstSeenAt > seenState.firstSeenAt ||
    (row.last_live_event_end_at != null && pendingState.firstSeenAt <= row.last_live_event_end_at) ||
    legacyClosureMismatch ||
    (onsetBoundary != null && pendingState.firstSeenAt < onsetBoundary)
      ? seenState.firstSeenAt : pendingState.firstSeenAt;

  if (openSet.has(row.stablecoin_id)) {
    return { kind: "mutate", statements: buildOutcomeAndDeleteStmts(
      db, row, outcomeState, "superseded", now, {}, "open-event-already-exists",
    ) };
  }
  if (row.last_live_event_end_at != null && row.last_live_event_end_at > seenState.firstSeenAt) {
    return { kind: "mutate", statements: buildOutcomeAndDeleteStmts(
      db, row, outcomeState, "superseded", now, {}, "live-event-ended-after-pending-discovery",
    ) };
  }

  const peerWritesEnabled = canPersistPeerEvents(input);
  if (!peerWritesEnabled && (isPeerRelative || latest?.basis === "peer-relative" || pendingReceipt?.peak?.basis === "peer-relative")) {
    return { kind: "mutate", statements: buildOutcomeAndDeleteStmts(
      db, row, outcomeState, "rejected", now, {}, "peer-event-rollback-incompatible",
    ) };
  }

  const defaultThreshold = getDepegThresholdBps(pegType ?? row.peg_type);
  const recoveryThreshold = getDepegRecoveryThresholdBps(pegType ?? row.peg_type);
  const currentMove = asset?.price == null ? null : deriveDepegSignal(asset.price, refreshedPegRef);
  const legacyPending = !isNativeOrigin && !isPeerRelative && !silverEntitlementRequired &&
    !onset?.referenceAdmission && !latest?.referenceAdmission && Number.isFinite(row.peg_reference) && row.peg_reference > 0
    ? { discoveredAt: seenState.firstSeenAt, pegReference: row.peg_reference } : undefined;
  const reference = meta ? assessDetectionReference({ asset, meta, pegRates, pegRateSources, now, signal: currentMove,
    quoteObservedAt: asset?.price == null ? null : undefined,
    legacyPending, referenceContext: input.referenceContext }) : null;
  const usableNative = native && (reference == null || native.quote.updatedAt >= reference.boundary) ? native : null;
  const independentNative = usableNative && isIndependentVenue(asset, usableNative.venue) &&
    (!isNativeOrigin || onsetNativeVenue !== "") ? usableNative : null;
  const benchmark = benchmarkAdmission(reference, currentMove, independentNative, defaultThreshold);
  const directAdmitted = benchmark != null && !incompatibleParity && (!silverEntitlementRequired || (!!suppliedAsset && !!meta));
  // An open-session reference can be paired with a secondary quote's own clock.
  const pairSecondaryQuote = suppliedAsset?.price == null && !silverEntitlementRequired && !isNativeOrigin &&
    !isPeerRelative && Number.isFinite(refreshedPegRef) && reference?.closed === false &&
    reference.verdict.reason === "quote-clock-unavailable" &&
    now - pendingState.lastSeenAt <= DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC;
  const clockedNative = getClockedTradedNativeQuote(nativePegQuote, now, reference?.boundary);
  const nativeVenue = independenceKey(clockedNative?.derivation?.lineage.venue);
  const repeatedNativeSignal = clockedNative ? deriveDepegSignal(clockedNative.price, 1) : null;
  const observedDistinctNative = isNativeOrigin && onsetNativeVenue && nativeVenue && nativeVenue !== onsetNativeVenue &&
    clockedNative != null && clockedNative.updatedAt > pendingState.firstSeenAt &&
    repeatedNativeSignal?.direction === pendingState.direction && signalCrossesThreshold(repeatedNativeSignal, defaultThreshold)
    ? clockedNative : null;
  const peerMove = reference && asset && (isNativeOrigin || peerWritesEnabled) && (isPeerRelative || !directAdmitted)
    ? assessIndependentPeerMove({ reference, asset,
      native: isNativeOrigin && (!onsetNativeVenue || usableNative?.venue === onsetNativeVenue) ? null : usableNative,
      pools: silverEntitlementRequired
        ? input.challengerPools?.filter((pool) => hasSecondaryQuoteUnit(pool.observedAt)) : input.challengerPools,
      excludedVenue: onsetNativeVenue || undefined,
      threshold: defaultThreshold, recoveryThreshold, now })
    : null;
  const nativeBasis = isNativeOrigin && clockedNative != null;
  // A severe episode that was still observed at the close can confirm during the
  // closure. Missing evidence alone must not expire it before the market reopens.
  const preserveUntilReopen = reference?.closed === true && seenState.firstSeenAt < reference.boundary &&
    pendingState.lastSeenAt >= reference.boundary - DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC &&
    Math.abs(pendingState.peakSeenBps) >= DEPEG_SEVERITY_BPS.severe;
  if (!peerMove && !directAdmitted && !nativeBasis && !pairSecondaryQuote) {
    if (reference?.legacyClosureHeld) return { kind: "wait", reason: "reference-market-closed", legacyClosure: true };
    if (reference?.closureHeld && currentMove != null && reference.band != null && currentMove.absRawBps < reference.band &&
      (preserveUntilReopen || (Math.abs(pendingState.peakSeenBps) < reference.band && !isExtremeMovePending(pendingState.reason)))) {
      return { kind: "wait", reason: "reference-market-closed" };
    }
    if (preserveUntilReopen) return { kind: "wait", reason: "peg-reference-unavailable" };
    return unavailableReferencePlan(db, row, outcomeState, now, reference?.verdict.reason ?? "no-reference");
  }

  const pegReference = isNativeOrigin ? 1 : peerMove?.pegReference ??
    (Number.isFinite(refreshedPegRef) && refreshedPegRef > 0 ? refreshedPegRef : row.peg_reference);
  const threshold = isNativeOrigin || peerMove ? defaultThreshold : benchmark?.threshold ?? defaultThreshold;
  const independentBasis = peerMove != null || (isNativeOrigin && !directAdmitted);
  const independentPeer = peerMove?.signal.direction === pendingState.direction && signalCrossesThreshold(peerMove?.signal, threshold) &&
    (!isNativeOrigin || (onsetNativeVenue !== "" && isIndependentVenue(asset, onsetNativeVenue) &&
      reference?.peer?.contributors.every((contributor) => contributor.provenanceKey !== onsetNativeVenue)));
  const peerConfirmation = independentPeer ? { source: isNativeOrigin ? "peer:median" : peerMove!.source, peerReceipt: peerMove!.receipt } : undefined;
  const promotionState = !isNativeOrigin && (isPeerRelative || peerMove)
    ? { ...pendingState, reason: buildPendingReason([...parsePendingReason(pendingState.reason), "low-confidence", "peer-relative"]) }
    : pendingState;

  if (!Number.isFinite(pegReference) || pegReference <= 0) {
    if (asset && meta && !refreshedPegReferenceIsAuthoritative) {
      return { kind: "wait", reason: "peg-reference-unavailable" };
    }
    logWorkerEventArgs("handler", "warn", `[depeg-confirm] Deleted pending for ${row.symbol}: invalid peg_reference=${row.peg_reference}`);
    return {
      kind: "mutate",
      statements: buildOutcomeAndDeleteStmts(
        db,
        row,
        outcomeState,
        "rejected",
        now,
        {},
        `invalid-peg-reference:${row.peg_reference}`,
      ),
    };
  }

  const primaryEvidence = asset && independentPrimaryTrustInput(asset);
  const primaryTrust = primaryEvidence ? classifyPrimaryDepegTrust(primaryEvidence, now) : "unusable";
  const currentNativeQuote = !pairSecondaryQuote && clockedNative && (clockedNative.updatedAt >= pendingState.lastSeenAt ||
    !isOpposingConfirmationStatus(classifyDirectionalSignal(repeatedNativeSignal, defaultThreshold, pendingState.direction, recoveryThreshold))) && (isNativeOrigin || isIndependentVenue(asset, clockedNative.derivation?.lineage.venue))
    ? clockedNative : undefined;
  const rawNativeSignal = currentNativeQuote ? deriveDepegSignal(currentNativeQuote.price, 1) : null;
  const rawNativeStatus = classifyDirectionalSignal(rawNativeSignal, defaultThreshold, pendingState.direction, recoveryThreshold);
  const confirmingSources: string[] = [];
  const opposingSources: string[] = [];
  const unavailableSources: string[] = [];
  const circuitOpenSources: string[] = [];
  const hardOpposingSources: string[] = [];
  const nativeSourceKey = buildNativeConfirmationKey(nativePegQuote?.pegCurrency ?? meta?.flags.pegCurrency);

  const authoritativePriceCandidate = isNativeOrigin
    ? currentNativeQuote?.price ?? null
    : peerMove?.price ?? (asset != null &&
        primaryTrust === "authoritative" &&
        asset.price != null &&
        typeof asset.price === "number" &&
        Number.isFinite(asset.price) &&
        asset.price > 0
      ? asset.price
      : null);
  const independentPrimaryFamilies =
    isNativeOrigin && primaryEvidence && directAdmitted && onsetNativeVenue && isIndependentVenue(primaryEvidence, onsetNativeVenue)
      ? getFreshIndependentPrimarySourceFamilies(primaryEvidence, now, onsetNativeVenue)
      : new Set<string>();
  const normalizedNativePrimaryPrice =
    isNativeOrigin &&
    asset?.price != null &&
    Number.isFinite(asset.price) &&
    asset.price > 0 &&
    refreshedPegReferenceIsAuthoritative &&
    Number.isFinite(refreshedPegRef) &&
    refreshedPegRef > 0 &&
    independentPrimaryFamilies.size > 0
      ? asset.price / refreshedPegRef
      : null;
  const primarySignalPrice = isNativeOrigin ? normalizedNativePrimaryPrice : authoritativePriceCandidate;
  const currentPrimarySignal = isNativeOrigin && peerConfirmation ? peerMove!.signal :
    primarySignalPrice != null
      ? deriveDepegSignal(primarySignalPrice, pegReference)
      : null;
  const classifiedPrimary = classifyDirectionalSignal(currentPrimarySignal, threshold, pendingState.direction, recoveryThreshold);
  // Pre-clock USD producers dated an eligible primary quote with priceUpdatedAt.
  const primaryClock = pegType === "peggedUSD" && asset?.priceObservedAt === undefined && asset?.priceObservedAtMode === undefined
    ? asset?.priceUpdatedAt : sourceObservationClock(asset);
  const currentPrimaryStatus = isOpposingConfirmationStatus(classifiedPrimary) &&
    (primaryClock == null || !Number.isSafeInteger(primaryClock) || primaryClock > now || primaryClock < pendingState.lastSeenAt)
    ? "insufficient" : classifiedPrimary;
  const primarySameDirectionDepegged = currentPrimaryStatus === "confirm";
  const primaryConfirmationSources = !independentBasis && primarySameDirectionDepegged && primaryEvidence
    ? (
        isNativeOrigin
          ? [...independentPrimaryFamilies]
          : hasFreshMultiSourcePrimaryAgreement(primaryEvidence, now)
            ? [...getPrimaryDepegSourceFamilies(primaryEvidence)]
            : []
      ).sort().map((family) => `primary:${family}`)
    : [];
  if (isNativeOrigin && isOpposingConfirmationStatus(currentPrimaryStatus)) {
    addSources(
      opposingSources,
      [...independentPrimaryFamilies].sort().map((family) => `primary:${family}`),
    );
  }

  // A stored native sample and this run's native quote both pass the same
  // plausibility bound. An extreme sample may stand only when an independent
  // family shows its own extreme move in the same direction.
  const retainedSamples = isNativeOrigin ? [
    { price: pendingState.firstPrice, venue: onsetNativeVenue },
    { price: pendingState.peakPrice, venue: pendingReceipt?.peak?.price === pendingState.peakPrice
        ? independenceKey(pendingReceipt.peak.venue) : pendingState.peakPrice === pendingState.firstPrice ? onsetNativeVenue : "" },
  ] : [];
  const samples = [...retainedSamples, ...(currentNativeQuote ? [{ price: currentNativeQuote.price, venue: nativeVenue }] : [])];
  const implausibility = (price: number) => classifyNativeQuoteImplausibility({
    price, stablecoinId: row.stablecoin_id, pegType: row.peg_type,
  });
  const corroborates = (price: number, sample: number) =>
    implausibility(price)?.corroborationCanAdmit === true && (price < 1) === (sample < 1) &&
    pricesAgreeWithinBps(price, sample, DIVERGENCE_THRESHOLD_BPS);
  let nativeQuoteImplausibility: NativeQuoteImplausibility | null = null;
  for (const sample of samples) {
    const reason = implausibility(sample.price);
    if (!reason) continue;
    const corroborated = reason.corroborationCanAdmit && sample.venue && (
      (normalizedNativePrimaryPrice != null && isIndependentVenue(asset, sample.venue) &&
        corroborates(normalizedNativePrimaryPrice, sample.price)) ||
      samples.some((other) => other.venue && other.venue !== sample.venue && corroborates(other.price, sample.price))
    );
    if (!corroborated) {
      nativeQuoteImplausibility = reason;
      break;
    }
  }
  const nativeSignal = nativeQuoteImplausibility == null ? rawNativeSignal : null;
  const admittedNativePegQuote = nativeQuoteImplausibility == null ? currentNativeQuote : undefined;
  const authoritativePrice = isNativeOrigin
    ? admittedNativePegQuote?.price ?? null
    : authoritativePriceCandidate;
  const distinctNative = nativeSignal != null ? observedDistinctNative : null;
  const independentConfirmation = distinctNative && nativeSignal ? {
    source: nativeSourceKey,
    nativeReceipt: { basis: "native-peg" as const, venue: nativeVenue, price: distinctNative.price,
      observedAt: distinctNative.updatedAt, pegReference: 1, bps: nativeSignal.rawBps },
  } : peerConfirmation;
  if (independentBasis && !independentConfirmation) addSource(unavailableSources, "reference:independent-corroboration-unavailable");
  const nativePegStillDepegged = nativeSignal != null && rawNativeStatus === "confirm";
  const nativePegRecovered = !isPeerRelative && nativeSignal != null && rawNativeStatus === "recover" &&
    currentNativeQuote!.updatedAt >= pendingState.lastSeenAt &&
    (!isNativeOrigin || (onsetNativeVenue !== "" && currentNativeQuote!.updatedAt > pendingState.firstSeenAt));

  if (nativeQuoteImplausibility != null) {
    addSource(unavailableSources, `${nativeSourceKey}:${nativeQuoteImplausibility.reason}`);
  } else if (nativeSignal != null && !isNativeOrigin) {
    if (isOpposingConfirmationStatus(rawNativeStatus)) {
      addSource(opposingSources, nativeSourceKey);
      addSource(hardOpposingSources, nativeSourceKey);
    }
  } else if (nativeSignal == null && expectsNativePegQuote(meta)) {
    addSource(unavailableSources, buildNativeConfirmationKey(meta?.flags.pegCurrency));
  }

  const peerClock = peerMove ? sourceObservationClock(asset) : null;
  const latestIndependentClock = distinctNative?.updatedAt ?? (isNativeOrigin ? null : peerClock);
  const latestClock = latestIndependentClock != null && latestIndependentClock >= pendingState.lastSeenAt &&
    latestIndependentClock - pendingState.lastSeenAt <= DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC
    ? latestIndependentClock : pendingState.lastSeenAt;
  const trustedObservationAt = isNativeOrigin
    ? admittedNativePegQuote?.updatedAt ?? latestClock
    : (primarySameDirectionDepegged ? sourceObservationClock(asset) : null) ?? latestClock;
  const lastSeenRunAt = latestClock > pendingState.lastSeenAt ? now : seenState.lastSeenAt;
  const temporalSameDirectionConfirmed =
    lastSeenRunAt - seenState.firstSeenAt >= DEPEG_PENDING_MIN_AGE_SEC &&
    latestClock - pendingState.firstSeenAt >= DEPEG_PENDING_MIN_AGE_SEC &&
    now - latestClock <= (pairSecondaryQuote ? DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC : DEPEG_PENDING_MIN_AGE_SEC) &&
    (latestClock !== pendingState.lastSeenAt || Math.abs(pendingState.lastSeenBps) >= threshold) &&
    (!independentBasis || primarySameDirectionDepegged || distinctNative != null);

  if (nativePegRecovered) {
    logWorkerEventArgs("handler", "info",
      `[depeg-confirm] Cleared pending for ${row.symbol}: ${nativePegQuote?.pegCurrency ?? meta?.flags.pegCurrency ?? "native"} quote recovered to ${nativeSignal?.absBps ?? "n/a"}bps`,
    );
    return {
      kind: "mutate",
      statements: buildOutcomeAndDeleteStmts(
        db,
        row,
        outcomeState,
        "recovered",
        now,
        { confirmingSources, opposingSources, unavailableSources, circuitOpenSources },
        "native-peg-recovered",
      ),
    };
  }

  if (currentPrimaryStatus === "recover" && !nativePegStillDepegged && !(isNativeOrigin && nativeQuoteImplausibility != null)) {
    addSource(opposingSources, "primary:authoritative");
    logWorkerEventArgs("handler", "info",
      `[depeg-confirm] Cleared pending for ${row.symbol}: authoritative primary recovered to ${currentPrimarySignal?.absBps ?? "n/a"}bps`,
    );
    return {
      kind: "mutate",
      statements: buildOutcomeAndDeleteStmts(
        db,
        row,
        outcomeState,
        "recovered",
        now,
        { confirmingSources, opposingSources, unavailableSources, circuitOpenSources },
        "authoritative-primary-recovered",
      ),
    };
  }

  if (age < DEPEG_PENDING_MIN_AGE_SEC) {
    return { kind: "wait", reason: "too-young" };
  }

  const onsetSourceMatch = onset != null && (onset.seenAt ?? onset.observedAt) === seenState.firstSeenAt &&
    onset.price === seenState.firstPrice && onset.bps === seenState.firstSeenBps;
  const latestSourceMatch = latestMatches && latest.bps === seenState.lastSeenBps;
  // Older receipts had a single union. It identifies the onset by itself only
  // when the two receipt observations are the same.
  const legacyOnsetKeys = onsetSourceMatch && latest != null && latest.seenAt === onset.seenAt &&
    latest.observedAt === onset.observedAt && latest.price === onset.price && latest.bps === onset.bps
    ? pendingReceipt?.sourceFamilies : undefined;
  const onsetSourceKeys = onsetSourceMatch ? onset.sourceKeys ?? legacyOnsetKeys ?? [] : [];
  const pendingSourceKeys = new Set([
    ...onsetSourceKeys,
    ...(latestSourceMatch ? latest.sourceKeys ?? [] : []),
    ...(latestSourceMatch && (onset == null || onsetSourceMatch)
      ? pendingReceipt?.sourceKeys ?? pendingReceipt?.sourceFamilies ?? [] : []),
  ]);

  return {
    kind: "ready",
    row,
    pendingState: promotionState,
    outcomeState: promotionState === pendingState ? outcomeState : promotionState,
    asset,
    meta,
    pegReference,
    threshold,
    recoveryThreshold,
    independentConfirmation,
    independentBasis,
    eventStartedAt,
    hasPendingOnsetSourceKeys: onsetSourceKeys.length > 0,
    pendingSourceKeys: pendingSourceKeys.size > 0 ? pendingSourceKeys : undefined,
    allowsUsdObservation: (reference && meta) || silverEntitlementRequired ? (price, observedAt, quoteMaxAgeSec) => {
      if (peerMove || !hasSecondaryQuoteUnit(observedAt)) return false;
      if (pairSecondaryQuote && (observedAt == null || observedAt < pendingState.lastSeenAt ||
        now - observedAt > DEPEG_PENDING_MIN_AGE_SEC)) return false;
      if (!reference || !meta) return true;
      const signal = deriveDepegSignal(price, pegReference);
      const read = assessDetectionReference({ asset, meta, pegRates, pegRateSources, now,
        signal, quoteObservedAt: observedAt ?? null, quoteMaxAgeSec, cohort: reference.peer, referenceContext: input.referenceContext });
      return benchmarkAdmission(read, signal, independentNative, defaultThreshold) != null;
    } : undefined,
    nativeSignal,
    nativePegQuote: admittedNativePegQuote,
    nativeQuoteImplausibility,
    nativeSourceKey,
    authoritativePrice,
    primaryStatus: currentPrimaryStatus,
    primarySameDirectionDepegged,
    primaryConfirmationSources,
    temporalSameDirectionConfirmed,
    trustedObservationAt,
    preserveUntilReopen,
    age,
    evidence: {
      confirmingSources,
      opposingSources,
      unavailableSources,
      circuitOpenSources,
      hardOpposingSources,
      offchainStatus: "insufficient",
      offchainSourceKey: null,
      offchainPeakCandidate: null,
      dexStatus: "insufficient",
      dexPeakCandidates: [],
      dexConfirmationKeys: [],
      cexStatus: "insufficient",
      cexPeakCandidate: null,
      poolStatus: "insufficient",
      poolConfirmations: [],
    },
  };
}
