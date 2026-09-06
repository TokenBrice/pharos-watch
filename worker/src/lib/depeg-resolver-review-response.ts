import { summarizeDdrrRows } from "@shared/lib/depeg-resolver-review";
import {
  DDRR_PUBLIC_WARNING,
  DDRR_REVIEWER_VERSION,
  type DdrrResponse,
  type DdrrSummary,
} from "@shared/types/depeg-resolver-review";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { buildDdrMethodologyEnvelope } from "./depeg-resolver-methodology";

/**
 * Published as `_meta.assessmentRowLimit`; retained for response-shape
 * compatibility. `assessmentRowsTruncated` below is likewise a retained
 * public field that is always false since the v2 review rewrite.
 */
const DDRR_ASSESSMENT_ROW_CAP = 20_000;
const DDRR_SNAPSHOT_TTL_SEC = API_FRESHNESS_MAX_AGE_SEC.depegResolverReview;
/** Single source for the incident read cap; imported by the cron. */
export const DDRR_V2_INCIDENT_ROW_CAP = 20_000;
const DDRR_PUBLIC_ROW_CAP = 400;

export function buildEmptyDdrrSummary(): DdrrSummary {
  return summarizeDdrrRows([]);
}

export function buildDdrrResponseEnvelope(input: {
  nowSec: number;
  summary: DdrrSummary;
  rows: DdrrResponse["rows"];
  assessedEventCount: number;
  incidentRowLimit?: number;
  incidentRowsTruncated?: boolean;
  methodologyVersions: string[];
  degradedReasons?: string[];
}): DdrrResponse {
  const publicRows = input.rows.slice(0, DDRR_PUBLIC_ROW_CAP);
  const publicRowsTruncated = input.rows.length > publicRows.length;
  const degradedReasons = input.degradedReasons ?? [];

  return {
    _meta: {
      computedAt: input.nowSec,
      expiresAt: input.nowSec + DDRR_SNAPSHOT_TTL_SEC,
      degraded: degradedReasons.length > 0,
      degradedReason: degradedReasons.length > 0 ? degradedReasons.join(",") : null,
      reviewerVersion: DDRR_REVIEWER_VERSION,
      publicWarning: DDRR_PUBLIC_WARNING,
      assessedEventCount: input.assessedEventCount,
      reviewedEventCount: input.rows.length,
      pendingEventCount:
        input.summary.headline.pendingLockCount +
        input.summary.headline.lockDeferredCount +
        input.summary.headline.publicationRetryPendingCount,
      durationScoredCount: input.summary.headline.durationScoredCount,
      verdictScoredCount: input.summary.headline.recoveryLikelihoodScoredCount,
      assessmentRowLimit: DDRR_ASSESSMENT_ROW_CAP,
      assessmentRowsTruncated: false,
      incidentRowLimit: input.incidentRowLimit ?? DDRR_V2_INCIDENT_ROW_CAP,
      incidentRowsTruncated: input.incidentRowsTruncated ?? false,
      publicRowLimit: DDRR_PUBLIC_ROW_CAP,
      publicRowsTruncated,
      methodologyVersions: input.methodologyVersions,
    },
    summary: input.summary,
    rows: publicRows,
    methodology: buildDdrMethodologyEnvelope(input.nowSec),
  };
}
