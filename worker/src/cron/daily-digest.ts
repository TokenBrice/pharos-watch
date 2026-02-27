import type { StablecoinData } from "../../../src/lib/types";
import { getCirculatingRaw, getPrevWeekRaw } from "../../../src/lib/supply";
import { TRACKED_IDS } from "../../../src/lib/stablecoins";
import { formatCurrency } from "../../../src/lib/format";
import { getCache } from "../lib/db";
import type { CronResult } from "../lib/db";
import { postDigestTweet, type TwitterCreds } from "../lib/twitter";

const SYSTEM_PROMPT =
  "You write the daily editorial summary for Pharos, a stablecoin analytics dashboard. " +
  "Your voice is dry, sharp, and memorable — like a financial columnist who's seen too many death spirals to be impressed. " +
  "Think sardonic wit meets hard data. You can be funny, but the humor comes from precision, not clowning. " +
  "Every sentence must contain a specific number or coin name from the data. " +
  "CRITICAL — rank everything by market impact (deviation × market cap). " +
  "A 30 bps wobble on USDT is front-page news. A 2000 bps depeg on a $15M coin is a footnote at best — mention it only if nothing more interesting happened. " +
  "Do not lead with small illiquid coins that have been off-peg for weeks; that is not news. " +
  "No emojis, no clickbait, no hedging, no exclamation marks, no em dashes. " +
  "When nothing happened, make the calm sound ominous or amusing. " +
  "When something did happen, make the reader feel it. " +
  "VARIETY IS MANDATORY. " +
  "You will receive recent digests below. Do NOT reuse any phrasing, metaphors, or sentence structures from them. " +
  "Never repeat pet phrases across days — no recurring catchphrases, no signature idioms. " +
  "Vary your angle: one day lead with a macro observation, another with a single coin's story, another with a wry comparison. " +
  "Rotate between tones: deadpan, wistful, clinical, bemused, foreboding. Never settle into one voice for consecutive days. " +
  "If the data is similar to yesterday, find a completely different framing. Same numbers can tell different stories. " +
  "Open with the Pharos Stability Index score and its condition band. " +
  "Reference the band name naturally — 'Another day in BEDROCK' or 'We\\'ve slipped into TREMOR for the first time since March.' " +
  "When the band changed from yesterday, lead with that transition — band shifts are the headline. " +
  "You MUST respond with valid JSON: {\"title\": \"...\", \"extended\": \"...\", \"text\": \"...\"}. " +
  "Output ONLY the raw JSON object — no markdown code fences, no preamble, no trailing text. " +
  "The title is 2-6 words that capture the day's theme — punchy, catchy, like a newspaper column header. " +
  "The extended field (write this FIRST): 1-3 sentences of sharp editorial analysis. This is your thinking space — be specific, be funny, find the story in the data. No character limit. " +
  "The text field (write this AFTER extended): distill the single most compelling take from your extended analysis into a tweet-sized line. " +
  "The title and text will be concatenated as '{title}\\n\\n{text}' for a tweet. The combined result MUST be under 270 characters (leave ~10 chars headroom for cashtag formatting). " +
  "Pack every character with data and wit — density is a virtue. No sentence count limit.";

interface DigestInputData {
  totalMcapUsd: number;
  mcap7dDelta: number;
  activeDepegCount: number;
  topDepegs: { symbol: string; bps: number; mcapUsd: number }[];
  biggestSupplyChange: {
    id: string;
    symbol: string;
    name: string;
    changeUsd: number;
    currentMcap: number;
  } | null;
  stabilityIndex: { score: number; band: string; components: { severity: number; breadth: number; trend: number } } | null;
  yesterdayIndex: { score: number; band: string } | null;
}

function buildUserPrompt(data: DigestInputData, recentDigests: string[] = []): string {
  const lines: string[] = [
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
  }

  if (data.biggestSupplyChange) {
    const { symbol, changeUsd, currentMcap } = data.biggestSupplyChange;
    const direction = changeUsd >= 0 ? "increase" : "decrease";
    lines.push(
      `Biggest 7d supply ${direction}: ${symbol} ${changeUsd >= 0 ? "+" : ""}${formatCurrency(changeUsd)} (now ${formatCurrency(currentMcap)})`,
    );
  }

  if (recentDigests.length > 0) {
    lines.push(
      "",
      "RECENT DIGESTS — read these carefully, then write something that sounds NOTHING like them. " +
        "Do not borrow their phrases, metaphors, structure, or framing. " +
        "DO keep covering ongoing stories (a depeg entering day 3 is bigger news, not old news) but use a completely different angle and wording:",
      ...recentDigests.map((d) => `- "${d}"`),
    );
  }

  return lines.join("\n");
}

export async function generateDailyDigest(
  db: D1Database,
  anthropicApiKey: string | null,
  twitterCreds: TwitterCreds | null = null,
  force = false,
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
    if (ageSec < 3600 && !isBroken && !force) {
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
    .prepare("SELECT digest_title, digest_text, digest_extended FROM daily_digest ORDER BY generated_at DESC LIMIT 5")
    .all<{ digest_title: string | null; digest_text: string; digest_extended: string | null }>();
  const recentDigests = (recentRows.results ?? []).map((r) => {
    const base = r.digest_title ? `${r.digest_title}: ${r.digest_text}` : r.digest_text;
    return r.digest_extended ? `${base} ${r.digest_extended}` : base;
  });

  // --- Collect data ---

  // 1. Total mcap + 7d delta from stablecoins cache
  const stablecoinsCache = await getCache(db, "stablecoins");
  let totalMcapUsd = 0;
  let totalPrevWeek = 0;
  let biggestSupplyChange: DigestInputData["biggestSupplyChange"] = null;
  let biggestAbsChange = 0;

  if (stablecoinsCache) {
    const parsed = JSON.parse(stablecoinsCache.value) as {
      peggedAssets: StablecoinData[];
    };
    const tracked = parsed.peggedAssets.filter((c) => TRACKED_IDS.has(c.id));

    for (const coin of tracked) {
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

    // Cross-reference with mcap from stablecoins cache to rank by impact
    const mcapById = new Map<string, number>();
    if (stablecoinsCache) {
      const parsed = JSON.parse(stablecoinsCache.value) as { peggedAssets: StablecoinData[] };
      for (const coin of parsed.peggedAssets) {
        mcapById.set(coin.id, getCirculatingRaw(coin));
      }
    }

    const withImpact = rows.map((r) => {
      const mcapUsd = mcapById.get(r.stablecoin_id) ?? 0;
      return { symbol: r.symbol, bps: r.peak_deviation_bps, mcapUsd, impact: r.peak_deviation_bps * mcapUsd };
    });
    withImpact.sort((a, b) => b.impact - a.impact);
    topDepegs.push(...withImpact.slice(0, 3).map(({ symbol, bps, mcapUsd }) => ({ symbol, bps, mcapUsd })));
  } catch (e) {
    console.error("[daily-digest] Failed to query active depegs:", e);
  }

  // 3. Stability index — date-keyed lookup for today + yesterday
  const nowSec = Math.floor(Date.now() / 1000);
  const todayTs = nowSec - (nowSec % 86400);
  const yesterdayTs = todayTs - 86400;
  const indexRows = await db
    .prepare(
      "SELECT computed_at, score, band, components FROM stability_index " +
      "WHERE computed_at IN (?, ?) ORDER BY computed_at DESC"
    )
    .bind(todayTs, yesterdayTs)
    .all<{ computed_at: number; score: number; band: string; components: string }>();
  const indexResults = indexRows.results ?? [];
  const todayRow = indexResults.find(r => r.computed_at === todayTs);
  const yesterdayRow = indexResults.find(r => r.computed_at === yesterdayTs);
  // If today's PSI hasn't computed yet, use yesterday as "current"
  const currentRow = todayRow ?? yesterdayRow;
  const stabilityIndex = currentRow
    ? { score: currentRow.score, band: currentRow.band, components: JSON.parse(currentRow.components) }
    : null;
  const yesterdayIndex = todayRow && yesterdayRow
    ? { score: yesterdayRow.score, band: yesterdayRow.band }
    : null;

  // --- Build input data ---
  const inputData: DigestInputData = {
    totalMcapUsd,
    mcap7dDelta: totalMcapUsd - totalPrevWeek,
    activeDepegCount,
    topDepegs,
    biggestSupplyChange,
    stabilityIndex,
    yesterdayIndex,
  };

  const userPromptContent = buildUserPrompt(inputData, recentDigests);
  console.log("[daily-digest] Calling Claude API with data:\n" + userPromptContent);

  // --- Call Claude API ---
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 800,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPromptContent }],
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Claude API error ${response.status}: ${errorText.slice(0, 500)}`,
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
  const jsonText = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

  // Parse JSON response for title + text + extended
  let digestTitle: string;
  let digestText: string;
  let digestExtended: string;
  try {
    const parsed = JSON.parse(jsonText) as { title?: string; text?: string; extended?: string };
    digestTitle = (parsed.title ?? "").trim();
    digestText = (parsed.text ?? "").trim();
    digestExtended = (parsed.extended ?? "").trim();
    if (!digestText) throw new Error("empty text field");
  } catch {
    // Fallback: treat entire response as text with no title or extended
    console.warn("[daily-digest] Failed to parse JSON response, using raw text");
    digestTitle = "";
    digestText = rawText.trim();
    digestExtended = "";
  }

  // --- Store result ---
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      "INSERT INTO daily_digest (generated_at, digest_text, digest_title, input_data, digest_extended) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(now, digestText, digestTitle || null, JSON.stringify(inputData), digestExtended || null)
    .run();

  // Post to Twitter if credentials are available
  let tweetStatus = "no-creds";
  if (twitterCreds) {
    try {
      await postDigestTweet(digestTitle, digestText, twitterCreds);
      tweetStatus = "ok";
    } catch (err) {
      console.error("[daily-digest] Failed to post tweet (non-fatal):", err);
      tweetStatus = `failed: ${String(err).slice(0, 100)}`;
    }
  }

  console.log(`[daily-digest] Generated and stored digest: "${digestTitle}" (${digestText.length} chars + ${digestExtended.length} extended), tweet: ${tweetStatus}`);
  return { itemCount: 1, metadata: `${digestText.length} chars, tweet: ${tweetStatus}` };
}
