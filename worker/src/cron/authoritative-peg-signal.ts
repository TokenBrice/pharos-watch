import {
  getPegReference,
  normalizePegType,
  type PegRateSource,
} from "@shared/lib/peg-rates";
import { isAuthoritativeDepegPegReference } from "@shared/lib/peg-reference-trust";
import { deriveDepegSignal, type DepegSignal } from "@shared/lib/depeg-signals";

export type AuthoritativePegSignalRejectionReason =
  | "non-authoritative-reference"
  | "invalid-reference"
  | "invalid-price";

export interface PegReferenceEvidence {
  pegType: string | undefined;
  source: PegRateSource | undefined;
  contributorCount: number | undefined;
}

export type AuthoritativePegSignalResult =
  | {
      kind: "signal";
      pegReference: number;
      deviationBps: number;
      signal: DepegSignal;
      evidence: PegReferenceEvidence;
    }
  | {
      kind: "rejected";
      reason: AuthoritativePegSignalRejectionReason;
      evidence: PegReferenceEvidence;
    };

/**
 * Build a depeg signal only when the peg reference carries enough evidence to
 * anchor state mutation or resolver readiness. Incident fingerprint
 * quantization is a separate identity concern and must not be applied here.
 */
export function deriveAuthoritativePegSignal(input: {
  price: number | null | undefined;
  pegCurrency?: string | null;
  pegType?: string | null;
  pegRates: Record<string, number>;
  pegRateSources: Record<string, PegRateSource>;
  pegRateCounts: Record<string, number>;
  commodityOunces?: number;
}): AuthoritativePegSignalResult {
  const pegType = normalizePegType(input.pegType ?? undefined);
  const evidence: PegReferenceEvidence = {
    pegType,
    source: pegType ? input.pegRateSources[pegType] : undefined,
    contributorCount: pegType ? input.pegRateCounts[pegType] : undefined,
  };

  // VAR/OTHER are unreviewed floating pegs: their derived "reference" is a
  // peer median of unrelated coins, not a peg. Measuring a coin against that
  // median can open an event whose deviation is another peer's level (RAI
  // 2026-03-25, 13,603 bps against SILK's quote), so fail closed here.
  if (
    input.pegCurrency === "VAR" || input.pegCurrency === "OTHER" ||
    pegType === "peggedVAR" || pegType === "peggedOTHER"
  ) {
    return { kind: "rejected", reason: "non-authoritative-reference", evidence };
  }

  if (!isAuthoritativeDepegPegReference({
    pegCurrency: input.pegCurrency,
    pegType,
    pegRateSource: evidence.source,
    pegRateContributorCount: evidence.contributorCount,
    pegRateAvailable: pegType != null && Object.prototype.hasOwnProperty.call(input.pegRates, pegType),
  })) {
    return { kind: "rejected", reason: "non-authoritative-reference", evidence };
  }

  const pegReference = getPegReference(pegType, input.pegRates, input.commodityOunces);
  if (pegReference == null || !Number.isFinite(pegReference) || pegReference <= 0) {
    return { kind: "rejected", reason: "invalid-reference", evidence };
  }

  if (input.price == null) {
    return { kind: "rejected", reason: "invalid-price", evidence };
  }

  const signal = deriveDepegSignal(input.price, pegReference);
  if (signal == null) {
    return { kind: "rejected", reason: "invalid-price", evidence };
  }

  return {
    kind: "signal",
    pegReference,
    deviationBps: signal.bps,
    signal,
    evidence,
  };
}
