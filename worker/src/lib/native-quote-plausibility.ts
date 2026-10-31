import { DEPEG_EXTREME_MOVE_BPS } from "@shared/lib/depeg-config";
import { deriveDepegSignal } from "@shared/lib/depeg-signals";
import {
  buildPriceValidationContext,
  isFixedPegContext,
  validatePriceCandidateAgainstReference,
} from "./price-validation";

export type NativeQuoteImplausibilityReason =
  | "native-quote-invalid"
  | "native-quote-above-peg-reference-band"
  | "native-quote-extreme-move";

export interface NativeQuoteImplausibility {
  reason: NativeQuoteImplausibilityReason;
  /** An independent family may corroborate any bounded sample except an invalid one. */
  corroborationCanAdmit: boolean;
}

export interface NativeQuotePlausibilityInput {
  price: number;
  stablecoinId?: string;
  pegCurrency?: string;
  pegType?: string;
}

function implausibility(
  reason: NativeQuoteImplausibilityReason,
  corroborationCanAdmit: boolean,
): NativeQuoteImplausibility {
  return { reason, corroborationCanAdmit };
}

/**
 * The single native-quote plausibility bound for live depeg admission.
 *
 * A native-currency quote is measured against its own par (reference 1). The
 * primary price-validation reference band supplies the upper bound; the shared
 * extreme-move threshold marks a move that needs an independent source family
 * before it can stand as depeg evidence. Callers decide whether such a family
 * corroborated the move; an invalid quote never becomes evidence.
 */
export function classifyNativeQuoteImplausibility(
  input: NativeQuotePlausibilityInput,
): NativeQuoteImplausibility | null {
  if (!Number.isFinite(input.price) || input.price <= 0) {
    return implausibility("native-quote-invalid", false);
  }

  const context = buildPriceValidationContext(input);
  if (!isFixedPegContext(context)) return null;

  const decision = validatePriceCandidateAgainstReference(input.price, context, "primary_authoritative", {
    price: 1,
    type: "fresh",
  });
  if (!decision.accepted) {
    return implausibility("native-quote-above-peg-reference-band", true);
  }

  const signal = deriveDepegSignal(input.price, 1);
  if (signal != null && signal.absRawBps >= DEPEG_EXTREME_MOVE_BPS) {
    return implausibility("native-quote-extreme-move", true);
  }

  return null;
}
