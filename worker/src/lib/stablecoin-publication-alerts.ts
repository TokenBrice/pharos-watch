import { sendAlert } from "./alerts";
import { logCronEvent } from "./cron-logger";
import { getCaches, setCacheMany } from "./db-cache";
import type { StablecoinActivePriceCoverage } from "./stablecoin-publication-coverage";

const ALERT_COOLDOWN_SEC = 24 * 60 * 60;
const ALERT_MARKER_PREFIX = "sync-stablecoins:missing-active-price-alert:v1";

export interface StablecoinPriceCoverageAlertResult {
  eligibleCount: number;
  dueCount: number;
  sent: boolean;
  suppressedByCooldown: number;
}

function markerKey(stablecoinId: string): string {
  return `${ALERT_MARKER_PREFIX}:${stablecoinId}`;
}

function formatLastAccepted(observedAt: number | null): string {
  return observedAt == null ? "never" : new Date(observedAt * 1_000).toISOString();
}

export async function alertOnMissingActiveStablecoinPrices(
  db: D1Database,
  coverage: StablecoinActivePriceCoverage,
  alertWebhookUrl?: string | null,
): Promise<StablecoinPriceCoverageAlertResult> {
  const eligible = coverage.missingActiveAssets.filter((asset) => asset.alertEligible);
  if (eligible.length === 0) {
    return { eligibleCount: 0, dueCount: 0, sent: false, suppressedByCooldown: 0 };
  }

  await logCronEvent(db, {
    job: "sync-stablecoins",
    eventType: "active-price-coverage-gap",
    severity: "warning",
    message: `${eligible.length} active stablecoin price gap(s) persisted for at least two generations`,
    metadata: {
      affectedMarketCapUsd: coverage.affectedMarketCapUsd,
      assets: eligible.map((asset) => ({
        id: asset.stablecoinId,
        symbol: asset.symbol,
        streak: asset.consecutiveMissingGenerations,
        reason: asset.rejectionReason,
        lastAcceptedSource: asset.lastAcceptedSource,
        lastAcceptedObservedAt: asset.lastAcceptedObservedAt,
      })),
    },
  });

  const nowSec = Math.floor(Date.now() / 1_000);
  let markers = new Map<string, { updatedAt: number }>();
  try {
    markers = await getCaches(db, eligible.map((asset) => markerKey(asset.stablecoinId)));
  } catch (error) {
    console.warn("[sync-stablecoins] Failed to load active price alert markers:", error);
  }
  const due = eligible.filter((asset) => {
    const marker = markers.get(markerKey(asset.stablecoinId));
    return marker == null || nowSec - marker.updatedAt >= ALERT_COOLDOWN_SEC;
  });
  if (due.length === 0) {
    return {
      eligibleCount: eligible.length,
      dueCount: 0,
      sent: false,
      suppressedByCooldown: eligible.length,
    };
  }

  const sent = await sendAlert(
    alertWebhookUrl,
    "Active stablecoin prices missing",
    due.map((asset) => [
      `${asset.symbol} (${asset.stablecoinId})`,
      `missing generations=${asset.consecutiveMissingGenerations}`,
      `reason=${asset.rejectionReason}`,
      `last accepted source=${asset.lastAcceptedSource ?? "none"}`,
      `last accepted at=${formatLastAccepted(asset.lastAcceptedObservedAt)}`,
    ].join("; ")).join("\n"),
  );

  if (sent) {
    try {
      await setCacheMany(db, due.map((asset) => ({
        key: markerKey(asset.stablecoinId),
        value: JSON.stringify({
          stablecoinId: asset.stablecoinId,
          alertedAt: nowSec,
          consecutiveMissingGenerations: asset.consecutiveMissingGenerations,
        }),
      })));
    } catch (error) {
      console.warn("[sync-stablecoins] Failed to persist active price alert markers:", error);
    }
  }

  return {
    eligibleCount: eligible.length,
    dueCount: due.length,
    sent,
    suppressedByCooldown: eligible.length - due.length,
  };
}
