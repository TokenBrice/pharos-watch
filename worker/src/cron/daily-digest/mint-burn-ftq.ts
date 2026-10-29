import { buildFlightToQualityClassificationFromV9Snapshot } from "../../lib/flight-to-quality-classification";
import { detectFlightToQualityFromValuedNets, type ValuedNetFlow24h } from "../../lib/mint-burn-scoring";
import { loadActiveSafetyScoreIndex } from "../../lib/safety-score-index";
import type { SafetyScorePublicationIdentity } from "@shared/types/safety-score-publication";

export interface DigestMintBurnCoinNet extends ValuedNetFlow24h {
  id: string;
  /**
   * Whether the published 24h flow window itself is complete. `null` when the
   * publication carries no window evidence (legacy payload).
   */
  window24hComplete: boolean | null;
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
  let source: Awaited<ReturnType<typeof loadActiveSafetyScoreIndex>>;
  try {
    source = await loadActiveSafetyScoreIndex(db);
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
  // A withheld net has two distinct causes. An incomplete 24h flow window means
  // the flow evidence itself is missing, which degrades the run; missing USD
  // valuation is decided below by the bounded detector (or named
  // `valuation-incomplete`). Window completeness is the publication's
  // scan-coverage fact; a publication that does not carry it proves nothing,
  // so the fail-closed degrade stays.
  if (coinNets.some((coin) => coin.knownNetUsd === null && coin.window24hComplete !== true)) {
    return unavailable("flow-window-unavailable", gradeClassification.safetyScoreIdentity);
  }
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
