import { describe, expect, it } from "vitest";
import {
  V9_WRAPPER_LOCAL_FACT_KEYS,
  type V9ApplicableWrapperLocalFacts,
  type V9WrapperForm,
} from "../../types/safety-score-v9-wrapper";
import { resolveV9WrapperParentLimit } from "../safety-score-v9/wrapper-risk";

const DISCOUNTS = { pure: 3, "native-staked": 5, "strategy-vault": 10 } as const;

function facts(form: V9WrapperForm): V9ApplicableWrapperLocalFacts {
  return {
    schemaVersion: 1, applicability: "wrapper", form, formDisposition: "reviewed",
    formSignals: [`wrapper-form:${form}`], formEvidenceRefIds: ["evidence:form"],
    facts: Object.fromEntries(V9_WRAPPER_LOCAL_FACT_KEYS.map((key) => [key, {
      disposition: "reviewed", assessment: "none", signals: [], evidenceRefIds: [`evidence:${key}`],
    }])) as V9ApplicableWrapperLocalFacts["facts"],
  };
}

function limit(parentScore: number, localFacts: V9ApplicableWrapperLocalFacts) {
  return resolveV9WrapperParentLimit({ parentScore, localFacts, formDiscounts: DISCOUNTS });
}

describe("wrapper form parent limits", () => {
  it.each(["pure", "native-staked", "strategy-vault"] as const)("deducts only the %s form cost", (form) => {
    expect(limit(84, facts(form))).toMatchObject({
      form, appliedDiscount: DISCOUNTS[form], limit: 84 - DISCOUNTS[form], factsComplete: true,
    });
  });

  it("keeps local risk evidence diagnostic rather than charging a second sum", () => {
    const local = facts("strategy-vault");
    for (const fact of Object.values(local.facts)) fact.assessment = "critical";
    expect(limit(84, local).limit).toBe(74);
    local.facts.withdrawalTerms = {
      disposition: "issuer-undisclosed", assessment: null, signals: [], evidenceRefIds: [],
    };
    expect(limit(84, local)).toMatchObject({ limit: 74, factsComplete: false });
    expect(limit(84, local).missingFacts).toContainEqual(expect.objectContaining({ factClass: "withdrawalTerms" }));
  });

  it("floors fractional parent ceilings and never exceeds the parent", () => {
    for (const form of ["pure", "native-staked", "strategy-vault"] as const) {
      for (const parent of [0, 2, 25, 40, 49.9, 84, 100]) {
        const result = limit(parent, facts(form));
        expect(result.limit).toBe(Math.max(0, Math.floor(parent - DISCOUNTS[form])));
        expect(result.limit).toBeLessThanOrEqual(parent);
      }
    }
  });

  it("does not lift a weak parent to a mild-risk grade floor", () => {
    expect(limit(40, facts("strategy-vault")).limit).toBe(30);
  });

  it("passes accumulated form limits through nested wrappers", () => {
    const middle = limit(84, facts("strategy-vault"));
    const child = limit(middle.limit, facts("pure"));
    expect(middle.limit).toBe(74);
    expect(child.limit).toBe(71);
  });
});
