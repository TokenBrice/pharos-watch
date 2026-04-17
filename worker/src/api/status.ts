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
import { loadStatusSupplements } from "./status-supplements";
import type { StatusResponse } from "@shared/types/status";
import type { CloudflareD1StatusBindings } from "../lib/env";
import { runAdminRoute } from "../lib/route-wrappers";

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
      const raw = await computeRawStatus(db, now);
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
      const probe = await getLatestStatusProbe(db, collectPersistenceIssue);
      const discrepancyStreak = await getDiscrepancyStreak(db, collectPersistenceIssue);
      const discrepancy = buildDiscrepancy(effectiveOverallStatus, probe, now, discrepancyStreak);
      const timeline = await listRecentStatusTransitions(db, 40, undefined, collectPersistenceIssue);
      const supplements = await loadStatusSupplements(
        db,
        now,
        raw.crons,
        coingeckoApiKey,
        cloudflareD1StatusBindings,
      );
      const statusStateError = summarizeStatusPersistenceIssues(persistenceIssues);

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
        dataQuality: raw.dataQuality,
        telegramBot: raw.telegramBot,
        sectionErrors: {
          ...raw.sectionErrors,
          ...(statusStateError ? { statusState: statusStateError } : {}),
          ...supplements.sectionErrors,
        },
        datasetFreshness: raw.datasetFreshness,
        summary: raw.summary,
        reserveComposition: raw.reserveComposition,
        liquidityHealth: supplements.liquidityHealth,
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
