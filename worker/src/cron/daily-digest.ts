import type { DigestInputData, StablecoinData } from "@shared/types";
import { getCirculatingRaw, getPrevWeekRaw } from "@shared/lib/supply";
import { TRACKED_IDS } from "@shared/lib/stablecoins";
import { formatCurrency } from "@shared/lib/format";
import { type CronResult } from "../lib/db";
import { postDigestTweet, type TwitterCreds } from "../lib/twitter";
import { postDigestToTelegram, type TelegramCreds } from "../lib/telegram";
import { fetchWithRetry } from "../lib/fetch-retry";
import { SECONDS } from "../lib/time-constants";
import { CIRCUIT_SOURCE } from "../lib/constants";
import { recordOutcomeSafe, shouldAttemptFetch } from "../lib/circuit-breaker";
import { getConditionBand } from "../lib/stability-index";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import {
  collectActiveDepegs,
  collectBlacklistActivity,
  collectSupplyVelocity,
  collectSafetyScores,
  collectResolvedDepegs,
  collectMintBurnFlows,
  collectDewsStress,
  collectHistoricalContext,
  collectGradeTransitions,
  type CollectorContext,
} from "./daily-digest/collectors";

const SYSTEM_PROMPT =
  // 1. Voice directives
  "You write the daily editorial summary for Pharos, a stablecoin analytics dashboard. " +
  "Your voice is dry, sharp, and memorable — like a financial columnist who's seen too many death spirals to be impressed. " +
  "Think sardonic wit meets hard data. You can be funny, but the humor comes from precision, not clowning.\n\n" +
  // 2. Market-impact ranking
  "Every sentence must contain a specific number or coin name from the data. " +
  "CRITICAL — rank everything by market impact (deviation × market cap). " +
  "A 30 bps wobble on USDT is front-page news. A 2000 bps depeg on a $15M coin is a footnote at best — mention it only if nothing more interesting happened. " +
  "Do not lead with small illiquid coins that have been off-peg for weeks; that is not news.\n\n" +
  // 3. Formatting bans
  "No emojis, no clickbait, no hedging, no exclamation marks. " +
  "NEVER use em dashes (\u2014) or en dashes (\u2013). Use commas, semicolons, colons, or periods instead. Any dash that is not a hyphen is forbidden.\n\n" +
  // 4. Calm/eventful framing
  "When nothing happened, make the calm sound ominous or amusing. " +
  "When something did happen, make the reader feel it.\n\n" +
  // 5. Variety enforcement
  "VARIETY IS MANDATORY. You will receive a summary of recent digest angles below. " +
  "Do NOT reuse the same lead signal, tone, or primary coin as any of the last 3 days. " +
  "If the data is similar to yesterday, find a completely different framing — same numbers can tell different stories. " +
  "Rotate leads, tones, and featured coins deliberately.\n\n" +
  // 6. Regime-aware enrichment priority
  "You receive enrichment data across several categories. Not all will be present every day. " +
  "What matters most depends on the regime:\n" +
  "CRISIS priority: FTQ status > active depegs > gauge + pressure shifts > capital flows. " +
  "Everything else is background — don't dilute the lead.\n" +
  "TENSION priority: DEWS band changes > gauge drift > active depegs > grade transitions. " +
  "Historical context supports the narrative but doesn't lead.\n" +
  "WATCHFUL priority: the single most interesting signal, whatever category it's in. " +
  "Grade transitions, DEWS shifts, supply reversals, and blacklist contrasts are equally valid leads. Pick the sharpest story.\n" +
  "CALM priority: historical context > grade transitions > supply mover context > structural observations. " +
  "The PSI band streak is always worth mentioning. Find the story in the micro-data.\n" +
  "In all regimes: pick the 1-2 most compelling stories. Weave grades and scores into observations, don't list them. " +
  "A D-grade on an $8M coin is noise. A coin entering DANGER band while PSI reads BEDROCK is a story.\n\n" +
  // 7. Historical context instruction
  "HISTORICAL CONTEXT: You will receive \"Context:\" lines after PSI and supply data. USE THEM. " +
  "\"PSI at 72\" is a data point. \"PSI at 72, its lowest since March\" is journalism. " +
  "Streaks, precedents, and ATH comparisons make the reader feel the weight of a number. " +
  "Always prefer the contextual framing over the raw value.\n\n" +
  // 8. Narrative structure
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
  "The extended field is 2-3 paragraphs following the P1/P2/P3 structure above. P3 is optional — two tight paragraphs that say everything beat three that pad. " +
  "The text field distills the single sharpest take.\n" +
  "FOCUS: never mention more than 3 data categories in a single digest. Depth on 1-2 stories beats shallow coverage of 6. " +
  "If a data point doesn't connect to your lead story or provide meaningful contrast, leave it out entirely.\n\n" +
  // 9. Output format with meta field
  "You MUST respond with valid JSON: {\"title\": \"...\", \"extended\": \"...\", \"text\": \"...\", \"meta\": {\"lead\": \"...\", \"tone\": \"...\", \"coins\": [\"...\", \"...\"]}}. " +
  "Output ONLY the raw JSON object — no markdown code fences, no preamble, no trailing text. " +
  "The meta field captures your editorial choices for variety tracking: " +
  "lead is the primary signal you led with (e.g., \"psi-streak\", \"dews-band-change\", \"ftq\", \"grade-transition\", \"supply-reversal\", \"blacklist-contrast\", \"macro-observation\"); " +
  "tone is the dominant tone (e.g., \"bemused\", \"foreboding\", \"clinical\", \"wistful\", \"darkly-amused\", \"urgent\"); " +
  "coins are the 1-3 coin symbols you featured most prominently.\n\n" +
  // 10. Title + text + extended specs
  "The title is 2-6 words that capture the day's theme — punchy, catchy, like a newspaper column header. " +
  "The extended field (write this FIRST): 2-3 short paragraphs of editorial analysis, separated by \\n\\n. " +
  "The text field (write this AFTER extended): distill the single most compelling take from your extended analysis into a tweet-sized line. " +
  "Do NOT start or repeat the title in this field — the title is prepended automatically. " +
  "The title and text will be concatenated as '{title}\\n\\n{text}' for a tweet. " +
  "The combined result MUST be under 270 characters (leave ~10 chars headroom for cashtag formatting).\n\n" +
  // 11. Density contract
  "DENSITY RULES for the extended field: each paragraph should be 30-60 words. Total extended field: 80-160 words. " +
  "Every sentence must contain a specific number, coin name, or sharp observation. " +
  "No throat-clearing (\"Meanwhile\", \"In other news\", \"It's worth noting\"). " +
  "No hedging qualifiers (\"somewhat\", \"arguably\", \"it remains to be seen\"). " +
  "If a sentence doesn't carry data or wit, cut it. Density is not a style preference — it is a constraint.\n\n" +
  // 12. Text field hook guidance
  "THE TEXT FIELD IS THE HOOK. It will appear as a tweet and at the top of Telegram messages. " +
  "It must make someone who reads only this line want to read the full digest. " +
  "Lead with the sharpest number or most provocative observation. " +
  "Don't summarize the extended field — distill it into a single take that stands alone.";

export function classifyRegime(data: DigestInputData): "CRISIS" | "TENSION" | "WATCHFUL" | "CALM" {
  const band = data.stabilityIndex?.band ?? "BEDROCK";
  const activeDepegs = data.activeDepegCount;
  const gaugeScore = data.mintBurnFlows?.gaugeScore ?? 0;
  const ftqActive = data.mintBurnFlows?.flightToQuality.active ?? false;
  const alertPlus = (data.dewsStress?.bandCounts.alert ?? 0)
    + (data.dewsStress?.bandCounts.warning ?? 0)
    + (data.dewsStress?.bandCounts.danger ?? 0);

  if (band === "TREMOR" || band === "FRACTURE" || band === "CRISIS" || ftqActive || gaugeScore < -50)
    return "CRISIS";
  if (activeDepegs >= 2 || gaugeScore < -20 || alertPlus >= 3)
    return "TENSION";
  if ((data.dewsStress?.bandChanges?.length ?? 0) > 0 || activeDepegs >= 1 || gaugeScore < -10)
    return "WATCHFUL";
  return "CALM";
}

interface DigestMeta {
  lead?: string;
  tone?: string;
  coins?: string[];
}

function buildUserPrompt(
  data: DigestInputData,
  recentMeta: { meta: DigestMeta | null; rawText: string | null }[] = [],
): string {
  const regime = classifyRegime(data);
  const lines: string[] = [
    `Market regime: ${regime}`,
    "",
    `Total stablecoin market cap: ${formatCurrency(data.totalMcapUsd)}`,
    `7-day market cap change: ${data.mcap7dDelta >= 0 ? "+" : ""}${formatCurrency(data.mcap7dDelta)} (${((data.mcap7dDelta / (data.totalMcapUsd - data.mcap7dDelta)) * 100).toFixed(2)}%)`,
    `Active depeg events: ${data.activeDepegCount}`,
  ];

  if (data.topDepegs.length > 0) {
    lines.push("Active depegs by market impact (deviation × mcap):");
    for (const d of data.topDepegs) {
      lines.push(`  ${d.symbol}: ${d.bps} bps off-peg, mcap ${formatCurrency(d.mcapUsd)}`);
    }
  }

  if (data.stabilityIndex) {
    const { score, band, components } = data.stabilityIndex;
    const trendStr = components.trend >= 0 ? `+${components.trend}` : `${components.trend}`;
    lines.push(
      `Pharos Stability Index: ${score} [${band}] (severity=${components.severity}, breadth=${components.breadth}, trend=${trendStr})`,
    );
    if (data.yesterdayIndex) {
      lines.push(`Yesterday: ${data.yesterdayIndex.score} [${data.yesterdayIndex.band}]`);
    }
    if (data.historicalContext) {
      const { psiPrecedent, psiBandStreak } = data.historicalContext;
      if (psiPrecedent) {
        const precDate = new Date(psiPrecedent.lastSeenDate * 1000).toISOString().slice(0, 10);
        lines.push(`Context: last below ${score} on ${precDate}, ${psiPrecedent.lastSeenDaysAgo} days ago. Current ${band} streak: ${psiBandStreak} days.`);
      } else {
        lines.push(`Context: all-time low. Current ${band} streak: ${psiBandStreak} days.`);
      }
    }
  }

  if (data.biggestSupplyChange) {
    const { symbol, changeUsd, currentMcap } = data.biggestSupplyChange;
    const direction = changeUsd >= 0 ? "increase" : "decrease";
    lines.push(
      `Biggest 7d supply ${direction}: ${symbol} ${changeUsd >= 0 ? "+" : ""}${formatCurrency(changeUsd)} (now ${formatCurrency(currentMcap)})`,
    );
    if (data.historicalContext?.supplyMoverContext) {
      const ctx = data.historicalContext.supplyMoverContext;
      const athPct = ((ctx.allTimeHighMcap - currentMcap) / ctx.allTimeHighMcap * 100).toFixed(0);
      const relation = currentMcap < ctx.allTimeHighMcap ? "below" : "above";
      const athDate = new Date(ctx.allTimeHighDate * 1000).toISOString().slice(0, 10);
      lines.push(
        `Context: ${symbol}'s largest single-week change was ${formatCurrency(ctx.largestWeeklyChange)} (${ctx.largestWeeklyChangeDaysAgo} days ago). Current mcap is ${athPct}% ${relation} ATH (${formatCurrency(ctx.allTimeHighMcap)} on ${athDate}).`,
      );
    }
  }

  // Enrichment: blacklist activity
  if (data.blacklistActivity) {
    const { eventCount, totalAmountUsd, topEvents } = data.blacklistActivity;
    lines.push("", `Blacklist activity (last 24h): ${eventCount} events, ${formatCurrency(totalAmountUsd)} affected`);
    for (const e of topEvents) {
      lines.push(`  ${e.symbol} on ${e.chain}: ${e.type} (${formatCurrency(e.amountUsd)})`);
    }
  }

  // Enrichment: supply velocity
  if (data.supplyVelocity && data.supplyVelocity.length > 0) {
    lines.push("", "Supply velocity (1d vs 7d):");
    for (const v of data.supplyVelocity) {
      const d1 = `${v.change1d >= 0 ? "+" : ""}${formatCurrency(v.change1d)} yesterday`;
      const d7 = `${v.change7d >= 0 ? "+" : ""}${formatCurrency(v.change7d)}/week`;
      lines.push(`  ${v.coin}: ${d1} vs ${d7} — ${v.signal}`);
    }
  }

  // Enrichment: mint-burn flows
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
      for (const p of topPressure) {
        lines.push(`    ${p.symbol}: ${Math.round(p.intensity)} (net ${formatCurrency(p.net24hUsd)} yesterday)`);
      }
    }
  }

  // Enrichment: DEWS stress signals
  if (data.dewsStress) {
    const { bandCounts, yesterdayBandCounts: y, bandChanges, elevatedCoins } = data.dewsStress;
    lines.push("", "DEWS Stress Signals:");
    lines.push(
      `  Band distribution: ${bandCounts.calm} CALM, ${bandCounts.watch} WATCH, ${bandCounts.alert} ALERT, ${bandCounts.warning} WARNING, ${bandCounts.danger} DANGER (vs yesterday: ${y.calm}/${y.watch}/${y.alert}/${y.warning}/${y.danger})`,
    );
    if (bandChanges.length > 0) {
      lines.push("  Band changes (last 24h):");
      for (const c of bandChanges) {
        lines.push(`    ${c.symbol}: ${c.from} -> ${c.to} (score ${c.score}, driven by ${c.topDriver})`);
      }
    }
    if (elevatedCoins.length > 0) {
      lines.push("  Elevated coins (ALERT+):");
      for (const c of elevatedCoins) {
        lines.push(`    ${c.symbol}: ${c.band} (score ${c.score}, mcap ${formatCurrency(c.mcapUsd)})`);
      }
    }
  }

  // Enrichment: grade transitions
  if (data.gradeTransitions && data.gradeTransitions.length > 0) {
    lines.push("", "Grade Transitions (last 48h):");
    for (const t of data.gradeTransitions) {
      const dims = t.currentDimensions;
      lines.push(
        `  ${t.symbol}: ${t.fromGrade} (${t.fromScore}) -> ${t.toGrade} (${t.toScore}), mcap ${formatCurrency(t.mcapUsd)} — dimensions: peg=${dims.peg}, liq=${dims.liq}, resilience=${dims.resilience}, decentralization=${dims.decentralization}`,
      );
    }
  }

  // Enrichment: safety scores
  if (data.safetyScores) {
    const { mentionedCoins, medianGrade, aboveBCount, fCount } = data.safetyScores;
    lines.push("");
    if (mentionedCoins.length > 0) {
      lines.push("Safety Scores:");
      for (const c of mentionedCoins) {
        const parts = [`${c.symbol}: ${c.grade} (${c.score}`];
        if (c.peg !== null) parts.push(`peg=${c.peg}`);
        if (c.liq !== null) parts.push(`liq=${c.liq}`);
        lines.push(`  ${parts.join(", ")})`);
      }
    }
    lines.push(`  Distribution: median ${medianGrade}, ${aboveBCount} above B, ${fCount} rated F`);
  }

  // Enrichment: resolved depegs
  if (data.resolvedDepegs && data.resolvedDepegs.length > 0) {
    lines.push("");
    for (const r of data.resolvedDepegs) {
      lines.push(`Recently resolved: ${r.symbol} recovered from ${r.peakBps}bps after ${r.durationHours}h (${formatCurrency(r.mcapUsd)} mcap)`);
    }
  }

  // Variety enforcement (meta-based when available, raw text fallback)
  const metaLines: string[] = [];
  const rawFallbacks: string[] = [];
  for (let i = 0; i < recentMeta.length; i++) {
    const m = recentMeta[i];
    if (m.meta) {
      metaLines.push(`  Day -${i + 1}: led with ${m.meta.lead ?? "unknown"}, tone: ${m.meta.tone ?? "unknown"}, coins: ${(m.meta.coins ?? []).join(", ") || "none"}`);
    } else if (m.rawText) {
      rawFallbacks.push(`- "${m.rawText}"`);
    }
  }
  if (metaLines.length > 0) {
    lines.push("", "Recent digest angles (DO NOT repeat any of these approaches):", ...metaLines);
  }
  if (rawFallbacks.length > 0) {
    lines.push(
      "",
      "RECENT DIGESTS — do NOT reuse phrasing, metaphors, or structure:",
      ...rawFallbacks,
    );
  }

  return lines.join("\n");
}

export async function generateDailyDigest(
  db: D1Database,
  anthropicApiKey: string | null,
  twitterCreds: TwitterCreds | null = null,
  force = false,
  telegramCreds: TelegramCreds | null = null,
  signal?: AbortSignal,
): Promise<CronResult> {
  if (!anthropicApiKey) {
    console.log("[daily-digest] No API key configured, skipping");
    return { metadata: "skipped: no API key" };
  }

  // Check if latest digest is <1h old and valid (not a broken code-block response)
  const latest = await db
    .prepare(
      "SELECT generated_at, digest_text FROM daily_digest ORDER BY generated_at DESC LIMIT 1",
    )
    .first<{ generated_at: number; digest_text: string }>();

  if (latest) {
    const ageSec = Math.floor(Date.now() / 1000) - latest.generated_at;
    const isBroken = latest.digest_text.trimStart().startsWith("```");
    if (ageSec < SECONDS.ONE_HOUR && !isBroken && !force) {
      console.log(
        `[daily-digest] Latest digest is ${Math.round(ageSec / 60)}min old, skipping`,
      );
      return { metadata: "skipped: recent digest exists" };
    }
    if (isBroken) {
      console.log("[daily-digest] Latest digest is malformed (code-block response), regenerating");
    }
  }

  // Fetch last 5 digests so the model sees a wider window to avoid repetition
  const recentRows = await db
    .prepare("SELECT digest_title, digest_text, digest_extended, digest_meta FROM daily_digest ORDER BY generated_at DESC LIMIT 5")
    .all<{ digest_title: string | null; digest_text: string; digest_extended: string | null; digest_meta: string | null }>();
  const recentMeta: { meta: DigestMeta | null; rawText: string | null }[] = (recentRows.results ?? []).map((r) => {
    let meta: DigestMeta | null = null;
    if (r.digest_meta) {
      try { meta = JSON.parse(r.digest_meta) as DigestMeta; } catch { /* ignore */ }
    }
    const rawText = !meta ? (r.digest_title ? `${r.digest_title}: ${r.digest_text}` : r.digest_text) : null;
    return { meta, rawText };
  });
  const degradedReasons: string[] = [];

  // --- Collect data ---

  // 1. Total mcap + 7d delta from stablecoins cache
  const stablecoinsCacheResult = await loadStablecoinsCache(db, { mode: "lenient", allowLegacyArray: true });
  if (stablecoinsCacheResult.kind !== "ok") {
    console.warn(`[daily-digest] stablecoins cache unavailable (${stablecoinsCacheResult.reason}), skipping regeneration`);
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({
        reason: "stablecoins-cache-unavailable",
        stablecoinsCacheReason: stablecoinsCacheResult.reason,
        skipped: true,
      }),
    };
  }
  const stablecoinAssets = stablecoinsCacheResult.payload.peggedAssets as StablecoinData[];
  const trackedStablecoinAssets = stablecoinAssets.filter((coin) => TRACKED_IDS.has(coin.id));
  const mcapById = new Map<string, number>();
  for (const coin of stablecoinAssets) {
    mcapById.set(coin.id, getCirculatingRaw(coin));
  }

  let totalMcapUsd = 0;
  let totalPrevWeek = 0;
  let biggestSupplyChange: DigestInputData["biggestSupplyChange"] = null;
  let biggestAbsChange = 0;

  for (const coin of trackedStablecoinAssets) {
    const mcap = getCirculatingRaw(coin);
    const prevWeek = getPrevWeekRaw(coin);
    totalMcapUsd += mcap;
    totalPrevWeek += prevWeek;

    if (mcap > 1_000_000) {
      const absChange = Math.abs(mcap - prevWeek);
      if (absChange > biggestAbsChange) {
        biggestAbsChange = absChange;
        biggestSupplyChange = {
          id: coin.id,
          symbol: coin.symbol,
          name: coin.name,
          changeUsd: mcap - prevWeek,
          currentMcap: mcap,
        };
      }
    }
  }

  // 2. Active depeg count + top depegs ranked by market impact (bps × mcap)
  const nowSec = Math.floor(Date.now() / 1000);
  const todayTs = nowSec - (nowSec % SECONDS.ONE_DAY);
  const yesterdayTs = todayTs - SECONDS.ONE_DAY;

  const ctx: CollectorContext = { db, trackedStablecoinAssets, mcapById, nowSec, todayTs, yesterdayTs };

  const { activeDepegCount, topDepegs } = await collectActiveDepegs(ctx);

  // 3. Stability index — match homepage/stability page display logic
  // Current source: latest 15-min sample, fallback to latest daily snapshot if needed
  const latestSample = await db
    .prepare("SELECT score, band, components FROM stability_index_samples ORDER BY stored_at DESC LIMIT 1")
    .first<{ score: number; band: string; components: string }>();
  const latestDaily = latestSample
    ? null
    : await db
      .prepare("SELECT score, band, components FROM stability_index ORDER BY computed_at DESC LIMIT 1")
      .first<{ score: number; band: string; components: string }>();
  const currentPsiSource = latestSample ?? latestDaily;

  // Displayed PSI on both pages is avg24h if available, else current source score
  const avg24hRow = await db
    .prepare("SELECT AVG(score) as avg FROM stability_index_samples WHERE stored_at > ?")
    .bind(nowSec - SECONDS.ONE_DAY)
    .first<{ avg: number | null }>();
  const avg24h = avg24hRow?.avg != null
    ? Math.round(avg24hRow.avg * 10) / 10
    : null;

  const displayScore = avg24h ?? currentPsiSource?.score ?? null;
  const displayBand = avg24h != null
    ? getConditionBand(avg24h)
    : currentPsiSource?.band ?? null;

  const stabilityIndex = currentPsiSource && displayScore != null && displayBand
    ? { score: displayScore, band: displayBand, components: JSON.parse(currentPsiSource.components) }
    : null;

  // Yesterday: daily snapshot for comparison
  const yesterdayRow = await db
    .prepare("SELECT score, band FROM stability_index WHERE computed_at = ?")
    .bind(yesterdayTs)
    .first<{ score: number; band: string }>();
  const yesterdayIndex = yesterdayRow
    ? { score: yesterdayRow.score, band: yesterdayRow.band }
    : null;

  // --- Enrichment data collection via collectors ---

  const blacklistActivity = await collectBlacklistActivity(ctx);
  const supplyVelocity = await collectSupplyVelocity(ctx);

  // Safety scores need "mentioned symbols" from earlier phases
  const mentionedSymbols = new Set<string>();
  for (const d of topDepegs) mentionedSymbols.add(d.symbol);
  if (biggestSupplyChange) mentionedSymbols.add(biggestSupplyChange.symbol);
  if (supplyVelocity) for (const v of supplyVelocity) mentionedSymbols.add(v.coin);
  const { safetyScores, safetyGrades } = await collectSafetyScores(ctx, mentionedSymbols, degradedReasons);

  const resolvedDepegs = await collectResolvedDepegs(ctx);
  const mintBurnFlows = await collectMintBurnFlows(ctx);
  const dewsStress = await collectDewsStress(ctx);
  const historicalContext = await collectHistoricalContext(ctx, displayScore, displayBand, biggestSupplyChange);
  const gradeTransitions = await collectGradeTransitions(ctx, safetyGrades);

  // --- Build input data ---
  const inputData: DigestInputData = {
    totalMcapUsd,
    mcap7dDelta: totalMcapUsd - totalPrevWeek,
    activeDepegCount,
    topDepegs,
    biggestSupplyChange,
    stabilityIndex,
    yesterdayIndex,
    blacklistActivity,
    supplyVelocity,
    safetyScores,
    resolvedDepegs,
    mintBurnFlows,
    dewsStress,
    historicalContext,
    gradeTransitions,
  };

  const userPromptContent = buildUserPrompt(inputData, recentMeta);
  console.log("[daily-digest] Calling Claude API with data:\n" + userPromptContent);

  // --- Call Claude API ---
  const response = await fetchWithRetry(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: 800,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPromptContent }],
      }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
    },
    2,
    { timeoutMs: 120_000 },
  );

  if (!response || !response.ok) {
    const errorText = response ? await response.text() : "no response after retries";
    throw new Error(
      `Claude API error ${response?.status ?? "null"}: ${typeof errorText === "string" ? errorText.slice(0, 500) : errorText}`,
    );
  }

  const result = (await response.json()) as {
    content?: { type: string; text: string }[];
  };
  const rawText = result.content?.[0]?.text ?? "";

  if (!rawText) {
    throw new Error("Claude API returned empty digest text");
  }

  // Strip markdown code block wrapper if Claude added one (```json ... ```)
  let jsonText = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

  // Extract the first JSON object if the model appended trailing text
  const braceStart = jsonText.indexOf("{");
  if (braceStart !== -1) {
    let depth = 0;
    let braceEnd = -1;
    for (let i = braceStart; i < jsonText.length; i++) {
      if (jsonText[i] === "{") depth++;
      else if (jsonText[i] === "}") { depth--; if (depth === 0) { braceEnd = i; break; } }
    }
    if (braceEnd !== -1) {
      jsonText = jsonText.slice(braceStart, braceEnd + 1);
    }
  }

  // Parse JSON response for title + text + extended + meta
  let digestTitle: string;
  let digestText: string;
  let digestExtended: string;
  let digestMeta: string | null = null;
  try {
    const parsed = JSON.parse(jsonText) as { title?: string; text?: string; extended?: string; meta?: { lead?: string; tone?: string; coins?: string[] } };
    digestTitle = (parsed.title ?? "").trim();
    digestText = (parsed.text ?? "").trim();
    digestExtended = (parsed.extended ?? "").trim();
    if (!digestText) throw new Error("empty text field");
    if (parsed.meta) {
      digestMeta = JSON.stringify(parsed.meta);
    }
  } catch {
    // Fallback: treat entire response as text with no title or extended
    console.warn("[daily-digest] Failed to parse JSON response, using raw text");
    digestTitle = "";
    digestText = rawText.trim();
    digestExtended = "";
  }

  // Post-process: replace em/en dashes the model may still produce
  const stripDashes = (s: string) => s.replace(/[\u2013\u2014]/g, ",");
  digestTitle = stripDashes(digestTitle);
  digestText = stripDashes(digestText);
  digestExtended = stripDashes(digestExtended);

  // --- Store result ---
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      "INSERT INTO daily_digest (generated_at, digest_text, digest_title, input_data, digest_extended, digest_meta) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(now, digestText, digestTitle || null, JSON.stringify(inputData), digestExtended || null, digestMeta)
    .run();

  // Post to Twitter if credentials are available
  let tweetStatus = "no-creds";
  if (twitterCreds) {
    const twitterAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.TWITTER_API);
    if (!twitterAllowed) {
      tweetStatus = "skipped: circuit-open";
    } else {
      try {
        await postDigestTweet(digestTitle, digestText, twitterCreds);
        await recordOutcomeSafe(db, CIRCUIT_SOURCE.TWITTER_API, true);
        tweetStatus = "ok";
      } catch (err) {
        await recordOutcomeSafe(db, CIRCUIT_SOURCE.TWITTER_API, false);
        console.error("[daily-digest] Failed to post tweet (non-fatal):", err);
        tweetStatus = `failed: ${String(err).slice(0, 100)}`;
      }
    }
  }

  // Post to Telegram if credentials are available
  let telegramStatus = "no-creds";
  if (telegramCreds) {
    const telegramAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.TELEGRAM_API);
    if (!telegramAllowed) {
      telegramStatus = "skipped: circuit-open";
    } else {
      try {
        const date = new Date(now * 1000).toISOString().slice(0, 10);
        await postDigestToTelegram(digestTitle, digestExtended, date, telegramCreds);
        await recordOutcomeSafe(db, CIRCUIT_SOURCE.TELEGRAM_API, true);
        telegramStatus = "ok";
      } catch (err) {
        await recordOutcomeSafe(db, CIRCUIT_SOURCE.TELEGRAM_API, false);
        console.error("[daily-digest] Failed to post to Telegram (non-fatal):", err);
        telegramStatus = `failed: ${String(err).slice(0, 100)}`;
      }
    }
  }

  console.log(`[daily-digest] Generated and stored digest: "${digestTitle}" (${digestText.length} chars + ${digestExtended.length} extended), tweet: ${tweetStatus}, telegram: ${telegramStatus}`);
  return {
    itemCount: 1,
    ...(degradedReasons.length > 0 ? { status: "degraded" as const } : {}),
    metadata: `${digestText.length} chars, tweet: ${tweetStatus}, telegram: ${telegramStatus}${degradedReasons.length > 0 ? `, degraded: ${degradedReasons.join("|")}` : ""}`,
  };
}
