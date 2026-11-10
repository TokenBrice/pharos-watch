import { startOfUtcDaySec } from "@shared/lib/time-buckets";
import { toErrorMessage } from "@shared/lib/error-utils";
import { runWithOverloadRetry } from "./d1-overload-retry";
import {
  classifyStablecoinPublicationGap,
} from "./stablecoin-publication-coverage";
import { getCompletedSupplySnapshot } from "./supply-snapshot-completion";

const MAX_REPORTED_IDS = 20;
const MAX_ERROR_CHARS = 800;

function boundedText(value: string, maxChars = MAX_ERROR_CHARS): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

function okResult(metadata: Record<string, unknown>) {
  return {
    status: "ok" as const,
    severity: "info" as const,
    executionStatus: "completed" as const,
    executionFailureReason: null,
    metadata,
  };
}

function degradedResult(error: string, metadata: Record<string, unknown>) {
  return {
    status: "degraded" as const,
    severity: "warning" as const,
    executionStatus: "completed" as const,
    executionFailureReason: null,
    error,
    metadata,
  };
}

function errorResult(error: string, metadata: Record<string, unknown>) {
  return {
    status: "error" as const,
    severity: "error" as const,
    executionStatus: "completed" as const,
    executionFailureReason: null,
    error,
    metadata,
  };
}

function failedResult(reason: string, metadata: Record<string, unknown>) {
  return {
    ...errorResult(reason, metadata),
    executionStatus: "failed" as const,
    executionFailureReason: reason,
  };
}

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

/**
 * Daily supply-history completion canary. Compares the persisted rows for the
 * marker's snapshot date with the marker's written-row proof and bands the
 * non-restored active assets whose supply was unavailable. The marker is the
 * generation-scoped evidence; the live stablecoins cache is intentionally not
 * re-read here because a later sync generation may already have recovered
 * (R7: the verdict names what the producer read).
 */
export async function checkSupplyHistoryDailyCoverage(
  db: D1Database,
  observedAt: number,
) {
  try {
    const expectedDate = startOfUtcDaySec(new Date(observedAt * 1000));
    const marker = await getCompletedSupplySnapshot(db);
    if (!marker) {
      return degradedResult("supply-snapshot-marker-missing", {
        expectedDate,
        snapshotDate: null,
        reason: "supply-snapshot-marker-missing",
      });
    }
    const baseMetadata = {
      expectedDate,
      snapshotDate: marker.snapshotDate,
      ageSec: Math.max(0, expectedDate - marker.snapshotDate),
      expectedActiveCount: marker.expectedActiveCount,
      accountedActiveCount: marker.accountedActiveCount,
      writtenRows: marker.ownedRowIds?.length ?? null,
      coverageIdentityVerified: marker.coverageIdentityVerified,
    };
    if (marker.snapshotDate !== expectedDate) {
      return degradedResult(
        `supply snapshot is from ${new Date(marker.snapshotDate * 1000).toISOString().slice(0, 10)}`,
        baseMetadata,
      );
    }

    const row = await runWithOverloadRetry(() =>
      db
        .prepare("SELECT COUNT(*) AS count FROM supply_history WHERE snapshot_date = ?")
        .bind(marker.snapshotDate)
        .first<{ count: number | null }>(),
    );
    if (row?.count == null || !Number.isInteger(row.count) || row.count < 0) {
      return failedResult("supply-history-row-count-unavailable", baseMetadata);
    }
    const metadata = {
      ...baseMetadata,
      persistedRows: row.count,
      unavailableCount: marker.unavailableActiveIds?.length ?? null,
      unavailableActiveIds: marker.unavailableActiveIds?.slice(0, MAX_REPORTED_IDS) ?? null,
      band: marker.unavailableActiveIds != null && marker.expectedActiveCount != null
        ? classifyStablecoinPublicationGap({
            expectedActiveCount: marker.expectedActiveCount,
            missingActiveIds: marker.unavailableActiveIds,
          })
        : null,
    };
    if (metadata.writtenRows != null && row.count < metadata.writtenRows) {
      return errorResult(
        `supply_history has ${row.count} of ${metadata.writtenRows} written rows for the current snapshot`,
        metadata,
      );
    }
    if (marker.unavailableActiveIds == null || marker.expectedActiveCount == null) {
      return degradedResult("supply-snapshot-unavailable-evidence-missing", metadata);
    }
    const share = marker.expectedActiveCount > 0
      ? marker.unavailableActiveIds.length / marker.expectedActiveCount
      : 0;
    if (metadata.band === "systemic") {
      return errorResult(
        `${marker.unavailableActiveIds.length}/${marker.expectedActiveCount} active assets (${formatPercent(share)}) have unavailable supply`,
        metadata,
      );
    }
    if (metadata.band === "elevated") {
      return degradedResult(
        `${marker.unavailableActiveIds.length}/${marker.expectedActiveCount} active assets (${formatPercent(share)}) have unavailable supply`,
        metadata,
      );
    }
    return okResult(metadata);
  } catch (error) {
    return failedResult("canary-source-unavailable", {
      error: boundedText(toErrorMessage(error)),
    });
  }
}
