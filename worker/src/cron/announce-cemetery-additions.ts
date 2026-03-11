import { DEAD_STABLECOINS } from "@shared/lib/dead-stablecoins";
import { formatCurrency } from "@shared/lib/format";
import type { CauseOfDeath, DeadStablecoin } from "@shared/types";
import { getCache, setCache, type CronResult } from "../lib/db";
import { escapeHtml, sendToChat } from "../lib/telegram";
import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import { CIRCUIT_SOURCE } from "../lib/constants";

const CEMETERY_SNAPSHOT_CACHE_KEY = "telegram:cemetery-snapshot";
const CEMETERY_FOOTER_INDEX_CACHE_KEY = "telegram:cemetery-footer-index";

const CAUSE_LABELS: Record<CauseOfDeath, string> = {
  "algorithmic-failure": "Algorithmic Failure",
  "counterparty-failure": "Counterparty Failure",
  "liquidity-drain": "Liquidity Drain",
  regulatory: "Regulatory",
  abandoned: "Abandoned",
};

export const CEMETERY_FOOTERS = [
  "The cemetery remains a growth sector.",
  "Stability, once again, proved negotiable.",
  "Another peg has entered the afterlife.",
  "The market has finished another obituary for us.",
  'Another reminder that "stable" is often aspirational.',
  "Reflexivity, leverage, and neglect keep excellent undertakers.",
  "The graveyard shift in stablecoins never really ends.",
  "One more monument to the distance between promise and peg.",
  "The peg graveyard grows.",
  "Another headstone for the stablecoin experiment.",
] as const;

function buildDeadStablecoinKey(coin: DeadStablecoin): string {
  if (coin.llamaId) return `llama:${coin.llamaId}`;
  return `${coin.symbol.toUpperCase()}|${coin.deathDate}|${coin.name.toLowerCase()}`;
}

function buildSnapshotPayload(): string {
  return JSON.stringify(DEAD_STABLECOINS.map(buildDeadStablecoinKey));
}

function parseSnapshotKeys(raw: string): Set<string> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
      return null;
    }
    return new Set(parsed);
  } catch {
    return null;
  }
}

function parseFooterIndex(raw: string | null): number {
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function formatDeadStablecoinBlock(coin: DeadStablecoin): string {
  const lines = [`<code>${escapeHtml(coin.symbol)}</code> ${escapeHtml(coin.name)}`];

  if (coin.epitaph) {
    lines.push(`<i>${escapeHtml(coin.epitaph)}</i>`);
  }

  lines.push(`Cause of death: ${CAUSE_LABELS[coin.causeOfDeath]}`);
  lines.push(`Died: ${escapeHtml(coin.deathDate)}`);

  if (typeof coin.peakMcap === "number" && Number.isFinite(coin.peakMcap)) {
    lines.push(`Peak mcap: ${escapeHtml(formatCurrency(coin.peakMcap))}`);
  }

  return lines.join("\n");
}

export function formatCemeteryAnnouncementMessage(coins: DeadStablecoin[], footer: string): string {
  const header =
    coins.length === 1
      ? "🪦 A stablecoin has fallen!"
      : `🪦 ${coins.length} stablecoins have fallen!`;

  return [
    `<b>${header}</b>`,
    "",
    coins.map(formatDeadStablecoinBlock).join("\n\n"),
    "",
    escapeHtml(footer),
    "",
    '<a href="https://pharos.watch/cemetery/">Enter the cemetery →</a>',
  ].join("\n");
}

export async function announceCemeteryAdditions(
  db: D1Database,
  botToken: string,
  chatId: string,
): Promise<CronResult> {
  const allowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.TELEGRAM_API);
  if (!allowed) {
    return {
      itemCount: 0,
      metadata: JSON.stringify({
        snapshotSeeded: false,
        detected: 0,
        sent: false,
        skipped: "circuit-open",
      }),
    };
  }

  const snapshotPayload = buildSnapshotPayload();
  const cachedSnapshot = await getCache(db, CEMETERY_SNAPSHOT_CACHE_KEY);

  if (!cachedSnapshot) {
    await setCache(db, CEMETERY_SNAPSHOT_CACHE_KEY, snapshotPayload);
    await recordOutcome(db, CIRCUIT_SOURCE.TELEGRAM_API, true);
    return {
      itemCount: 0,
      metadata: JSON.stringify({
        snapshotSeeded: true,
        detected: 0,
        sent: false,
        reason: "first-run",
      }),
    };
  }

  const previousKeys = parseSnapshotKeys(cachedSnapshot.value);
  if (!previousKeys) {
    await setCache(db, CEMETERY_SNAPSHOT_CACHE_KEY, snapshotPayload);
    await recordOutcome(db, CIRCUIT_SOURCE.TELEGRAM_API, true);
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({
        snapshotSeeded: true,
        detected: 0,
        sent: false,
        reason: "invalid-snapshot-reseeded",
      }),
    };
  }

  const newCoins = DEAD_STABLECOINS.filter((coin) => !previousKeys.has(buildDeadStablecoinKey(coin)));
  if (newCoins.length === 0) {
    if (cachedSnapshot.value !== snapshotPayload) {
      await setCache(db, CEMETERY_SNAPSHOT_CACHE_KEY, snapshotPayload);
    }
    await recordOutcome(db, CIRCUIT_SOURCE.TELEGRAM_API, true);
    return {
      itemCount: 0,
      metadata: JSON.stringify({
        snapshotSeeded: false,
        detected: 0,
        sent: false,
      }),
    };
  }

  const cachedFooterIndex = await getCache(db, CEMETERY_FOOTER_INDEX_CACHE_KEY);
  const footerIndex = parseFooterIndex(cachedFooterIndex?.value ?? null);
  const footer = CEMETERY_FOOTERS[footerIndex % CEMETERY_FOOTERS.length];
  const html = formatCemeteryAnnouncementMessage(newCoins, footer);

  const result = await sendToChat(chatId, html, botToken, { disableWebPagePreview: true });
  if (!result.ok) {
    await recordOutcome(db, CIRCUIT_SOURCE.TELEGRAM_API, false);
    return {
      status: result.permanentFailure ? "error" : "degraded",
      itemCount: 0,
      metadata: JSON.stringify({
        snapshotSeeded: false,
        detected: newCoins.length,
        sent: false,
        symbols: newCoins.map((coin) => coin.symbol),
        delivery: result.delivery,
        statusCode: result.statusCode,
        errorClass: result.errorClass,
      }),
    };
  }

  await setCache(db, CEMETERY_SNAPSHOT_CACHE_KEY, snapshotPayload);
  await setCache(db, CEMETERY_FOOTER_INDEX_CACHE_KEY, String(footerIndex + 1));
  await recordOutcome(db, CIRCUIT_SOURCE.TELEGRAM_API, true);

  return {
    itemCount: newCoins.length,
    metadata: JSON.stringify({
      snapshotSeeded: false,
      detected: newCoins.length,
      sent: true,
      symbols: newCoins.map((coin) => coin.symbol),
      footer,
    }),
  };
}
