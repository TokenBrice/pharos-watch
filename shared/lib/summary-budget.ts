/**
 * Summary-layer budget for stablecoin detail modules (design-language
 * "Stablecoin Detail Module Contract"). Verdicts and always-visible prose must
 * stay short and free of raw identifiers; reviewer narrative, addresses,
 * block heights, evaluator keys and gate codes belong behind a disclosure.
 */

export const SUMMARY_VERDICT_MAX_WORDS = 25;
export const SUMMARY_PROSE_MAX_WORDS = 40;

const RAW_IDENTIFIER_PATTERNS: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  { id: "hex-address", pattern: /\b0x[0-9a-fA-F]{6,}/ },
  { id: "block-height", pattern: /\bblocks?\s+#?\d[\d,]{4,}/i },
  { id: "raw-seconds", pattern: /\b\d[\d,]*[-\s]seconds?\b/i },
  { id: "gate-code", pattern: /\bD\d{2}(?:-[A-Z])?\b/ },
  { id: "evaluator-key", pattern: /\b(?:chain|bridge-route|bridge-meta|mechanism|reserve|parent):[a-z0-9]/ },
  { id: "version-pin", pattern: /\bv\d+\.\d+\s+(?:campaign\s+)?pin\b/i },
];

export type SummaryBudgetViolation =
  | { kind: "word-count"; words: number; max: number }
  | { kind: "raw-identifier"; id: string; match: string };

export function countSummaryWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

export function findSummaryBudgetViolations(
  text: string,
  maxWords: number = SUMMARY_VERDICT_MAX_WORDS,
): SummaryBudgetViolation[] {
  const violations: SummaryBudgetViolation[] = [];
  const words = countSummaryWords(text);
  if (words > maxWords) violations.push({ kind: "word-count", words, max: maxWords });
  for (const { id, pattern } of RAW_IDENTIFIER_PATTERNS) {
    const match = pattern.exec(text);
    if (match) violations.push({ kind: "raw-identifier", id, match: match[0] });
  }
  return violations;
}
