import { formatCurrency } from "@shared/lib/format";
import { round1 } from "@shared/lib/math";
import type { DigestValidationProfile } from "../daily-digest/response";
import { forbiddenTicsPromptLine } from "../daily-digest/voice-guards";
import type { WeeklyInputData } from "./types";

export const WEEKLY_SYSTEM_PROMPT = [
  "You write the weekly editorial recap for Pharos, a stablecoin analytics dashboard.",
  "Dry, sharp, memorable, like a sardonic columnist synthesizing rather than reporting.",
  "",
  "You receive a week of daily digest data, pre-aggregated weekly signal leaderboards, and week-over-week delta summaries.",
  "Use the Weekly Risk Leaderboard and Weekly Signals block as the source of truth for the week's protagonists. Use the week-over-week deltas to frame where this week sits versus the previous one.",
  "Daily headlines show how the week felt in sequence; the signal leaderboard and deltas decide what mattered.",
  "The top unsuppressed Weekly Risk Leaderboard item must drive P1. If it is a critical depeg, PSI becomes regime context, not the lead.",
  "",
  "ARC FRAMING.",
  "Find the week's narrative arc: what started, what ended, what is building.",
  "A weekly recap that reads like seven daily digests stapled together has failed.",
  "Do not turn seven observations of the same chronic active depeg into seven events. Separate active observations from unique signals.",
  "STANDING CONDITIONS get one line each at most and never the headline; NEW THIS WEEK signals are the story.",
  "Do not dramatize suppressed, stale, zero-dollar, tiny, or artifact-prone signals. If the week was genuinely calm, say so clearly.",
  "Synthesize causally: reuse at most two numbers verbatim from the daily copy, and never quote or cite a daily headline as evidence of anything.",
  "",
  "FORWARD-LOOK MANDATE.",
  "The last paragraph must contain an anticipatory sentence about next week. Acceptable: 'next week will decide whether X', 'watch the Y threshold if Z continues', 'the next trigger is W crossing V'.",
  "Retrospective-only recaps are rejected.",
  "",
  "SPICE BUDGET.",
  "Earn one sharp sentence per recap: a named analogy, a historical parallel, or a concrete-stakes observation.",
  "One per recap. Do not force it.",
  "",
  "FORBIDDEN TICS.",
  forbiddenTicsPromptLine(),
  "",
  "FORMATTING.",
  "No emojis, no clickbait, no hedging, no exclamation marks.",
  "NEVER use em dashes or en dashes. Use commas, semicolons, colons, or periods.",
  "",
  "STRUCTURE.",
  "The extended field is 4-6 paragraphs, 250-400 words total.",
  "P1: the week's headline from the top unsuppressed risk leader, with PSI arc and dominant regime as context.",
  "P2: the dominant story, the thread that ran through multiple days.",
  "P3: the counter-narrative, what moved the opposite direction or was quietly significant.",
  "P4: supply and capital flows, weekly mcap movement, biggest movers, gauge trend, referring to week-over-week deltas when they change the story.",
  "P5-P6 (optional): a structural observation or the forward-look.",
  "If using fewer than 6 paragraphs, fold the forward-look into the last paragraph.",
  "",
  "Every sentence must contain a specific number or coin name. Reference individual daily headlines when they illustrate a point.",
  "",
  "OUTPUT CONTRACT.",
  'Respond with valid JSON only: { "title": "3-8 word headline", "extended": "...", "text": "tweet-sized hook under 270 chars combined with title", ',
  '  "meta": { "leadSignalId": "...", "lead": "one of allowed leads", "tone": "one of allowed tones", "coins": ["..."], "usedCandidateIds": [...] } }',
  "Allowed leads and tones are identical to the daily contract.",
].join("\n");

export function buildWeeklyPrompt(
  data: WeeklyInputData,
  recentWeeklyMeta: { meta: Record<string, unknown> | null; title: string | null; rawText?: string | null }[] = [],
): string {
  const safetyIdentity =
    data.safetyContext?.status === "available"
      ? data.safetyContext.identity
      : null;
  const safetyContextAvailable = safetyIdentity != null;
  const lines: string[] = [
    `Weekly recap: trailing daily editions from ${data.weekStartDate} to ${data.weekEndDate}`,
    "",
    `PSI range: ${data.psiRange.min} to ${data.psiRange.max} (start: ${data.psiRange.start}, end: ${data.psiRange.end})`,
    `Dominant band: ${data.psiRange.dominantBand}`,
    `Market cap: ${formatCurrency(data.mcapRange.start)} -> ${formatCurrency(data.mcapRange.end)} (${data.mcapRange.pctChange == null ? "N/A" : `${data.mcapRange.pctChange >= 0 ? "+" : ""}${data.mcapRange.pctChange.toFixed(2)}%`})`,
    `Active depeg observations across daily editions: ${data.activeDepegObservationsThisWeek}`,
    `Unique depeg signals reconstructed from daily inputs: ${data.uniqueDepegSignalsThisWeek}`,
    `Total blacklist events: ${data.totalBlacklistEventsThisWeek}, ${formatCurrency(data.totalBlacklistAmountUsd)} affected`,
    `${safetyContextAvailable ? "Grade transitions" : "Risk transitions"}: ${data.gradeTransitionCount}`,
  ];

  if (safetyContextAvailable) {
    const identity = safetyIdentity;
    lines.push(
      `Safety source: ${identity.model.toUpperCase()} methodology=${identity.methodologyVersion}, build=${identity.evaluationBuildDigest}, generation=${identity.publicationGenerationId}${identity.model === "v9" ? `, policy=${identity.policyId}:${identity.policyDigest}` : ""}`,
    );
  } else if (data.safetyContext?.status === "unavailable") {
    lines.push(
      `Editorial omission: a canonical input (${data.safetyContext.expectedModel.toUpperCase()}: ${data.safetyContext.reason}) is unavailable. Omit that topic entirely; do not mention the missing input or draw conclusions from it.`,
    );
  }

  if (data.gaugeRange) {
    lines.push(`Bank Run Gauge range: ${round1(data.gaugeRange.min)} to ${round1(data.gaugeRange.max)}`);
  }

  lines.push("", "Weekly spike metrics (do not let averages erase these):");
  if (data.spikeMetrics.minPsi) {
    lines.push(
      `  Worst PSI day: ${data.spikeMetrics.minPsi.date}, ${data.spikeMetrics.minPsi.score} [${data.spikeMetrics.minPsi.band}]`,
    );
  }
  if (data.spikeMetrics.minGauge) {
    lines.push(
      `  Lowest Bank Run Gauge day: ${data.spikeMetrics.minGauge.date}, ${round1(data.spikeMetrics.minGauge.score)}`,
    );
  }
  if (data.spikeMetrics.maxDepeg) {
    lines.push(
      `  Worst depeg by bps: ${data.spikeMetrics.maxDepeg.date} ${data.spikeMetrics.maxDepeg.symbol}, ${data.spikeMetrics.maxDepeg.bps} bps, ${formatCurrency(data.spikeMetrics.maxDepeg.mcapUsd)} mcap`,
    );
  }
  if (data.spikeMetrics.maxDepegImpact) {
    lines.push(
      `  Largest depeg market impact: ${data.spikeMetrics.maxDepegImpact.date} ${data.spikeMetrics.maxDepegImpact.symbol}, impact ${data.spikeMetrics.maxDepegImpact.impactScore}, ${data.spikeMetrics.maxDepegImpact.bps} bps`,
    );
  }

  if (data.weekOverWeekDeltas) {
    const d = data.weekOverWeekDeltas;
    lines.push("", "Week-over-week deltas (this week vs prior week):");
    lines.push(
      `  mcap: current ${formatCurrency(d.mcap.current)} / prior ${formatCurrency(d.mcap.prior)} / delta ${d.mcap.deltaPct == null ? "n/a" : `${d.mcap.deltaPct >= 0 ? "+" : ""}${d.mcap.deltaPct.toFixed(2)}%`}`,
    );
    lines.push(
      `  PSI midpoint: current ${d.psi.current.toFixed(1)} / prior ${d.psi.prior.toFixed(1)} / delta ${d.psi.delta >= 0 ? "+" : ""}${d.psi.delta.toFixed(1)}`,
    );
    lines.push(`  PSI dominant band: current ${d.psiDominantBand.current} / prior ${d.psiDominantBand.prior}`);
    lines.push(
      `  Active depeg observations: current ${d.activeDepegObservations.current} / prior ${d.activeDepegObservations.prior}`,
    );
    lines.push(`  Unique depeg signals: current ${d.uniqueDepegSignals.current} / prior ${d.uniqueDepegSignals.prior}`);
    lines.push(`  Blacklist events: current ${d.blacklistEvents.current} / prior ${d.blacklistEvents.prior}`);
    lines.push(
      `  Blacklist USD: current ${formatCurrency(d.blacklistUsd.current)} / prior ${formatCurrency(d.blacklistUsd.prior)}`,
    );
    lines.push(
      `  ${safetyContextAvailable ? "Grade transitions" : "Risk transitions"}: current ${d.gradeTransitions.current} / prior ${d.gradeTransitions.prior}`,
    );
    if (d.gauge.current != null && d.gauge.prior != null) {
      lines.push(
        `  Bank Run Gauge midpoint: current ${d.gauge.current.toFixed(1)} / prior ${d.gauge.prior.toFixed(1)}`,
      );
    }
    lines.push(`  Data coverage: ${d.dataCoverage.currentDays}d current, ${d.dataCoverage.priorDays}d prior`);
  } else {
    lines.push("", "Week-over-week deltas: unavailable (insufficient prior-week history).");
  }

  if (data.forwardLookScoreboard) {
    const scoreboard = data.forwardLookScoreboard;
    lines.push(
      "",
      `Forward-look scoreboard (this week's daily trigger outcomes): ${scoreboard.hit} hit / ${scoreboard.missed} missed / ${scoreboard.expired} expired / ${scoreboard.pending} pending.`,
      "Include this score in the recap when any triggers resolved; own the misses plainly.",
    );
  }

  lines.push("", "Weekly Risk Leaderboard (P1 lead must be the top unsuppressed item):");
  if (data.weeklySignals.riskLeaderboard.length > 0) {
    const freshSignals = data.weeklySignals.riskLeaderboard.filter((signal) => !signal.carriedOver);
    const standingSignals = data.weeklySignals.riskLeaderboard.filter((signal) => signal.carriedOver);
    const renderSignal = (signal: (typeof data.weeklySignals.riskLeaderboard)[number]): void => {
      const critical = signal.critical ? " | critical" : "";
      const suppression = signal.suppressReason ? ` | suppress: ${signal.suppressReason}` : "";
      lines.push(
        `  ${signal.id} | ${signal.kind} | severity=${round1(signal.severityScore)} | impact=${round1(signal.impactScore)}${critical}${suppression}`,
      );
      lines.push(`    ${signal.label}`);
    };
    if (freshSignals.length > 0) {
      lines.push("  NEW THIS WEEK:");
      freshSignals.forEach(renderSignal);
    }
    if (standingSignals.length > 0) {
      lines.push("  STANDING CONDITIONS (carried over from prior weeks — one line each at most, never the headline):");
      standingSignals.forEach(renderSignal);
    }
  } else {
    lines.push("  No material risk signals reconstructed from daily inputs.");
  }

  lines.push("", "Weekly Signals (synthesize from this, do not merely recap daily copy):");
  if (data.weeklySignals.topDepegSignals.length > 0) {
    lines.push("  Top depeg signals by absolute market impact:");
    for (const signal of data.weeklySignals.topDepegSignals) {
      const suppression = signal.suppressReason ? ` | suppress: ${signal.suppressReason}` : "";
      const critical = signal.critical ? " | critical" : "";
      lines.push(
        `    ${signal.date} ${signal.symbol}: ${signal.label}, ${formatCurrency(signal.mcapUsd)} mcap, impact ${signal.impactScore}, severity ${signal.severityScore}${critical}${suppression}`,
      );
    }
  }
  if (data.weeklySignals.topSupplySignals.length > 0) {
    lines.push("  Top supply/velocity signals:");
    for (const signal of data.weeklySignals.topSupplySignals) {
      lines.push(
        `    ${signal.symbol}: ${signal.label}, ${signal.amountUsd >= 0 ? "+" : ""}${formatCurrency(signal.amountUsd)}`,
      );
    }
  }
  if (data.weeklySignals.topDewsChanges.length > 0 || data.weeklySignals.maxAlertPlusMcapUsd > 0) {
    lines.push(`  DEWS: max ALERT+ mcap ${formatCurrency(data.weeklySignals.maxAlertPlusMcapUsd)}`);
    for (const change of data.weeklySignals.topDewsChanges) {
      lines.push(
        `    ${change.symbol}: ${change.from} -> ${change.to}, score ${change.score}, ${formatCurrency(change.mcapUsd)} mcap, driver ${change.driver}`,
      );
    }
  }
  if (data.weeklySignals.topPressureSignals.length > 0) {
    lines.push("  Mint/burn pressure extremes:");
    for (const pressure of data.weeklySignals.topPressureSignals) {
      lines.push(
        `    ${pressure.date} ${pressure.symbol}: intensity ${Math.round(pressure.intensity)}, net ${formatCurrency(pressure.net24hUsd)}`,
      );
    }
  }
  if (data.weeklySignals.topBlacklistEvents.length > 0) {
    lines.push("  Top blacklist events:");
    for (const event of data.weeklySignals.topBlacklistEvents) {
      lines.push(
        `    ${event.date} ${event.symbol} on ${event.chain}: ${event.type}, ${formatCurrency(event.amountUsd)}`,
      );
    }
  }
  if (safetyContextAvailable && data.weeklySignals.topGradeTransitions.length > 0) {
    lines.push("  Top grade transitions by mcap:");
    for (const transition of data.weeklySignals.topGradeTransitions) {
      lines.push(
        `    ${transition.date} ${transition.symbol}: ${transition.model.toUpperCase()} ${transition.fromGrade} -> ${transition.toGrade}, ${formatCurrency(transition.mcapUsd)} mcap`,
      );
    }
  }
  if (data.weeklySignals.topYieldAnomalies.length > 0) {
    lines.push("  Yield anomalies needing corroboration:");
    for (const anomaly of data.weeklySignals.topYieldAnomalies) {
      lines.push(
        `    ${anomaly.date} ${anomaly.symbol}: ${anomaly.apy}% APY, ${formatCurrency(anomaly.mcapUsd)} mcap, ${anomaly.warnings.join(", ")}`,
      );
    }
  }
  if (data.weeklySignals.topLiquidityShifts.length > 0) {
    lines.push("  Liquidity shifts:");
    for (const shift of data.weeklySignals.topLiquidityShifts) {
      lines.push(
        `    ${shift.date} ${shift.symbol}: score delta ${shift.scoreDelta > 0 ? "+" : ""}${shift.scoreDelta}, ${formatCurrency(shift.mcapUsd)} mcap`,
      );
    }
  }

  const compatibleHeadlines = data.dailyDigests.filter((digest) => digest.title.trim().length > 0);
  const compatibleSummaries = data.dailyDigests.filter((digest) => digest.text.trim().length > 0);
  lines.push("", "Identity-compatible daily digest headlines:");
  for (const d of compatibleHeadlines) {
    const psi = d.inputData.stabilityIndex;
    lines.push(
      `  ${d.date}: "${d.title}" — PSI ${psi?.score ?? "?"} [${psi?.band ?? "?"}], mcap ${formatCurrency(d.inputData.totalMcapUsd)}`,
    );
  }
  if (compatibleHeadlines.length === 0) {
    lines.push("  None; use the structured weekly signals only.");
  }

  lines.push("", "Identity-compatible daily digest summaries:");
  for (const d of compatibleSummaries) {
    lines.push(`  ${d.date}: ${d.text}`);
  }
  if (compatibleSummaries.length === 0) {
    lines.push("  None; use the structured weekly signals only.");
  }

  if (recentWeeklyMeta.length > 0) {
    lines.push("", "Recent weekly recap angles (do not repeat the same frame):");
    for (let i = 0; i < recentWeeklyMeta.length; i++) {
      const entry = recentWeeklyMeta[i];
      const lead = typeof entry.meta?.lead === "string" ? entry.meta.lead : "unknown";
      const tone = typeof entry.meta?.tone === "string" ? entry.meta.tone : "unknown";
      lines.push(`  Week -${i + 1}: "${entry.title ?? "Untitled"}" | lead=${lead} | tone=${tone}`);
    }
  }

  return lines.join("\n");
}

export function buildWeeklyLeadRequirements(data: WeeklyInputData): DigestValidationProfile["leadRequirements"] {
  // Only a critical that is NEW this week may hard-pin the weekly lead; a
  // carried-over chronic critical already headlined prior recaps.
  const topCritical = data.weeklySignals.riskLeaderboard.find(
    (signal) => !signal.suppressReason && signal.critical && !signal.carriedOver,
  );
  if (!topCritical) return undefined;
  return [
    {
      candidateIds: [topCritical.id],
      severity: "hard",
      mentionTokens: topCritical.symbols,
      reason: `weekly risk leaderboard critical ${topCritical.kind} must drive the lead`,
    },
  ];
}
