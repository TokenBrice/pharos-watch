import type { DigestInputData, StablecoinData } from "@shared/types";
import { getCirculatingRaw, getPrevWeekRaw } from "@shared/lib/supply";
import { TRACKED_IDS } from "@shared/lib/stablecoins";
import { formatCurrency } from "@shared/lib/format";
import { scoreToGrade } from "@shared/lib/report-cards";
import { buildInClause, type CronResult } from "../lib/db";
import { postDigestTweet, type TwitterCreds } from "../lib/twitter";
import { postDigestToTelegram, type TelegramCreds } from "../lib/telegram";
import { fetchWithRetry } from "../lib/fetch-retry";
import { SECONDS } from "../lib/time-constants";
import { CIRCUIT_SOURCE } from "../lib/constants";
import { recordOutcomeSafe, shouldAttemptFetch } from "../lib/circuit-breaker";
import { getConditionBand } from "../lib/stability-index";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import { computeSafetyScoresSnapshot, type SafetyGradeRow } from "../lib/safety-scores";
import { computeFlowIntensity, computeGaugeScore, getGaugeBand, detectFlightToQuality } from "../lib/mint-burn-scoring";
import { SAFE_HAVEN_IDS } from "../lib/mint-burn-contracts";

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

  // --- Collect data ---

  // 1. Total mcap + 7d delta from stablecoins cache
  const stablecoinsCacheResult = await loadStablecoinsCache(db, { mode: "lenient", allowLegacyArray: true });
  if (stablecoinsCacheResult.ok && stablecoinsCacheResult.warningReason) {
    console.warn(`[daily-digest] stablecoins cache fallback (${stablecoinsCacheResult.warningReason})`);
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
  let activeDepegCount = 0;
  const topDepegs: DigestInputData["topDepegs"] = [];

  try {
    const activeDepegs = await db
      .prepare("SELECT stablecoin_id, symbol, peak_deviation_bps FROM depeg_events WHERE ended_at IS NULL")
      .all<{ stablecoin_id: string; symbol: string; peak_deviation_bps: number }>();
    const rows = activeDepegs.results ?? [];
    activeDepegCount = rows.length;

    const withImpact = rows.map((r) => {
      const mcapUsd = mcapById.get(r.stablecoin_id) ?? 0;
      return { symbol: r.symbol, bps: r.peak_deviation_bps, mcapUsd, impact: r.peak_deviation_bps * mcapUsd };
    });
    withImpact.sort((a, b) => b.impact - a.impact);
    topDepegs.push(...withImpact.slice(0, 3).map(({ symbol, bps, mcapUsd }) => ({ symbol, bps, mcapUsd })));
  } catch (e) {
    console.error("[daily-digest] Failed to query active depegs:", e);
  }

  // 3. Stability index — match homepage/stability page display logic
  const nowSec = Math.floor(Date.now() / 1000);
  const todayTs = nowSec - (nowSec % SECONDS.ONE_DAY);
  const yesterdayTs = todayTs - SECONDS.ONE_DAY;

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

  // --- Enrichment data collection ---

  // 4a. Blacklist events (last 24h)
  let blacklistActivity: DigestInputData["blacklistActivity"];
  try {
    const blRows = await db
      .prepare(
        "SELECT stablecoin AS symbol, chain_name, event_type, amount FROM blacklist_events WHERE timestamp >= ? AND timestamp < ? ORDER BY amount DESC",
      )
      .bind(todayTs - SECONDS.ONE_DAY, todayTs)
      .all<{ symbol: string; chain_name: string; event_type: string; amount: number | null }>();
    const blEvents = blRows.results ?? [];
    if (blEvents.length > 0) {
      const eventCount = blEvents.length;
      const totalAmountUsd = blEvents.reduce((s, e) => s + (e.amount ?? 0), 0);
      const hasLargeEvent = blEvents.some((e) => (e.amount ?? 0) > 10_000_000);
      if (eventCount >= 2 || hasLargeEvent) {
        blacklistActivity = {
          eventCount,
          totalAmountUsd,
          topEvents: blEvents
            .filter((e) => e.event_type === "blacklist" || e.event_type === "destroy")
            .slice(0, 5)
            .map((e) => ({
              symbol: e.symbol,
              chain: e.chain_name,
              type: e.event_type as "blacklist" | "destroy",
              amountUsd: e.amount ?? 0,
            })),
        };
      }
    }
  } catch (e) {
    console.error("[daily-digest] Failed to query blacklist events:", e);
  }

  // 4b. Supply velocity (1d vs 7d for top 10 coins by mcap)
  let supplyVelocity: DigestInputData["supplyVelocity"];
  try {
    // Get top 10 coins by mcap
    const top10: { id: string; symbol: string; mcap: number }[] = [];
    const tracked = trackedStablecoinAssets
      .map((coin) => ({ id: coin.id, symbol: coin.symbol, mcap: getCirculatingRaw(coin) }))
      .sort((a, b) => b.mcap - a.mcap)
      .slice(0, 10);
    top10.push(...tracked);

    if (top10.length > 0) {
      const yesterday = todayTs - SECONDS.ONE_DAY;
      const weekAgo = todayTs - 7 * SECONDS.ONE_DAY;
      const top10IdInClause = buildInClause(top10.map((coin) => coin.id));
      // Query supply snapshots for today, yesterday, and 7 days ago
      const supplyRows = await db
        .prepare(
          `SELECT stablecoin_id, snapshot_date, circulating_usd FROM supply_history WHERE stablecoin_id IN (${top10IdInClause.sql}) AND snapshot_date IN (?, ?, ?)`,
        )
        .bind(...top10IdInClause.binds, todayTs, yesterday, weekAgo)
        .all<{ stablecoin_id: string; snapshot_date: number; circulating_usd: number }>();

      const snapMap = new Map<string, Map<number, number>>();
      for (const row of supplyRows.results ?? []) {
        let byDate = snapMap.get(row.stablecoin_id);
        if (!byDate) { byDate = new Map(); snapMap.set(row.stablecoin_id, byDate); }
        byDate.set(row.snapshot_date, row.circulating_usd);
      }

      const velocitySignals: NonNullable<DigestInputData["supplyVelocity"]> = [];
      for (const coin of top10) {
        const byDate = snapMap.get(coin.id);
        if (!byDate) continue;
        const todayVal = byDate.get(todayTs);
        const yesterdayVal = byDate.get(yesterday);
        const weekAgoVal = byDate.get(weekAgo);
        if (todayVal == null || yesterdayVal == null || weekAgoVal == null) continue;

        const change1d = todayVal - yesterdayVal;
        const change7d = todayVal - weekAgoVal;
        const dailyAvg7d = change7d / 7;

        // Threshold: day is 2.5x weekly average OR direction reversed
        const directionReversed = (change1d > 0 && change7d < 0) || (change1d < 0 && change7d > 0);
        const velocityRatio = dailyAvg7d !== 0 ? Math.abs(change1d / dailyAvg7d) : 0;

        if (directionReversed || velocityRatio > 2.5) {
          let signal: string;
          if (directionReversed) signal = "reversed";
          else if (velocityRatio > 2.5 && Math.abs(change1d) > Math.abs(dailyAvg7d)) signal = "accelerating";
          else signal = "decelerating";

          velocitySignals.push({ coin: coin.symbol, change1d, change7d, signal });
        }
      }

      if (velocitySignals.length > 0) {
        supplyVelocity = velocitySignals;
      }
    }
  } catch (e) {
    console.error("[daily-digest] Failed to compute supply velocity:", e);
  }

  // 4c. Safety scores (for mentioned coins + distribution)
  let safetyScores: DigestInputData["safetyScores"];
  let safetyGrades: SafetyGradeRow[] | undefined;
  try {
    // Collect IDs of coins already mentioned in other data sections
    const mentionedSymbols = new Set<string>();
    for (const d of topDepegs) mentionedSymbols.add(d.symbol);
    if (biggestSupplyChange) mentionedSymbols.add(biggestSupplyChange.symbol);
    if (supplyVelocity) for (const v of supplyVelocity) mentionedSymbols.add(v.coin);
    const safetySnapshot = await computeSafetyScoresSnapshot(db, {
      includeNavTokens: false,
      outputMode: "full-grades",
    });
    const allGrades = safetySnapshot.grades;
    safetyGrades = allGrades;

    // Distribution stats
    const scores = allGrades.map((g) => g.score).sort((a, b) => a - b);
    const medianScore = scores.length > 0 ? scores[Math.floor(scores.length / 2)] : 0;
    const medianGrade = scoreToGrade(medianScore);
    const aboveBCount = allGrades.filter((g) => g.score >= 75).length;
    const fCount = allGrades.filter((g) => g.grade === "F").length;

    // Per-coin grades for mentioned coins + up to 2 "notable tension" coins
    const mentionedCoinGrades = allGrades.filter((g) => mentionedSymbols.has(g.symbol));
    const tensionCoins = allGrades
      .filter((g) => !mentionedSymbols.has(g.symbol) && g.pegScore !== null && g.pegScore > 90 && g.score < 50)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);
    const reportCoins = [...mentionedCoinGrades, ...tensionCoins];

    safetyScores = {
      mentionedCoins: reportCoins.map((g) => ({
        symbol: g.symbol, grade: g.grade, score: g.score,
        peg: g.pegScore, liq: g.liqScore,
      })),
      medianGrade,
      aboveBCount,
      fCount,
    };
  } catch (e) {
    console.error("[daily-digest] Failed to compute safety scores:", e);
  }

  // 4d. Recently resolved depegs (last 48h)
  let resolvedDepegs: DigestInputData["resolvedDepegs"];
  try {
    const cutoff48h = nowSec - SECONDS.TWO_DAYS;
    const resolvedRows = await db
      .prepare(
        `SELECT symbol, peak_deviation_bps, started_at, ended_at, stablecoin_id
         FROM depeg_events
         WHERE ended_at IS NOT NULL AND ended_at >= ?
         ORDER BY peak_deviation_bps DESC
         LIMIT 5`,
      )
      .bind(cutoff48h)
      .all<{ symbol: string; peak_deviation_bps: number; started_at: number; ended_at: number; stablecoin_id: string }>();

    const candidates = (resolvedRows.results ?? [])
      .map((r) => ({
        symbol: r.symbol,
        peakBps: Math.abs(r.peak_deviation_bps),
        durationHours: Math.round((r.ended_at - r.started_at) / SECONDS.ONE_HOUR),
        mcapUsd: mcapById.get(r.stablecoin_id) ?? 0,
      }))
      .filter((r) => r.peakBps > 200 && r.mcapUsd > 50_000_000)
      .slice(0, 3);

    if (candidates.length > 0) {
      resolvedDepegs = candidates;
    }
  } catch (e) {
    console.error("[daily-digest] Failed to query resolved depegs:", e);
  }

  // 4e. Mint-burn flows (24h + 30d baseline)
  let mintBurnFlows: DigestInputData["mintBurnFlows"];
  try {
    const cutoff24h = nowSec - SECONDS.ONE_DAY;
    const cutoff30d = nowSec - 30 * SECONDS.ONE_DAY;

    // 24h aggregate per coin (across all chains)
    const flow24hRows = await db
      .prepare(
        `SELECT stablecoin_id,
                SUM(mint_volume_usd) as mint_24h,
                SUM(burn_volume_usd) as burn_24h,
                SUM(net_flow_usd) as net_24h
         FROM mint_burn_hourly
         WHERE hour_ts >= ?
         GROUP BY stablecoin_id`,
      )
      .bind(cutoff24h)
      .all<{ stablecoin_id: string; mint_24h: number; burn_24h: number; net_24h: number }>();

    // 30d baseline per coin
    const flow30dRows = await db
      .prepare(
        `SELECT stablecoin_id,
                SUM(net_flow_usd) / 30.0 as avg_daily_net,
                SUM(mint_volume_usd + burn_volume_usd) / 30.0 as avg_daily_abs,
                COUNT(DISTINCT CAST(hour_ts / 86400 AS INTEGER)) as data_days
         FROM mint_burn_hourly
         WHERE hour_ts >= ?
         GROUP BY stablecoin_id`,
      )
      .bind(cutoff30d)
      .all<{ stablecoin_id: string; avg_daily_net: number; avg_daily_abs: number; data_days: number }>();

    const flow24h = new Map((flow24hRows.results ?? []).map((r) => [r.stablecoin_id, r]));
    const flow30d = new Map((flow30dRows.results ?? []).map((r) => [r.stablecoin_id, r]));

    // Compute FIS per coin
    const coinIntensities: { id: string; symbol: string; intensity: number | null; net24h: number; mcap: number }[] = [];
    for (const [id, f24] of flow24h) {
      const f30 = flow30d.get(id);
      if (!f30) continue;
      const coin = trackedStablecoinAssets.find((c) => c.id === id);
      if (!coin) continue;
      const intensity = computeFlowIntensity({
        currentDailyNet: f24.net_24h,
        baselineDailyNet: f30.avg_daily_net,
        baselineDailyAbs: f30.avg_daily_abs,
        dataAgeDays: f30.data_days,
      });
      coinIntensities.push({ id, symbol: coin.symbol, intensity, net24h: f24.net_24h, mcap: getCirculatingRaw(coin) });
    }

    const gaugeScore = computeGaugeScore(coinIntensities.map((c) => ({ intensity: c.intensity, mcap: c.mcap })));
    if (gaugeScore !== null) {
      // FTQ: sum net flows for safe vs risky
      let safeNet24h = 0;
      let riskyNet24h = 0;
      for (const c of coinIntensities) {
        if (SAFE_HAVEN_IDS.has(c.id)) safeNet24h += c.net24h;
        else riskyNet24h += c.net24h;
      }
      const ftq = detectFlightToQuality({ safeNet24h, riskyNet24h });

      // Top pressure: coins with |intensity| > 20, sorted by |intensity|
      const topPressure = coinIntensities
        .filter((c) => c.intensity !== null && Math.abs(c.intensity) > 20)
        .sort((a, b) => Math.abs(b.intensity!) - Math.abs(a.intensity!))
        .slice(0, 3)
        .map((c) => ({ symbol: c.symbol, intensity: c.intensity!, net24hUsd: c.net24h }));

      mintBurnFlows = {
        gaugeScore,
        gaugeBand: getGaugeBand(gaugeScore).label,
        flightToQuality: { active: ftq.active, safeNetUsd: safeNet24h, riskyNetUsd: riskyNet24h },
        topPressure,
      };
    }
  } catch (e) {
    console.error("[daily-digest] Failed to collect mint-burn flows:", e);
  }

  // 4f. DEWS stress signals
  let dewsStress: DigestInputData["dewsStress"];
  try {
    // Latest DEWS per coin (most recent sample)
    const latestDews = await db
      .prepare(
        `SELECT s.stablecoin_id, s.score, s.band, s.signals_json
         FROM stress_signals s
         INNER JOIN (
           SELECT stablecoin_id, MAX(computed_at) as max_at
           FROM stress_signals GROUP BY stablecoin_id
         ) latest ON s.stablecoin_id = latest.stablecoin_id AND s.computed_at = latest.max_at`,
      )
      .all<{ stablecoin_id: string; score: number; band: string; signals_json: string }>();

    const todayRows = latestDews.results ?? [];
    if (todayRows.length > 0) {
      // Yesterday's snapshot for band-change detection
      const yesterdayDews = await db
        .prepare("SELECT stablecoin_id, score, band FROM stress_signal_history WHERE snapshot_date = ?")
        .bind(yesterdayTs)
        .all<{ stablecoin_id: string; score: number; band: string }>();

      const yesterdayMap = new Map((yesterdayDews.results ?? []).map((r) => [r.stablecoin_id, r]));

      // Band counts
      const initCounts = () => ({ calm: 0, watch: 0, alert: 0, warning: 0, danger: 0 });
      const bandCounts = initCounts();
      const yesterdayBandCounts = initCounts();

      for (const r of todayRows) {
        const key = r.band.toLowerCase() as keyof typeof bandCounts;
        if (key in bandCounts) bandCounts[key]++;
      }
      for (const r of yesterdayDews.results ?? []) {
        const key = r.band.toLowerCase() as keyof typeof yesterdayBandCounts;
        if (key in yesterdayBandCounts) yesterdayBandCounts[key]++;
      }

      // Band changes crossing WATCH/ALERT boundary
      const SIGNAL_LABELS: Record<string, string> = {
        supply: "supply velocity", pool: "pool balance drift", liq: "liquidity erosion",
        price: "price confidence", diverg: "cross-source divergence", black: "blacklist activity",
        flow: "mint/burn flow", yield: "yield anomaly",
      };
      const ALERT_BANDS = new Set(["ALERT", "WARNING", "DANGER"]);
      const bandChanges: NonNullable<DigestInputData["dewsStress"]>["bandChanges"] = [];

      for (const today of todayRows) {
        const yesterday = yesterdayMap.get(today.stablecoin_id);
        if (!yesterday || yesterday.band === today.band) continue;
        // Only include if crossing the WATCH/ALERT boundary
        const wasElevated = ALERT_BANDS.has(yesterday.band);
        const isElevated = ALERT_BANDS.has(today.band);
        if (wasElevated === isElevated) continue; // Both above or both below — not crossing

        // Extract top driver from signals_json
        let topDriver = "unknown";
        try {
          const signals = JSON.parse(today.signals_json) as Record<string, { value: number; available: boolean }>;
          let maxVal = -1;
          for (const [key, sig] of Object.entries(signals)) {
            if (sig.available && sig.value > maxVal) { maxVal = sig.value; topDriver = SIGNAL_LABELS[key] ?? key; }
          }
        } catch { /* use "unknown" */ }

        const coin = trackedStablecoinAssets.find((c) => c.id === today.stablecoin_id);
        if (!coin) continue;
        bandChanges.push({ symbol: coin.symbol, from: yesterday.band, to: today.band, score: today.score, topDriver });
      }

      // Elevated coins: ALERT+ with mcap > $10M
      const elevatedCoins = todayRows
        .filter((r) => ALERT_BANDS.has(r.band))
        .map((r) => {
          const coin = trackedStablecoinAssets.find((c) => c.id === r.stablecoin_id);
          return coin ? { symbol: coin.symbol, band: r.band, score: r.score, mcapUsd: getCirculatingRaw(coin) } : null;
        })
        .filter((r): r is NonNullable<typeof r> => r !== null && r.mcapUsd > 10_000_000)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

      dewsStress = { bandCounts, yesterdayBandCounts, bandChanges: bandChanges.slice(0, 5), elevatedCoins };
    }
  } catch (e) {
    console.error("[daily-digest] Failed to collect DEWS stress signals:", e);
  }

  // 4g. Historical context (PSI precedent, band streak, supply mover)
  let historicalContext: DigestInputData["historicalContext"];
  try {
    // Check we have enough history (>30 days)
    const histDepth = await db
      .prepare("SELECT COUNT(*) as cnt FROM stability_index")
      .first<{ cnt: number }>();

    if (displayScore != null && displayBand && (histDepth?.cnt ?? 0) > 30) {
      // PSI precedent: last time score was at or below current
      const precedent = await db
        .prepare(
          "SELECT computed_at, score, band FROM stability_index WHERE score <= ? AND computed_at < ? ORDER BY computed_at DESC LIMIT 1",
        )
        .bind(displayScore, todayTs)
        .first<{ computed_at: number; score: number; band: string }>();

      const psiPrecedent = precedent
        ? {
            lastSeenDate: precedent.computed_at,
            lastSeenDaysAgo: Math.round((todayTs - precedent.computed_at) / SECONDS.ONE_DAY),
            lastSeenScore: precedent.score,
            lastSeenBand: precedent.band,
          }
        : null; // null = all-time low

      // PSI band streak: count consecutive days in current band
      const bandHistory = await db
        .prepare(
          "SELECT computed_at, band FROM stability_index WHERE computed_at <= ? ORDER BY computed_at DESC LIMIT 90",
        )
        .bind(todayTs)
        .all<{ computed_at: number; band: string }>();

      let psiBandStreak = 0;
      for (const row of bandHistory.results ?? []) {
        if (row.band === displayBand) psiBandStreak++;
        else break;
      }
      if (psiBandStreak === 0) psiBandStreak = 1; // Minimum 1 (today)

      // Supply mover context
      let supplyMoverContext: NonNullable<DigestInputData["historicalContext"]>["supplyMoverContext"] = null;
      if (biggestSupplyChange) {
        const athRow = await db
          .prepare("SELECT MAX(circulating_usd) as ath_mcap FROM supply_history WHERE stablecoin_id = ?")
          .bind(biggestSupplyChange.id)
          .first<{ ath_mcap: number | null }>();

        // ATH date (separate query since D1 doesn't support argmax)
        let athDate = 0;
        if (athRow?.ath_mcap) {
          const athDateRow = await db
            .prepare(
              "SELECT snapshot_date FROM supply_history WHERE stablecoin_id = ? AND circulating_usd = ? ORDER BY snapshot_date DESC LIMIT 1",
            )
            .bind(biggestSupplyChange.id, athRow.ath_mcap)
            .first<{ snapshot_date: number }>();
          athDate = athDateRow?.snapshot_date ?? 0;
        }

        // Largest historical 7d change
        const largestChangeRow = await db
          .prepare(
            `SELECT s1.snapshot_date, ABS(s1.circulating_usd - s2.circulating_usd) as abs_change
             FROM supply_history s1
             JOIN supply_history s2
               ON s1.stablecoin_id = s2.stablecoin_id
               AND s2.snapshot_date = s1.snapshot_date - ?
             WHERE s1.stablecoin_id = ?
             ORDER BY abs_change DESC LIMIT 1`,
          )
          .bind(7 * SECONDS.ONE_DAY, biggestSupplyChange.id)
          .first<{ snapshot_date: number; abs_change: number }>();

        if (athRow?.ath_mcap && largestChangeRow) {
          supplyMoverContext = {
            allTimeHighMcap: athRow.ath_mcap,
            allTimeHighDate: athDate,
            largestWeeklyChange: largestChangeRow.abs_change,
            largestWeeklyChangeDate: largestChangeRow.snapshot_date,
            largestWeeklyChangeDaysAgo: Math.round(
              (todayTs - largestChangeRow.snapshot_date) / SECONDS.ONE_DAY,
            ),
          };
        }
      }

      historicalContext = { psiPrecedent, psiBandStreak, supplyMoverContext };
    }
  } catch (e) {
    console.error("[daily-digest] Failed to collect historical context:", e);
  }

  // 4h. Grade transitions (last 48h)
  let gradeTransitions: DigestInputData["gradeTransitions"];
  try {
    const cutoff48h = nowSec - SECONDS.TWO_DAYS;

    // Check for methodology bumps (>10 simultaneous transitions = version change)
    const bumpRows = await db
      .prepare(
        `SELECT recorded_at FROM safety_grade_history
         WHERE recorded_at >= ? AND prev_grade IS NOT NULL
         GROUP BY recorded_at HAVING COUNT(*) > 10`,
      )
      .bind(cutoff48h)
      .all<{ recorded_at: number }>();
    const bumpTimestamps = new Set((bumpRows.results ?? []).map((r) => r.recorded_at));

    // Get transitions sorted by largest score change
    const transitionRows = await db
      .prepare(
        `SELECT stablecoin_id, recorded_at, grade, score, prev_grade, prev_score
         FROM safety_grade_history WHERE recorded_at >= ? AND prev_grade IS NOT NULL
         ORDER BY ABS(score - prev_score) DESC
         LIMIT 10`,
      )
      .bind(cutoff48h)
      .all<{ stablecoin_id: string; recorded_at: number; grade: string; score: number; prev_grade: string; prev_score: number }>();

    const candidates = (transitionRows.results ?? [])
      .filter((r) => !bumpTimestamps.has(r.recorded_at)) // Exclude methodology bumps
      .filter((r) => {
        const coin = trackedStablecoinAssets.find((c) => c.id === r.stablecoin_id);
        return coin && getCirculatingRaw(coin) > 10_000_000; // mcap > $10M
      })
      .slice(0, 5);

    if (candidates.length > 0 && safetyGrades) {
      const gradeMap = new Map(safetyGrades.map((g) => [g.id, g]));

      gradeTransitions = candidates.map((r) => {
        const coin = trackedStablecoinAssets.find((c) => c.id === r.stablecoin_id)!;
        const currentGrade = gradeMap.get(r.stablecoin_id);
        return {
          symbol: coin.symbol,
          fromGrade: r.prev_grade,
          toGrade: r.grade,
          fromScore: r.prev_score,
          toScore: r.score,
          currentDimensions: {
            peg: currentGrade?.pegScore ?? null,
            liq: currentGrade?.liqScore ?? null,
            resilience: null,
            decentralization: null,
          },
          mcapUsd: getCirculatingRaw(coin),
        };
      });
    }
  } catch (e) {
    console.error("[daily-digest] Failed to collect grade transitions:", e);
  }

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
  return { itemCount: 1, metadata: `${digestText.length} chars, tweet: ${tweetStatus}, telegram: ${telegramStatus}` };
}
