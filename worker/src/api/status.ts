import { withErrorHandler, jsonResponse } from "../lib/api-utils";
import { withAdmin } from "../lib/auth";
import {
  buildDiscrepancy,
  getDiscrepancyStreak,
  getLatestStatusProbe,
  getStatusStateSnapshot,
  listRecentStatusTransitions,
  reconcileStatusState,
  STATUS_SYSTEM_FRESHNESS_SEC,
  type StatusLevel,
} from "../lib/status-reliability";
import { computeRawStatus } from "../lib/status-evaluation";
import { loadStatusSupplements } from "./status-supplements";
import type { StatusResponse } from "@shared/types";

function fallbackState(rawOverallStatus: StatusLevel, now: number): StatusResponse["state"] {
  return {
    scope: "global",
    currentStatus: rawOverallStatus,
    rawStatus: rawOverallStatus,
    lastEvaluatedAt: now,
    lastChangedAt: now,
    minDwellSec: 120,
    staleMinDwellSec: 180,
    consecutiveRaw: {
      healthy: rawOverallStatus === "healthy" ? 1 : 0,
      degraded: rawOverallStatus === "degraded" ? 1 : 0,
      stale: rawOverallStatus === "stale" ? 1 : 0,
    },
    thresholds: {
      escalateToDegraded: 2,
      escalateToStale: 1,
      recoverToDegraded: 2,
      recoverToHealthy: 3,
    },
  };
}

export const handleStatus = withErrorHandler(
  "status",
  async (db: D1Database, trustedAdmin?: boolean, request?: Request): Promise<Response> => {
    return withAdmin(request, async () => {
      const now = Math.floor(Date.now() / 1000);
      const raw = await computeRawStatus(db, now);

      let { state, staleness } = await getStatusStateSnapshot(db, now);

      if (!state || staleness?.isStale) {
        const seeded = await reconcileStatusState(db, now, raw.rawOverallStatus, raw.confidence, raw.causes.overall);
        state = seeded.state;
        staleness = {
          ageSeconds: 0,
          maxAgeSec: STATUS_SYSTEM_FRESHNESS_SEC,
          isStale: false,
        };
      }

      const effectiveOverallStatus = state?.currentStatus ?? raw.rawOverallStatus;
      const probe = await getLatestStatusProbe(db);
      const discrepancyStreak = await getDiscrepancyStreak(db);
      const discrepancy = buildDiscrepancy(effectiveOverallStatus, probe, now, discrepancyStreak);
      const timeline = await listRecentStatusTransitions(db, 40);
      const supplements = await loadStatusSupplements(db, now, raw.crons);

      const body: StatusResponse = {
        timestamp: now,
        dbHealthy: raw.dbHealthy,
        availabilityStatus: raw.availabilityStatus,
        dataQualityStatus: raw.dataQualityStatus,
        rawOverallStatus: raw.rawOverallStatus,
        overallStatus: effectiveOverallStatus,
        confidence: raw.confidence,
        causes: raw.causes,
        state: state ?? fallbackState(raw.rawOverallStatus, now),
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
          ...supplements.sectionErrors,
        },
        datasetFreshness: raw.datasetFreshness,
        summary: raw.summary,
        reserveComposition: raw.reserveComposition,
        liquidityHealth: supplements.liquidityHealth,
        priceSourceHealth: supplements.priceSourceHealth,
        discoveryCandidates: supplements.discoveryCandidates,
        mintBurnReconciliation: supplements.mintBurnReconciliation,
        reserveDrift: supplements.reserveDrift,
        classificationWarnings: supplements.classificationWarnings,
      };

      return jsonResponse(body, { "Cache-Control": "no-store" });
    }, trustedAdmin);
  },
);
