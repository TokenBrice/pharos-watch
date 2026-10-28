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

  it("keeps the event-page vocabulary unchanged", () => {
    expect(DEPEG_CLOSURE_LABELS.open).toBe("Ongoing");
    expect(DEPEG_CLOSURE_LABELS.recovered).toBe("Recovered");
    expect(DEPEG_CLOSURE_LABELS.legacy_recovered).toBe("Recovered");
    expect(DEPEG_CLOSURE_LABELS.coverage_lost).toBe("Tracking closed: coverage lost");
    expect(DEPEG_CLOSURE_LABELS.superseded).toBe("Tracking closed: direction superseded");
    expect(DEPEG_CLOSURE_LABELS.orphan).toBe("Tracking closed: asset removed");
    expect(DEPEG_CLOSURE_LABELS.unknown_closed).toBe("Tracking closed: recovery unconfirmed");
  });
});
