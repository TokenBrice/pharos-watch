import { jsonResponse } from "../lib/api-utils";
import {
  buildFallbackStatusState,
  buildDiscrepancy,
  getDiscrepancyStreak,
  getLatestStatusProbe,
  getStatusStateSnapshot,
  listRecentStatusTransitions,
  STATUS_SYSTEM_FRESHNESS_SEC,
  summarizeStatusPersistenceIssues,
  type StatusPersistenceIssue,
} from "../lib/status-reliability";
import { computeRawStatus } from "../lib/status-evaluation";
import {
  loadStatusRawSnapshot,
  type StatusRawSnapshotLoadResult,
} from "../lib/status/raw-snapshot";
import { loadStatusSupplements } from "./status-supplements";
import { buildDependencyHealth } from "../lib/dependency-health";
import type { StatusResponse, StatusSectionError } from "@shared/types/status";
import type { CloudflareD1StatusBindings } from "../lib/env";
import { runAdminRoute } from "../lib/route-wrappers";

type StatusSnapshotFallbackReason = Exclude<StatusRawSnapshotLoadResult["kind"], "fresh"> | "bypassed";

interface ResolvedRawStatus {
  raw: Awaited<ReturnType<typeof computeRawStatus>>;
  snapshotFallbackReason: StatusSnapshotFallbackReason | null;
  snapshotError?: string;
}

function shouldBypassStatusSnapshot(request?: Request): boolean {
  if (!request) return false;
  try {
    const url = new URL(request.url);
    return url.searchParams.get("refresh") === "live";
  } catch {
    return false;
  }
}

function statusSnapshotSectionError(
  reason: StatusSnapshotFallbackReason | null,
  error?: string,
): StatusSectionError | null {
  if (reason !== "read-error" && reason !== "stale" && reason !== "unreadable") return null;
  const code = reason === "read-error"
    ? "status_snapshot_read_failed"
    : reason === "stale"
      ? "status_snapshot_stale"
      : "status_snapshot_unreadable";
  return {
    code,
    message: error
      ? `Status raw snapshot ${reason}; served live fallback. ${error}`
      : `Status raw snapshot ${reason}; served live fallback.`,
  };
}

async function resolveRawStatusForResponse(
  db: D1Database,
  now: number,
  request?: Request,
): Promise<ResolvedRawStatus> {
  if (shouldBypassStatusSnapshot(request)) {
    return {
      raw: await computeRawStatus(db, now),
      snapshotFallbackReason: "bypassed",
    };
  }

  const snapshot = await loadStatusRawSnapshot(db, now);
  if (snapshot.kind === "fresh") {
    return {
      raw: snapshot.raw,
      snapshotFallbackReason: null,
    };
  }

  return {
    raw: await computeRawStatus(db, now),
    snapshotFallbackReason: snapshot.kind,
    snapshotError: snapshot.error,
  };
}

export function handleStatus(
  db: D1Database,
  trustedAdmin?: boolean,
  request?: Request,
  coingeckoApiKey?: string | null,
  cloudflareD1StatusBindings?: CloudflareD1StatusBindings,
): Promise<Response> {
  return runAdminRoute(
    {
      endpoint: "status",
      request,
      trustedAdmin,
    },
    async () => {
      const now = Math.floor(Date.now() / 1000);
      const {
        raw,
        snapshotFallbackReason,
        snapshotError,
      } = await resolveRawStatusForResponse(db, now, request);
      const persistenceIssues: StatusPersistenceIssue[] = [];
      const collectPersistenceIssue = (issue: StatusPersistenceIssue) => {
        persistenceIssues.push(issue);
      };

      const { state, staleness } = await getStatusStateSnapshot(db, now, collectPersistenceIssue);
      // Intentionally read-only: the cron (status-self-check, */15 min) is the
      // sole writer. If the snapshot is stale or absent, we return it as-is
      // with `staleness.isStale` reflecting the lag. This removes the prior
      // race with the cron's own reconcile call. First-boot with empty table
      // returns a fallback state but does NOT persist — the next cron seeds.
      const resolvedState = state ?? buildFallbackStatusState(raw.rawOverallStatus, now);
      // Distinguish three cases:
      //  1. staleness present → use it (honest age reporting)
      //  2. state absent on cold boot, no persistence issue → isStale: false
      //  3. staleness query itself failed → surface isStale: true so clients
      //     don't trust the fallback as fresh. The specific DB error is also
      //     present in `sectionErrors.statusState`.
      const statusStateReadFailed = persistenceIssues.some((issue) => issue.operation === "read-status-snapshot");
      const resolvedStaleness = staleness ?? {
        ageSeconds: statusStateReadFailed ? STATUS_SYSTEM_FRESHNESS_SEC + 1 : 0,
        maxAgeSec: STATUS_SYSTEM_FRESHNESS_SEC,
        isStale: statusStateReadFailed,
      };

      const effectiveOverallStatus = resolvedState.currentStatus;
      const probeIssues: StatusPersistenceIssue[] = [];
      const discrepancyIssues: StatusPersistenceIssue[] = [];
      const timelineIssues: StatusPersistenceIssue[] = [];
      const [
        probe,
        discrepancyStreak,
        timeline,
        supplements,
      ] = await Promise.all([
        getLatestStatusProbe(db, (issue) => probeIssues.push(issue)),
        getDiscrepancyStreak(db, (issue) => discrepancyIssues.push(issue)),
        listRecentStatusTransitions(db, 40, undefined, (issue) => timelineIssues.push(issue)),
        loadStatusSupplements(
          db,
          now,
          raw.crons,
          coingeckoApiKey,
          cloudflareD1StatusBindings,
        ),
      ]);
      persistenceIssues.push(...probeIssues, ...discrepancyIssues, ...timelineIssues);
      const discrepancy = buildDiscrepancy(effectiveOverallStatus, probe, now, discrepancyStreak);
      const statusStateError = summarizeStatusPersistenceIssues(persistenceIssues);
      const snapshotErrorSection = statusSnapshotSectionError(snapshotFallbackReason, snapshotError);
      let dependencyHealth: StatusResponse["dependencyHealth"] = null;
      let dependencyHealthError: StatusSectionError | null = null;
      try {
        dependencyHealth = buildDependencyHealth({
          now,
          caches: raw.caches,
          crons: raw.crons,
          publicationHealth: supplements.publicationHealth,
        });
      } catch {
        dependencyHealthError = {
          code: "dependency_health_computation_failed",
          message: "Dependency health unavailable.",
        };
      }

      const canarySummary = supplements.canaries
        ? {
            canaryTotalChecks: supplements.canaries.totalChecks,
            canaryErrorCount: supplements.canaries.errorCount,
            canaryDegradedCount: supplements.canaries.degradedCount,
            canarySkippedCount: supplements.canaries.skippedCount,
            canaryStaleCount: supplements.canaries.staleCount,
          }
        : {};

      const body: StatusResponse = {
        timestamp: now,
        dbHealthy: raw.dbHealthy,
        availabilityStatus: raw.availabilityStatus,
        dataQualityStatus: raw.dataQualityStatus,
        rawOverallStatus: raw.rawOverallStatus,
        overallStatus: effectiveOverallStatus,
        confidence: raw.confidence,
        causes: raw.causes,
        state: resolvedState,
        staleness: resolvedStaleness,
        probe,
        discrepancy,
        timeline,
        caches: raw.caches,
        crons: raw.crons,
        budgetOnlySurfaces: raw.budgetOnlySurfaces,
        dataQuality: raw.dataQuality,
        telegramBot: raw.telegramBot,
        sectionErrors: {
          ...raw.sectionErrors,
          ...(statusStateError ? { statusState: statusStateError } : {}),
          ...supplements.sectionErrors,
          ...(snapshotErrorSection ? { statusSnapshot: snapshotErrorSection } : {}),
          ...(dependencyHealthError ? { dependencyHealth: dependencyHealthError } : {}),
        },
        datasetFreshness: raw.datasetFreshness,
        summary: {
          ...raw.summary,
          ...canarySummary,
        },
        reserveComposition: raw.reserveComposition,
        liquidityHealth: supplements.liquidityHealth,
        yieldHealth: supplements.yieldHealth,
        publicationHealth: supplements.publicationHealth,
        dependencyHealth,
        providerCircuitHealth: supplements.providerCircuitHealth,
        canaries: supplements.canaries,
        priceSourceHealth: supplements.priceSourceHealth,
        priceProviderDiagnostics: supplements.priceProviderDiagnostics,
        gtProbe: supplements.gtProbe,
        coingeckoPriceDiff: supplements.coingeckoPriceDiff,
        d1Usage: supplements.d1Usage,
        discoveryCandidates: supplements.discoveryCandidates,
        cacheBlobSizes: supplements.cacheBlobSizes,
        mintBurnReconciliation: supplements.mintBurnReconciliation,
        reserveDrift: supplements.reserveDrift,
        classificationWarnings: supplements.classificationWarnings,
      };

      return jsonResponse(body, { noStore: true });
    },
  );
}
