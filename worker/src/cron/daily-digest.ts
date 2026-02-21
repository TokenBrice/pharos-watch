import type { StablecoinData } from "../../../src/lib/types";
import { getCirculatingRaw, getPrevWeekRaw } from "../../../src/lib/supply";
import { TRACKED_IDS } from "../../../src/lib/stablecoins";
import { formatCurrency } from "../../../src/lib/format";
import { getCache } from "../lib/db";
import type { CronResult } from "../lib/db";

const SYSTEM_PROMPT =
  "You write the daily editorial summary for Pharos, a stablecoin analytics dashboard. " +
  "Your voice is dry, sharp, and memorable — like a financial columnist who's seen too many death spirals to be impressed. " +
  "Think sardonic wit meets hard data. You can be funny, but the humor comes from precision, not clowning. " +
  "You write 2-4 sentences max. Every sentence must contain a specific number or coin name from the data. " +
  "No emojis, no clickbait, no hedging, no exclamation marks, no em dashes. " +
  "When nothing happened, make the calm sound ominous or amusing. " +
  "When something did happen, make the reader feel it. " +
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

function buildUserPrompt(data: DigestInputData): string {
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

  return lines.join("\n");
}

export async function generateDailyDigest(
  db: D1Database,
  anthropicApiKey: string | null,
): Promise<CronResult> {
  if (!anthropicApiKey) {
    console.log("[daily-digest] No API key configured, skipping");
    return { metadata: "skipped: no API key" };
  }

  // Check if latest digest is <1h old
  const latest = await db
    .prepare(
      "SELECT generated_at FROM daily_digest ORDER BY generated_at DESC LIMIT 1",
    )
    .first<{ generated_at: number }>();

  if (latest) {
    const ageSec = Math.floor(Date.now() / 1000) - latest.generated_at;
    if (ageSec < 3600) {
      console.log(
        `[daily-digest] Latest digest is ${Math.round(ageSec / 60)}min old, skipping`,
      );
      return { metadata: "skipped: recent digest exists" };
    }
  }

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

  const userPromptContent = buildUserPrompt(inputData);
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
  const digestText = result.content?.[0]?.text ?? "";

  if (!digestText) {
    throw new Error("Claude API returned empty digest text");
  }

  // --- Store result ---
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      "INSERT INTO daily_digest (generated_at, digest_text, input_data) VALUES (?, ?, ?)",
    )
    .bind(now, digestText, JSON.stringify(inputData))
    .run();

  // --- Clean up rows older than 7 days ---
  await db
    .prepare("DELETE FROM daily_digest WHERE generated_at < ?")
    .bind(now - 604800)
    .run();

  console.log(`[daily-digest] Generated and stored digest (${digestText.length} chars)`);
  return { itemCount: 1, metadata: `${digestText.length} chars` };
}
