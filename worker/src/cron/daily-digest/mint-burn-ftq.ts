import { buildFlightToQualityClassificationFromV9Snapshot } from "../../lib/flight-to-quality-classification";
import { loadActiveSafetyScoreSource } from "../../lib/safety-score-active-source";
import type { SafetyScorePublicationIdentity } from "@shared/types/safety-score-publication";

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
  let source: Awaited<ReturnType<typeof loadActiveSafetyScoreSource>>;
  try {
    source = await loadActiveSafetyScoreSource(db);
  } catch {
    return {
      kind: "unavailable",
      safeNet24h: 0,
      riskyNet24h: 0,
      reason: "cache-read-failed",
      safetyScoreIdentity: null,
    };
  }
  if (source.kind === "error") {
    return {
      kind: "unavailable",
      safeNet24h: 0,
      riskyNet24h: 0,
      reason: source.reason,
      safetyScoreIdentity: null,
    };
  }

  const classification = buildFlightToQualityClassificationFromV9Snapshot(
    source.snapshot,
    { expectedIdentity: source.snapshot.safetyScoreIdentity },
  );
  if (classification.kind !== "ok") {
    return {
      kind: "unavailable",
      safeNet24h: 0,
      riskyNet24h: 0,
      reason: classification.reason,
      safetyScoreIdentity: source.snapshot.safetyScoreIdentity,
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
