import { logWorkerEventArgs } from "./structured-log";
import { DEAD_STABLECOINS } from "@shared/lib/dead-stablecoins";
import { formatCurrency } from "@shared/lib/format";
import { FROZEN_IDS, FROZEN_META_BY_ID, TRACKED_META_BY_ID, TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { CauseOfDeath, DeadStablecoin } from "@shared/types/market";
import { getCache, setCache } from "./db-cache";
import { escapeHtml } from "./telegram";

const CEMETERY_SNAPSHOT_CACHE_KEY = "telegram:cemetery-snapshot";
const CEMETERY_FOOTER_INDEX_CACHE_KEY = "telegram:cemetery-footer-index";
const TRACKED_SNAPSHOT_CACHE_KEY = "telegram:tracked-stablecoins-snapshot";
const TRACKED_PENDING_CACHE_KEY = "telegram:tracked-stablecoins-pending";
const FROZEN_SNAPSHOT_CACHE_KEY = "frozen_ids_snapshot";

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

function isTrackedAnnouncementCoin(coin: TrackedStablecoinMeta): boolean {
  return coin.status == null || coin.status === "active" || coin.status === "pre-launch";
}

export interface TelegramDigestSuccessAction {
  key: string;
  value: string;
}

export interface TelegramDigestAppendixMetadata {
  hasAppendix: boolean;
  cemeteryDetected: number;
  trackedDetected: number;
  preLaunchDetected: number;
  frozenDetected: number;
  cemeterySymbols: string[];
  trackedSymbols: string[];
  preLaunchSymbols: string[];
  frozenSymbols: string[];
  seededSnapshots: string[];
}

export interface PreparedTelegramDigestAppendices {
  appendixHtml: string | null;
  metadata: TelegramDigestAppendixMetadata;
  successActions?: readonly TelegramDigestSuccessAction[];
  commitSuccess: () => Promise<void>;
}

export interface QueueTrackedStablecoinAdditionsResult {
  queuedIds: string[];
  totalPending: number;
  baselineMissing: boolean;
}

function buildLegacyDeadStablecoinKey(coin: DeadStablecoin): string {
  return `${coin.symbol.toUpperCase()}|${coin.deathDate}|${coin.name.toLowerCase()}`;
}

function buildDeadStablecoinKey(coin: DeadStablecoin): string {
  return coin.id;
}

function wasDeadStablecoinPreviouslySeen(previousKeys: Set<string>, coin: DeadStablecoin): boolean {
  if (previousKeys.has(coin.id)) {
    return true;
  }
  if (coin.llamaId && previousKeys.has(`llama:${coin.llamaId}`)) {
    return true;
  }
  return previousKeys.has(buildLegacyDeadStablecoinKey(coin));
}

function buildCemeterySnapshotPayload(): string {
  return JSON.stringify(DEAD_STABLECOINS.map(buildDeadStablecoinKey));
}

function buildFrozenSnapshotPayload(): string {
  return JSON.stringify([...FROZEN_IDS]);
}

export function diffFrozenIds(current: ReadonlySet<string>, previous: ReadonlySet<string>): Set<string> {
  const added = new Set<string>();
  for (const id of current) {
    if (!previous.has(id)) added.add(id);
  }
  return added;
}

function buildFrozenAppendix(ids: Iterable<string>): string {
  const lines: string[] = ["<b>Newly Frozen Stablecoins</b>"];
  for (const id of ids) {
    const meta = FROZEN_META_BY_ID.get(id);
    if (!meta?.obituary) continue;
    lines.push(
      `<code>${escapeHtml(meta.symbol)}</code> ${escapeHtml(meta.name)} — <i>${escapeHtml(meta.obituary.epitaph)}</i>`,
    );
  }
  return lines.join("\n");
}

function buildTrackedSnapshotPayload(): string {
  return JSON.stringify(TRACKED_STABLECOINS.filter(isTrackedAnnouncementCoin).map((coin) => coin.id));
}

function parseSnapshotKeys(raw: string): Set<string> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
      return null;
    }
    return new Set(parsed);
  } catch (err) {
    logWorkerEventArgs("lib", "warn", "[telegram-digest-appendices] ignored invalid snapshot:", err);
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

async function applyCacheWrites(db: D1Database, writes: readonly TelegramDigestSuccessAction[]): Promise<void> {
  for (const write of writes) {
    await setCache(db, write.key, write.value);
  }
}

export async function queuePendingTrackedStablecoinAdditions(
  db: D1Database,
  previousAssetIds: Iterable<string>,
  currentAssetIds: Iterable<string>,
): Promise<QueueTrackedStablecoinAdditionsResult> {
  const previousIds = new Set(Array.from(previousAssetIds, String));
  if (previousIds.size === 0) {
    return {
      queuedIds: [],
      totalPending: 0,
      baselineMissing: true,
    };
  }

  const cachedPending = await getCache(db, TRACKED_PENDING_CACHE_KEY);
  const parsedPending = cachedPending ? parseSnapshotKeys(cachedPending.value) : null;
  const pendingIds = new Set(
    Array.from(parsedPending ?? [], String).filter((id) => TRACKED_META_BY_ID.has(id)),
  );

  const queuedIds = Array.from(new Set(Array.from(currentAssetIds, String)))
    .filter((id) => TRACKED_META_BY_ID.has(id))
    .filter((id) => !previousIds.has(id))
    .filter((id) => !pendingIds.has(id));

  if (queuedIds.length === 0) {
    return {
      queuedIds,
      totalPending: pendingIds.size,
      baselineMissing: false,
    };
  }

  const mergedPendingIds = new Set(pendingIds);
  for (const id of queuedIds) {
    mergedPendingIds.add(id);
  }

  await setCache(db, TRACKED_PENDING_CACHE_KEY, JSON.stringify([...mergedPendingIds]));
  return {
    queuedIds,
    totalPending: mergedPendingIds.size,
    baselineMissing: false,
  };
}

export async function prepareTelegramDigestAppendices(
  db: D1Database,
): Promise<PreparedTelegramDigestAppendices> {
  const immediateWrites: TelegramDigestSuccessAction[] = [];
  const postSuccessWrites: TelegramDigestSuccessAction[] = [];
  const appendixSections: string[] = [];
  const metadata: TelegramDigestAppendixMetadata = {
    hasAppendix: false,
    cemeteryDetected: 0,
    trackedDetected: 0,
    preLaunchDetected: 0,
    frozenDetected: 0,
    cemeterySymbols: [],
    trackedSymbols: [],
    preLaunchSymbols: [],
    frozenSymbols: [],
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
        (coin) => !wasDeadStablecoinPreviouslySeen(previousCemeteryKeys, coin),
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
  const [cachedTrackedSnapshot, cachedTrackedPending] = await Promise.all([
    getCache(db, TRACKED_SNAPSHOT_CACHE_KEY),
    getCache(db, TRACKED_PENDING_CACHE_KEY),
  ]);
  const parsedTrackedPending = cachedTrackedPending ? parseSnapshotKeys(cachedTrackedPending.value) : null;
  const pendingTrackedIds = new Set(
    Array.from(parsedTrackedPending ?? [], String).filter((id) => TRACKED_META_BY_ID.has(id)),
  );

  const appendTrackedCoins = (trackedIds: Iterable<string>, seedReason?: string) => {
    const trackedCoins: TrackedStablecoinMeta[] = [];
    const preLaunchCoins: TrackedStablecoinMeta[] = [];

    for (const id of trackedIds) {
      const coin = TRACKED_META_BY_ID.get(id);
      if (!coin || !isTrackedAnnouncementCoin(coin)) continue;
      if (coin.status === "pre-launch") {
        preLaunchCoins.push(coin);
      } else {
        trackedCoins.push(coin);
      }
    }

    if (trackedCoins.length === 0 && preLaunchCoins.length === 0) {
      immediateWrites.push({
        key: TRACKED_SNAPSHOT_CACHE_KEY,
        value: trackedSnapshotPayload,
      });
      if (seedReason) {
        metadata.seededSnapshots.push(seedReason);
      }
      return;
    }

    appendixSections.push(buildTrackedAppendix(trackedCoins, preLaunchCoins));
    metadata.trackedDetected = trackedCoins.length;
    metadata.preLaunchDetected = preLaunchCoins.length;
    metadata.trackedSymbols = trackedCoins.map((coin) => coin.symbol);
    metadata.preLaunchSymbols = preLaunchCoins.map((coin) => coin.symbol);

    postSuccessWrites.push(
      {
        key: TRACKED_SNAPSHOT_CACHE_KEY,
        value: trackedSnapshotPayload,
      },
      {
        key: TRACKED_PENDING_CACHE_KEY,
        value: JSON.stringify([]),
      },
    );

    if (seedReason) {
      metadata.seededSnapshots.push(seedReason);
    }
  };

  if (!cachedTrackedSnapshot) {
    appendTrackedCoins(pendingTrackedIds, "tracked:first-run");
  } else {
    const previousTrackedKeys = parseSnapshotKeys(cachedTrackedSnapshot.value);
    if (!previousTrackedKeys) {
      appendTrackedCoins(pendingTrackedIds, "tracked:invalid-reseeded");
    } else {
      const appendixTrackedIds = new Set(pendingTrackedIds);
      for (const coin of TRACKED_STABLECOINS) {
        if (!isTrackedAnnouncementCoin(coin)) continue;
        if (!previousTrackedKeys.has(coin.id)) {
          appendixTrackedIds.add(coin.id);
        }
      }

      if (appendixTrackedIds.size === 0) {
        if (cachedTrackedSnapshot.value !== trackedSnapshotPayload) {
          immediateWrites.push({
            key: TRACKED_SNAPSHOT_CACHE_KEY,
            value: trackedSnapshotPayload,
          });
        }
      } else {
        appendTrackedCoins(appendixTrackedIds);
      }
    }
  }

  const frozenSnapshotPayload = buildFrozenSnapshotPayload();
  const cachedFrozenSnapshot = await getCache(db, FROZEN_SNAPSHOT_CACHE_KEY);

  if (!cachedFrozenSnapshot) {
    immediateWrites.push({
      key: FROZEN_SNAPSHOT_CACHE_KEY,
      value: frozenSnapshotPayload,
    });
    metadata.seededSnapshots.push("frozen:first-run");
  } else {
    const previousFrozenKeys = parseSnapshotKeys(cachedFrozenSnapshot.value);
    if (!previousFrozenKeys) {
      immediateWrites.push({
        key: FROZEN_SNAPSHOT_CACHE_KEY,
        value: frozenSnapshotPayload,
      });
      metadata.seededSnapshots.push("frozen:invalid-reseeded");
    } else {
      const addedFrozen = diffFrozenIds(FROZEN_IDS, previousFrozenKeys);
      if (addedFrozen.size === 0) {
        if (cachedFrozenSnapshot.value !== frozenSnapshotPayload) {
          immediateWrites.push({
            key: FROZEN_SNAPSHOT_CACHE_KEY,
            value: frozenSnapshotPayload,
          });
        }
      } else {
        appendixSections.push(buildFrozenAppendix(addedFrozen));
        metadata.frozenDetected = addedFrozen.size;
        metadata.frozenSymbols = [...addedFrozen]
          .map((id) => FROZEN_META_BY_ID.get(id)?.symbol)
          .filter((symbol): symbol is string => typeof symbol === "string");

        postSuccessWrites.push({
          key: FROZEN_SNAPSHOT_CACHE_KEY,
          value: frozenSnapshotPayload,
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
    successActions: postSuccessWrites,
    // Appendix snapshot advancement is a post-delivery best-effort commit.
    // The daily digest sender owns retry idempotency through the send marker.
    commitSuccess: async () => {
      await applyCacheWrites(db, postSuccessWrites);
    },
  };
}
