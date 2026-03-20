import { DEAD_STABLECOINS } from "@shared/lib/dead-stablecoins";
import { formatCurrency } from "@shared/lib/format";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import type { CauseOfDeath, DeadStablecoin } from "@shared/types";
import { getCache, setCache } from "./db-cache";
import { escapeHtml } from "./telegram";

const CEMETERY_SNAPSHOT_CACHE_KEY = "telegram:cemetery-snapshot";
const CEMETERY_FOOTER_INDEX_CACHE_KEY = "telegram:cemetery-footer-index";
const TRACKED_SNAPSHOT_CACHE_KEY = "telegram:tracked-stablecoins-snapshot";

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

type TrackedStablecoinMeta = (typeof TRACKED_STABLECOINS)[number];

interface CacheWrite {
  key: string;
  value: string;
}

export interface TelegramDigestAppendixMetadata {
  hasAppendix: boolean;
  cemeteryDetected: number;
  trackedDetected: number;
  preLaunchDetected: number;
  cemeterySymbols: string[];
  trackedSymbols: string[];
  preLaunchSymbols: string[];
  seededSnapshots: string[];
}

export interface PreparedTelegramDigestAppendices {
  appendixHtml: string | null;
  metadata: TelegramDigestAppendixMetadata;
  commitSuccess: () => Promise<void>;
}

function buildDeadStablecoinKey(coin: DeadStablecoin): string {
  if (coin.llamaId) return `llama:${coin.llamaId}`;
  return `${coin.symbol.toUpperCase()}|${coin.deathDate}|${coin.name.toLowerCase()}`;
}

function buildCemeterySnapshotPayload(): string {
  return JSON.stringify(DEAD_STABLECOINS.map(buildDeadStablecoinKey));
}

function buildTrackedSnapshotPayload(): string {
  return JSON.stringify(TRACKED_STABLECOINS.map((coin) => coin.id));
}

function parseSnapshotKeys(raw: string): Set<string> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
      return null;
    }
    return new Set(parsed);
  } catch (err) {
    console.warn("[telegram-digest-appendices] ignored invalid snapshot:", err);
    return null;
  }
}

function parseFooterIndex(raw: string | null): number {
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function formatCemeteryCoin(coin: DeadStablecoin): string {
  const header = `<code>${escapeHtml(coin.symbol)}</code> ${escapeHtml(coin.name)} (${escapeHtml(coin.deathDate)}; ${CAUSE_LABELS[coin.causeOfDeath]})`;
  const lines = [header];

  if (coin.epitaph) {
    lines.push(`<i>${escapeHtml(coin.epitaph)}</i>`);
  }

  if (typeof coin.peakMcap === "number" && Number.isFinite(coin.peakMcap)) {
    lines.push(`Peak mcap: ${escapeHtml(formatCurrency(coin.peakMcap))}`);
  }

  return lines.join("\n");
}

function formatTrackedCoin(coin: TrackedStablecoinMeta): string {
  return `<code>${escapeHtml(coin.symbol)}</code> ${escapeHtml(coin.name)}`;
}

function buildCemeteryAppendix(coins: DeadStablecoin[], footer: string): string {
  return [
    "<b>New Cemetery Entries</b>",
    coins.map(formatCemeteryCoin).join("\n\n"),
    escapeHtml(footer),
  ].join("\n\n");
}

function buildTrackedAppendix(
  trackedCoins: TrackedStablecoinMeta[],
  preLaunchCoins: TrackedStablecoinMeta[],
): string {
  const sections = ["<b>Tracking Changes</b>"];

  if (trackedCoins.length > 0) {
    sections.push(
      "Newly tracked stablecoins:\n" + trackedCoins.map(formatTrackedCoin).join("\n"),
    );
  }

  if (preLaunchCoins.length > 0) {
    sections.push(
      "Newly tracked pre-launch stablecoins:\n" + preLaunchCoins.map(formatTrackedCoin).join("\n"),
    );
  }

  return sections.join("\n\n");
}

async function applyCacheWrites(db: D1Database, writes: CacheWrite[]): Promise<void> {
  for (const write of writes) {
    await setCache(db, write.key, write.value);
  }
}

export async function prepareTelegramDigestAppendices(
  db: D1Database,
): Promise<PreparedTelegramDigestAppendices> {
  const immediateWrites: CacheWrite[] = [];
  const postSuccessWrites: CacheWrite[] = [];
  const appendixSections: string[] = [];
  const metadata: TelegramDigestAppendixMetadata = {
    hasAppendix: false,
    cemeteryDetected: 0,
    trackedDetected: 0,
    preLaunchDetected: 0,
    cemeterySymbols: [],
    trackedSymbols: [],
    preLaunchSymbols: [],
    seededSnapshots: [],
  };

  const cemeterySnapshotPayload = buildCemeterySnapshotPayload();
  const cachedCemeterySnapshot = await getCache(db, CEMETERY_SNAPSHOT_CACHE_KEY);

  if (!cachedCemeterySnapshot) {
    immediateWrites.push({
      key: CEMETERY_SNAPSHOT_CACHE_KEY,
      value: cemeterySnapshotPayload,
    });
    metadata.seededSnapshots.push("cemetery:first-run");
  } else {
    const previousCemeteryKeys = parseSnapshotKeys(cachedCemeterySnapshot.value);
    if (!previousCemeteryKeys) {
      immediateWrites.push({
        key: CEMETERY_SNAPSHOT_CACHE_KEY,
        value: cemeterySnapshotPayload,
      });
      metadata.seededSnapshots.push("cemetery:invalid-reseeded");
    } else {
      const newCemeteryCoins = DEAD_STABLECOINS.filter(
        (coin) => !previousCemeteryKeys.has(buildDeadStablecoinKey(coin)),
      );

      if (newCemeteryCoins.length === 0) {
        if (cachedCemeterySnapshot.value !== cemeterySnapshotPayload) {
          immediateWrites.push({
            key: CEMETERY_SNAPSHOT_CACHE_KEY,
            value: cemeterySnapshotPayload,
          });
        }
      } else {
        const cachedFooterIndex = await getCache(db, CEMETERY_FOOTER_INDEX_CACHE_KEY);
        const footerIndex = parseFooterIndex(cachedFooterIndex?.value ?? null);
        const footer = CEMETERY_FOOTERS[footerIndex % CEMETERY_FOOTERS.length];

        appendixSections.push(buildCemeteryAppendix(newCemeteryCoins, footer));
        metadata.cemeteryDetected = newCemeteryCoins.length;
        metadata.cemeterySymbols = newCemeteryCoins.map((coin) => coin.symbol);

        postSuccessWrites.push(
          {
            key: CEMETERY_SNAPSHOT_CACHE_KEY,
            value: cemeterySnapshotPayload,
          },
          {
            key: CEMETERY_FOOTER_INDEX_CACHE_KEY,
            value: String(footerIndex + 1),
          },
        );
      }
    }
  }

  const trackedSnapshotPayload = buildTrackedSnapshotPayload();
  const cachedTrackedSnapshot = await getCache(db, TRACKED_SNAPSHOT_CACHE_KEY);

  if (!cachedTrackedSnapshot) {
    immediateWrites.push({
      key: TRACKED_SNAPSHOT_CACHE_KEY,
      value: trackedSnapshotPayload,
    });
    metadata.seededSnapshots.push("tracked:first-run");
  } else {
    const previousTrackedKeys = parseSnapshotKeys(cachedTrackedSnapshot.value);
    if (!previousTrackedKeys) {
      immediateWrites.push({
        key: TRACKED_SNAPSHOT_CACHE_KEY,
        value: trackedSnapshotPayload,
      });
      metadata.seededSnapshots.push("tracked:invalid-reseeded");
    } else {
      const newTrackedCoins = TRACKED_STABLECOINS.filter(
        (coin) => !previousTrackedKeys.has(coin.id),
      );

      if (newTrackedCoins.length === 0) {
        if (cachedTrackedSnapshot.value !== trackedSnapshotPayload) {
          immediateWrites.push({
            key: TRACKED_SNAPSHOT_CACHE_KEY,
            value: trackedSnapshotPayload,
          });
        }
      } else {
        const trackedCoins = newTrackedCoins.filter((coin) => coin.status !== "pre-launch");
        const preLaunchCoins = newTrackedCoins.filter((coin) => coin.status === "pre-launch");

        appendixSections.push(buildTrackedAppendix(trackedCoins, preLaunchCoins));
        metadata.trackedDetected = trackedCoins.length;
        metadata.preLaunchDetected = preLaunchCoins.length;
        metadata.trackedSymbols = trackedCoins.map((coin) => coin.symbol);
        metadata.preLaunchSymbols = preLaunchCoins.map((coin) => coin.symbol);

        postSuccessWrites.push({
          key: TRACKED_SNAPSHOT_CACHE_KEY,
          value: trackedSnapshotPayload,
        });
      }
    }
  }

  await applyCacheWrites(db, immediateWrites);

  const appendixHtml = appendixSections.length > 0 ? appendixSections.join("\n\n") : null;
  metadata.hasAppendix = appendixHtml != null;

  return {
    appendixHtml,
    metadata,
    commitSuccess: async () => {
      await applyCacheWrites(db, postSuccessWrites);
    },
  };
}
