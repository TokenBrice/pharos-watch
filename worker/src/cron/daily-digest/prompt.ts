import type { DigestInputData } from "@shared/types/digest";
import { formatCurrency } from "@shared/lib/format";
import { round1 } from "@shared/lib/math";
import { classifyRegime } from "./prompt/regime";
import {
  formatDigestUsdPrice,
  pushDataQualityLines,
  pushEditorialCandidateLines,
  pushMomentumLines,
  pushDigestIntelligenceLines,
} from "./prompt/data-fmt";

export { SYSTEM_PROMPT } from "./prompt/policy";
export { classifyRegime } from "./prompt/regime";

export interface DigestMeta {
  leadSignalId?: string;
  lead?: string;
  tone?: string;
  coins?: string[];
  usedCandidateIds?: string[];
  suppressedCandidateIds?: string[];
}

export function buildUserPrompt(
  data: DigestInputData,
  recentMeta: { meta: DigestMeta | null; rawText: string | null; title: string | null }[] = [],
): string {
  const regime = classifyRegime(data);
  const lines: string[] = [`Market regime: ${regime}`];

  pushDataQualityLines(lines, data);
  pushEditorialCandidateLines(lines, data);
  pushMomentumLines(lines, data);
  pushDigestIntelligenceLines(lines, data);

  lines.push(
    "",
    "Supporting evidence:",
    `Total stablecoin market cap: ${formatCurrency(data.totalMcapUsd)}`,
    `7-day market cap change: ${data.mcap7dDelta >= 0 ? "+" : ""}${formatCurrency(data.mcap7dDelta)} (${((data.mcap7dDelta / (data.totalMcapUsd - data.mcap7dDelta)) * 100).toFixed(2)}%)`,
    `Currently active depegs (ongoing, not yet resolved): ${data.activeDepegCount}`,
    `Depegs resolved in last 24h: ${data.resolvedDepegs?.length ?? 0}`,
  );

  if (data.totalMcapAth && data.totalMcapAth.value > 0) {
    const pctFromAth = (((data.totalMcapAth.value - data.totalMcapUsd) / data.totalMcapAth.value) * 100).toFixed(2);
    const relation = data.totalMcapUsd < data.totalMcapAth.value ? "below" : "above";
    lines.push(
      `Context: total mcap is ${pctFromAth}% ${relation} its Digest-window ATH (${formatCurrency(data.totalMcapAth.value)} set ${data.totalMcapAth.daysAgo} days ago).`,
    );
  }

  if (data.topDepegs.length > 0) {
    lines.push("Active depegs by market impact (deviation × mcap):");
    for (const depeg of data.topDepegs) {
      const age = depeg.ageHours != null ? ` | age ${depeg.ageHours}h` : "";
      const suppression = depeg.suppressReason ? ` | suppress: ${depeg.suppressReason}` : "";
      const currentPrice = formatDigestUsdPrice(depeg.currentPriceUsd);
      const peak = depeg.peakBps != null && depeg.peakBps !== depeg.bps ? ` | peak ${Math.abs(depeg.peakBps)} bps` : "";
      lines.push(
        `  ${depeg.symbol} | ${Math.abs(depeg.bps)} bps ${depeg.direction ?? (depeg.bps >= 0 ? "above" : "below")}-peg${currentPrice ? ` | current ${currentPrice}` : ""}${peak} | ${formatCurrency(depeg.mcapUsd)} mcap | impact ${depeg.impactScore ?? "n/a"}${age}${suppression}`,
      );
    }
  }

  if (data.stabilityIndex) {
    const { score, band, components } = data.stabilityIndex;
    const trendStr = components.trend >= 0 ? `+${components.trend}` : `${components.trend}`;
    lines.push(
      `Pharos Stability Index: ${score} [${band}] (severity=${components.severity}, breadth=${components.breadth}, trend=${trendStr})`,
    );
    lines.push(
      "  (severity: weighted depeg impact 0-68; breadth: coin-count pressure 0-17; trend: 7d mcap momentum -5 to +5)",
    );
    if (data.yesterdayIndex) {
      lines.push(`Yesterday: ${data.yesterdayIndex.score} [${data.yesterdayIndex.band}]`);
    }
    if (data.historicalContext) {
      const { psiPrecedent, psiBandStreak, digestTrackingDays } = data.historicalContext;
      const trackingWindow = digestTrackingDays > 0 ? ` (Digest history: ${digestTrackingDays} days)` : "";
      if (psiPrecedent && psiPrecedent.lastSeenDaysAgo >= 2) {
        const precedentDate = new Date(psiPrecedent.lastSeenDate * 1000).toISOString().slice(0, 10);
        lines.push(
          `Context: last below ${score} on ${precedentDate}, ${psiPrecedent.lastSeenDaysAgo} days ago${trackingWindow}. Current ${band} streak: ${psiBandStreak} days.`,
        );
      } else if (!psiPrecedent) {
        lines.push(
          `Context: lowest since Digest tracking began${trackingWindow}. Current ${band} streak: ${psiBandStreak} days.`,
        );
      } else {
        lines.push(`Context: current ${band} streak: ${psiBandStreak} days.`);
      }
    }
  }

  if (data.psiContributors && data.psiContributors.length > 0) {
    lines.push("  PSI severity contributors (top coins driving the score):");
    for (const contributor of data.psiContributors) {
      lines.push(
        `    ${contributor.symbol}: ${contributor.bps} bps, mcap ${formatCurrency(contributor.mcapUsd)}, impact ${contributor.marketImpact}`,
      );
    }
  }

  if (data.crossDayTrends) {
    const { psiTrajectory, mcapTrajectory, gaugeTrajectory } = data.crossDayTrends;
    if (psiTrajectory.length >= 3) {
      const psiMissing = psiTrajectory.length < 7 ? ` (${7 - psiTrajectory.length} days missing)` : "";
      lines.push(
        `PSI 7-day trajectory: ${psiTrajectory.map((point) => `${point.date}: ${point.score} [${point.band}]`).join(" -> ")}${psiMissing}`,
      );
    }
    if (mcapTrajectory.length >= 3) {
      const mcapMissing = mcapTrajectory.length < 7 ? ` (${7 - mcapTrajectory.length} days missing)` : "";
      lines.push(
        `Market cap 7-day trajectory: ${mcapTrajectory.map((point) => `${point.date}: ${formatCurrency(point.mcapUsd)}`).join(" -> ")}${mcapMissing}`,
      );
    }
    if (gaugeTrajectory && gaugeTrajectory.length >= 3) {
      const gaugeMissing = gaugeTrajectory.length < 7 ? ` (${7 - gaugeTrajectory.length} days missing)` : "";
      lines.push(
        `Bank Run Gauge 7-day trajectory: ${gaugeTrajectory.map((point) => `${point.date}: ${round1(point.gaugeScore)}`).join(" -> ")}${gaugeMissing}`,
      );
    }
  }

  if (data.biggestSupplyChange) {
    const { symbol, changeUsd, currentMcap } = data.biggestSupplyChange;
    const direction = changeUsd >= 0 ? "increase" : "decrease";
    lines.push(
      `Biggest 7d supply ${direction}: ${symbol} ${changeUsd >= 0 ? "+" : ""}${formatCurrency(changeUsd)} (now ${formatCurrency(currentMcap)})`,
    );
    if (data.historicalContext?.supplyMoverContext) {
      const context = data.historicalContext.supplyMoverContext;
      const athPct = (((context.allTimeHighMcap - currentMcap) / context.allTimeHighMcap) * 100).toFixed(0);
      const relation = currentMcap < context.allTimeHighMcap ? "below" : "above";
      const athDate = new Date(context.allTimeHighDate * 1000).toISOString().slice(0, 10);
      lines.push(
        `Context: ${symbol}'s largest single-week change was ${formatCurrency(context.largestWeeklyChange)} (${context.largestWeeklyChangeDaysAgo} days ago). Current mcap is ${athPct}% ${relation} ATH (${formatCurrency(context.allTimeHighMcap)} on ${athDate}).`,
      );
    }
  }

  if (data.blacklistActivity) {
    const { eventCount, totalAmountUsd, topEvents } = data.blacklistActivity;
    lines.push(
      "",
      `Blacklist activity (rolling last 24h): ${eventCount} events, ${formatCurrency(totalAmountUsd)} affected`,
    );
    for (const event of topEvents) {
      lines.push(`  ${event.symbol} on ${event.chain}: ${event.type} (${formatCurrency(event.amountUsd)})`);
    }
  }

  if (data.supplyVelocity && data.supplyVelocity.length > 0) {
    lines.push("", "Supply velocity (1d vs 7d):");
    for (const velocity of data.supplyVelocity) {
      const day1 = `${velocity.change1d >= 0 ? "+" : ""}${formatCurrency(velocity.change1d)} 1d`;
      const day7 = `${velocity.change7d >= 0 ? "+" : ""}${formatCurrency(velocity.change7d)} 7d`;
      lines.push(`  ${velocity.coin} | ${day1} vs ${day7} | ${velocity.signal}`);
    }
  }

  if (data.mintBurnFlows) {
    const { gaugeScore, gaugeBand, classificationReason, classificationSource, flightToQuality, topPressure } =
      data.mintBurnFlows;
    lines.push("", "Mint/Burn Flows (24h on-chain):");
    lines.push(`  Bank Run Gauge: ${round1(gaugeScore)} [${gaugeBand}]`);
    if (classificationSource === "unavailable") {
      lines.push(`  Flight-to-Quality: unavailable${classificationReason ? ` (${classificationReason})` : ""}`);
    } else if (flightToQuality.active) {
      lines.push(
        `  Flight-to-Quality: ACTIVE, ${formatCurrency(flightToQuality.safeNetUsd)} into safe havens, ${formatCurrency(flightToQuality.riskyNetUsd)} out of risky coins`,
      );
    } else {
      lines.push("  Flight-to-Quality: inactive");
    }
    if (topPressure.length > 0) {
      lines.push("  Top pressure shifts vs 30d baseline:");
      for (const pressure of topPressure) {
        lines.push(
          `    ${pressure.symbol}: ${Math.round(pressure.intensity)} (net ${formatCurrency(pressure.net24hUsd)} yesterday)`,
        );
      }
    }
    if (data.mintBurnFlows.topChains && data.mintBurnFlows.topChains.length > 0) {
      lines.push("  Top chains by net flow:");
      for (const chain of data.mintBurnFlows.topChains) {
        lines.push(`    ${chain.chainId}: ${chain.netUsd >= 0 ? "+" : ""}${formatCurrency(chain.netUsd)} net`);
      }
    }
  }

  if (data.dewsStress) {
    const { bandCounts, yesterdayBandCounts, bandChanges, elevatedCoins } = data.dewsStress;
    lines.push("", "DEWS Stress Signals:");
    lines.push(
      `  Band distribution: ${bandCounts.calm} CALM, ${bandCounts.watch} WATCH, ${bandCounts.alert} ALERT, ${bandCounts.warning} WARNING, ${bandCounts.danger} DANGER (vs yesterday: ${yesterdayBandCounts.calm}/${yesterdayBandCounts.watch}/${yesterdayBandCounts.alert}/${yesterdayBandCounts.warning}/${yesterdayBandCounts.danger})`,
    );
    if (bandChanges.length > 0) {
      lines.push("  Band changes (last 24h):");
      for (const change of bandChanges) {
        lines.push(
          `    ${change.symbol}: ${change.from} -> ${change.to} (score ${change.score}, driven by ${change.topDriver})`,
        );
      }
    }
    if (elevatedCoins.length > 0) {
      lines.push("  Elevated coins (ALERT+):");
      for (const coin of elevatedCoins) {
        const driverStr = coin.topSignals?.length
          ? `driven by ${coin.topSignals.map((signal) => `${signal.name}=${signal.value}`).join(", ")}`
          : "";
        lines.push(
          `    ${coin.symbol} | ${coin.band} score ${coin.score} | ${formatCurrency(coin.mcapUsd)} mcap | ${driverStr}`,
        );
      }
    }
  }

  if (data.gradeTransitions && data.gradeTransitions.length > 0) {
    lines.push("", "Grade Transitions (last 48h):");
    for (const transition of data.gradeTransitions) {
      const dims = transition.currentDimensions;
      lines.push(
        `  ${transition.symbol} | ${transition.fromGrade} (${transition.fromScore}) -> ${transition.toGrade} (${transition.toScore}) | ${formatCurrency(transition.mcapUsd)} mcap | peg=${dims.peg}, liq=${dims.liq}, resilience=${dims.resilience}, decentralization=${dims.decentralization}`,
      );
    }
  }

  if (data.safetyScores) {
    const { mentionedCoins } = data.safetyScores;
    if (mentionedCoins.length > 0) {
      lines.push("", "Safety Scores:");
      for (const coin of mentionedCoins) {
        const parts = [`${coin.symbol}: ${coin.grade} (${coin.score}`];
        if (coin.peg !== null) parts.push(`peg=${coin.peg}`);
        if (coin.liq !== null) parts.push(`liq=${coin.liq}`);
        lines.push(`  ${parts.join(", ")})`);
      }
    }
  }

  if (data.yieldAnomalies && data.yieldAnomalies.length > 0) {
    lines.push("", "Yield Anomalies:");
    for (const anomaly of data.yieldAnomalies) {
      lines.push(
        `  ${anomaly.symbol} | ${anomaly.currentApy}% APY (7d avg ${anomaly.apy7d}%, 30d avg ${anomaly.apy30d}%) | ${formatCurrency(anomaly.mcapUsd)} mcap | ${anomaly.warnings.join(", ")}`,
      );
    }
  }

  if (data.liquidityShifts && data.liquidityShifts.length > 0) {
    lines.push("", "DEX Liquidity Shifts (day-over-day):");
    for (const shift of data.liquidityShifts) {
      const dir = shift.scoreDelta > 0 ? "+" : "";
      lines.push(
        `  ${shift.symbol} | score ${shift.previousScore} -> ${shift.currentScore} (${dir}${shift.scoreDelta}) | ${formatCurrency(shift.mcapUsd)} mcap | TVL ${formatCurrency(shift.previousTvl)} -> ${formatCurrency(shift.currentTvl)}`,
      );
    }
  }

  if (data.resolvedDepegs && data.resolvedDepegs.length > 0) {
    lines.push("", "Recently resolved depegs:");
    for (const resolved of data.resolvedDepegs) {
      lines.push(
        `  ${resolved.symbol} | ${resolved.peakBps} bps peak, ${resolved.durationHours}h duration | ${formatCurrency(resolved.mcapUsd)} mcap | recovered`,
      );
    }
  }

  const metaLines: string[] = [];
  const rawFallbacks: string[] = [];
  for (let i = 0; i < recentMeta.length; i++) {
    const entry = recentMeta[i];
    if (entry.meta) {
      const meta = entry.meta;
      metaLines.push(
        `  Day -${i + 1}: "${entry.title}" — lead: ${meta.lead ?? "unknown"}, tone: ${meta.tone ?? "unknown"}, coins: ${(meta.coins ?? []).join(", ") || "none"}`,
      );
    } else if (entry.rawText) {
      rawFallbacks.push(`- "${entry.rawText}"`);
    }
  }
  if (metaLines.length > 0) {
    lines.push("", "Recent digest angles (DO NOT repeat any of these approaches):", ...metaLines);
  }
  if (rawFallbacks.length > 0) {
    lines.push("", "RECENT DIGESTS — do NOT reuse phrasing, metaphors, or structure:", ...rawFallbacks);
  }

  return lines.join("\n");
}
