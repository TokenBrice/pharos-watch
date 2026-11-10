import { describe, expect, it } from "vitest";
import {
  DEPEG_CLOSURE_LABELS,
  getDepegClosureSnapshotLabel,
} from "../depeg";
import type { DepegClosureClassification } from "../../depeg-closure";

const CLOSURE_CLASSES: readonly DepegClosureClassification[] = [
  "open",
  "recovered",
  "legacy_recovered",
  "coverage_lost",
  "superseded",
  "orphan",
  "unknown_closed",
];

describe("depeg closure presentation labels", () => {
  it("owns a base label for every closure classification", () => {
    expect(Object.keys(DEPEG_CLOSURE_LABELS).sort()).toEqual([...CLOSURE_CLASSES].sort());
    for (const closure of CLOSURE_CLASSES) {
      expect(DEPEG_CLOSURE_LABELS[closure].trim().length).toBeGreaterThan(0);
    }
  });

  it("time-qualifies only the two clock-dependent snapshot labels", () => {
    const overrides = {
      open: "Open at capture",
      legacy_recovered: "Legacy recovery",
    } as const;
    for (const closure of CLOSURE_CLASSES) {
      const expected = closure in overrides
        ? overrides[closure as keyof typeof overrides]
        : DEPEG_CLOSURE_LABELS[closure];
      expect(getDepegClosureSnapshotLabel(closure)).toBe(expected);
    }
  });
});
