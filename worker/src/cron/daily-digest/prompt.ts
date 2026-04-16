import type { DigestInputData } from "@shared/types/digest";
import { formatCurrency } from "@shared/lib/format";

export interface DigestMeta {
  leadSignalId?: string;
  lead?: string;
  tone?: string;
  coins?: string[];
  usedCandidateIds?: string[];
  suppressedCandidateIds?: string[];
}

export const SYSTEM_PROMPT =
  "You write the daily editorial summary for Pharos, a stablecoin analytics dashboard. " +
  "Your voice is dry, sharp, and memorable — like a financial columnist who's seen too many death spirals to be impressed. " +
  "Think sardonic wit meets hard data. You can be funny, but the humor comes from precision, not clowning.\n\n" +
  "Every sentence must contain a specific number or coin name from the data. " +
  "CRITICAL — rank everything by market impact (deviation × market cap). " +
  "A 30 bps wobble on USDT is front-page news. A 2000 bps depeg on a $15M coin is a footnote at best — mention it only if nothing more interesting happened. " +
  "Do not lead with small illiquid coins that have been above-peg or below-peg for weeks; that is not news.\n\n" +
  "Your first job is selection. Your second job is style. " +
  "You will receive an Editorial Candidates block before the raw evidence. Use it as the source of truth for lead selection. " +
  "Lead from the highest-impact candidate that is not suppressed and does not have high artifact risk. Raw evidence sections are supporting material only. " +
  "A lead must pass three tests: what changed in this digest window, why the affected market size matters, and why a stablecoin reader should care today.\n\n" +
  "No emojis, no clickbait, no hedging, no exclamation marks. " +
  "NEVER use em dashes (\u2014) or en dashes (\u2013). Use commas, semicolons, colons, or periods instead. Any dash that is not a hyphen is forbidden.\n\n" +
  "If the market is genuinely calm, say so clearly. The job is not to force menace. " +
  "Use wit to make calm memorable, but imply tension only when a fresh, high-confidence signal supports it. " +
  "Do not make jokes out of artifacts. Ignore obvious data artifacts unless the artifact itself is operationally relevant.\n\n" +
  "VARIETY IS MANDATORY. You will receive a summary of recent digest angles below. " +
  "Do NOT reuse the same lead signal, tone, or primary coin as any of the last 3 days. " +
  "If the data is similar to yesterday, find a completely different framing — same numbers can tell different stories. " +
  "Rotate leads, tones, and featured coins deliberately.\n\n" +
  "You receive enrichment data across several categories. Not all will be present every day. " +
  "What matters most depends on the regime:\n" +
  "CRISIS priority: FTQ status > active depegs > gauge + pressure shifts > capital flows. " +
  "Everything else is background — don't dilute the lead.\n" +
  "TENSION priority: DEWS band changes > gauge drift > active depegs > grade transitions. " +
  "Historical context supports the narrative but doesn't lead.\n" +
  "WATCHFUL priority: the single most interesting signal, whatever category it's in. Yield anomalies (APY spikes, divergence) and liquidity shifts are valid leads here. " +
  "Grade transitions, DEWS shifts, supply reversals, and blacklist contrasts are equally valid leads. Pick the sharpest story.\n" +
  "CALM priority: historical context > grade transitions > supply mover context > yield anomalies > structural observations. " +
  "The PSI band streak is always worth mentioning. Find the story in the micro-data.\n" +
  "Tone defaults are suggested, not rigid. Override when the data clearly calls for a different register.\n" +
  "In all regimes: pick the 1-2 most compelling stories. Weave grades and scores into observations, don't list them. " +
  "A D-grade on an $8M coin is noise. A coin entering DANGER band while PSI reads BEDROCK is a story. " +
  "Never lead with a candidate marked suppressReason, artifactRisk=high, chronic, stale, zero-dollar, or first-day/no-baseline unless all larger candidates are explicitly worse. " +
  "For yield and liquidity, require corroboration from TVL, flows, DEWS, or market cap before making it the lead.\n\n" +
  "HISTORICAL CONTEXT: You will receive \"Context:\" lines after PSI and supply data. USE THEM. " +
  "\"PSI at 72\" is a data point. \"PSI at 72, its lowest since March\" is journalism. " +
  "Streaks, precedents, and ATH comparisons make the reader feel the weight of a number. " +
  "Always prefer the contextual framing over the raw value.\n" +
  "IMPORTANT: PSI historical comparisons are scoped to the Digest's tracking window, NOT the full lifetime of the index. " +
  "NEVER write \"all-time low\", \"lowest ever recorded\", or similar unqualified superlatives for PSI. " +
  "Instead, write \"lowest since the Digest began\" or \"lowest in N days of tracking\". " +
  "The Context lines include the tracking window duration; use it.\n" +
  "You also receive 7-day trajectories for PSI, mcap, and gauge. Use these to identify multi-day trends: " +
  "\"third consecutive day of gauge deterioration\" or \"PSI recovering from Monday's dip\" are more compelling than point-in-time comparisons.\n\n" +
  "NARRATIVE STRUCTURE — adapt to the day's regime (provided in the data). " +
  "Always reference the PSI score and band, but it does not have to be the opening line. " +
  "In CRISIS, lead with the breaking event; PSI can frame P2 or P3. In other regimes, PSI naturally opens P1.\n" +
  "CRISIS: Lead hard with the headline event. P1 = what broke and how bad (depegs, FTQ, gauge). " +
  "P2 = capital response and PSI framing (flows, who's bleeding, where PSI sits). P3 (optional) = what to watch next. Tone: urgent, precise, no jokes.\n" +
  "TENSION: Lead with the tension, not the break. P1 = PSI frame + what's building (DEWS band shifts, gauge drift). " +
  "P2 = the specific story (which coin, what signal). P3 (optional) = historical parallel or structural observation. Tone: foreboding, sharp.\n" +
  "WATCHFUL: Lead with the most interesting signal, even if small. P1 = PSI frame + the day's angle (a band change, a supply reversal, a grade transition). " +
  "P2 = develop the observation with data. P3 (optional) = a wry or forward-looking kicker. Tone: observant, dry.\n" +
  "CALM: Find the story in the stillness. P1 = PSI frame + structural context (macro supply trend, grade distribution, band streak). " +
  "P2 = the most interesting micro-observation (a single coin's velocity, a DEWS signal ticking up from nothing, a resolved depeg aftermath). " +
  "P3 (optional) = a memorable closing line. Tone: bemused, wistful, or darkly amused.\n" +
  "The extended field is 3-4 paragraphs following the P1/P2/P3/P4 structure above. P3 and P4 are optional. Write 3 paragraphs by default; add a 4th only when the data demands a distinct secondary story that cannot fold into P1-P3. " +
  "The text field distills the single sharpest take.\n" +
  "FOCUS: never lead with more than 3 data categories as primary stories; supporting details woven into those stories don't count toward the limit. Depth on 1-2 stories beats shallow coverage of 6. " +
  "If a data point doesn't connect to your lead story or provide meaningful contrast, leave it out entirely.\n\n" +
  "OPTIONAL SECTION HEADERS: When the digest covers two distinct stories, you may use bold inline headers to separate them. " +
  "Format: start a paragraph with **Header** (markdown bold) followed by the paragraph text. " +
  "Use short, punchy headers (2-4 words): e.g., **Peg Watch**, **Capital Flows**, **Yield Signal**, **Safety Shift**, **Structural Note**. " +
  "Do NOT use headers on every paragraph — only when two stories are genuinely distinct. A single-narrative digest needs no headers. " +
  "P1 (the lead) should NEVER have a header — it stands alone.\n\n" +
  "You MUST respond with valid JSON: {\"title\": \"...\", \"extended\": \"...\", \"text\": \"...\", \"meta\": {\"leadSignalId\": \"...\", \"lead\": \"...\", \"tone\": \"...\", \"coins\": [\"...\", \"...\"], \"usedCandidateIds\": [\"...\"], \"suppressedCandidateIds\": [\"...\"]}}. " +
  "Output ONLY the raw JSON object — no markdown code fences, no preamble, no trailing text. " +
  "The meta field captures your editorial choices for variety tracking: " +
  "leadSignalId is the id of the Editorial Candidate you used as the lead; " +
  "lead is the primary signal you led with (e.g., \"psi-streak\", \"dews-band-change\", \"ftq\", \"grade-transition\", \"supply-reversal\", \"blacklist-contrast\", \"macro-observation\", \"yield-anomaly\", \"liquidity-shift\"); " +
  "tone is the dominant tone (e.g., \"bemused\", \"foreboding\", \"clinical\", \"wistful\", \"darkly-amused\", \"urgent\"); " +
  "coins are the 1-3 coin symbols you featured most prominently; usedCandidateIds are the candidate ids you relied on; suppressedCandidateIds are any candidate ids you deliberately ignored because they looked noisy.\n\n" +
  "The title is 2-6 words that capture the day's theme — punchy, catchy, like a newspaper column header. " +
  "The extended field (write this FIRST): 3-4 short paragraphs of editorial analysis, separated by \\n\\n. " +
  "The text field (write this AFTER extended): distill the single most compelling take from your extended analysis into a tweet-sized line. " +
  "Do NOT start or repeat the title in this field — the title is prepended automatically. " +
  "The title and text will be concatenated as '{title}\\n\\n{text}' for a tweet. " +
  "The combined result MUST be under 270 characters (leave ~10 chars headroom for cashtag formatting).\n\n" +
  "DENSITY RULES for the extended field: each paragraph should be 40-70 words. Total extended field: 150-280 words. You may write 3-4 paragraphs following the regime structure. " +
  "Every sentence must contain a specific number, coin name, or sharp observation. " +
  "No throat-clearing (\"Meanwhile\", \"In other news\", \"It's worth noting\"). " +
  "No hedging qualifiers (\"somewhat\", \"arguably\", \"it remains to be seen\"). " +
  "If a sentence doesn't carry data or wit, cut it. Density is not a style preference — it is a constraint.\n\n" +
  "THE TEXT FIELD IS THE HOOK. It will appear as a tweet and at the top of Telegram messages. " +
  "It must make someone who reads only this line want to read the full digest. " +
  "Lead with the sharpest number or most provocative observation. " +
  "Don't summarize the extended field — distill it into a single take that stands alone.";

export function classifyRegime(data: DigestInputData): "CRISIS" | "TENSION" | "WATCHFUL" | "CALM" {
  const band = data.stabilityIndex?.band ?? "BEDROCK";
  const activeDepegImpact = data.topDepegs.reduce((sum, depeg) => {
    const impact = depeg.impactScore ?? Math.abs(depeg.bps) * depeg.mcapUsd / 1_000_000_000;
    const suppressedButMaterial = depeg.suppressReason && impact < 5_000;
    return suppressedButMaterial ? sum : sum + impact;
  }, 0);
  const unsuppressedActiveDepegs = data.topDepegs.filter((depeg) => !depeg.suppressReason).length;
  const gaugeScore = data.mintBurnFlows?.gaugeScore ?? 0;
  const ftqActive = data.mintBurnFlows?.flightToQuality.active ?? false;
  const alertPlus = (data.dewsStress?.bandCounts.alert ?? 0)
    + (data.dewsStress?.bandCounts.warning ?? 0)
    + (data.dewsStress?.bandCounts.danger ?? 0);
  const alertPlusMcap = (data.dewsStress?.elevatedCoins ?? [])
    .reduce((sum, coin) => sum + coin.mcapUsd, 0);

  if (band === "TREMOR" || band === "FRACTURE" || band === "CRISIS" || ftqActive || gaugeScore < -50 || activeDepegImpact >= 50_000) {
    return "CRISIS";
  }
  if (activeDepegImpact >= 1_000 || gaugeScore < -20 || alertPlusMcap > 1_000_000_000 || (alertPlus >= 3 && alertPlusMcap > 100_000_000)) {
    return "TENSION";
  }
  if ((data.dewsStress?.bandChanges?.length ?? 0) > 0 || unsuppressedActiveDepegs >= 1 || gaugeScore < -10) {
    return "WATCHFUL";
  }
  return "CALM";
}

function formatDateTime(ts: number): string {
  return new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function pushDataQualityLines(lines: string[], data: DigestInputData): void {
  if (!data.dataQuality) return;

  const quality = data.dataQuality;
  lines.push("", "Data quality notes:");
  if (quality.stablecoinsCacheAgeSec != null) {
    lines.push(`  Stablecoins cache age: ${Math.round(quality.stablecoinsCacheAgeSec / 60)} minutes`);
  }
  if (quality.degradedSources && quality.degradedSources.length > 0) {
    lines.push(`  Missing/degraded collectors: ${quality.degradedSources.join(", ")}`);
    lines.push("  Do not infer calm from missing sections. Avoid claims about unavailable categories.");
  } else {
    lines.push("  No degraded collectors reported.");
  }
  lines.push(`  Blacklist window: ${quality.windows.blacklistActivity.label}, ${formatDateTime(quality.windows.blacklistActivity.start)} to ${formatDateTime(quality.windows.blacklistActivity.end)}`);
  lines.push(`  Mint/burn window: ${quality.windows.mintBurnFlows.label}, ${formatDateTime(quality.windows.mintBurnFlows.start)} to ${formatDateTime(quality.windows.mintBurnFlows.end)}`);
  lines.push(`  PSI source: ${quality.windows.psi.label}; sample=${quality.windows.psi.sampleAt ? formatDateTime(quality.windows.psi.sampleAt) : "n/a"}, daily=${quality.windows.psi.dailySnapshotAt ? formatDateTime(quality.windows.psi.dailySnapshotAt) : "n/a"}`);
}

function pushEditorialCandidateLines(lines: string[], data: DigestInputData): void {
  const candidates = data.editorialCandidates ?? [];
  if (candidates.length === 0) return;

  const usable = candidates.filter((candidate) => !candidate.suppressReason).slice(0, 8);
  const suppressed = candidates.filter((candidate) => candidate.suppressReason).slice(0, 5);

  lines.push("", "Editorial Candidates (lead from these unless a higher candidate is suppressed):");
  for (const candidate of usable) {
    const symbols = candidate.symbols.length > 0 ? ` | coins=${candidate.symbols.join(",")}` : "";
    lines.push(
      `  ${candidate.id} | ${candidate.kind}/${candidate.novelty}${symbols} | impact=${candidate.impactScore} | confidence=${candidate.confidence} | artifactRisk=${candidate.artifactRisk}`,
    );
    lines.push(`    facts: ${candidate.headlineFacts.join("; ")}`);
    lines.push(`    why: ${candidate.whyItMatters}`);
  }

  if (suppressed.length > 0) {
    lines.push("Suppressed or noisy candidates (do NOT lead with these):");
    for (const candidate of suppressed) {
      lines.push(
        `  ${candidate.id} | ${candidate.kind}/${candidate.novelty} | impact=${candidate.impactScore} | artifactRisk=${candidate.artifactRisk} | reason=${candidate.suppressReason}`,
      );
      lines.push(`    facts: ${candidate.headlineFacts.join("; ")}`);
    }
  }
}

export function buildUserPrompt(
  data: DigestInputData,
  recentMeta: { meta: DigestMeta | null; rawText: string | null; title: string | null }[] = [],
): string {
  const regime = classifyRegime(data);
  const lines: string[] = [
    `Market regime: ${regime}`,
  ];

  pushDataQualityLines(lines, data);
  pushEditorialCandidateLines(lines, data);

  lines.push(
    "",
    "Supporting evidence:",
    `Total stablecoin market cap: ${formatCurrency(data.totalMcapUsd)}`,
    `7-day market cap change: ${data.mcap7dDelta >= 0 ? "+" : ""}${formatCurrency(data.mcap7dDelta)} (${((data.mcap7dDelta / (data.totalMcapUsd - data.mcap7dDelta)) * 100).toFixed(2)}%)`,
    `Currently active depegs (ongoing, not yet resolved): ${data.activeDepegCount}`,
    `Depegs resolved in last 24h: ${data.resolvedDepegs?.length ?? 0}`,
  );

  if (data.topDepegs.length > 0) {
    lines.push("Active depegs by market impact (deviation × mcap):");
    for (const depeg of data.topDepegs) {
      const age = depeg.ageHours != null ? ` | age ${depeg.ageHours}h` : "";
      const suppression = depeg.suppressReason ? ` | suppress: ${depeg.suppressReason}` : "";
      lines.push(`  ${depeg.symbol} | ${Math.abs(depeg.bps)} bps ${depeg.direction ?? (depeg.bps >= 0 ? "above" : "below")}-peg | ${formatCurrency(depeg.mcapUsd)} mcap | impact ${depeg.impactScore ?? "n/a"}${age}${suppression}`);
    }
  }

  if (data.stabilityIndex) {
    const { score, band, components } = data.stabilityIndex;
    const trendStr = components.trend >= 0 ? `+${components.trend}` : `${components.trend}`;
    lines.push(
      `Pharos Stability Index: ${score} [${band}] (severity=${components.severity}, breadth=${components.breadth}, trend=${trendStr})`,
    );
    lines.push("  (severity: weighted depeg impact 0-68; breadth: coin-count pressure 0-17; trend: 7d mcap momentum -5 to +5)");
    if (data.yesterdayIndex) {
      lines.push(`Yesterday: ${data.yesterdayIndex.score} [${data.yesterdayIndex.band}]`);
    }
    if (data.historicalContext) {
      const { psiPrecedent, psiBandStreak, digestTrackingDays } = data.historicalContext;
      const trackingWindow = digestTrackingDays > 0 ? ` (Digest history: ${digestTrackingDays} days)` : "";
      if (psiPrecedent && psiPrecedent.lastSeenDaysAgo >= 2) {
        const precedentDate = new Date(psiPrecedent.lastSeenDate * 1000).toISOString().slice(0, 10);
        lines.push(`Context: last below ${score} on ${precedentDate}, ${psiPrecedent.lastSeenDaysAgo} days ago${trackingWindow}. Current ${band} streak: ${psiBandStreak} days.`);
      } else if (!psiPrecedent) {
        lines.push(`Context: lowest since Digest tracking began${trackingWindow}. Current ${band} streak: ${psiBandStreak} days.`);
      } else {
        lines.push(`Context: current ${band} streak: ${psiBandStreak} days.`);
      }
    }
  }

  if (data.psiContributors && data.psiContributors.length > 0) {
    lines.push("  PSI severity contributors (top coins driving the score):");
    for (const contributor of data.psiContributors) {
      lines.push(`    ${contributor.symbol}: ${contributor.bps} bps, mcap ${formatCurrency(contributor.mcapUsd)}, impact ${contributor.marketImpact}`);
    }
  }

  if (data.crossDayTrends) {
    const { psiTrajectory, mcapTrajectory, gaugeTrajectory } = data.crossDayTrends;
    if (psiTrajectory.length >= 3) {
      const psiMissing = psiTrajectory.length < 7 ? ` (${7 - psiTrajectory.length} days missing)` : "";
      lines.push(`PSI 7-day trajectory: ${psiTrajectory.map((point) => `${point.date}: ${point.score} [${point.band}]`).join(" -> ")}${psiMissing}`);
    }
    if (mcapTrajectory.length >= 3) {
      const mcapMissing = mcapTrajectory.length < 7 ? ` (${7 - mcapTrajectory.length} days missing)` : "";
      lines.push(`Market cap 7-day trajectory: ${mcapTrajectory.map((point) => `${point.date}: ${formatCurrency(point.mcapUsd)}`).join(" -> ")}${mcapMissing}`);
    }
    if (gaugeTrajectory && gaugeTrajectory.length >= 3) {
      const gaugeMissing = gaugeTrajectory.length < 7 ? ` (${7 - gaugeTrajectory.length} days missing)` : "";
      lines.push(`Bank Run Gauge 7-day trajectory: ${gaugeTrajectory.map((point) => `${point.date}: ${Math.round(point.gaugeScore * 10) / 10}`).join(" -> ")}${gaugeMissing}`);
    }
  }

  if (data.biggestSupplyChange) {
    const { symbol, changeUsd, currentMcap } = data.biggestSupplyChange;
    const direction = changeUsd >= 0 ? "increase" : "decrease";
    lines.push(`Biggest 7d supply ${direction}: ${symbol} ${changeUsd >= 0 ? "+" : ""}${formatCurrency(changeUsd)} (now ${formatCurrency(currentMcap)})`);
    if (data.historicalContext?.supplyMoverContext) {
      const context = data.historicalContext.supplyMoverContext;
      const athPct = ((context.allTimeHighMcap - currentMcap) / context.allTimeHighMcap * 100).toFixed(0);
      const relation = currentMcap < context.allTimeHighMcap ? "below" : "above";
      const athDate = new Date(context.allTimeHighDate * 1000).toISOString().slice(0, 10);
      lines.push(
        `Context: ${symbol}'s largest single-week change was ${formatCurrency(context.largestWeeklyChange)} (${context.largestWeeklyChangeDaysAgo} days ago). Current mcap is ${athPct}% ${relation} ATH (${formatCurrency(context.allTimeHighMcap)} on ${athDate}).`,
      );
    }
  }

  if (data.blacklistActivity) {
    const { eventCount, totalAmountUsd, topEvents } = data.blacklistActivity;
    lines.push("", `Blacklist activity (rolling last 24h): ${eventCount} events, ${formatCurrency(totalAmountUsd)} affected`);
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
    const { gaugeScore, gaugeBand, flightToQuality, topPressure } = data.mintBurnFlows;
    lines.push("", "Mint/Burn Flows (24h on-chain):");
    lines.push(`  Bank Run Gauge: ${Math.round(gaugeScore * 10) / 10} [${gaugeBand}]`);
    if (flightToQuality.active) {
      lines.push(`  Flight-to-Quality: ACTIVE, ${formatCurrency(flightToQuality.safeNetUsd)} into safe havens, ${formatCurrency(flightToQuality.riskyNetUsd)} out of risky coins`);
    } else {
      lines.push("  Flight-to-Quality: inactive");
    }
    if (topPressure.length > 0) {
      lines.push("  Top pressure shifts vs 30d baseline:");
      for (const pressure of topPressure) {
        lines.push(`    ${pressure.symbol}: ${Math.round(pressure.intensity)} (net ${formatCurrency(pressure.net24hUsd)} yesterday)`);
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
        lines.push(`    ${change.symbol}: ${change.from} -> ${change.to} (score ${change.score}, driven by ${change.topDriver})`);
      }
    }
    if (elevatedCoins.length > 0) {
      lines.push("  Elevated coins (ALERT+):");
      for (const coin of elevatedCoins) {
        const driverStr = coin.topSignals?.length
          ? `driven by ${coin.topSignals.map((signal) => `${signal.name}=${signal.value}`).join(", ")}`
          : "";
        lines.push(`    ${coin.symbol} | ${coin.band} score ${coin.score} | ${formatCurrency(coin.mcapUsd)} mcap | ${driverStr}`);
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
    const { mentionedCoins, medianGrade, aboveBCount, fCount } = data.safetyScores;
    lines.push("");
    if (mentionedCoins.length > 0) {
      lines.push("Safety Scores:");
      for (const coin of mentionedCoins) {
        const parts = [`${coin.symbol}: ${coin.grade} (${coin.score}`];
        if (coin.peg !== null) parts.push(`peg=${coin.peg}`);
        if (coin.liq !== null) parts.push(`liq=${coin.liq}`);
        lines.push(`  ${parts.join(", ")})`);
      }
    }
    lines.push(`  Distribution: median ${medianGrade}, ${aboveBCount} above B, ${fCount} rated F`);
  }

  if (data.yieldAnomalies && data.yieldAnomalies.length > 0) {
    lines.push("", "Yield Anomalies:");
    for (const anomaly of data.yieldAnomalies) {
      lines.push(`  ${anomaly.symbol} | ${anomaly.currentApy}% APY (7d avg ${anomaly.apy7d}%, 30d avg ${anomaly.apy30d}%) | ${formatCurrency(anomaly.mcapUsd)} mcap | ${anomaly.warnings.join(", ")}`);
    }
  }

  if (data.liquidityShifts && data.liquidityShifts.length > 0) {
    lines.push("", "DEX Liquidity Shifts (day-over-day):");
    for (const shift of data.liquidityShifts) {
      const dir = shift.scoreDelta > 0 ? "+" : "";
      lines.push(`  ${shift.symbol} | score ${shift.previousScore} -> ${shift.currentScore} (${dir}${shift.scoreDelta}) | ${formatCurrency(shift.mcapUsd)} mcap | TVL ${formatCurrency(shift.previousTvl)} -> ${formatCurrency(shift.currentTvl)}`);
    }
  }

  if (data.resolvedDepegs && data.resolvedDepegs.length > 0) {
    lines.push("", "Recently resolved depegs:");
    for (const resolved of data.resolvedDepegs) {
      lines.push(`  ${resolved.symbol} | ${resolved.peakBps} bps peak, ${resolved.durationHours}h duration | ${formatCurrency(resolved.mcapUsd)} mcap | recovered`);
    }
  }

  const metaLines: string[] = [];
  const rawFallbacks: string[] = [];
  for (let i = 0; i < recentMeta.length; i++) {
    const entry = recentMeta[i];
    if (entry.meta) {
      const meta = entry.meta;
      metaLines.push(`  Day -${i + 1}: "${entry.title}" — lead: ${meta.lead ?? "unknown"}, tone: ${meta.tone ?? "unknown"}, coins: ${(meta.coins ?? []).join(", ") || "none"}`);
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
