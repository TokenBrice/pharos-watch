import { findSummaryBudgetViolations, SUMMARY_VERDICT_MAX_WORDS } from "@shared/lib/summary-budget";

/**
 * Words that end in a period without ending the sentence. Single capital
 * letters (initials) are handled separately.
 */
const NON_TERMINAL_ABBREVIATIONS: Record<string, true> = {
  "u.s": true,
  "e.g": true,
  "i.e": true,
  vs: true,
  inc: true,
  ltd: true,
  co: true,
  corp: true,
  no: true,
  st: true,
  dr: true,
  approx: true,
  etc: true,
};

const SENTENCE_BREAK = /([.!?]["')\]]?)\s+(?=[A-Z0-9"“(\[])/g;
const CLAUSE_BREAK = /;\s+| — |: /;

function firstSentence(text: string): string {
  SENTENCE_BREAK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SENTENCE_BREAK.exec(text)) !== null) {
    const end = match.index + match[1]!.length;
    const lastWord = text.slice(0, match.index + 1).split(/\s+/).pop() ?? "";
    const bare = lastWord.replace(/[.!?"')\]]+$/, "").toLowerCase();
    const isInitial = /^[A-Z]\.?$/.test(lastWord);
    if (NON_TERMINAL_ABBREVIATIONS[bare] || isInitial) continue;
    return text.slice(0, end);
  }
  return text;
}

/**
 * The summary-layer verdict carved out of longer authored prose: its first
 * sentence when that sentence fits the verdict budget (<= 25 words, no raw
 * identifiers), else its first clause when that does, else `null` so the caller
 * can fall back to a verdict built from structured fields. The text is never
 * clipped mid-clause: a verdict that cannot be carved cleanly is better
 * replaced than truncated.
 */
export function deriveVerdictLine(text: string, maxWords: number = SUMMARY_VERDICT_MAX_WORDS): string | null {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") return null;

  const sentence = firstSentence(flat);
  if (findSummaryBudgetViolations(sentence, maxWords).length === 0) return sentence;

  const clause = sentence.split(CLAUSE_BREAK)[0]?.replace(/[,:;—\s]+$/, "") ?? "";
  if (clause.split(" ").length < 6) return null;
  const closed = /[.!?]$/.test(clause) ? clause : `${clause}.`;
  return findSummaryBudgetViolations(closed, maxWords).length === 0 ? closed : null;
}
