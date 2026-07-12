import { describe, expect, it } from "vitest";
import { prioritizeSupplyGapCandidateOrder } from "../supply-gap-reconciliation";

describe("supply-gap reconciliation ordering", () => {
  it("admits blocking zero-supply collapses before the bounded missing-chain tail", () => {
    const candidates = [
      ...Array.from({ length: 15 }, (_, index) => ({
        kind: "missing-chain" as const,
        id: `chain-gap-${index}`,
      })),
      { kind: "zero-supply-collapse" as const, id: "xofm-mento" },
    ];

    const ordered = prioritizeSupplyGapCandidateOrder(candidates);

    expect(ordered[0]).toEqual({ kind: "zero-supply-collapse", id: "xofm-mento" });
    expect(ordered.slice(0, 15).some(({ id }) => id === "xofm-mento")).toBe(true);
  });
});
