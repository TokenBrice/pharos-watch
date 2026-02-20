import type { StablecoinData, PegSummaryResponse } from "../../../src/lib/types";
import { getCirculatingRaw, getPrevWeekRaw } from "../../../src/lib/supply";
import { TRACKED_IDS } from "../../../src/lib/stablecoins";
import { getCache } from "../lib/db";
import type { CronResult } from "../lib/db";

const SYSTEM_PROMPT =
  "You write the daily editorial summary for Pharos, a stablecoin analytics dashboard. " +
  "Your tone is concise, slightly editorial, never alarmist, and always factual. " +
  "You write 2-4 sentences max summarizing the last 24 hours in stablecoin markets. " +
  "No emojis, no clickbait, no hedging. When nothing happened, acknowledge the calm with personality. " +
  "Reference specific coins and numbers from the data provided.";

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

function formatUsd(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function buildUserPrompt(data: DigestInputData): string {
  const lines: string[] = [
    `Total stablecoin market cap: ${formatUsd(data.totalMcapUsd)}`,
    `7-day market cap change: ${data.mcap7dDelta >= 0 ? "+" : ""}${formatUsd(data.mcap7dDelta)} (${((data.mcap7dDelta / (data.totalMcapUsd - data.mcap7dDelta)) * 100).toFixed(2)}%)`,
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
      `Biggest 7d supply ${direction}: ${symbol} ${changeUsd >= 0 ? "+" : ""}${formatUsd(changeUsd)} (now ${formatUsd(currentMcap)})`,
    );
  }

  return lines.join("\n");
}

export async function generateDailyDigest(
  db: D1Database,
  anthropicApiKey: string | null,
  force = false,
): Promise<CronResult> {
  if (!anthropicApiKey) {
    console.log("[daily-digest] No API key configured, skipping");
    return { metadata: "skipped: no API key" };
  }

  // Check if latest digest is <1h old (skip check if force=true)
  if (!force) {
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

  // 2. Active depeg count + worst deviation from peg-summary cache
  let activeDepegCount = 0;
  let worstDepeg: DigestInputData["worstDepeg"] = null;

  const pegCache = await getCache(db, "peg-summary");
  if (pegCache) {
    const pegData = JSON.parse(pegCache.value) as PegSummaryResponse;
    if (pegData.summary) {
      activeDepegCount = pegData.summary.activeDepegCount;
      worstDepeg = pegData.summary.worstCurrent;
    }
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
