import {
  DigestChangeSummarySchema,
  DigestForwardLookOutcomeSchema,
  DigestNextTriggerSchema,
  DigestRiskTapeItemSchema,
  DigestStandingConditionSchema,
  type DigestChangeSummary,
  type DigestForwardLookOutcome,
  type DigestNextTrigger,
  type DigestRiskTapeItem,
  type DigestStandingCondition,
} from "@shared/types/digest";
import { isRecord } from "@shared/lib/type-guards";
import type { ZodType } from "zod";

export interface DigestIntelligenceSummary {
  changeSummary: DigestChangeSummary | null;
  nextTriggers: DigestNextTrigger[] | null;
  forwardLookOutcomes: DigestForwardLookOutcome[] | null;
  riskTape: DigestRiskTapeItem[] | null;
  standingConditions: DigestStandingCondition[] | null;
}

// Validate each element against its schema and drop malformed entries so the
// public DigestIntelligenceSummary cannot carry structurally-invalid items.
// Source rows come from a best-effort JSON decode of daily_digest.input_data,
// so legacy/corrupt arrays must not flow through as if well-typed.
function parseArray<T>(input: unknown, schema: ZodType<T>): T[] | null {
  if (!Array.isArray(input)) return null;
  const valid: T[] = [];
  for (const item of input) {
    const result = schema.safeParse(item);
    if (result.success) valid.push(result.data);
  }
  return valid;
}

export function selectDigestIntelligence(input: unknown): DigestIntelligenceSummary {
  if (!isRecord(input)) {
    return {
      changeSummary: null,
      nextTriggers: null,
      forwardLookOutcomes: null,
      riskTape: null,
      standingConditions: null,
    };
  }

  const changeSummary = DigestChangeSummarySchema.safeParse(input.changeSummary);

  return {
    changeSummary: changeSummary.success ? changeSummary.data : null,
    nextTriggers: parseArray(input.nextTriggers, DigestNextTriggerSchema),
    forwardLookOutcomes: parseArray(input.forwardLookOutcomes, DigestForwardLookOutcomeSchema),
    riskTape: parseArray(input.riskTape, DigestRiskTapeItemSchema),
    standingConditions: parseArray(input.standingConditions, DigestStandingConditionSchema),
  };
}
