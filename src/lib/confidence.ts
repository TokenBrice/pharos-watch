import type { PriceConfidence } from "@shared/types";

const CONFIDENCE_CLASSES: Record<PriceConfidence, string> = {
  high: "pharos-confidence-high",
  "single-source": "pharos-confidence-single-source",
  low: "pharos-confidence-low",
  fallback: "pharos-confidence-fallback",
};

/** Returns a CSS class that reduces visual weight for lower-confidence prices. */
export function confidenceClass(confidence: PriceConfidence | null | undefined): string {
  return confidence ? CONFIDENCE_CLASSES[confidence] ?? "" : "";
}
