import { describe, it, expect } from "vitest";
import {
  GOVERNANCE_LABELS,
  GOVERNANCE_LABELS_SHORT,
  BACKING_LABELS,
  BACKING_LABELS_SHORT,
  BACKING_SENTENCE_LABELS,
  BACKING_CHART_FILL_CLASSES,
  PEG_LABELS,
  PEG_LABELS_SHORT,
  GOVERNANCE_BADGE_STYLES,
  BACKING_BADGE_STYLES,
} from "@shared/lib/classification";

// Consumers index the short/sentence/badge/fill maps with keys taken from the
// base taxonomy maps, so a class present in one and missing from another
// renders an undefined label or an unstyled badge. Label wording itself is
// editorial and owned by shared/lib/classification.ts.
describe("classification taxonomy coverage", () => {
  it("covers every governance class in the short and badge maps", () => {
    const governanceClasses = Object.keys(GOVERNANCE_LABELS).sort();

    expect(governanceClasses.length).toBeGreaterThan(0);
    expect(Object.keys(GOVERNANCE_LABELS_SHORT).sort()).toEqual(governanceClasses);
    expect(Object.keys(GOVERNANCE_BADGE_STYLES).sort()).toEqual(governanceClasses);
  });

  it("covers every backing class in the short, sentence and badge maps", () => {
    const backingClasses = Object.keys(BACKING_LABELS).sort();

    expect(backingClasses.length).toBeGreaterThan(0);
    expect(Object.keys(BACKING_LABELS_SHORT).sort()).toEqual(backingClasses);
    expect(Object.keys(BACKING_SENTENCE_LABELS).sort()).toEqual(backingClasses);
    expect(Object.keys(BACKING_BADGE_STYLES).sort()).toEqual(backingClasses);
  });

  it("covers every backing class plus the other bucket in the chart fill map", () => {
    expect(Object.keys(BACKING_CHART_FILL_CLASSES).sort()).toEqual(
      [...Object.keys(BACKING_LABELS), "other"].sort(),
    );
  });

  it("covers every peg in the short peg label map", () => {
    const pegs = Object.keys(PEG_LABELS).sort();

    expect(pegs.length).toBeGreaterThan(0);
    expect(Object.keys(PEG_LABELS_SHORT).sort()).toEqual(pegs);
  });
});
