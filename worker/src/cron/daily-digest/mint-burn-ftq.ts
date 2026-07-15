import { buildFlightToQualityClassificationFromV8Cache } from "../../lib/flight-to-quality-classification";
import { loadReportCardCache } from "../../lib/report-card-cache";
import type { SafetyScorePublicationIdentity } from "@shared/types/safety-score-publication";

const REPORT_CARD_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export interface DigestMintBurnCoinIntensity {
  id: string;
  net24h: number;
}

export type DigestMintBurnFtqFlows =
  | {
      kind: "ok";
      safeNet24h: number;
      riskyNet24h: number;
      safetyScoreIdentity: SafetyScorePublicationIdentity;
    }
  | {
      kind: "unavailable";
      safeNet24h: 0;
      riskyNet24h: 0;
      reason: string;
      safetyScoreIdentity: SafetyScorePublicationIdentity | null;
    };

export async function computeDigestMintBurnFtqFlows(
  db: D1Database,
  coinIntensities: DigestMintBurnCoinIntensity[],
): Promise<DigestMintBurnFtqFlows> {
  let reportCardCache: Awaited<ReturnType<typeof loadReportCardCache>>;
  try {
    reportCardCache = await loadReportCardCache(db, {
      maxAgeMs: REPORT_CARD_MAX_AGE_MS,
      requireCompleteness: true,
    });
  } catch {
    return {
      kind: "unavailable",
      safeNet24h: 0,
      riskyNet24h: 0,
      reason: "cache-read-failed",
      safetyScoreIdentity: null,
    };
  }
  if (reportCardCache.kind !== "ok") {
    return {
      kind: "unavailable",
      safeNet24h: 0,
      riskyNet24h: 0,
      reason: reportCardCache.reason,
      safetyScoreIdentity: null,
    };
  }

  const classification = buildFlightToQualityClassificationFromV8Cache(reportCardCache.payload);
  if (classification.kind !== "ok") {
    return {
      kind: "unavailable",
      safeNet24h: 0,
      riskyNet24h: 0,
      reason: classification.reason,
      safetyScoreIdentity: reportCardCache.payload.safetyScoreIdentity ?? null,
    };
  }
  const gradeClassification = classification.classification;
  let safeNet24h = 0;
  let riskyNet24h = 0;
  for (const coin of coinIntensities) {
    if (gradeClassification.safeIds.has(coin.id)) {
      safeNet24h += coin.net24h;
    } else if (gradeClassification.riskyIds.has(coin.id)) {
      riskyNet24h += coin.net24h;
    }
  }
  return {
    kind: "ok",
    safeNet24h,
    riskyNet24h,
    safetyScoreIdentity: gradeClassification.safetyScoreIdentity,
  };
}
