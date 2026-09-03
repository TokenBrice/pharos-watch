import { describe, expect, it } from "vitest";
import { classifyV9CurationWorklistStream } from "../generate-safety-score-v9-missing-data-registry";

describe("Safety Score v9 curation worklist routing", () => {
  it("routes reserve refresh work through the typed missing-data registry", () => {
    expect(classifyV9CurationWorklistStream("stale-audited-reserve-composition")).toBe("RESV");
    expect(classifyV9CurationWorklistStream("missing-reserve-composition")).toBe("RESV");
  });

  it("keeps ordinary non-curation reasons silently unmapped", () => {
    expect(classifyV9CurationWorklistStream("bounded-mechanism-review")).toBeNull();
    expect(classifyV9CurationWorklistStream("nonmaterial-bridge-supply-unmatched")).toBeNull();
  });
});
