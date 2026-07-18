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

export function buildNextTriggers(data: DigestInputData): DigestNextTrigger[] {
  const triggers: DigestNextTrigger[] = [];
  const candidates = data.editorialCandidates ?? [];
  const momentum = selectMomentumCandidates(candidates);
  const preferredCandidates = unique([...usableCandidates(data).slice(0, 2), ...momentum]);

  for (const candidate of preferredCandidates) {
    if (triggers.length >= TRIGGER_LIMIT) break;
    const trigger = triggerForCandidate(candidate, data);
    if (trigger && !triggers.some((existing) => existing.id === trigger.id)) {
      triggers.push(trigger);
    }
  }

  if (triggers.length < TRIGGER_LIMIT) {
    const topDepeg = data.topDepegs.find((depeg) => !depeg.suppressReason);
    const trigger = topDepeg ? depegTrigger(topDepeg) : null;
    if (trigger && !triggers.some((existing) => existing.id === trigger.id)) triggers.push(trigger);
  }

  if (triggers.length < TRIGGER_LIMIT && data.stabilityIndex) {
    triggers.push(psiTrigger(data.stabilityIndex.score));
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
    return {
      id: `outcome:${trigger.id}`,
      triggerId: trigger.id,
      label: trigger.label,
      status: result.status,
      detail: result.detail,
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
  return null;
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
  return { status: "pending", detail: "No evaluator exists for this trigger." };
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
