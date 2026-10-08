import { describe, expect, it } from "vitest";
import {
  priorityBand,
  resolutionModeAction,
  V9_MISSING_DATA_WORK_TYPES,
} from "../../lib/safety-score-v9-missing-data-work-types";
import { classifyV9CurationWorklistStream } from "../generate-safety-score-v9-missing-data-registry";
import { renderCurationWorklist } from "../generate-safety-score-v9-curation-worklist.mjs";

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

  it("renders mixed known, null, missing and zero supplies without false coverage or smallest-asset ordering", () => {
    const supplies = [
      { id: "zero", supply: 0 },
      { id: "unknown-z", supply: null },
      { id: "known", supply: 2_000_000 },
      { id: "unknown-a", supply: undefined },
    ];
    const cards = supplies.map(({ id }) => ({ id, ratingStatus: "rated", grade: "B", score: 75 }));
    const replay = {
      pipeline: {
        candidate: { cards },
        evaluatedSet: {
          assets: supplies.map(({ id, supply }) => ({
            assetId: id,
            ...(supply === undefined ? {} : { stressState: { exitPortfolio: { circulatingUsd: supply } } }),
            scoreInput: {
              pillars: {
                backing: { reasons: [{ code: "missing-reserve-composition", path: "reserve" }] },
                exit: { reasons: [] },
                control: { reasons: [] },
              },
              peg: { reasons: [] },
              dependencyReasons: [],
            },
            backing: { archetype: "fiat-cash", contributions: [] },
          })),
        },
      },
    };
    const registry = {
      summary: { stablecoinCount: 4, warnings: [] },
      stablecoins: supplies.map(({ id }) => ({ assetId: id, missingItems: [] })),
    };
    const markdown = renderCurationWorklist(replay, registry, "capture.json");
    expect(markdown).toContain("2 known (including observed zero), 2 unavailable");
    expect(markdown).toContain("Known-supply subtotal: $2.0M; not a full-cohort total");
    expect(markdown).toContain("Rated share of known supply only: 100.00%; not full-cohort supply coverage");
    expect(markdown).toContain("| RESV-zero | P3 | $0 |");
    expect(markdown).toContain("| RESV-unknown-a | unknown supply | unavailable (missing-captured-supply) |");
    expect(markdown.indexOf("RESV-unknown-a")).toBeLessThan(markdown.indexOf("RESV-unknown-z"));
    expect(markdown.indexOf("RESV-unknown-z")).toBeLessThan(markdown.indexOf("RESV-known"));
    expect(markdown.indexOf("RESV-known")).toBeLessThan(markdown.indexOf("RESV-zero"));
    replay.pipeline.evaluatedSet.assets[2].stressState!.exitPortfolio.circulatingUsd = 0;
    expect(renderCurationWorklist(replay, registry, "capture.json")).toContain(
      "Rated share of known supply only: unavailable (zero known-supply denominator)",
    );
  });
});
