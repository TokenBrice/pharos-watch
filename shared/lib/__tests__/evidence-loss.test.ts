import { describe, expect, it } from "vitest";
import { deriveDisposition, isCarryEligible, summarizeEvidenceLossOutcomes } from "@shared/lib/evidence-loss";
import { EvidenceLossOutcomeSchema, OperationalEvidenceLossReasonSchema } from "@shared/types/evidence-loss";
import type { EvidenceLossDisposition, EvidenceLossLeg, EvidenceLossOutcome } from "@shared/types/evidence-loss";

function leg(disposition: EvidenceLossDisposition = "operational", proof: string | null = "proof:primary"): EvidenceLossLeg {
  return { key: "primary", sourceId: "provider", disposition, reason: disposition === "operational" ? "timeout" : "invalid-datum", proof };
}

function outcome(overrides: Partial<EvidenceLossOutcome> = {}): EvidenceLossOutcome {
  return {
    scope: { assetId: "usdc-circle", kind: "route", key: "route:primary" },
    disposition: "operational", reason: "timeout", attemptId: "attempt:1", runId: "run:1",
    generationId: null, sourceId: "provider", observedAtSec: 150,
    legs: [leg()], proof: "proof:attempt:1",
    priorEvidence: { ref: "evidence:original", observedAtSec: 100, expiresAtSec: 200 }, legacy: false,
    ...overrides,
  };
}

describe("evidence loss disposition", () => {
  it("does not mask a semantic primary with a timed-out fallback", () => {
    const legs = [leg("semantic"), { ...leg(), key: "fallback" }];
    expect(deriveDisposition(legs)).toBe("semantic");
    expect(deriveDisposition([...legs].reverse())).toBe("semantic");
    expect(isCarryEligible(outcome({ legs }), 150)).toBe(false);
  });

  it("preserves evidential loss and explicit unknown over operational legs", () => {
    expect(deriveDisposition([leg(), leg("evidential")])).toBe("evidential");
    expect(deriveDisposition([leg(), leg("unknown")])).toBe("unknown");
    expect(deriveDisposition([leg("unknown"), leg("evidential")])).toBe("evidential");
  });

  it("requires proof for every required operational leg", () => {
    expect(deriveDisposition([leg()])).toBe("operational");
    expect(deriveDisposition([leg("operational", null)])).toBe("unknown");
    expect(deriveDisposition([leg(), leg("operational", " ")])).toBe("unknown");
    expect(deriveDisposition([])).toBe("unknown");
    expect(deriveDisposition(null)).toBe("unknown");
    expect(deriveDisposition(undefined)).toBe("unknown");
  });
});

describe("original-clock carry eligibility", () => {
  it("expires at the exact original boundary second without renewing evidence", () => {
    const loss = outcome();
    const original = { ...loss.priorEvidence! };
    expect(isCarryEligible(loss, 199)).toBe(true);
    expect(isCarryEligible(loss, 200)).toBe(false);
    expect(isCarryEligible(loss, 201)).toBe(false);
    expect(loss.priorEvidence).toEqual(original);
  });

  it("requires both outcome proof and prior evidence", () => {
    expect(isCarryEligible(outcome({ proof: null }), 150)).toBe(false);
    expect(isCarryEligible(outcome({ priorEvidence: null }), 150)).toBe(false);
    expect(isCarryEligible(outcome({ legs: [] }), 150)).toBe(false);
    expect(isCarryEligible(outcome({ legs: [leg("operational", null)] }), 150)).toBe(false);
  });

  it.each(["semantic", "evidential", "unknown"] as const)("never carries %s", (disposition) => {
    expect(isCarryEligible(outcome({ disposition }), 150)).toBe(false);
  });

  it("rejects legacy and future/invalid clock inputs", () => {
    expect(isCarryEligible(outcome({ legacy: true, disposition: "unknown" }), 150)).toBe(false);
    expect(isCarryEligible(outcome(), 99)).toBe(false);
    expect(isCarryEligible(outcome(), 150.5)).toBe(false);
    expect(isCarryEligible(outcome(), NaN)).toBe(false);
    expect(isCarryEligible(outcome({ priorEvidence: { ref: "prior", observedAtSec: 100, expiresAtSec: 100 } }), 100)).toBe(false);
  });
});

describe("evidence loss wire contract", () => {
  it("accepts exact scoped attempt identity with either run or generation identity", () => {
    expect(EvidenceLossOutcomeSchema.safeParse(outcome()).success).toBe(true);
    expect(EvidenceLossOutcomeSchema.safeParse(outcome({ runId: null, generationId: "generation:1" })).success).toBe(true);
    expect(EvidenceLossOutcomeSchema.safeParse(outcome({ runId: null })).success).toBe(false);
    expect(EvidenceLossOutcomeSchema.safeParse(outcome({ attemptId: null })).success).toBe(false);
  });

  it("refuses operational labels without complete proof or with adverse legs", () => {
    expect(EvidenceLossOutcomeSchema.safeParse(outcome({ proof: null })).success).toBe(false);
    expect(EvidenceLossOutcomeSchema.safeParse(outcome({ legs: [leg("semantic")] })).success).toBe(false);
    expect(EvidenceLossOutcomeSchema.safeParse(outcome({ legs: [] })).success).toBe(false);
    expect(EvidenceLossOutcomeSchema.safeParse(outcome({ reason: "sync-error" })).success).toBe(false);
  });

  it("represents pre-contract rows explicitly as unknown without manufacturing identity", () => {
    const legacy = outcome({ legacy: true, disposition: "unknown", reason: "legacy-unclassified",
      attemptId: null, runId: null, generationId: null, sourceId: null, observedAtSec: null,
      legs: [], proof: null, priorEvidence: null });
    expect(EvidenceLossOutcomeSchema.safeParse(legacy).success).toBe(true);
    expect(EvidenceLossOutcomeSchema.safeParse({ ...legacy, disposition: "operational" }).success).toBe(false);
    expect(isCarryEligible(legacy, 150)).toBe(false);
  });

  it("rejects invalid original clocks and non-machine reasons", () => {
    expect(EvidenceLossOutcomeSchema.safeParse(outcome({ priorEvidence: { ref: "prior", observedAtSec: 200, expiresAtSec: 200 } })).success).toBe(false);
    expect(EvidenceLossOutcomeSchema.safeParse(outcome({ disposition: "unknown", reason: "provider failed" })).success).toBe(false);
    expect(EvidenceLossOutcomeSchema.safeParse(outcome({ disposition: "unknown", reason: "x".repeat(97) })).success).toBe(false);
    expect(OperationalEvidenceLossReasonSchema.options).toEqual([
      "transport", "timeout", "budget-deferred", "rate-limited", "provider-outage", "credential-missing",
    ]);
  });
});

describe("bounded evidence loss summaries", () => {
  it("counts every disposition and retained reason, exposing omitted outcome counts", () => {
    const summary = summarizeEvidenceLossOutcomes([
      outcome(), outcome({ disposition: "semantic", reason: "invalid-datum" }),
      outcome({ disposition: "evidential", reason: "expired-evidence" }), outcome(),
      outcome({ legacy: true, disposition: "unknown", reason: "legacy-unclassified" }),
    ], 2);
    expect(summary).toEqual({
      total: 5, byDisposition: { operational: 2, semantic: 1, evidential: 1, unknown: 1 },
      byReason: [{ reason: "timeout", count: 2 }, { reason: "invalid-datum", count: 1 }], omittedReasonCount: 2,
    });
  });

  it("bounds reason slots and lengths while retaining total counts", () => {
    const rows = Array.from({ length: 105 }, (_, i) => outcome({ disposition: "unknown", reason: `reason-${i}` }));
    expect(summarizeEvidenceLossOutcomes(rows, 1000).byReason).toHaveLength(100);
    expect(summarizeEvidenceLossOutcomes(rows, 1000).omittedReasonCount).toBe(5);
    expect(summarizeEvidenceLossOutcomes(rows, 0).omittedReasonCount).toBe(105);
    expect(summarizeEvidenceLossOutcomes(rows, NaN).byReason).toHaveLength(20);
    expect(summarizeEvidenceLossOutcomes([outcome({ reason: "x".repeat(97) })]).omittedReasonCount).toBe(1);
    expect(summarizeEvidenceLossOutcomes([]).total).toBe(0);
  });
});
