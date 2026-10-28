import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "../../../types";
import { POR_BADGE_STYLES, POR_NEUTRAL_REPORT_LABEL, getProofOfReservesStyle } from "../badges";

type ProofOfReserves = NonNullable<StablecoinMeta["proofOfReserves"]>;
type AssuranceMethod = NonNullable<ProofOfReserves["latestReport"]>["assuranceMethod"];

const REPORT: NonNullable<ProofOfReserves["latestReport"]> = {
  periodEnd: "2026-09-30",
  publishedAt: "2026-10-26",
  assuranceMethod: "examination",
  scope: "assets-and-liabilities",
  liabilityReconciliation: "full",
  reviewer: "test",
  confidence: "verified",
  sources: [{ label: "Examination report", url: "https://example.com/report" }],
};

function proof(overrides: Partial<ProofOfReserves> = {}): ProofOfReserves {
  return { type: "independent-audit", url: "https://example.com/reserves", ...overrides };
}

describe("getProofOfReservesStyle", () => {
  it("returns null without a proof entry, leaving absence copy to the caller", () => {
    expect(getProofOfReservesStyle(undefined)).toBeNull();
    expect(getProofOfReservesStyle(null)).toBeNull();
  });

  it.each(["examination", "audit"] as const)("names the reviewed %s engagement in the audit-blue tone", (method) => {
    const style = getProofOfReservesStyle(proof({ latestReport: { ...REPORT, assuranceMethod: method } }));
    expect(style?.label).toBe(method === "examination" ? "Examination" : "Audit");
    expect(style?.cls).toContain("bg-blue-500");
  });

  it.each([
    "unknown",
    "review",
    "agreed-upon-procedures",
    "attestation",
    "onchain-proof",
    "self-verification",
  ] as const satisfies readonly AssuranceMethod[])(
    "keeps a reviewed %s method a neutral Independent Report, never audit-blue",
    (method) => {
      const style = getProofOfReservesStyle(proof({ latestReport: { ...REPORT, assuranceMethod: method } }));
      expect(style?.label).toBe("Independent Report");
      expect(style?.cls).not.toContain("bg-blue-500");
      expect(style?.cls).toContain("bg-muted");
    },
  );

  it("treats an absent latest report as a neutral Independent Report", () => {
    const style = getProofOfReservesStyle(proof());
    expect(style?.label).toBe("Independent Report");
    expect(style?.label).not.toMatch(/Audit|Examination/);
    expect(style?.cls).not.toContain("bg-blue-500");
  });

  it("changes only the engagement label, never the proof object", () => {
    const input = proof({ latestReport: { ...REPORT, assuranceMethod: "audit" } });
    const before = structuredClone(input);
    getProofOfReservesStyle(input);
    expect(input).toEqual(before);
  });

  it.each([
    ["agreed-upon-procedures", "Agreed-Upon Procedures"],
    ["attestation", "Independent Attestation"],
    ["real-time", "Real-Time PoR"],
    ["self-reported", "Self-Reported PoR"],
  ] as const)("keeps the existing %s label for non-independent engagements", (type, label) => {
    const style = getProofOfReservesStyle(proof({ type, latestReport: { ...REPORT, assuranceMethod: "audit" } }));
    expect(style).toBe(POR_BADGE_STYLES[type]);
    expect(style?.label).toBe(label);
  });

  it("pins the raw storage-type fallback away from audit wording", () => {
    expect(POR_NEUTRAL_REPORT_LABEL).toBe("Independent Report");
    expect(POR_BADGE_STYLES["independent-audit"].label).toBe(POR_NEUTRAL_REPORT_LABEL);
    expect(POR_BADGE_STYLES["independent-audit"].cls).not.toContain("bg-blue-500");
  });
});
