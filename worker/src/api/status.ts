import { jsonResponse } from "../lib/api-utils";
import {
  buildFallbackStatusState,
  buildDiscrepancy,
  getDiscrepancyStreak,
  getLatestStatusProbe,
  getStatusStateSnapshot,
  listRecentStatusTransitions,
  reconcileStatusState,
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

      let { state, staleness } = await getStatusStateSnapshot(db, now, collectPersistenceIssue);

      if (!state || staleness?.isStale) {
        const seeded = await reconcileStatusState(
          db,
          now,
          raw.rawOverallStatus,
          raw.confidence,
          raw.causes.overall,
          collectPersistenceIssue,
        );
        state = seeded.state;
        staleness = {
          ageSeconds: 0,
          maxAgeSec: STATUS_SYSTEM_FRESHNESS_SEC,
          isStale: false,
        };
      }

      const effectiveOverallStatus = state?.currentStatus ?? raw.rawOverallStatus;
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
        state: state ?? buildFallbackStatusState(raw.rawOverallStatus, now),
        staleness: staleness ?? {
          ageSeconds: 0,
          maxAgeSec: STATUS_SYSTEM_FRESHNESS_SEC,
          isStale: false,
        },
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
