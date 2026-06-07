import { getPegReference } from "@shared/lib/peg-rates";
import { normalizePricingSourceKeys } from "@shared/lib/pricing-sources";
import { sumPegBuckets } from "@shared/lib/supply";
import type { DepegEvent } from "@shared/types/market";
import {
  DEPEG_CONFIRMATION_SUPPLY_THRESHOLD,
  DEPEG_DEX_PROTOCOL_CORROBORATION_MIN,
  DEPEG_EVENT_MIN_SUPPLY_USD,
  DEPEG_EXTREME_MOVE_BPS,
  DEPEG_SECONDARY_THRESHOLD_RATIO,
  getDepegThresholdBps,
} from "../../lib/constants";
import {
  buildPendingReason,
  countDexProtocolCorroborations,
  isExtremeMovePending,
  type DepegRow,
  type DexPriceRow,
  type PendingDepegReason,
  type PendingDepegReasonFlag,
} from "../../lib/depeg-helpers";
import {
  classifyPrimaryDepegTrust,
  hasFreshMultiSourcePrimaryAgreement,
  isAuthoritativeDepegPegReference,
  isTrustedDexPriceRow,
} from "../../lib/depeg-trust-policy";
import {
  deriveDepegSignal,
  signalCrossesThreshold,
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
} from "./types";

interface DecisionContext {
  trackedCoinId: string;
  now: number;
  asset: DepegAssetDecisionInput["asset"];
  price: number;
  bps: number;
  absBps: number;
  direction: DepegDirection;
  threshold: number;
  pegRef: number;
  supply: number;
  primaryTrust: "authoritative" | "confirm_required";
  dexRow: DexPriceRow | undefined;
  dexAbsBps: number | null;
  dexDirectionProtocolCount: number;
  dexRecoveryProtocolCount: number;
  dexRecoveryChallenged: boolean;
  dexSupportsDirection: boolean;
  dexSupportsSecondaryBarDirection: boolean;
  dexSupportsRecovery: boolean;
  primarySupportsRecovery: boolean;
  requiresConfirmation: boolean;
  pendingReason: PendingDepegReason;
  nativeSignal: DepegSignal | null;
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

function buildLiveEventCommand(
  asset: DepegAssetDecisionInput["asset"],
  now: number,
  direction: DepegDirection,
  peakDeviationBps: number,
  eventPrice: number,
  pegReference: number,
): DepegPersistenceCommand {
  const event: DepegEvent = {
    id: 0,
    stablecoinId: asset.id,
    symbol: asset.symbol,
    pegType: asset.pegType ?? "",
    direction,
    peakDeviationBps,
    startedAt: now,
    endedAt: null,
    startPrice: eventPrice,
    peakPrice: eventPrice,
    recoveryPrice: null,
    pegReference,
    source: "live",
    confirmationSources: null,
    pendingReason: null,
  };
  return { type: "insert-live", event };
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

  const supply = sumPegBuckets(asset.circulating);
  if (supply < DEPEG_EVENT_MIN_SUPPLY_USD) {
    const decision = emptyDecision(trackedCoinId);
    if (existing) {
      decision.commands.push({
        type: "close-event",
        id: existing.id,
        endedAt: now,
        recoveryPrice: null,
        recoveryPriceMode: "null",
      });
      decision.diagnostics.push(withDiagnostic(
        "log",
        `[depeg] Closing live event for ${asset.symbol}: ` +
        `supply $${Math.round(supply).toLocaleString("en-US")} is below the live-event floor`,
      ));
    }
    return { kind: "skip", decision };
  }

  const pegReferenceIsAuthoritative = isAuthoritativeDepegPegReference({
    pegCurrency: meta.flags.pegCurrency,
    pegType: asset.pegType,
    pegRateSource: asset.pegType ? input.pegRateSources[asset.pegType] : undefined,
    pegRateContributorCount: asset.pegType ? input.pegRateCounts[asset.pegType] : undefined,
  });
  if (!pegReferenceIsAuthoritative) {
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

  const pegRef = getPegReference(asset.pegType, input.pegRates, meta.commodityOunces);
  if (!Number.isFinite(pegRef) || pegRef <= 0) {
    return { kind: "skip", decision: emptyDecision(trackedCoinId) };
  }

  const primarySignal = deriveDepegSignal(price, pegRef);
  if (primarySignal == null) {
    return { kind: "skip", decision: emptyDecision(trackedCoinId) };
  }
  const { bps, absBps, direction } = primarySignal;
  const threshold = getDepegThresholdBps(asset.pegType);
  const nativeSignal = input.nativePegQuote ? deriveDepegSignal(input.nativePegQuote.price, 1) : null;
  const dexSignal = input.dexRow && isTrustedDexPriceRow(input.dexRow, now, "depeg")
    ? deriveDepegSignal(input.dexRow.dex_price_usd, pegRef)
    : null;
  const dexAbsBps = dexSignal?.absBps ?? null;
  const secondaryBar = Math.round(threshold * DEPEG_SECONDARY_THRESHOLD_RATIO);
  const dexDirectionProtocolCount = countDexProtocolCorroborations(input.protocolSources, pegRef, threshold, direction, "confirm");
  const dexSecondaryDirectionProtocolCount = countDexProtocolCorroborations(input.protocolSources, pegRef, secondaryBar, direction, "confirm");
  const dexRecoveryProtocolCount = countDexProtocolCorroborations(input.protocolSources, pegRef, threshold, direction, "recover");
  const recoveryVetoDirection: DepegDirection =
    existing?.direction === "above" ? "above" : existing?.direction === "below" ? "below" : direction;
  const dexRecoveryChallenged = hasRecoveryChallenge(input.challengerPools, pegRef, threshold, recoveryVetoDirection);
  const dexSupportsDirection =
    dexSignal != null &&
    signalCrossesThreshold(dexSignal, threshold) &&
    signalsShareDirection(dexSignal, direction) &&
    dexDirectionProtocolCount >= DEPEG_DEX_PROTOCOL_CORROBORATION_MIN;
  const dexSupportsSecondaryBarDirection =
    dexSignal != null &&
    signalCrossesThreshold(dexSignal, secondaryBar) &&
    signalsShareDirection(dexSignal, direction) &&
    dexSecondaryDirectionProtocolCount >= DEPEG_DEX_PROTOCOL_CORROBORATION_MIN;
  const dexSupportsRecovery =
    dexSignal != null &&
    dexSignal.absBps < threshold &&
    dexRecoveryProtocolCount >= DEPEG_DEX_PROTOCOL_CORROBORATION_MIN &&
    !dexRecoveryChallenged;
  const sourceDepth = getPrimarySourceDepth(asset);
  const tieredMarketCapRequiresConfirmation = requiresTieredMarketCapConfirmation({
    supply,
    sourceDepth,
    absBps,
    threshold,
  });
  const requiresConfirmation =
    tieredMarketCapRequiresConfirmation ||
    primaryTrust === "confirm_required" ||
    absBps >= DEPEG_EXTREME_MOVE_BPS;
  const primarySupportsRecovery =
    primaryTrust === "authoritative" ||
    hasFreshMultiSourcePrimaryAgreement(asset, now);
  const reasonFlags: PendingDepegReasonFlag[] = [];
  if (absBps >= DEPEG_EXTREME_MOVE_BPS) reasonFlags.push("extreme-move");
  if (tieredMarketCapRequiresConfirmation) reasonFlags.push("large-cap");
  if (primaryTrust === "confirm_required") reasonFlags.push("low-confidence");
  if (reasonFlags.length === 0) reasonFlags.push("large-cap"); // defensive - requiresConfirmation is true so at least one reason must apply.
  const pendingReason: PendingDepegReason = buildPendingReason(reasonFlags);

  return {
    kind: "context",
    ctx: {
      trackedCoinId,
      now,
      asset,
      price,
      bps,
      absBps,
      direction,
      threshold,
      pegRef,
      supply,
      primaryTrust,
      dexRow: input.dexRow,
      dexAbsBps,
      dexDirectionProtocolCount,
      dexRecoveryProtocolCount,
      dexRecoveryChallenged,
      dexSupportsDirection,
      dexSupportsSecondaryBarDirection,
      dexSupportsRecovery,
      primarySupportsRecovery,
      requiresConfirmation,
      pendingReason,
      nativeSignal,
      nativePegCurrency: input.nativePegQuote?.pegCurrency ?? meta.flags.pegCurrency,
    },
  };
}

function buildNativeSuppressionWarning(ctx: DecisionContext): DepegDiagnostic {
  return withDiagnostic(
    "warn",
    `[depeg] Suppressed live depeg mutation for ${ctx.asset.symbol}: ` +
    `primary=${ctx.bps}bps but direct ${ctx.nativePegCurrency} quote=${ctx.nativeSignal?.bps ?? "n/a"}bps`,
  );
}

function applyNativeQuoteVeto(
  ctx: DecisionContext,
  existing: DepegRow | undefined,
): DepegAssetDecision | null {
  const nativeSupportsPrimaryDirection =
    ctx.nativeSignal != null &&
    signalCrossesThreshold(ctx.nativeSignal, ctx.threshold) &&
    signalsShareDirection(ctx.nativeSignal, ctx.direction);
  const nativeShowsRecovery = ctx.nativeSignal != null && ctx.nativeSignal.absBps < ctx.threshold;
  const nativeSupportsExistingDirection =
    existing != null &&
    ctx.nativeSignal != null &&
    signalCrossesThreshold(ctx.nativeSignal, ctx.threshold) &&
    signalsShareDirection(ctx.nativeSignal, existing.direction as DepegDirection);

  if (ctx.absBps >= ctx.threshold && ctx.nativeSignal != null && !nativeSupportsPrimaryDirection) {
    const decision = emptyDecision(ctx.trackedCoinId);
    if (nativeShowsRecovery) {
      if (existing) {
        decision.commands.push({
          type: "close-event",
          id: existing.id,
          endedAt: ctx.now,
          recoveryPrice: null,
          recoveryPriceMode: "null",
        });
      }
      decision.diagnostics.push(buildNativeSuppressionWarning(ctx));
      return decision;
    }

    if (existing && nativeSupportsExistingDirection) {
      decision.seenEventIds.push(existing.id);
    }
    decision.diagnostics.push(buildNativeSuppressionWarning(ctx));
    return decision;
  }

  if (ctx.absBps < ctx.threshold && existing && nativeSupportsExistingDirection) {
    const decision = emptyDecision(ctx.trackedCoinId);
    decision.seenEventIds.push(existing.id);
    decision.diagnostics.push(withDiagnostic(
      "warn",
      `[depeg] Kept ${ctx.asset.symbol} open despite primary recovery: ` +
      `primary=${ctx.bps}bps but direct ${ctx.nativePegCurrency} quote=${ctx.nativeSignal?.bps ?? "n/a"}bps`,
    ));
    return decision;
  }

  return null;
}

/**
 * Handles an existing open event where deviation still exceeds threshold.
 * Covers same-direction peak updates and direction changes.
 */
function decideExistingEvent(
  ctx: DecisionContext,
  existing: DepegRow,
): Omit<DepegAssetDecision, "trackedCoinId"> {
  const {
    now,
    asset,
    price,
    bps,
    absBps,
    direction,
    threshold,
    pegRef,
    primaryTrust,
    dexRow,
    dexAbsBps,
    dexSupportsDirection,
    dexSupportsSecondaryBarDirection,
    requiresConfirmation,
    pendingReason,
  } = ctx;
  const commands: DepegPersistenceCommand[] = [];
  const seenEventIds: number[] = [];
  const diagnostics: DepegDiagnostic[] = [];

  // Direction change: retire the live row only on authoritative contradiction
  // or corroborated same-direction DEX support for the replacement move.
  if (existing.direction !== direction) {
    if (primaryTrust === "authoritative" || dexSupportsDirection) {
      commands.push({
        type: "close-event",
        id: existing.id,
        endedAt: now,
        recoveryPrice: price,
        recoveryPriceMode: "bind",
      });
      if (requiresConfirmation) {
        commands.push(buildPendingCommand(asset, now, direction, bps, price, pegRef, pendingReason));
      } else {
        commands.push(buildLiveEventCommand(asset, now, direction, bps, price, pegRef));
      }
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
  const canUpdatePeak =
    primaryTrust === "authoritative" ||
    dexSupportsDirection ||
    (primaryTrust === "confirm_required" && dexSupportsSecondaryBarDirection);
  if (canUpdatePeak && absBps > Math.abs(existing.peak_deviation_bps)) {
    commands.push({
      type: "update-peak",
      id: existing.id,
      peakDeviationBps: bps,
      peakPrice: price,
    });
  }

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
 * Routes to pending confirmation for large-cap / low-confidence / extreme moves,
 * or applies DEX cross-validation before instant event creation.
 */
function decideNewDepeg(ctx: DecisionContext): Omit<DepegAssetDecision, "trackedCoinId"> {
  const {
    now,
    asset,
    bps,
    direction,
    pegRef,
    supply,
    dexRow,
    dexAbsBps,
    dexSupportsDirection,
    dexSupportsRecovery,
    requiresConfirmation,
    pendingReason,
  } = ctx;
  const commands: DepegPersistenceCommand[] = [];
  const diagnostics: DepegDiagnostic[] = [];

  if (supply >= DEPEG_CONFIRMATION_SUPPLY_THRESHOLD) {
    // >=$1B coin: insert into pending table for confirmation next cycle.
    commands.push(buildPendingCommand(asset, now, direction, bps, ctx.price, pegRef, pendingReason));
    diagnostics.push(withDiagnostic(
      "log",
      `[depeg] Pending confirmation for ${asset.symbol}: ${bps}bps (supply $${(supply / 1e9).toFixed(1)}B)`,
    ));
    return { seenEventIds: [], commands, diagnostics };
  }

  if (requiresConfirmation) {
    if (isExtremeMovePending(pendingReason) && dexSupportsDirection) {
      commands.push(buildLiveEventCommand(asset, now, direction, bps, ctx.price, pegRef));
    } else {
      commands.push(buildPendingCommand(asset, now, direction, bps, ctx.price, pegRef, pendingReason));
      diagnostics.push(withDiagnostic("log", `[depeg] Pending confirmation for ${asset.symbol}: ${bps}bps (${pendingReason})`));
    }
    return { seenEventIds: [], commands, diagnostics };
  }

  // <$1B coin, no special confirmation needed - DEX cross-validation then instant event.
  if (isDexFresh(dexRow, dexAbsBps, ctx.now) && dexRow && dexSupportsRecovery) {
    diagnostics.push(withDiagnostic(
      "log",
      `[depeg] Suppressed new event for ${asset.symbol}: ` +
      `primary=${bps}bps but DEX=${dexAbsBps}bps (${dexRow.source_pool_count} pools, ` +
      `$${(dexRow.source_total_tvl / 1e6).toFixed(1)}M TVL)`,
    ));
    return { seenEventIds: [], commands, diagnostics };
  }

  commands.push(buildLiveEventCommand(asset, now, direction, bps, ctx.price, pegRef));
  return { seenEventIds: [], commands, diagnostics };
}

/**
 * Handles an existing open event where price has recovered below threshold.
 * Closes via authoritative primary or confirming DEX data, otherwise keeps open.
 */
function decideRecovery(
  ctx: DecisionContext,
  existing: DepegRow,
): Omit<DepegAssetDecision, "trackedCoinId"> {
  const {
    now,
    asset,
    price,
    primarySupportsRecovery,
    threshold,
    dexRow,
    dexAbsBps,
    dexRecoveryProtocolCount,
    dexRecoveryChallenged,
    dexSupportsRecovery,
  } = ctx;
  const commands: DepegPersistenceCommand[] = [];
  const seenEventIds: number[] = [];
  const diagnostics: DepegDiagnostic[] = [];

  if (primarySupportsRecovery) {
    // Price recovered - close the event.
    commands.push({
      type: "close-event",
      id: existing.id,
      endedAt: now,
      recoveryPrice: price,
      recoveryPriceMode: "bind",
    });
  } else if (isDexFresh(dexRow, dexAbsBps, now) && dexRow && dexSupportsRecovery) {
    commands.push({
      type: "close-event",
      id: existing.id,
      endedAt: now,
      recoveryPrice: dexRow.dex_price_usd,
      recoveryPriceMode: "bind",
    });
  } else {
    seenEventIds.push(existing.id);
    if (isDexFresh(dexRow, dexAbsBps, now) && dexRow && dexAbsBps != null && dexAbsBps < threshold) {
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

export function decideDepegAsset(input: DepegAssetDecisionInput): DepegAssetDecision {
  const derived = deriveDecisionContext(input);
  if (derived.kind === "skip") return derived.decision;

  const { ctx } = derived;
  const nativeVeto = applyNativeQuoteVeto(ctx, input.existing);
  if (nativeVeto) return nativeVeto;

  const decision = input.existing
    ? ctx.absBps >= ctx.threshold
      ? decideExistingEvent(ctx, input.existing)
      : decideRecovery(ctx, input.existing)
    : ctx.absBps >= ctx.threshold
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
      console.warn(diagnostic.message);
    } else {
      console.log(diagnostic.message);
    }
  }
}
