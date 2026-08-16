import { describe, expect, it } from "vitest";
import {
  DDR_COVERAGE_LABELS,
  DDR_OUTCOME_LABELS,
  DDR_VERDICT_LABELS,
  ddrSourceEventStateToActualOutcome,
  formatDdrSignedDuration,
  isDdrCorrectVerdict,
  isDdrMissVerdict,
  isDdrScoredVerdict,
} from "../depeg-resolver-review-presentation";

describe("DDR review presentation vocabulary", () => {
  it("owns labels and scoreability for both public review surfaces", () => {
    expect(DDR_VERDICT_LABELS.correct_recoverable).toBe("Correct recoverable");
    expect(DDR_COVERAGE_LABELS.no_call).toBe("no-call");
    expect(DDR_OUTCOME_LABELS.still_open).toBe("still open");
    expect(isDdrScoredVerdict("risk_noted_terminal")).toBe(true);
    expect(isDdrCorrectVerdict("correct_terminal")).toBe(true);
    expect(isDdrMissVerdict("false_recoverable")).toBe(true);
    expect(isDdrScoredVerdict("pending")).toBe(false);
  });

  it("normalizes source outcomes and duration display exhaustively", () => {
    expect(ddrSourceEventStateToActualOutcome("active")).toBe("still_open");
    expect(ddrSourceEventStateToActualOutcome("missing")).toBe("source_missing");
    expect(ddrSourceEventStateToActualOutcome("terminal")).toBe("terminal");
    expect(formatDdrSignedDuration(null)).toBe("N/A");
    expect(formatDdrSignedDuration(61)).toBe("+1m");
    expect(formatDdrSignedDuration(-61)).toBe("−1m");
  });
});
