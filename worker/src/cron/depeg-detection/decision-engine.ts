import { DEPEG_CONFIRMATION_SUPPLY_THRESHOLD, DEPEG_DEX_PROTOCOL_CORROBORATION_MIN, DEPEG_EVENT_MIN_SUPPLY_USD, DEPEG_EXTREME_MOVE_BPS, DEPEG_PENDING_MIN_AGE_SEC } from "@shared/lib/depeg-config";
import { logWorkerEventArgs } from "../../lib/structured-log";
import { DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC } from "@shared/lib/depeg-closure";
import { normalizePricingSourceKeys } from "@shared/lib/pricing-sources";
import { getCirculatingRaw } from "@shared/lib/supply";
import { weightedMedian } from "@shared/lib/stats";
import { corroboratingProtocolGroupsOutvote, divergingProtocolGroupsOutvote, getDepegRecoveryThresholdBps, getDepegThresholdBps, POOL_CHALLENGE_HIGH_TVL_USD } from "../../lib/constants";
import {
  buildPendingReason,
  countDexProtocolCorroborations,
  dexPoolIndependentGroupKey,
  markNativeOriginPending,
  type DepegRow,
  type DexPriceRow,
  type PendingDepegReason,
  type PendingDepegReasonFlag,
} from "../../lib/depeg-helpers";
import {
  classifyPrimaryDepegTrust,
  hasFreshMultiSourcePrimaryAgreement,
  isTrustedDexPriceRow,
} from "../../lib/depeg-trust-policy";
import {
  deriveDepegSignal,
  signalCrossesThreshold,
  signalIsWithinThreshold,
  signalsShareDirection,
  type DepegDirection,
  type DepegSignal,
} from "../../lib/depeg-signals";
import type {
  DepegAssetDecision,
  DepegAssetDecisionInput,
  DepegDiagnostic,
  DepegPersistenceCommand,
  DexPoolChallenger,
  PendingDepegCommandPayload,
  DepegDetectionRow,
} from "./types";
import {
  applyNativeQuoteVeto,
  isNativePegEvent,
  recoveryPriceForEvent,
  resolveDirectRecovery,
  resolvePeakUpdateCommand,
} from "./native-quote-policy";
import { deriveAuthoritativePegSignal } from "../authoritative-peg-signal";

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
  recoveryThreshold: number;
  pegRef: number;
  supply: number;
  primaryTrust: "authoritative" | "confirm_required";
  dexRow: DexPriceRow | undefined;
  dexAbsBps: number | null;
  dexDirectionProtocolCount: number;
  dexExistingDirectionProtocolCount: number;
  dexRecoveryProtocolCount: number;
  dexRecoveryChallenged: boolean;
  poolRecoveryVeto: boolean;
  poolRecoveryVetoGroupCount: number;
  poolRecoveryVetoCorroboratingGroupCount: number;
  poolRecoveryVetoHighTvl: boolean;
  poolRecoverySupported: boolean;
  poolRecoverySupportGroupCount: number;
  poolRecoveryPrice: number | null;
  dexSupportsDirection: boolean;
  dexSupportsExistingDirection: boolean;
  dexSupportsRecovery: boolean;
  primarySupportsRecovery: boolean;
  pendingReason: PendingDepegReason;
  nativeSignal: DepegSignal | null;
  nativePegPrice: number | null;
  nativePegCurrency: string | undefined;
}

const DEPEG_CONFIRMATION_SOFT_SUPPLY_THRESHOLD = DEPEG_CONFIRMATION_SUPPLY_THRESHOLD * 0.75;
const DEPEG_CONFIRMATION_WEAK_SEVERE_SUPPLY_THRESHOLD = DEPEG_CONFIRMATION_SUPPLY_THRESHOLD * 0.5;
const DEPEG_TIERED_CONFIRMATION_SEVERITY_MULTIPLIER = 2;

type DecisionContextDerivation =
  | { kind: "skip"; decision: DepegAssetDecision }
  | { kind: "context"; ctx: DecisionContext };

function emptyDecision(trackedCoinId?: string): DepegAssetDecision {
  return {
    trackedCoinId,
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
  recoverySupported: boolean;
  recoveryGroupCount: number;
  recoveryPrice: number | null;
}

/**
 * Derives the pool-challenger evidence for an open event from the published
 * challenger snapshot: the diverging majority veto and the corroborating
 * majority that can carry a recovery when the primary lane is ambiguous and no
 * fresh trusted aggregate DEX row is available.
 *
 * 2026-09-24 (vchf-vnx): the veto used to fire on POOL_CHALLENGE_CONFIRM_MIN
 * diverging groups with no test against the pools that agree with the recovery.
 * Two dormant diverging venues (a months-silent Celo Uniswap v3 pool with a
 * provider-reported $4.7M reserve and a zero-volume kongswap pool) therefore
 * outvoted the four live protocols that corroborated the at-peg price. Pools
 * inside the trigger threshold now corroborate the recovered price through the
 * shared majority rule; the high-TVL single-pool carve-out is unchanged.
 *
 * 2026-09-24 (usdb-blast): `computeDexPrices` only publishes an aggregate
 * `dex_prices` row when the asset's primary price already clears
 * `classifyPrimaryDepegTrust`/`hasFreshMultiSourcePrimaryAgreement`
 * (`loadTrackedStablecoinMaps` feeds the publisher a trust-filtered price map,
 * and a weak primary withholds the row), so the documented aggregate-DEX
 * recovery lane is structurally unreachable for exactly the ambiguous
 * primaries that need independent corroboration. The same challenger snapshot
 * the veto already consumes is the independent lane: at least
 * POOL_CHALLENGE_CONFIRM_MIN independent groups inside the recovery band that
 * strictly outvote the diverging set support recovery, mirroring
 * `corroboratingProtocolGroupsOutvote`.
 */
function derivePoolChallengerEvidence(params: {
  challengers: DexPoolChallenger[] | undefined;
  pegRef: number;
  threshold: number;
  recoveryThreshold: number;
  depegDirection: DepegDirection;
}): PoolChallengerEvidence {
  const divergingGroups = new Set<string>();
  const corroboratingGroups = new Set<string>();
  const recoveryGroups = new Set<string>();
  const recoveryPools: Array<{ value: number; weight: number }> = [];
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
    if (signalIsWithinThreshold(signal, params.recoveryThreshold)) {
      recoveryGroups.add(groupKey);
      recoveryPools.push({ value: pool.price, weight: pool.tvlUsd });
    }
  }
  const groupCount = divergingGroups.size;
  const recoveryGroupCount = recoveryGroups.size;
  return {
    veto: highTvl || divergingProtocolGroupsOutvote({
      divergingCount: groupCount,
      corroboratingCount: corroboratingGroups.size,
    }),
    groupCount,
    corroboratingGroupCount: corroboratingGroups.size,
    highTvl,
    recoverySupported: !highTvl && corroboratingProtocolGroupsOutvote({
      divergingCount: groupCount,
      corroboratingCount: recoveryGroupCount,
    }),
    recoveryGroupCount,
    recoveryPrice: weightedMedian(recoveryPools),
  };
}

function buildPendingCommand(
  asset: DepegAssetDecisionInput["asset"],
  now: number,
  direction: DepegDirection,
  bps: number,
  eventPrice: number,
  pegReference: number,
  reason: PendingDepegReason,
): DepegPersistenceCommand {
  const payload: PendingDepegCommandPayload = {
    stablecoinId: asset.id,
    symbol: asset.symbol,
    pegType: asset.pegType ?? "",
    direction,
    bps,
    seenAt: now,
    price: eventPrice,
    pegReference,
    reason,
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
  poolRecoverySupported: boolean;
  poolRecoverySupportGroupCount: number;
  poolRecoveryPrice: number | null;
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
  const dexDirectionProtocolCount = countDexProtocolCorroborations(input.protocolSources, pegRef, threshold, direction, "confirm");
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
  const dexRecoveryProtocolCount = countDexProtocolCorroborations(input.protocolSources, pegRef, recoveryThreshold, direction, "recover");
  const recoveryVetoDirection: DepegDirection = existingDirection;
  const dexRecoveryChallenged = hasRecoveryChallenge(input.challengerPools, pegRef, threshold, recoveryVetoDirection);
  const poolChallengerEvidence = derivePoolChallengerEvidence({
    challengers: input.challengerPools,
    pegRef,
    threshold,
    recoveryThreshold,
    depegDirection: recoveryVetoDirection,
  });
  const dexSupportsDirection =
    dexSignal != null &&
    signalCrossesThreshold(dexSignal, threshold) &&
    signalsShareDirection(dexSignal, direction) &&
    dexDirectionProtocolCount >= DEPEG_DEX_PROTOCOL_CORROBORATION_MIN;
  const dexSupportsExistingDirection =
    dexSignal != null &&
    signalCrossesThreshold(dexSignal, threshold) &&
    signalsShareDirection(dexSignal, existingDirection) &&
    dexExistingDirectionProtocolCount >= DEPEG_DEX_PROTOCOL_CORROBORATION_MIN;
  const dexSupportsRecovery =
    dexSignal != null &&
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
    poolRecoverySupported: poolChallengerEvidence.recoverySupported,
    poolRecoverySupportGroupCount: poolChallengerEvidence.recoveryGroupCount,
    poolRecoveryPrice: poolChallengerEvidence.recoveryPrice,
    dexSupportsDirection,
    dexSupportsExistingDirection,
    dexSupportsRecovery,
  };
}

function deriveDecisionContext(input: DepegAssetDecisionInput): DecisionContextDerivation {
  const { now, asset, meta, existing } = input;
  if (!meta) return { kind: "skip", decision: emptyDecision() };
  if (meta.flags.navToken) return { kind: "skip", decision: emptyDecision() };

  const trackedCoinId = asset.id;
  const price = asset.price;
  const primaryTrust = classifyPrimaryDepegTrust(asset, now);
  if (primaryTrust === "unusable" || price == null || typeof price !== "number" || isNaN(price) || price <= 0) {
    return { kind: "skip", decision: emptyDecision(trackedCoinId) };
  }

  const supply = getCirculatingRaw(asset);
  if (supply < DEPEG_EVENT_MIN_SUPPLY_USD) {
    const decision = emptyDecision(trackedCoinId);
    if (existing) {
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
    }
    return { kind: "skip", decision };
  }

  const pegSignal = deriveAuthoritativePegSignal({
    price,
    pegCurrency: meta.flags.pegCurrency,
    pegType: asset.pegType,
    pegRates: input.pegRates,
    pegRateSources: input.pegRateSources,
    pegRateCounts: input.pegRateCounts,
    commodityOunces: meta.commodityOunces,
  });
  if (pegSignal.kind === "rejected" && pegSignal.reason === "non-authoritative-reference") {
    const decision = emptyDecision(trackedCoinId);
    if (existing) {
      decision.seenEventIds.push(existing.id);
    }
    decision.diagnostics.push(withDiagnostic(
      "warn",
      `[depeg] Skipped live-state mutation for ${asset.symbol}: ` +
      `thin ${meta.flags.pegCurrency} peg reference lacks FX fallback`,
    ));
    return { kind: "skip", decision };
  }
  if (pegSignal.kind === "rejected") {
    return { kind: "skip", decision: emptyDecision(trackedCoinId) };
  }
  const pegRef = pegSignal.pegReference;
  const primarySignal = pegSignal.signal;
  const { bps, absBps, direction } = primarySignal;
  const rawAbsBps = primarySignal.absRawBps ?? absBps;
  const threshold = getDepegThresholdBps(asset.pegType);
  const recoveryThreshold = getDepegRecoveryThresholdBps(asset.pegType);
  const nativeSignal = input.nativePegQuote ? deriveDepegSignal(input.nativePegQuote.price, 1) : null;
  const dexEvidence = deriveDexEvidence({ input, existing, now, pegRef, threshold, recoveryThreshold, direction });
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
    poolRecoverySupported,
    poolRecoverySupportGroupCount,
    poolRecoveryPrice,
    dexSupportsDirection,
    dexSupportsExistingDirection,
    dexSupportsRecovery,
  } = dexEvidence;
  const sourceDepth = getPrimarySourceDepth(asset);
  const tieredMarketCapRequiresConfirmation = requiresTieredMarketCapConfirmation({
    supply,
    sourceDepth,
    absBps: rawAbsBps,
    threshold,
  });
  const primarySupportsRecovery =
    primaryTrust === "authoritative" ||
    hasFreshMultiSourcePrimaryAgreement(asset, now);
  const reasonFlags: PendingDepegReasonFlag[] = ["confirmation-window"];
  if (rawAbsBps >= DEPEG_EXTREME_MOVE_BPS) reasonFlags.push("extreme-move");
  if (tieredMarketCapRequiresConfirmation) reasonFlags.push("large-cap");
  if (primaryTrust === "confirm_required") reasonFlags.push("low-confidence");
  const pendingReason: PendingDepegReason = buildPendingReason(reasonFlags);

  return {
    kind: "context",
    ctx: {
      trackedCoinId,
      now,
      asset,
      primarySignal,
      price,
      bps,
      absBps,
      rawAbsBps,
      direction,
      threshold,
      recoveryThreshold,
      pegRef,
      supply,
      primaryTrust,
      dexRow: input.dexRow,
      dexAbsBps,
      dexDirectionProtocolCount,
      dexExistingDirectionProtocolCount,
      dexRecoveryProtocolCount,
      dexRecoveryChallenged,
      poolRecoveryVeto,
      poolRecoveryVetoGroupCount,
      poolRecoveryVetoCorroboratingGroupCount,
      poolRecoveryVetoHighTvl,
      poolRecoverySupported,
      poolRecoverySupportGroupCount,
      poolRecoveryPrice,
      dexSupportsDirection,
      dexSupportsExistingDirection,
      dexSupportsRecovery,
      primarySupportsRecovery,
      pendingReason,
      nativeSignal,
      nativePegPrice: input.nativePegQuote?.price ?? null,
      nativePegCurrency: input.nativePegQuote?.pegCurrency ?? meta.flags.pegCurrency,
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
    ctx.rawAbsBps >= ctx.threshold
  ) {
    return null;
  }

  const commands: DepegPersistenceCommand[] = [];
  const diagnostics: DepegDiagnostic[] = [];
  const reasonFlags: PendingDepegReasonFlag[] = ["confirmation-window"];
  if (ctx.supply >= DEPEG_CONFIRMATION_SUPPLY_THRESHOLD) reasonFlags.push("large-cap");
  if (signalCrossesThreshold(ctx.nativeSignal, DEPEG_EXTREME_MOVE_BPS)) reasonFlags.push("extreme-move");

  const pendingReason = markNativeOriginPending(buildPendingReason(reasonFlags));
  commands.push(buildPendingCommand(
    ctx.asset,
    ctx.now,
    ctx.nativeSignal.direction,
    ctx.nativeSignal.bps,
    ctx.nativePegPrice,
    1,
    pendingReason,
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
  const nativeEvent = isNativePegEvent(existing);
  const eventSignal = nativeEvent ? ctx.nativeSignal : ctx.primarySignal;
  const eventPrice = nativeEvent ? ctx.nativePegPrice : price;
  if (eventSignal == null || eventPrice == null) {
    return { seenEventIds: [existing.id], commands, diagnostics };
  }
  const { bps, direction } = eventSignal;
  const pegRef = nativeEvent ? 1 : ctx.pegRef;

  // Direction change: retire the live row only on authoritative contradiction
  // or corroborated same-direction DEX support for the replacement move.
  if (existing.direction !== direction) {
    if (nativeEvent || primaryTrust === "authoritative" || dexSupportsDirection) {
      commands.push({
        type: "close-event",
        id: existing.id,
        endedAt: now,
        recoveryPrice: null,
        closeReason: "superseded-direction",
      });
      commands.push(buildPendingCommand(
        asset,
        now,
        direction,
        bps,
        eventPrice,
        pegRef,
        nativeEvent ? markNativeOriginPending(pendingReason) : pendingReason,
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
    nativeSignal: ctx.nativeSignal,
    nativePegPrice: ctx.nativePegPrice,
    primarySignal: ctx.primarySignal,
    primaryPrice: price,
    primaryTrust,
    dexSupportsDirection,
  });
  if (peakUpdate) commands.push(peakUpdate);

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

  commands.push(buildPendingCommand(asset, now, direction, bps, ctx.price, pegRef, pendingReason));
  diagnostics.push(withDiagnostic("log", `[depeg] Pending confirmation for ${asset.symbol}: ${bps}bps (${pendingReason})`));
  return { seenEventIds: [], commands, diagnostics };
}

/**
 * Handles an existing open event where price has recovered below threshold.
 * Closes via an authoritative/multi-source primary, a corroborated aggregate
 * DEX row, or a corroborating challenger-pool majority; otherwise keeps open.
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
    poolRecoverySupported,
    poolRecoverySupportGroupCount,
    poolRecoveryPrice,
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
    primaryPrice: price,
    recoveryThreshold,
    primarySupportsRecovery,
    primaryRecoveryContradicted:
      (isDexFresh(dexRow, dexAbsBps, now) && dexSupportsExistingDirection) || poolRecoveryVeto,
  });

  const trustedAggregateDexLane = isDexFresh(dexRow, dexAbsBps, now) && dexRow != null;
  const aggregateDexRecovery = trustedAggregateDexLane && dexSupportsRecovery;
  const poolChallengerRecovery = !trustedAggregateDexLane && poolRecoverySupported;
  const recovery = directRecovery ?? (
    aggregateDexRecovery && dexRow
      ? {
          recoveryPrice: recoveryPriceForEvent(existing, dexRow.dex_price_usd),
          closeReason: "recovered-dex" as const,
        }
      : poolChallengerRecovery
        ? {
            recoveryPrice: recoveryPriceForEvent(existing, poolRecoveryPrice ?? price),
            closeReason: "recovered-dex" as const,
          }
        : null
  );
  if (!directRecovery && poolChallengerRecovery) {
    diagnostics.push(withDiagnostic(
      "log",
      `[depeg] Pool-challenger majority recovery for ${asset.symbol}: ` +
      `${poolRecoverySupportGroupCount} independent group(s) inside the ${recoveryThreshold}bps recovery band ` +
      `outvote ${poolRecoveryVetoGroupCount} diverging group(s)`,
    ));
  }

  if (recovery) {
    const recoveryFirstSeenAt = existing.recovery_first_seen_at;
    const recoveryLastSeenAt = existing.recovery_last_seen_at;
    const continuousWithPrevious =
      recoveryLastSeenAt != null &&
      now - recoveryLastSeenAt <= DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC;
    if (recoveryFirstSeenAt == null || !continuousWithPrevious) {
      commands.push({ type: "begin-recovery", id: existing.id, firstSeenAt: now, lastSeenAt: now });
      seenEventIds.push(existing.id);
    } else if (now - recoveryFirstSeenAt >= DEPEG_PENDING_MIN_AGE_SEC) {
      commands.push({
        type: "close-event",
        id: existing.id,
        endedAt: now,
        ...recovery,
      });
    } else {
      commands.push({ type: "continue-recovery", id: existing.id, lastSeenAt: now });
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

export function decideDepegAsset(input: DepegAssetDecisionInput): DepegAssetDecision {
  const derived = deriveDecisionContext(input);
  if (derived.kind === "skip") return derived.decision;

  const { ctx } = derived;
  if (input.existing && isNativePegEvent(input.existing) && ctx.nativeSignal == null) {
    return {
      trackedCoinId: ctx.trackedCoinId,
      seenEventIds: [input.existing.id],
      commands: [],
      diagnostics: [],
    };
  }
  const nativeVeto = applyNativeQuoteVeto(ctx, input.existing);
  if (nativeVeto) return nativeVeto;

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

  return {
    trackedCoinId: ctx.trackedCoinId,
    seenEventIds: decision.seenEventIds,
    commands: decision.commands,
    diagnostics: decision.diagnostics,
  };
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
