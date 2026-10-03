import { describe, expect, it } from "vitest";
import {
  V9WrapperFactDispositionSchema,
  type V9ApplicableWrapperLocalFacts,
  type V9WrapperLocalFactKey,
  type V9WrapperRiskAssessment,
} from "../../types/safety-score-v9-wrapper";
import {
  resolveV9WrapperParentLimit,
  type V9WrapperParentLimitInput,
} from "../safety-score-v9/wrapper-risk";

import { createV9FactGapV3 } from "../safety-score-v9/reasons";
import type { V9EvidenceCauseProof } from "../../types/safety-score-v9-causes";
const FACT_KEYS = [
  "contractMutability",
  "custodyEscrow",
  "strategyComplexity",
  "leverage",
  "rehypothecationCorrelation",
  "shareAccountingNavOracle",
  "withdrawalTerms",
  "measuredUnwind",
  "lossAbsorptionEmergencyControls",
] as const satisfies readonly V9WrapperLocalFactKey[];
const DISCOUNTS = { pure: 3, "native-staked": 5, "strategy-vault": 10 } as const;

function facts(
  overrides: Partial<Record<V9WrapperLocalFactKey, V9WrapperRiskAssessment>> = {},
  form: V9ApplicableWrapperLocalFacts["form"] = "pure",
): V9ApplicableWrapperLocalFacts {
  return {
    schemaVersion: 1,
    applicability: "wrapper",
    form,
    formDisposition: "reviewed",
    formSignals: [`wrapper-form:${form}`],
    formEvidenceRefIds: ["registry-review"],
    facts: Object.fromEntries(
      FACT_KEYS.map((factKey) => [
        factKey,
        {
          disposition: "reviewed",
          assessment: overrides[factKey] ?? "none",
          signals: [`reviewed:${factKey}`],
          evidenceRefIds: [`evidence:${factKey}`],
        },
      ]),
    ) as V9ApplicableWrapperLocalFacts["facts"],
    riskTransfer: {
      disposition: "not-applicable",
      mechanism: "none",
      maximumParentLossAbsorptionPoints: 0,
      signals: ["no-documented-parent-loss-absorption-credit"],
      evidenceRefIds: [],
    },
  };
}

function input(overrides: Partial<V9WrapperParentLimitInput> = {}): V9WrapperParentLimitInput {
  return {
    parentScore: 84,
    localFacts: facts(),
    fallbackDiscounts: DISCOUNTS,
    ...overrides,
  };
}

describe("Safety Score v9 wrapper-local risk", () => {
  it("treats a complete pure 1:1 wrapper as pure rather than a vault", () => {
    const result = resolveV9WrapperParentLimit(input());
    expect(result.form).toBe("pure");
    expect(result.factsComplete).toBe(true);
    expect(result.fallbackDiscount).toBe(0);
    expect(result.limit).toBe(84);
  });

  it("uses fixed form discounts only for incomplete local facts", () => {
    const localFacts = facts({}, "strategy-vault");
    localFacts.facts.withdrawalTerms = {
      disposition: "issuer-undisclosed",
      assessment: null,
      signals: ["withdrawal-fees-undisclosed"],
      evidenceRefIds: ["terms-review"],
    };
    const result = resolveV9WrapperParentLimit(input({ localFacts }));
    expect(result.treatment).toBe("fallback-discount");
    expect(result.fallbackDiscount).toBe(10);
    expect(result.appliedDiscount).toBe(10);
    expect(result.limit).toBe(74);
    expect(result.missingFacts).toMatchObject([
      { factClass: "withdrawalTerms", disposition: "issuer-undisclosed" },
    ]);
  });

  it.each(["method-unsupported", "producer-failed", "issuer-undisclosed", "integration-missing", "unresearched", "public-data-uncurated"] as const)(
    "does not convert %s unwind uncertainty into a form haircut",
    (disposition) => {
      const localFacts = facts({ lossAbsorptionEmergencyControls: "high" }, "strategy-vault");
      localFacts.facts.measuredUnwind = {
        disposition, assessment: null, signals: [], evidenceRefIds: [],
      };
      expect(resolveV9WrapperParentLimit(input({ localFacts }))).toMatchObject({
        localRiskDiscount: 2.8, appliedDiscount: 2.8, fallbackDiscount: 0,
        factsComplete: false, limit: 81.2,
      });
    },
  );

  it("prices known local risk without also applying the fallback", () => {
    const result = resolveV9WrapperParentLimit(
      input({
        localFacts: facts({
          contractMutability: "moderate",
          measuredUnwind: "high",
          strategyComplexity: "moderate",
        }),
      }),
    );
    expect(result.factsComplete).toBe(true);
    expect(result.fallbackDiscount).toBe(0);
    expect(result.localRiskDiscount).toBe(4.9);
    expect(result.limit).toBe(79.1);
  });

  it("keeps integration-only unwind evidence out of root-holder loss", () => {
    const localFacts = facts({ shareAccountingNavOracle: "moderate", measuredUnwind: "none" }, "native-staked");
    localFacts.facts.measuredUnwind.incidentPostures = [
      {
        incidentId: "integration-unwind",
        scope: { kind: "integration-only", integrationKey: "external-lending-market" },
        assessment: "high",
        evidenceRefIds: ["integration-postmortem"],
      },
    ];
    const result = resolveV9WrapperParentLimit(input({ localFacts }));
    expect(result.adjustments.find((adjustment) => adjustment.factKey === "measuredUnwind")).toMatchObject({
      assessment: "none",
      discountPoints: 0,
    });
  });

  it("keeps an incomplete complex wrapper materially below a safe parent", () => {
    const localFacts = facts(
      {
        contractMutability: "high",
        strategyComplexity: "critical",
        measuredUnwind: "critical",
        lossAbsorptionEmergencyControls: "high",
      },
      "native-staked",
    );
    localFacts.facts.custodyEscrow = {
      disposition: "issuer-undisclosed",
      assessment: null,
      signals: ["custody-terms-undisclosed"],
      evidenceRefIds: ["custody-review"],
    };
    const result = resolveV9WrapperParentLimit(input({ parentScore: 95, localFacts }));
    expect(result.localRiskDiscount).toBeGreaterThan(10);
    expect(result.limit).toBeLessThan(85);
  });

  it("never exceeds the parent without documented loss absorption", () => {
    const localFacts = facts({ contractMutability: "low" });
    expect(resolveV9WrapperParentLimit(input({ localFacts })).limit).toBeLessThan(84);
    expect(resolveV9WrapperParentLimit(input()).limit).toBe(84);
  });

  it("permits only bounded, reviewed risk-transfer credit", () => {
    const localFacts = facts({ custodyEscrow: "low" });
    localFacts.riskTransfer = {
      disposition: "reviewed",
      mechanism: "first-loss-capital",
      maximumParentLossAbsorptionPoints: 4,
      signals: ["documented-first-loss-capital"],
      evidenceRefIds: ["first-loss-review"],
    };
    const result = resolveV9WrapperParentLimit(input({ localFacts }));
    expect(result.treatment).toBe("documented-risk-transfer");
    expect(result.riskTransfer).toMatchObject({ requestedCredit: 4, appliedCredit: 4 });
    expect(result.limit).toBe(87.8);
  });

  it("saturates documented credit at the remaining score headroom", () => {
    const localFacts = facts();
    localFacts.riskTransfer = {
      ...localFacts.riskTransfer,
      disposition: "reviewed",
      mechanism: "first-loss-capital",
      maximumParentLossAbsorptionPoints: 4,
    };
    expect(resolveV9WrapperParentLimit(input({ parentScore: 99, localFacts }))).toMatchObject({
      limit: 100,
      riskTransfer: { requestedCredit: 4, appliedCredit: 1 },
    });
  });

  it("denies requested credit when a local fact, form, or transfer review is unavailable", () => {
    for (const missing of ["withdrawalTerms", "wrapperForm", "riskTransfer"] as const) {
      const localFacts = facts();
      localFacts.riskTransfer = {
        ...localFacts.riskTransfer,
        disposition: "reviewed",
        mechanism: "first-loss-capital",
        maximumParentLossAbsorptionPoints: 4,
      };
      if (missing === "wrapperForm") localFacts.formDisposition = "producer-failed";
      else if (missing === "riskTransfer") localFacts.riskTransfer.disposition = "producer-failed";
      else localFacts.facts.withdrawalTerms.disposition = "producer-failed";
      expect(resolveV9WrapperParentLimit(input({ localFacts })), missing).toMatchObject({
        factsComplete: false,
        missingFacts: [{ factClass: missing, disposition: "producer-failed" }],
        riskTransfer: { requestedCredit: 0, appliedCredit: 0 },
      });
    }
  });

  it("floors a parent below the local risk discount at zero", () => {
    expect(resolveV9WrapperParentLimit(input({
      parentScore: 1,
      localFacts: facts({ leverage: "critical" }),
    }))).toMatchObject({ limit: 0, localRiskDiscount: 4 });
  });

  it("rejects invalid parent, fallback, and eligible credit values independently", () => {
    for (const invalid of [-1, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveV9WrapperParentLimit(input({ parentScore: invalid }))).toThrow();
      expect(() => resolveV9WrapperParentLimit(input({
        fallbackDiscounts: { ...DISCOUNTS, pure: invalid },
      }))).toThrow();
      const localFacts = facts();
      localFacts.riskTransfer = {
        ...localFacts.riskTransfer,
        disposition: "reviewed",
        mechanism: "first-loss-capital",
        maximumParentLossAbsorptionPoints: invalid,
      };
      expect(() => resolveV9WrapperParentLimit(input({ localFacts }))).toThrow();
    }
  });

  it("cannot improve when its serial parent score falls", () => {
    const localFacts = facts({ measuredUnwind: "moderate" }, "native-staked");
    const higherParent = resolveV9WrapperParentLimit(input({ parentScore: 84, localFacts })).limit;
    const lowerParent = resolveV9WrapperParentLimit(input({ parentScore: 70, localFacts })).limit;
    expect(lowerParent).toBeLessThan(higherParent);
    expect(higherParent - lowerParent).toBe(14);
  });

});

describe("cause-aware wrapper fallback", () => {
  it.each(["pure", "native-staked", "strategy-vault"] as const)(
    "retains the %s form charge for C/U custody and withdrawal gaps but excludes proven A/B", (form) => {
      for (const factKey of ["custodyEscrow", "withdrawalTerms"] as const) {
        for (const cause of ["A", "B", "C", "U"] as const) {
          const localFacts = facts({ contractMutability: "high" }, form);
          localFacts.riskTransfer = {
            disposition: "reviewed", mechanism: "first-loss-capital",
            maximumParentLossAbsorptionPoints: 4, signals: ["documented-first-loss-capital"],
            evidenceRefIds: ["first-loss-review"],
          };
          const id = `${form}:${factKey}:${cause}`;
          const proof: V9EvidenceCauseProof = cause === "A"
            ? { cause, producerState: "integration-missing", sourceId: "wrapper-reader", sourceGenerationId: "captured",
              observedAtSec: 1, rejectionCode: "reader-gap", evidenceRefIds: ["attempt"] }
            : cause === "U" ? { cause, reason: "not-yet-researched", evidenceRefIds: [] }
              : cause === "B" ? { cause, proofOrigin: "typed-review", classificationId: id, reviewedAt: "2026-10-01",
                sources: [{ url: "https://wrapper.example/terms", assertion: "Exact local terms are public." }],
                evidenceRefIds: ["review"], assertion: "required-data-public" }
                : { cause, proofOrigin: "typed-review", classificationId: id, reviewedAt: "2026-10-01",
                  sources: [{ url: "https://wrapper.example/terms", assertion: "Exact local terms were researched." }],
                  evidenceRefIds: ["review"], assertion: "researched-nondisclosure", rationale: "Required local datum absent." };
          const gap = createV9FactGapV3({ gapId: id, responsibility: "unresearched", causeProof: proof,
            reasonCode: "unresolved-control-identity", ownerDomain: "control", policyRuleId: "wrapper-local",
            observationState: "bounded-unknown", path: { kind: "local-component", componentKey: `wrapper-local:${factKey}` },
            message: "Scoped wrapper local uncertainty." });
          localFacts.facts[factKey] = { disposition: V9WrapperFactDispositionSchema.parse(gap.responsibility), assessment: null, signals: [], evidenceRefIds: [],
            status: { applicability: { state: "required", policyRuleId: "wrapper-local", rationale: null, gapId: null },
              observationState: "bounded-unknown", gapIds: [id], evidenceRefIds: [] } };
          const result = resolveV9WrapperParentLimit(input({ parentScore: 58, localFacts, gaps: [gap] }));
          const expectedDiscount = cause === "A" || cause === "B" ? 1.4 : DISCOUNTS[form];
          expect(result.localRiskDiscount).toBe(1.4);
          expect(result.fallbackDiscount).toBe(cause === "A" || cause === "B" ? 0 : DISCOUNTS[form]);
          expect(result.appliedDiscount).toBe(expectedDiscount);
          expect(result.limit).toBe(58 - expectedDiscount);
          expect(result.riskTransfer.appliedCredit).toBe(0);
          expect(result.factsComplete).toBe(false);
          expect(result.missingFacts[0]!.cause).toBe(cause);
          expect(result.adjustments.find((adjustment) => adjustment.factKey === "contractMutability")!.cause).toBeNull();
        }
      }
    },
  );

  it.each(["unresearched", "integration-missing", "producer-failed", "method-unsupported", "public-data-uncurated"] as const)(
    "does not grant withdrawal relief from an unproven %s label", (disposition) => {
      const localFacts = facts({ contractMutability: "high" });
      localFacts.facts.withdrawalTerms = {
        disposition, assessment: null, signals: ["withdrawal-fees-undisclosed"], evidenceRefIds: [],
      };
      expect(resolveV9WrapperParentLimit(input({ parentScore: 58, localFacts }))).toMatchObject({
        fallbackDiscount: 3, localRiskDiscount: 1.4, appliedDiscount: 3, limit: 55,
        missingFacts: [{ factClass: "withdrawalTerms", cause: "U" }],
      });
    },
  );
});
