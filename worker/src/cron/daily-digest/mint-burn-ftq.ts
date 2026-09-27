import { buildFlightToQualityClassificationFromV9Snapshot } from "../../lib/flight-to-quality-classification";
import { detectFlightToQualityFromValuedNets, type ValuedNetFlow24h } from "../../lib/mint-burn-scoring";
import { loadActiveSafetyScoreSource } from "../../lib/safety-score-active-source";
import type { SafetyScorePublicationIdentity } from "@shared/types/safety-score-publication";

export interface DigestMintBurnCoinNet extends ValuedNetFlow24h {
  id: string;
}

export type DigestMintBurnFtqFlows =
  | {
      kind: "ok";
      active: boolean;
      /** Known-valuation sums; exact whenever `active`. */
      safeNet24h: number;
      riskyNet24h: number;
      safetyScoreIdentity: SafetyScorePublicationIdentity;
    }
  | {
      kind: "unavailable";
      active: false;
      safeNet24h: 0;
      riskyNet24h: 0;
      /** Classification failure, or `valuation-incomplete` when missing valuation can alter FTQ. */
      reason: string;
      safetyScoreIdentity: SafetyScorePublicationIdentity | null;
    };

export async function computeDigestMintBurnFtqFlows(
  db: D1Database,
  coinNets: DigestMintBurnCoinNet[],
): Promise<DigestMintBurnFtqFlows> {
  const unavailable = (reason: string, safetyScoreIdentity: SafetyScorePublicationIdentity | null) => ({
    kind: "unavailable" as const,
    active: false as const,
    safeNet24h: 0 as const,
    riskyNet24h: 0 as const,
    reason,
    safetyScoreIdentity,
  });
  let source: Awaited<ReturnType<typeof loadActiveSafetyScoreSource>>;
  try {
    source = await loadActiveSafetyScoreSource(db);
  } catch {
    return unavailable("cache-read-failed", null);
  }
  if (source.kind === "error") return unavailable(source.reason, null);

  const classification = buildFlightToQualityClassificationFromV9Snapshot(
    source.snapshot,
  );
  if (classification.kind !== "ok") {
    return unavailable(classification.reason, source.snapshot.safetyScoreIdentity);
  }
  const gradeClassification = classification.classification;
  const ftq = detectFlightToQualityFromValuedNets({
    safe: coinNets.filter((coin) => gradeClassification.safeIds.has(coin.id)),
    risky: coinNets.filter((coin) => gradeClassification.riskyIds.has(coin.id)),
  });
  if (!ftq) return unavailable("valuation-incomplete", gradeClassification.safetyScoreIdentity);
  return {
    kind: "ok",
    active: ftq.active,
    safeNet24h: ftq.safeNet24h,
    riskyNet24h: ftq.riskyNet24h,
    safetyScoreIdentity: gradeClassification.safetyScoreIdentity,
  };
}
