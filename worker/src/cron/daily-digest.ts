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
  "You write 2-4 sentences max. Every sentence must contain a specific number or coin name from the data. " +
  "Prioritize by market impact: a 50 bps wobble on USDT matters more than a 2500 bps depeg on an $18M coin. " +
  "Small coins can be mentioned for color, but lead with what moves money. " +
  "No emojis, no clickbait, no hedging, no exclamation marks, no em dashes. " +
  "When nothing happened, make the calm sound ominous or amusing. " +
  "When something did happen, make the reader feel it. " +
  "You MUST respond with valid JSON: {\"title\": \"...\", \"text\": \"...\"}. " +
  "Output ONLY the raw JSON object — no markdown code fences, no preamble, no trailing text. " +
  "The title is 2-6 words that capture the day's theme — punchy, catchy, like a newspaper column header. " +
  "Examples of good titles: \"Calm Before the Storm\", \"Peg Watch\", \"Money Printer Goes Quiet\", \"Frozen Assets, Warm Markets\". " +
  "CRITICAL: title + text combined must be UNDER 260 characters (this goes in a tweet). " +
  "Examples of good tone: " +
  "\"$311B in stablecoins and JPYC is still 16% off peg like it's a lifestyle choice.\" " +
  "\"Thirty-four addresses got frozen today. Compliance never sleeps, and neither does Tether's blacklist bot.\" " +
  "\"The sector added $2B this week. Quiet growth, no casualties. Enjoy it while it lasts.\"";

interface DigestInputData {
  totalMcapUsd: number;
  mcap7dDelta: number;
  activeDepegCount: number;
  worstDepeg: { id: string; symbol: string; bps: number } | null;
  freezeCount24h: number;
  biggestSupplyChange: {
    id: string;
    symbol: string;
    name: string;
    changeUsd: number;
    currentMcap: number;
  } | null;
}

function buildUserPrompt(data: DigestInputData, recentDigests: string[] = []): string {
  const lines: string[] = [
    `Total stablecoin market cap: ${formatCurrency(data.totalMcapUsd)}`,
    `7-day market cap change: ${data.mcap7dDelta >= 0 ? "+" : ""}${formatCurrency(data.mcap7dDelta)} (${((data.mcap7dDelta / (data.totalMcapUsd - data.mcap7dDelta)) * 100).toFixed(2)}%)`,
    `Active depeg events: ${data.activeDepegCount}`,
  ];

  if (data.worstDepeg) {
    lines.push(
      `Worst current depeg: ${data.worstDepeg.symbol} at ${data.worstDepeg.bps} bps deviation`,
    );
  }

  lines.push(`Freeze/blacklist events in last 24h: ${data.freezeCount24h}`);

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
      "Recent digests (use fresh phrasing, but DO keep covering ongoing stories — a depeg entering day 3 is bigger news, not old news):",
      ...recentDigests.map((d) => `- "${d}"`),
    );
  }

  return lines.join("\n");
}

export async function generateDailyDigest(
  db: D1Database,
  anthropicApiKey: string | null,
  twitterCreds: TwitterCreds | null = null,
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
    if (ageSec < 3600 && !isBroken) {
      console.log(
        `[daily-digest] Latest digest is ${Math.round(ageSec / 60)}min old, skipping`,
      );
      return { metadata: "skipped: recent digest exists" };
    }
    if (isBroken) {
      console.log("[daily-digest] Latest digest is malformed (code-block response), regenerating");
    }
  }

  // Fetch last 3 digests for context-aware generation
  const recentRows = await db
    .prepare("SELECT digest_title, digest_text FROM daily_digest ORDER BY generated_at DESC LIMIT 3")
    .all<{ digest_title: string | null; digest_text: string }>();
  const recentDigests = (recentRows.results ?? []).map((r) =>
    r.digest_title ? `${r.digest_title}: ${r.digest_text}` : r.digest_text
  );

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

  // 2. Active depeg count + worst deviation from depeg_events table
  let activeDepegCount = 0;
  let worstDepeg: DigestInputData["worstDepeg"] = null;

  try {
    const activeDepegs = await db
      .prepare("SELECT stablecoin_id, symbol, peak_deviation_bps FROM depeg_events WHERE ended_at IS NULL ORDER BY peak_deviation_bps DESC")
      .all<{ stablecoin_id: string; symbol: string; peak_deviation_bps: number }>();
    const rows = activeDepegs.results ?? [];
    activeDepegCount = rows.length;
    if (rows.length > 0) {
      worstDepeg = { id: rows[0].stablecoin_id, symbol: rows[0].symbol, bps: rows[0].peak_deviation_bps };
    }
  } catch (e) {
    console.error("[daily-digest] Failed to query active depegs:", e);
  }

  // 3. Freeze count in last 24h
  const cutoff = Math.floor(Date.now() / 1000) - 86400;
  const freezeRow = await db
    .prepare("SELECT COUNT(*) as cnt FROM blacklist_events WHERE timestamp > ?")
    .bind(cutoff)
    .first<{ cnt: number }>();
  const freezeCount24h = freezeRow?.cnt ?? 0;

  // --- Build input data ---
  const inputData: DigestInputData = {
    totalMcapUsd,
    mcap7dDelta: totalMcapUsd - totalPrevWeek,
    activeDepegCount,
    worstDepeg,
    freezeCount24h,
    biggestSupplyChange,
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
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
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

  // Parse JSON response for title + text
  let digestTitle: string;
  let digestText: string;
  try {
    const parsed = JSON.parse(jsonText) as { title?: string; text?: string };
    digestTitle = (parsed.title ?? "").trim();
    digestText = (parsed.text ?? "").trim();
    if (!digestText) throw new Error("empty text field");
  } catch {
    // Fallback: treat entire response as text with no title
    console.warn("[daily-digest] Failed to parse JSON response, using raw text");
    digestTitle = "";
    digestText = rawText.trim();
  }

  // --- Store result ---
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      "INSERT INTO daily_digest (generated_at, digest_text, digest_title, input_data) VALUES (?, ?, ?, ?)",
    )
    .bind(now, digestText, digestTitle || null, JSON.stringify(inputData))
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

  console.log(`[daily-digest] Generated and stored digest: "${digestTitle}" (${digestText.length} chars), tweet: ${tweetStatus}`);
  return { itemCount: 1, metadata: `${digestText.length} chars, tweet: ${tweetStatus}` };
}
