import type {
  DigestEditorialCandidate,
  DigestForwardLookOutcome,
  DigestInputData,
  DigestNextTrigger,
} from "@shared/types/digest";
import { formatCurrency } from "@shared/lib/format";
import { selectMomentumCandidates } from "./editorial-candidates";
import {
  DEWS_BAND_RANK,
  formatScore,
  roundToStep,
  signedCurrency,
  toDateString,
  TRIGGER_LIMIT,
  unique,
  usableCandidates,
} from "./digest-intelligence-utils";

// A trigger may live at most this many consecutive editions without firing
// before it expires and cedes its slot. The apxUSD-3,650 trigger once ran 20
// straight editions with a byte-identical "pending" outcome.
const TRIGGER_MAX_EDITIONS = 3;

/**
 * Apply lifecycle rules against the previous edition's triggers:
 * - Sticky threshold: an already-armed trigger keeps its original threshold
 *   (re-deriving daily chased the metric — the PSI goalpost moved 89→93 as
 *   PSI rose, so it could never fire).
 * - Re-arm on fire: a trigger that hit yesterday re-derives fresh today.
 * - TTL: a trigger pending for TRIGGER_MAX_EDITIONS editions expires (dropped
 *   here; buildForwardLookOutcomes records the "expired" outcome).
 */
function applyTriggerLifecycle(
  trigger: DigestNextTrigger,
  data: DigestInputData,
  previousTriggers: ReadonlyMap<string, DigestNextTrigger>,
): DigestNextTrigger | null {
  const previous = previousTriggers.get(trigger.id);
  if (!previous) return trigger;
  if (previous.thresholdValue != null && triggerHit(previous, data).status === "hit") {
    return trigger;
  }
  const repeatedCount = (previous.repeatedCount ?? 0) + 1;
  if (repeatedCount >= TRIGGER_MAX_EDITIONS) return null;
  return {
    ...trigger,
    ...(previous.thresholdValue != null
      ? { thresholdValue: previous.thresholdValue, thresholdLabel: previous.thresholdLabel }
      : {}),
    repeatedCount,
  };
}

export function buildNextTriggers(
  data: DigestInputData,
  previousData: DigestInputData | null = null,
): DigestNextTrigger[] {
  const triggers: DigestNextTrigger[] = [];
  const previousTriggers = new Map((previousData?.nextTriggers ?? []).map((trigger) => [trigger.id, trigger]));
  const candidates = data.editorialCandidates ?? [];
  const momentum = selectMomentumCandidates(candidates);
  const preferredCandidates = unique([...usableCandidates(data).slice(0, 2), ...momentum]);

  const pushWithLifecycle = (trigger: DigestNextTrigger | null): void => {
    if (!trigger || triggers.some((existing) => existing.id === trigger.id)) return;
    const lively = applyTriggerLifecycle(trigger, data, previousTriggers);
    if (lively) triggers.push(lively);
  };

  for (const candidate of preferredCandidates) {
    if (triggers.length >= TRIGGER_LIMIT) break;
    pushWithLifecycle(triggerForCandidate(candidate, data));
  }

  if (triggers.length < TRIGGER_LIMIT) {
    const topDepeg = data.topDepegs.find((depeg) => !depeg.suppressReason);
    pushWithLifecycle(topDepeg ? depegTrigger(topDepeg) : null);
  }

  if (triggers.length < TRIGGER_LIMIT && data.stabilityIndex) {
    pushWithLifecycle(psiTrigger(data.stabilityIndex.score));
  }

  return triggers.slice(0, TRIGGER_LIMIT);
}

export function buildForwardLookOutcomes(
  data: DigestInputData,
  previousData: DigestInputData | null,
): DigestForwardLookOutcome[] {
  const triggers = previousData?.nextTriggers ?? [];
  if (triggers.length === 0) return [];
  const sourceDate = toDateString(previousData?.dataQuality?.generatedAt);
  return triggers.slice(0, TRIGGER_LIMIT).map((trigger) => {
    const result = triggerHit(trigger, data);
    // A trigger that has sat pending for its whole TTL records "expired"
    // instead of another identical pending line; buildNextTriggers drops it.
    const expired = result.status === "pending" && (trigger.repeatedCount ?? 0) >= TRIGGER_MAX_EDITIONS - 1;
    return {
      id: `outcome:${trigger.id}`,
      triggerId: trigger.id,
      label: trigger.label,
      status: expired ? ("expired" as const) : result.status,
      detail: expired
        ? `${result.detail} Trigger expired after ${TRIGGER_MAX_EDITIONS} editions without firing.`
        : result.detail,
      sourceDate,
    };
  });
}

function triggerForCandidate(
  candidate: DigestEditorialCandidate,
  data: DigestInputData,
): DigestNextTrigger | null {
  const symbol = candidate.symbols[0]?.toUpperCase();
  if (candidate.kind === "depeg" && symbol) {
    // Candidate ids embed the stablecoinId ("depeg:<id>:active"); prefer it so
    // same-symbol coins (the two USDAs) cannot cross-match.
    const candidateCoinId = candidate.id.split(":")[1];
    const depeg =
      data.topDepegs.find((entry) => entry.stablecoinId != null && entry.stablecoinId === candidateCoinId) ??
      data.topDepegs.find((entry) => entry.symbol.toUpperCase() === symbol);
    return depeg ? depegTrigger(depeg, candidate.id) : null;
  }
  if (candidate.kind === "supply" && symbol) {
    const velocity = (data.supplyVelocity ?? []).find((entry) => entry.coin.toUpperCase() === symbol);
    return velocity ? supplyVelocityTrigger(velocity, candidate.id) : null;
  }
  if (candidate.kind === "market" && data.biggestSupplyChange) {
    return weeklySupplyTrigger(data.biggestSupplyChange, candidate.id);
  }
  if (candidate.kind === "mint-burn" && data.mintBurnFlows) {
    return gaugeTrigger(data.mintBurnFlows.gaugeScore, candidate.id);
  }
  if (candidate.kind === "dews" && symbol) {
    const changed = data.dewsStress?.bandChanges.find((entry) => entry.symbol.toUpperCase() === symbol);
    const elevated = data.dewsStress?.elevatedCoins.find((entry) => entry.symbol.toUpperCase() === symbol);
    return changed || elevated
      ? dewsTrigger(symbol, changed?.to ?? elevated?.band ?? "ALERT", candidate.id)
      : null;
  }
  if (candidate.kind === "psi" && data.stabilityIndex) {
    return psiTrigger(data.stabilityIndex.score, candidate.id);
  }
  // Yield/liquidity candidates dominated the usable set during the July 2026
  // chronic era but had no evaluator, so triggers degenerated to the same
  // depeg+PSI pair for three straight weeks.
  if (candidate.kind === "yield" && symbol) {
    const anomaly = (data.yieldAnomalies ?? []).find((entry) => entry.symbol.toUpperCase() === symbol);
    return anomaly ? yieldTrigger(anomaly, candidate.id) : null;
  }
  if (candidate.kind === "liquidity" && symbol) {
    const shift = (data.liquidityShifts ?? []).find((entry) => entry.symbol.toUpperCase() === symbol);
    return shift ? liquidityTrigger(shift, candidate.id) : null;
  }
  return null;
}

function yieldTrigger(
  anomaly: NonNullable<DigestInputData["yieldAnomalies"]>[number],
  candidateId?: string,
): DigestNextTrigger {
  const symbol = anomaly.symbol.toUpperCase();
  const threshold = Math.round(anomaly.apy7d * 1.2 * 10) / 10;
  return {
    id: `trigger:yield:${symbol.toLowerCase()}`,
    label: `${symbol} yield anomaly cooling`,
    metric: "yield-apy",
    comparator: "lte",
    thresholdValue: threshold,
    thresholdLabel: `${threshold}% APY`,
    symbol,
    candidateId,
    rationale: "An APY back near its 7d average means the spike anomaly resolved rather than persisting.",
    detail: `If ${symbol}'s best APY falls back to ${threshold}% (1.2x its 7d average of ${anomaly.apy7d}%), the anomaly is cooling.`,
  };
}

function liquidityTrigger(
  shift: NonNullable<DigestInputData["liquidityShifts"]>[number],
  candidateId?: string,
): DigestNextTrigger {
  const symbol = shift.symbol.toUpperCase();
  const worsening = shift.scoreDelta < 0;
  const threshold = Math.round(worsening ? shift.currentScore - 8 : shift.currentScore + 8);
  return {
    id: `trigger:liquidity:${symbol.toLowerCase()}`,
    label: worsening ? `${symbol} liquidity decay continuing` : `${symbol} liquidity recovery continuing`,
    metric: "liquidity-score",
    comparator: worsening ? "lte" : "gte",
    thresholdValue: threshold,
    thresholdLabel: `liquidity score ${threshold}`,
    symbol,
    candidateId,
    rationale: worsening
      ? "A second 8-point drop confirms structural depth loss rather than a one-day rebalance."
      : "A second 8-point gain confirms depth genuinely returning.",
    detail: `If ${symbol}'s DEX liquidity score ${worsening ? "falls to" : "climbs to"} ${threshold}, the move has follow-through.`,
  };
}

function depegTrigger(
  depeg: DigestInputData["topDepegs"][number],
  candidateId?: string,
): DigestNextTrigger {
  // Threshold arms off the live deviation; a peak-derived threshold can sit
  // permanently above a static live price and never fire.
  const absBps = Math.abs(depeg.currentBps ?? depeg.bps);
  const threshold = roundToStep(Math.max(absBps + 25, absBps * 1.15), 25, "up");
  const symbol = depeg.symbol.toUpperCase();
  return {
    id: `trigger:depeg:${(depeg.stablecoinId ?? symbol).toLowerCase()}`,
    ...(depeg.stablecoinId != null ? { stablecoinId: depeg.stablecoinId } : {}),
    label: `${symbol} depeg widening`,
    metric: "depeg-bps",
    comparator: "abs-gte",
    thresholdValue: threshold,
    thresholdLabel: `${threshold} bps off peg`,
    symbol,
    candidateId,
    rationale: "A wider deviation raises market-impact severity and lead priority.",
    detail: `If ${symbol} reaches ${threshold} bps off peg, the next digest should treat it as a stronger peg-stress signal.`,
  };
}

function supplyVelocityTrigger(
  velocity: NonNullable<DigestInputData["supplyVelocity"]>[number],
  candidateId?: string,
): DigestNextTrigger {
  const threshold = roundToStep(Math.max(Math.abs(velocity.change1d) * 1.25, 10_000_000), 5_000_000, "up");
  const symbol = velocity.coin.toUpperCase();
  return {
    id: `trigger:supply-1d:${symbol.toLowerCase()}`,
    label: `${symbol} 1d supply velocity`,
    metric: "supply-1d-usd",
    comparator: "abs-gte",
    thresholdValue: threshold,
    thresholdLabel: `${formatCurrency(threshold, 0)} 1d move`,
    symbol,
    candidateId,
    rationale: "A larger one-day supply move confirms whether the velocity signal is still building.",
    detail: `If ${symbol} moves at least ${formatCurrency(threshold, 0)} in one day, the supply story graduates from drift to rotation.`,
  };
}

function weeklySupplyTrigger(
  mover: NonNullable<DigestInputData["biggestSupplyChange"]>,
  candidateId?: string,
): DigestNextTrigger {
  const threshold = roundToStep(Math.max(Math.abs(mover.changeUsd) * 1.1, 25_000_000), 10_000_000, "up");
  const symbol = mover.symbol.toUpperCase();
  return {
    id: `trigger:supply-7d:${symbol.toLowerCase()}`,
    label: `${symbol} weekly supply move`,
    metric: "supply-7d-usd",
    comparator: "abs-gte",
    thresholdValue: threshold,
    thresholdLabel: `${formatCurrency(threshold, 0)} 7d move`,
    symbol,
    candidateId,
    rationale: "The largest weekly mover stays editorially useful only if the move keeps scaling.",
    detail: `If ${symbol}'s 7d supply move clears ${formatCurrency(threshold, 0)}, the market-structure story has follow-through.`,
  };
}

function gaugeTrigger(score: number, candidateId?: string): DigestNextTrigger {
  const threshold = score < 0 ? roundToStep(score - 5, 5, "down") : -10;
  return {
    id: "trigger:gauge",
    label: "Bank Run Gauge pressure",
    metric: "bank-run-gauge",
    comparator: "lte",
    thresholdValue: threshold,
    thresholdLabel: `${formatScore(threshold)} or lower`,
    candidateId,
    rationale: "A lower gauge reading would confirm holder pressure instead of one-day noise.",
    detail: `If the Bank Run Gauge falls to ${formatScore(threshold)} or lower, flow stress becomes the next lead candidate.`,
  };
}

function dewsTrigger(symbol: string, band: string, candidateId?: string): DigestNextTrigger {
  const rank = Math.max(DEWS_BAND_RANK[band] ?? 2, DEWS_BAND_RANK.ALERT);
  const label = Object.entries(DEWS_BAND_RANK).find(([, value]) => value === rank)?.[0] ?? "ALERT";
  return {
    id: `trigger:dews:${symbol.toLowerCase()}`,
    label: `${symbol} DEWS severity`,
    metric: "dews-band",
    comparator: "band-gte",
    thresholdValue: rank,
    thresholdLabel: `${label} or worse`,
    symbol,
    candidateId,
    rationale: "A sustained or worsening DEWS band is stronger than a single transition.",
    detail: `If ${symbol} remains ${label} or worse, the risk signal survives the first-day band-change noise test.`,
  };
}

function psiTrigger(score: number, candidateId?: string): DigestNextTrigger {
  const threshold = Math.max(0, Math.floor(score - 2));
  return {
    id: "trigger:psi-score",
    label: "PSI deterioration",
    metric: "psi-score",
    comparator: "lte",
    thresholdValue: threshold,
    thresholdLabel: `${threshold} or lower`,
    candidateId,
    rationale: "A two-point PSI drop is large enough to change the regime frame.",
    detail: `If PSI falls to ${threshold} or lower, tomorrow's story should shift from regime frame to active deterioration.`,
  };
}

function triggerHit(
  trigger: DigestNextTrigger,
  data: DigestInputData,
): Pick<DigestForwardLookOutcome, "status" | "detail"> {
  const threshold = trigger.thresholdValue;
  if (threshold == null) return { status: "pending", detail: "Trigger had no numeric threshold to evaluate." };
  if (trigger.metric === "depeg-bps" && trigger.symbol) return depegOutcome(trigger, data, threshold);
  if (trigger.metric === "supply-1d-usd" && trigger.symbol) return supply1dOutcome(trigger, data, threshold);
  if (trigger.metric === "supply-7d-usd" && trigger.symbol) return supply7dOutcome(trigger, data, threshold);
  if (trigger.metric === "bank-run-gauge") return gaugeOutcome(trigger, data, threshold);
  if (trigger.metric === "dews-band" && trigger.symbol) return dewsOutcome(trigger, data, threshold);
  if (trigger.metric === "psi-score") return psiOutcome(trigger, data, threshold);
  if (trigger.metric === "yield-apy" && trigger.symbol) return yieldOutcome(trigger, data, threshold);
  if (trigger.metric === "liquidity-score" && trigger.symbol) return liquidityOutcome(trigger, data, threshold);
  return { status: "pending", detail: "No evaluator exists for this trigger." };
}

function yieldOutcome(trigger: DigestNextTrigger, data: DigestInputData, threshold: number) {
  const anomaly = (data.yieldAnomalies ?? []).find(
    (entry) => entry.symbol.toUpperCase() === trigger.symbol?.toUpperCase(),
  );
  if (!anomaly) {
    return { status: "hit" as const, detail: `${trigger.symbol} cleared the yield-anomaly warning set.` };
  }
  return {
    status: anomaly.currentApy <= threshold ? ("hit" as const) : ("pending" as const),
    detail: `${trigger.symbol} best APY is ${anomaly.currentApy}% versus ${trigger.thresholdLabel}.`,
  };
}

function liquidityOutcome(trigger: DigestNextTrigger, data: DigestInputData, threshold: number) {
  const shift = (data.liquidityShifts ?? []).find(
    (entry) => entry.symbol.toUpperCase() === trigger.symbol?.toUpperCase(),
  );
  if (!shift) {
    return {
      status: "missed" as const,
      detail: `${trigger.symbol} had no follow-through liquidity move today.`,
    };
  }
  const hit = trigger.comparator === "lte" ? shift.currentScore <= threshold : shift.currentScore >= threshold;
  return {
    status: hit ? ("hit" as const) : ("pending" as const),
    detail: `${trigger.symbol} liquidity score is ${shift.currentScore} versus ${trigger.thresholdLabel}.`,
  };
}

function depegOutcome(trigger: DigestNextTrigger, data: DigestInputData, threshold: number) {
  const depeg =
    (trigger.stablecoinId != null
      ? data.topDepegs.find((entry) => entry.stablecoinId === trigger.stablecoinId)
      : undefined) ?? data.topDepegs.find((entry) => entry.symbol.toUpperCase() === trigger.symbol?.toUpperCase());
  if (!depeg) return { status: "missed" as const, detail: `${trigger.symbol} is no longer in the active depeg set.` };
  const absBps = Math.abs(depeg.currentBps ?? depeg.bps);
  return {
    status: absBps >= threshold ? "hit" as const : "pending" as const,
    detail: `${trigger.symbol} is now ${absBps} bps off peg versus ${trigger.thresholdLabel}.`,
  };
}

function supply1dOutcome(trigger: DigestNextTrigger, data: DigestInputData, threshold: number) {
  const velocity = (data.supplyVelocity ?? []).find((entry) => entry.coin.toUpperCase() === trigger.symbol?.toUpperCase());
  if (!velocity) return { status: "missed" as const, detail: `${trigger.symbol} has no current supply-velocity signal.` };
  return {
    status: Math.abs(velocity.change1d) >= threshold ? "hit" as const : "missed" as const,
    detail: `${trigger.symbol} moved ${signedCurrency(velocity.change1d)} over 1d versus ${trigger.thresholdLabel}.`,
  };
}

function supply7dOutcome(trigger: DigestNextTrigger, data: DigestInputData, threshold: number) {
  const symbol = trigger.symbol?.toUpperCase();
  const biggestChange = data.biggestSupplyChange;
  const biggestWeeklyChange = biggestChange && biggestChange.symbol.toUpperCase() === symbol
    ? { coin: biggestChange.symbol, change7d: biggestChange.changeUsd }
    : null;
  const weeklyChange = (data.supplyChanges7d ?? []).find((entry) => entry.coin.toUpperCase() === symbol)
    ?? biggestWeeklyChange
    ?? (data.supplyVelocity ?? []).find((entry) => entry.coin.toUpperCase() === symbol);
  if (!weeklyChange) return { status: "missed" as const, detail: `${trigger.symbol} has no current weekly supply change.` };
  return {
    status: Math.abs(weeklyChange.change7d) >= threshold ? "hit" as const : "missed" as const,
    detail: `${trigger.symbol} moved ${signedCurrency(weeklyChange.change7d)} over 7d versus ${trigger.thresholdLabel}.`,
  };
}

function gaugeOutcome(trigger: DigestNextTrigger, data: DigestInputData, threshold: number) {
  const score = data.mintBurnFlows?.gaugeScore;
  if (score == null) return { status: "pending" as const, detail: "Bank Run Gauge is unavailable in the current input." };
  return {
    status: score <= threshold ? "hit" as const : "missed" as const,
    detail: `Bank Run Gauge is ${formatScore(score)} versus ${trigger.thresholdLabel}.`,
  };
}

function dewsOutcome(trigger: DigestNextTrigger, data: DigestInputData, threshold: number) {
  const coin = data.dewsStress?.elevatedCoins.find((entry) => entry.symbol.toUpperCase() === trigger.symbol?.toUpperCase())
    ?? data.dewsStress?.bandChanges.find((entry) => entry.symbol.toUpperCase() === trigger.symbol?.toUpperCase());
  const band = coin && "band" in coin ? coin.band : coin && "to" in coin ? coin.to : null;
  if (!band) return { status: "missed" as const, detail: `${trigger.symbol} is no longer elevated in DEWS.` };
  return {
    status: (DEWS_BAND_RANK[band] ?? 0) >= threshold ? "hit" as const : "missed" as const,
    detail: `${trigger.symbol} is ${band} versus ${trigger.thresholdLabel}.`,
  };
}

function psiOutcome(trigger: DigestNextTrigger, data: DigestInputData, threshold: number) {
  const score = data.stabilityIndex?.score;
  if (score == null) return { status: "pending" as const, detail: "PSI is unavailable in the current input." };
  return {
    status: score <= threshold ? "hit" as const : "missed" as const,
    detail: `PSI is ${formatScore(score)} versus ${trigger.thresholdLabel}.`,
  };
}
