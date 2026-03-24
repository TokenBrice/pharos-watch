import { buildFlightToQualityClassification } from "../../lib/flight-to-quality-classification";
import { loadReportCardCache } from "../../lib/report-card-cache";

const REPORT_CARD_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export interface DigestMintBurnCoinIntensity {
  id: string;
  net24h: number;
}

export async function computeDigestMintBurnFtqFlows(
  db: D1Database,
  coinIntensities: DigestMintBurnCoinIntensity[],
): Promise<{ safeNet24h: number; riskyNet24h: number }> {
  const reportCardCache = await loadReportCardCache(db, { maxAgeMs: REPORT_CARD_MAX_AGE_MS });
  if (reportCardCache.kind !== "ok") {
    return { safeNet24h: 0, riskyNet24h: 0 };
  }

  const gradeClassification = buildFlightToQualityClassification(reportCardCache.payload);
  let safeNet24h = 0;
  let riskyNet24h = 0;
  for (const coin of coinIntensities) {
    if (gradeClassification.safeIds.has(coin.id)) {
      safeNet24h += coin.net24h;
    } else if (gradeClassification.riskyIds.has(coin.id)) {
      riskyNet24h += coin.net24h;
    }
  }
  return { safeNet24h, riskyNet24h };
}
