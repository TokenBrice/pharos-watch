import type {
  DigestChangeSummary,
  DigestForwardLookOutcome,
  DigestNextTrigger,
  DigestRiskTapeItem,
} from "@shared/types/digest";
import { isRecord } from "@shared/lib/type-guards";

export interface DigestIntelligenceSummary {
  changeSummary: DigestChangeSummary | null;
  nextTriggers: DigestNextTrigger[] | null;
  forwardLookOutcomes: DigestForwardLookOutcome[] | null;
  riskTape: DigestRiskTapeItem[] | null;
}

export function selectDigestIntelligence(input: unknown): DigestIntelligenceSummary {
  if (!isRecord(input)) {
    return {
      changeSummary: null,
      nextTriggers: null,
      forwardLookOutcomes: null,
      riskTape: null,
    };
  }

  return {
    // Cast: isRecord runtime check narrows unknown → record but TS can't validate the inner field shape; trusting the runtime contract
    changeSummary: isRecord(input.changeSummary) ? input.changeSummary as unknown as DigestChangeSummary : null,
    nextTriggers: Array.isArray(input.nextTriggers) ? input.nextTriggers as DigestNextTrigger[] : null,
    forwardLookOutcomes: Array.isArray(input.forwardLookOutcomes)
      ? input.forwardLookOutcomes as DigestForwardLookOutcome[]
      : null,
    riskTape: Array.isArray(input.riskTape) ? input.riskTape as DigestRiskTapeItem[] : null,
  };
}
