import { describe, expect, it } from "vitest";
import type {
  V9ApplicableWrapperLocalFacts,
  V9WrapperLocalFactKey,
  V9WrapperRiskAssessment,
} from "../../types/safety-score-v9-wrapper";
import {
  resolveV9WrapperParentLimit,
  type V9WrapperParentLimitInput,
} from "../safety-score-v9/wrapper-risk";

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
    expect(result.missingFacts).toEqual([
      { factClass: "withdrawalTerms", disposition: "issuer-undisclosed" },
    ]);
  });

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

  it("cannot improve when its serial parent score falls", () => {
    const localFacts = facts({ measuredUnwind: "moderate" }, "native-staked");
    const higherParent = resolveV9WrapperParentLimit(input({ parentScore: 84, localFacts })).limit;
    const lowerParent = resolveV9WrapperParentLimit(input({ parentScore: 70, localFacts })).limit;
    expect(lowerParent).toBeLessThan(higherParent);
    expect(higherParent - lowerParent).toBe(14);
  });

  it("keeps production-shaped wM, sDAI, sBOLD, and sUSDai profiles distinct", () => {
    const wm = facts(
      { contractMutability: "high", custodyEscrow: "low", withdrawalTerms: "low" },
      "pure",
    );
    const sdai = facts(
      {
        custodyEscrow: "low",
        strategyComplexity: "low",
        rehypothecationCorrelation: "low",
        shareAccountingNavOracle: "moderate",
        withdrawalTerms: "low",
        measuredUnwind: "high",
      },
      "native-staked",
    );
    const sbold = facts(
      {
        custodyEscrow: "moderate",
        strategyComplexity: "moderate",
        rehypothecationCorrelation: "moderate",
        shareAccountingNavOracle: "moderate",
        withdrawalTerms: "moderate",
        lossAbsorptionEmergencyControls: "moderate",
      },
      "strategy-vault",
    );
    sbold.facts.measuredUnwind = {
      disposition: "producer-failed",
      assessment: null,
      signals: ["measured-unwind-not-produced"],
      evidenceRefIds: ["redemption-terms"],
    };
    const susdai = facts(
      {
        contractMutability: "moderate",
        strategyComplexity: "high",
        shareAccountingNavOracle: "moderate",
        lossAbsorptionEmergencyControls: "high",
      },
      "strategy-vault",
    );
    for (const factKey of ["custodyEscrow", "leverage", "rehypothecationCorrelation", "withdrawalTerms"] as const) {
      susdai.facts[factKey] = {
        disposition: "issuer-undisclosed",
        assessment: null,
        signals: [`undisclosed:${factKey}`],
        evidenceRefIds: [`review:${factKey}`],
      };
    }
    susdai.facts.measuredUnwind = {
      disposition: "producer-failed",
      assessment: null,
      signals: ["measured-unwind-not-produced"],
      evidenceRefIds: ["redemption-terms"],
    };

    const profiles = {
      "wm-m0": resolveV9WrapperParentLimit(input({ parentScore: 90, localFacts: wm })),
      "sdai-sky": resolveV9WrapperParentLimit(input({ parentScore: 81, localFacts: sdai })),
      "sbold-k3-capital": resolveV9WrapperParentLimit(input({ parentScore: 84, localFacts: sbold })),
      "susdai-usd-ai": resolveV9WrapperParentLimit(input({ parentScore: 90, localFacts: susdai })),
    };

    expect(profiles["wm-m0"]).toMatchObject({ form: "pure", factsComplete: true, limit: 88.1 });
    expect(profiles["sdai-sky"]).toMatchObject({ form: "native-staked", factsComplete: true });
    expect(profiles["sbold-k3-capital"]).toMatchObject({
      form: "strategy-vault",
      treatment: "fallback-discount",
      limit: 74,
    });
    expect(profiles["susdai-usd-ai"]).toMatchObject({
      form: "strategy-vault",
      treatment: "fallback-discount",
      limit: 80,
    });
    for (const result of Object.values(profiles)) {
      expect(result.riskTransfer).toMatchObject({
        disposition: "not-applicable",
        mechanism: "none",
        requestedCredit: 0,
        appliedCredit: 0,
      });
    }
  });
});
