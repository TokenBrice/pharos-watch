import { describe, expect, it } from "vitest";
import {
  priorityBand,
  resolutionModeAction,
  V9_MISSING_DATA_WORK_TYPES,
} from "../../lib/safety-score-v9-missing-data-work-types";
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

  it("fails closed when a reason has no typed curation disposition", () => {
    expect(() => classifyV9CurationWorklistStream("unregistered-reason")).toThrow(
      /Missing agent work-type definition/,
    );
  });

  it("gives every known reason exactly one routed or non-curation disposition", () => {
    const seenReasons = new Set<string>();
    for (const descriptor of Object.values(V9_MISSING_DATA_WORK_TYPES)) {
      expect(Object.keys(descriptor.reasonDispositions).sort()).toEqual([...descriptor.reasonCodes].sort());
      for (const reasonCode of descriptor.reasonCodes) {
        expect(seenReasons.has(reasonCode)).toBe(false);
        seenReasons.add(reasonCode);
        const disposition = descriptor.reasonDispositions[reasonCode];
        expect(disposition).toBeDefined();
        expect(classifyV9CurationWorklistStream(reasonCode)).toBe(
          disposition?.disposition === "routed" ? disposition.stream : null,
        );
      }
    }
  });

  it("uses the registry priority bands including the critical P0 escape hatch", () => {
    expect(priorityBand(false, 999_999_999)).toBe("P1");
    expect(priorityBand(true, 1)).toBe("P0");
  });

  it("derives each non-agent resolution action from the shared mode metadata", () => {
    expect(resolutionModeAction("producer-runtime", "unused")).toBe("implement-or-refresh-producer-capability");
    expect(resolutionModeAction("mixed-curation-and-runtime", "unused")).toBe(
      "reconcile-metadata-then-refresh-producer",
    );
    expect(resolutionModeAction("methodology-capability", "unused")).toBe(
      "define-reviewed-methodology-capability",
    );
    expect(resolutionModeAction("issuer-or-onchain-evidence", "unused")).toBe(
      "obtain-measured-source-evidence-then-curate",
    );
    expect(resolutionModeAction("agent-curation", "contextual-agent-action")).toBe(
      "contextual-agent-action",
    );
  });
});
