import type { PegAssetBase } from "@shared/types/core";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { getPegReference, normalizePegType, type PegRateSource } from "@shared/lib/peg-rates";
import {
  DEPEG_PENDING_EXPIRY_SEC,
  DEPEG_PENDING_MIN_AGE_SEC,
  DEPEG_PRIMARY_PRICE_MAX_AGE_SEC,
  DEPEG_SECONDARY_THRESHOLD_RATIO,
  getDepegThresholdBps,
} from "../lib/constants";
import {
  dexPoolIndependentGroupKey,
  isNativeOriginPending,
  loadDexPoolChallengers,
  loadDexPriceRows,
  loadDexPriceSources,
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
  type DepegSignal,
} from "../lib/depeg-signals";
import type {
  PendingDepegRow,
  PendingDepegState,
} from "../lib/depeg-pending";
import { normalizeSupportedPegCurrency, type NativePegQuote } from "../lib/native-peg-quotes";

const CONFIRMATION_TIMESTAMP_FUTURE_SKEW_SEC = 5 * 60;
const DEPEG_PENDING_EXTENDED_EXPIRY_SEC = DEPEG_PENDING_EXPIRY_SEC * 3;
const DEPEG_PENDING_SEVERE_EXPIRY_SEC = DEPEG_PENDING_EXPIRY_SEC * 4;

export type DirectionalSignalStatus = ReturnType<typeof classifyDirectionalSignal>;
export type ConfirmationTimestampStatus = "fresh" | "missing" | "invalid" | "future" | "stale";
type PendingOutcome = "promoted" | "rejected" | "expired" | "recovered" | "superseded" | "unconfirmed-severe";

export type DexPriceRowsByCoin = Awaited<ReturnType<typeof loadDexPriceRows>>;
export type DexPriceSourcesByCoin = Awaited<ReturnType<typeof loadDexPriceSources>>;
export type DexPoolChallengersByCoin = Awaited<ReturnType<typeof loadDexPoolChallengers>>;

export interface PeakCandidate {
  bps: number | null | undefined;
  price: number | null | undefined;
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
  asset: PegAssetBase | undefined;
  meta: ReturnType<typeof ACTIVE_META_BY_ID.get>;
  pegRates: Record<string, number>;
  pegRateSources: Record<string, PegRateSource>;
  pegRateCounts: Record<string, number>;
  nativePegQuote: NativePegQuote | undefined;
  openSet: ReadonlySet<string>;
  now: number;
}

export type ConfirmationPlan =
  | {
      kind: "mutate";
      statements: D1PreparedStatement[];
    }
  | {
      kind: "wait";
      reason: "too-young" | "peg-reference-unavailable";
    }
  | ConfirmationPlanReady;

export interface ConfirmationPlanReady {
  kind: "ready";
  row: PendingDepegRow;
  pendingState: PendingDepegState;
  outcomeState: PendingDepegState;
  asset: PegAssetBase | undefined;
  meta: ReturnType<typeof ACTIVE_META_BY_ID.get>;
  pegReference: number;
  threshold: number;
  secondaryBar: number;
  nativeSignal: DepegSignal | null;
  nativePegQuote: NativePegQuote | undefined;
  nativeSourceKey: string;
  authoritativePrice: number | null;
  primaryStatus: DirectionalSignalStatus;
  primarySameDirectionDepegged: boolean;
  primaryConfirmationSources: string[];
  temporalSameDirectionConfirmed: boolean;
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

export function pickPeakCandidate(candidates: PeakCandidate[], fallback: PeakCandidate): { bps: number; price: number | null } {
  const peakBps = pickMoreSevereBps(...candidates.map((candidate) => candidate.bps)) ?? fallback.bps ?? 0;
  const matching = candidates.find((candidate) => candidate.bps === peakBps && candidate.price != null);
  return {
    bps: peakBps,
    price: matching?.price ?? fallback.price ?? null,
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

function expectsNativePegQuote(meta: ReturnType<typeof ACTIVE_META_BY_ID.get>): boolean {
  return (
    typeof meta?.geckoId === "string" &&
    meta.geckoId.length > 0 &&
    normalizeSupportedPegCurrency(meta.flags.pegCurrency) != null
  );
}

export function getPendingExpiryLimitSec(params: {
  primarySameDirectionDepegged: boolean;
  isExtremeMove: boolean;
  unavailableSources: string[];
  circuitOpenSources: string[];
}): number {
  let expirySec = DEPEG_PENDING_EXPIRY_SEC;
  if (
    params.primarySameDirectionDepegged ||
    params.unavailableSources.length > 0 ||
    params.circuitOpenSources.length > 0
  ) {
    expirySec = Math.max(expirySec, DEPEG_PENDING_EXTENDED_EXPIRY_SEC);
  }
  if (params.isExtremeMove) {
    expirySec = Math.max(expirySec, DEPEG_PENDING_SEVERE_EXPIRY_SEC);
  }
  return expirySec;
}

export function buildConfirmationPlan(input: ConfirmationPlanInput): ConfirmationPlan {
  const {
    db,
    row,
    pendingState,
    asset,
    meta,
    pegRates,
    pegRateSources,
    pegRateCounts,
    nativePegQuote,
    openSet,
    now,
  } = input;
  const pegType = normalizePegType(asset?.pegType);
  const refreshedPegReferenceIsAuthoritative =
    asset && meta
      ? isAuthoritativeDepegPegReference({
        pegCurrency: meta.flags.pegCurrency,
        pegType,
        pegRateSource: pegType ? pegRateSources[pegType] : undefined,
        pegRateContributorCount: pegType ? pegRateCounts[pegType] : undefined,
      })
      : false;
  const refreshedPegRef =
    asset && meta && refreshedPegReferenceIsAuthoritative
      ? getPegReference(pegType, pegRates, meta.commodityOunces)
      : Number.NaN;
  const isNativeOrigin = isNativeOriginPending(pendingState.reason);
  const pegReference =
    !isNativeOrigin && Number.isFinite(refreshedPegRef) && refreshedPegRef > 0
      ? refreshedPegRef
      : row.peg_reference;
  const outcomeState: PendingDepegState = { ...pendingState, pegReference };

  if (!Number.isFinite(pegReference) || pegReference <= 0) {
    if (asset && meta && !refreshedPegReferenceIsAuthoritative) {
      return { kind: "wait", reason: "peg-reference-unavailable" };
    }
    console.warn(`[depeg-confirm] Deleted pending for ${row.symbol}: invalid peg_reference=${row.peg_reference}`);
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

  const threshold = getDepegThresholdBps(row.peg_type);
  const secondaryBar = Math.round(threshold * DEPEG_SECONDARY_THRESHOLD_RATIO);
  const primaryTrust = asset ? classifyPrimaryDepegTrust(asset, now) : "unusable";
  const nativeSignal = nativePegQuote ? deriveDepegSignal(nativePegQuote.price, 1) : null;
  const nativeSecondaryStatus = classifyDirectionalSignal(nativeSignal, secondaryBar, pendingState.direction);
  const nativePegRecovered = nativeSecondaryStatus === "recover";
  const nativePegStillDepegged = nativeSecondaryStatus === "confirm";
  const confirmingSources: string[] = [];
  const opposingSources: string[] = [];
  const unavailableSources: string[] = [];
  const circuitOpenSources: string[] = [];
  const hardOpposingSources: string[] = [];
  const nativeSourceKey = buildNativeConfirmationKey(nativePegQuote?.pegCurrency ?? meta?.flags.pegCurrency);
  if (nativeSignal != null && !isNativeOrigin) {
    if (nativeSecondaryStatus === "confirm") addSource(confirmingSources, nativeSourceKey);
    if (isOpposingConfirmationStatus(nativeSecondaryStatus)) {
      addSource(opposingSources, nativeSourceKey);
      addSource(hardOpposingSources, nativeSourceKey);
    }
  } else if (nativeSignal == null && expectsNativePegQuote(meta)) {
    addSource(unavailableSources, buildNativeConfirmationKey(meta?.flags.pegCurrency));
  }

  const authoritativePrice = isNativeOrigin
    ? nativePegQuote?.price ?? null
    : asset != null &&
        primaryTrust === "authoritative" &&
        asset.price != null &&
        typeof asset.price === "number" &&
        Number.isFinite(asset.price) &&
        asset.price > 0
      ? asset.price
      : null;
  const independentPrimaryFamilies =
    isNativeOrigin && asset
      ? getFreshIndependentPrimarySourceFamilies(asset, now, "coingecko")
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
  const primarySignalPrice = isNativeOrigin ? normalizedNativePrimaryPrice : authoritativePrice;
  const currentPrimarySignal =
    primarySignalPrice != null
      ? deriveDepegSignal(primarySignalPrice, pegReference)
      : null;
  const currentPrimaryStatus = classifyDirectionalSignal(currentPrimarySignal, threshold, pendingState.direction);
  const primarySameDirectionDepegged = currentPrimaryStatus === "confirm";
  const primaryConfirmationSources = primarySameDirectionDepegged && asset
    ? (
        isNativeOrigin
          ? [...independentPrimaryFamilies]
          : hasFreshMultiSourcePrimaryAgreement(asset, now)
            ? [...getPrimaryDepegSourceFamilies(asset)]
            : []
      ).sort().map((family) => `primary:${family}`)
    : [];
  if (isNativeOrigin && isOpposingConfirmationStatus(currentPrimaryStatus)) {
    addSources(
      opposingSources,
      [...independentPrimaryFamilies].sort().map((family) => `primary:${family}`),
    );
  }
  const temporalSameDirectionConfirmed =
    pendingState.lastSeenAt - pendingState.firstSeenAt >= DEPEG_PENDING_MIN_AGE_SEC &&
    now - pendingState.lastSeenAt <= DEPEG_PENDING_MIN_AGE_SEC &&
    Math.abs(pendingState.lastSeenBps) >= threshold;

  if (openSet.has(row.stablecoin_id)) {
    console.log(`[depeg-confirm] Cleaned pending for ${row.symbol}: open event already exists`);
    return {
      kind: "mutate",
      statements: buildOutcomeAndDeleteStmts(
        db,
        row,
        outcomeState,
        "superseded",
        now,
        { confirmingSources, opposingSources, unavailableSources, circuitOpenSources },
        "open-event-already-exists",
      ),
    };
  }

  if (nativePegRecovered) {
    console.log(
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

  if (currentPrimaryStatus === "recover" && !nativePegStillDepegged) {
    addSource(opposingSources, "primary:authoritative");
    console.log(
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

  const age = now - pendingState.firstSeenAt;
  if (age < DEPEG_PENDING_MIN_AGE_SEC) {
    return { kind: "wait", reason: "too-young" };
  }

  return {
    kind: "ready",
    row,
    pendingState,
    outcomeState,
    asset,
    meta,
    pegReference,
    threshold,
    secondaryBar,
    nativeSignal,
    nativePegQuote,
    nativeSourceKey,
    authoritativePrice,
    primaryStatus: currentPrimaryStatus,
    primarySameDirectionDepegged,
    primaryConfirmationSources,
    temporalSameDirectionConfirmed,
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
