import { describe, expect, it } from "vitest";
import { countV9EvidenceObligations } from "../../types/safety-score-v9-public-evidence-facts";
import { V9OpenEvidenceSchema } from "../../types/safety-score-v9-open-evidence";
import type { V9EvidenceCauseScope } from "../../types/safety-score-v9-causes";
import type { V9FactGapV3 } from "../../types/safety-score-v9-facts";
import { createV9FactGapV3 } from "../safety-score-v9/reasons";
import {
  V9_RESERVE_RESIDUAL_QUESTION_IDENTITY,
  classifyV9OpenQuestion,
  countV9OpenEvidence,
  createV9OpenEvidenceCounter,
  questionKeyForGap,
  questionKeyForScope,
  residualQuestionKey,
  type V9DocumentationGapClassifier,
  type V9OpenEvidenceAsset,
  type V9OpenEvidenceEvaluatedAsset,
  type V9OpenQuestionFact,
} from "../safety-score-v9/open-questions";

const NEVER_DOCUMENTATION: V9DocumentationGapClassifier = () => null;

function scope(overrides: Partial<V9EvidenceCauseScope> = {}): V9EvidenceCauseScope {
  return {
    pillar: "control",
    componentKey: "economic-control:mint",
    factorKey: null,
    routeKey: null,
    exposureId: null,
    requiredDatum: "economic-control:mint",
    ...overrides,
  };
}

const C_PROOF = {
  cause: "C" as const,
  classificationId: "research:fixture",
  proofOrigin: "typed-review" as const,
  reviewedAt: "2026-10-01",
  assertion: "researched-nondisclosure" as const,
  evidenceRefIds: ["research:fixture"],
  rationale: "The fixture search found no disclosure of this exact required datum.",
  sources: [{
    url: "https://issuer.example/disclosure",
    location: "Disclosure section",
    excerpt: "The required datum is omitted.",
    assertion: "The required datum is not disclosed.",
  }],
};

function gap(args: {
  gapId: string;
  causeScope?: V9EvidenceCauseScope;
  cause?: "U" | "C";
  reviewedAt?: string;
}): V9FactGapV3 {
  return createV9FactGapV3({
    gapId: args.gapId,
    reasonCode: "unresolved-control-identity",
    ownerDomain: "control",
    policyRuleId: "v9.fixture",
    observationState: "missing",
    responsibility: "unresearched",
    path: { kind: "local-component", componentKey: args.causeScope?.componentKey ?? "economic-control:mint" },
    message: "Fixture gap.",
    ...(args.causeScope === undefined ? {} : { causeScope: args.causeScope }),
    ...(args.cause === "C" ? { causeProof: { ...C_PROOF, reviewedAt: args.reviewedAt ?? C_PROOF.reviewedAt } } : {}),
  });
}

function fact(overrides: Partial<V9OpenQuestionFact> & Pick<V9OpenQuestionFact, "code" | "sourceGapId">): V9OpenQuestionFact {
  return {
    critical: false,
    responsibility: "unresearched",
    cause: "U",
    ...overrides,
  };
}

function asset(assetId: string, gaps: readonly V9FactGapV3[], controls?: V9OpenEvidenceAsset["controls"]): V9OpenEvidenceAsset {
  return { assetId, gaps, ...(controls === undefined ? {} : { controls }) };
}

function card(assetId: string, facts: readonly V9OpenQuestionFact[]): V9OpenEvidenceEvaluatedAsset {
  return { assetId, trace: { unresolvedFacts: facts } };
}

describe("question identity", () => {
  it("keeps one route question across producer generations", () => {
    const first = questionKeyForScope("usdc-circle", scope({
      pillar: "exit",
      componentKey: "exit-route",
      routeKey: "redemption:redemption:11111111-1111-4111-8111-111111111111:redemption:usdc-circle:offchain-issuer",
    }));
    const second = questionKeyForScope("usdc-circle", scope({
      pillar: "exit",
      componentKey: "exit-route",
      routeKey: "redemption:redemption:22222222-2222-4222-8222-222222222222:redemption:usdc-circle:offchain-issuer",
    }));
    expect(first).toBe("usdc-circle|route|redemption|redemption:usdc-circle:offchain-issuer");
    expect(second).toBe(first);
    expect(questionKeyForScope("usdc-circle", scope({
      pillar: "exit", componentKey: "exit-route", routeKey: "dex:dex-liquidity-4337:uniswap-v3-usdc",
    }))).toBe("usdc-circle|route|dex|uniswap-v3-usdc");
    // An unrecognized route shape stays exact rather than collapsing lanes.
    expect(questionKeyForScope("usdc-circle", scope({
      pillar: "exit", componentKey: "exit-route", routeKey: "dex:custom:route",
    }))).toBe("usdc-circle|route|dex:custom:route");
  });

  it("dispatches control before deployment exposure", () => {
    const bridge = scope({
      componentKey: "control:bridge-meta:acred-apollo-securitize:6ceb66b9323272b3535f",
      factorKey: "incidentState",
      exposureId: "solana:0xe528f4df568eb9fff6398adc514bc9585fab397f478972bcbebf1e75dee40a88",
      requiredDatum: "incidentState",
    });
    expect(questionKeyForScope("acred-apollo-securitize", bridge))
      .toBe("acred-apollo-securitize|control|control:bridge-meta:acred-apollo-securitize:6ceb66b9323272b3535f");
    // A non-control component keeps its exposure question.
    expect(questionKeyForScope("usdf-falcon", scope({
      pillar: "backing", componentKey: "reserve-exposure", factorKey: "maturity",
      exposureId: "reserve:b09ebd2c39712d16fa442be7", requiredDatum: "maturityDaysMax",
    }))).toBe("usdf-falcon|reserve-exposure|reserve:b09ebd2c39712d16fa442be7");
    expect(questionKeyForScope("usdc-circle", scope({ componentKey: "access:freeze", requiredDatum: "access:freeze" })))
      .toBe("usdc-circle|component|access:freeze");
  });

  it("roots a gap question at the gap's asset and a gapless fact at its code", () => {
    expect(questionKeyForGap(gap({ gapId: "parent-asset:gap:reserve-composition", causeScope: scope({ pillar: "backing", componentKey: "reserve-composition" }) }), "child-asset"))
      .toBe("parent-asset|component|reserve-composition");
    expect(questionKeyForGap(gap({ gapId: "local:reserve-bound:id" }), "usdc-circle"))
      .toBe("usdc-circle|path|unresolved-control-identity");
  });

  it("emits the merged 3f residual identity", () => {
    expect(residualQuestionKey("frax-frax"))
      .toBe(`frax-frax|reserve-exposure|${V9_RESERVE_RESIDUAL_QUESTION_IDENTITY}`);
    expect(V9_RESERVE_RESIDUAL_QUESTION_IDENTITY).toBe("reserve-residual:sub-0.01pct");
  });
});

describe("classifyV9OpenQuestion", () => {
  const gapA = gap({ gapId: "a:gap:one", causeScope: scope() });
  const documentationOnly: V9DocumentationGapClassifier = (value) =>
    value.gapId === "a:gap:one" ? "no-scoring-path" : null;

  it("counts documentation only when every obligation is documentation-classed", () => {
    const documented = { gap: gapA, reasonCode: "unresolved-control-identity" as const, cause: "U" as const, responsibility: "unresearched" as const };
    expect(classifyV9OpenQuestion([documented], documentationOnly)).toBe("documentation");
    // Documentation wins over an issuer cause that is itself documentation.
    expect(classifyV9OpenQuestion([{ ...documented, cause: "C" }], documentationOnly)).toBe("documentation");
  });

  it("moves a partly documented question to issuer, never to documentation", () => {
    const undocumented: V9OpenQuestionFact & { gap: null; reasonCode: "unresolved-control-identity"; cause: "C"; responsibility: "issuer-undisclosed" } = {
      code: "unresolved-control-identity", critical: false, responsibility: "issuer-undisclosed", cause: "C",
      sourceGapId: null, gap: null, reasonCode: "unresolved-control-identity",
    };
    const documented = { gap: gapA, reasonCode: "unresolved-control-identity" as const, cause: "U" as const, responsibility: "unresearched" as const };
    expect(classifyV9OpenQuestion([documented, undocumented as never], documentationOnly)).toBe("issuer");
    expect(classifyV9OpenQuestion([undocumented as never], documentationOnly)).toBe("issuer");
    expect(classifyV9OpenQuestion([{ ...undocumented, cause: "U" } as never], documentationOnly)).toBe("open");
    expect(classifyV9OpenQuestion([], documentationOnly)).toBe("open");
  });
});

function count(input: {
  assets: readonly V9OpenEvidenceAsset[];
  evaluated: readonly V9OpenEvidenceEvaluatedAsset[];
  isDocumentationGap?: V9DocumentationGapClassifier;
}) {
  const block = countV9OpenEvidence({ isDocumentationGap: NEVER_DOCUMENTATION, ...input });
  return { block, parsed: V9OpenEvidenceSchema.parse(block) };
}

describe("countV9OpenEvidence", () => {
  it("partitions the questions and reconciles the same obligations as the card summaries", () => {
    const openGap = gap({ gapId: "alpha:gap:economic-control:mint", causeScope: scope() });
    const issuerGap = gap({ gapId: "beta:gap:reserve-composition", causeScope: scope({ pillar: "backing", componentKey: "reserve-composition", requiredDatum: "reserve-composition" }), cause: "C" });
    const factsByCard = new Map<string, V9OpenQuestionFact[]>([
      ["alpha", [fact({ code: "unresolved-control-identity", sourceGapId: openGap.gapId })]],
      ["beta", [fact({ code: "missing-reserve-composition", sourceGapId: issuerGap.gapId, responsibility: "issuer-undisclosed", cause: "C" })]],
    ]);
    const { block } = count({
      assets: [asset("alpha", [openGap]), asset("beta", [issuerGap])],
      evaluated: [...factsByCard].map(([assetId, facts]) => card(assetId, facts)),
    });
    expect(block.totals).toEqual({ questions: 2, open: 1, issuer: 1, documentation: 0, obligations: 2 });
    expect(block.owners).toEqual([{ responsibility: "unresearched", questions: 1, obligations: 1 }]);
    expect(block.reasons).toEqual([
      { code: "missing-reserve-composition", bucket: "issuer", questions: 1, obligations: 1 },
      { code: "unresolved-control-identity", bucket: "open", questions: 1, obligations: 1 },
    ]);
    const expectedObligations = [...factsByCard.values()].reduce((sum, facts) => sum + countV9EvidenceObligations(
      facts, (row) => row.sourceGapId ?? null, (row) => row.causeGapIds ?? [], (row) => row.critical,
    ).factCount, 0);
    expect(block.totals.obligations).toBe(expectedObligations);
    expect(block.byCard.map((row) => [row.id, row.openBucketQuestionsCarried, row.openBucketObligationsCarried])).toEqual([
      ["alpha", 1, 1], ["beta", 0, 0],
    ]);
  });

  it("counts an inherited obligation once at the parent root", () => {
    const parentGap = gap({ gapId: "parent:gap:reserve-composition", causeScope: scope({ pillar: "backing", componentKey: "reserve-composition", requiredDatum: "reserve-composition" }) });
    const inherited = fact({ code: "missing-reserve-composition", sourceGapId: parentGap.gapId, responsibility: "issuer-undisclosed", cause: "C" });
    const assets = [asset("parent", [parentGap]), asset("child", [])];
    const parentOnly = count({ assets, evaluated: [card("parent", [inherited])] }).block;
    expect(parentOnly.totals).toEqual({ questions: 1, open: 0, issuer: 1, documentation: 0, obligations: 1 });
    expect(parentOnly.issuer.assets).toBe(1);

    const withChild = count({ assets, evaluated: [card("parent", [inherited]), card("child", [inherited])] }).block;
    expect(withChild.totals).toEqual({ questions: 1, open: 0, issuer: 1, documentation: 0, obligations: 2 });
    expect(withChild.issuer.assets).toBe(1);
    expect(withChild.byCard).toEqual([
      { id: "child", openBucketQuestionsCarried: 0, inheritedOpenBucketQuestionsCarried: 0, openBucketObligationsCarried: 0, documentationObligationsCarried: 0 },
      { id: "parent", openBucketQuestionsCarried: 0, inheritedOpenBucketQuestionsCarried: 0, openBucketObligationsCarried: 0, documentationObligationsCarried: 0 },
    ]);

    // Root dedupe is idempotent and order-independent.
    const reversed = count({ assets: [...assets].reverse(), evaluated: [card("child", [inherited]), card("parent", [inherited])] }).block;
    expect(reversed).toEqual(withChild);
  });

  it("flags the child that carries a parent's open question", () => {
    const parentGap = gap({ gapId: "parent:gap:economic-control:oracle", causeScope: scope({ componentKey: "economic-control:oracle", requiredDatum: "economic-control:oracle" }) });
    const carried = fact({ code: "missing-oracle-profile", sourceGapId: parentGap.gapId });
    const block = count({
      assets: [asset("parent", [parentGap])],
      evaluated: [card("child", [carried])],
    }).block;
    expect(block.byCard).toEqual([{
      id: "child", openBucketQuestionsCarried: 1, inheritedOpenBucketQuestionsCarried: 1, openBucketObligationsCarried: 1, documentationObligationsCarried: 0,
    }]);
    expect(block.owners).toEqual([{ responsibility: "unresearched", questions: 1, obligations: 1 }]);
  });

  it("drops a source-less view only when its own root is already a source under that owner", () => {
    const oracleGap = gap({ gapId: "alpha:gap:economic-control:oracle", causeScope: scope({ componentKey: "economic-control:oracle", requiredDatum: "economic-control:oracle" }) });
    const block = count({
      assets: [asset("alpha", [oracleGap])],
      evaluated: [card("alpha", [
        fact({ code: "missing-oracle-profile", sourceGapId: oracleGap.gapId }),
        fact({ code: "missing-oracle-profile", sourceGapId: null, causeGapIds: [oracleGap.gapId] }),
        fact({ code: "missing-oracle-profile", sourceGapId: null, causeGapIds: [] }),
      ])],
    }).block;
    expect(block.totals.obligations).toBe(2);
    expect(block.totals.questions).toBe(2);
    expect(block.reasons).toEqual([
      { code: "missing-oracle-profile", bucket: "open", questions: 2, obligations: 2 },
    ]);
    // The gapless view keeps its own `path|<code>` question.
    expect(block.byCard[0]).toMatchObject({ openBucketQuestionsCarried: 2, inheritedOpenBucketQuestionsCarried: 0 });
  });

  it("excludes measured-adverse facts from questions and from the obligation total", () => {
    const oracleGap = gap({ gapId: "alpha:gap:economic-control:oracle", causeScope: scope({ componentKey: "economic-control:oracle", requiredDatum: "economic-control:oracle" }) });
    const block = count({
      assets: [asset("alpha", [oracleGap])],
      evaluated: [card("alpha", [
        fact({ code: "missing-oracle-profile", sourceGapId: oracleGap.gapId }),
        fact({ code: "correlated-exit-routes", sourceGapId: null, causeGapIds: [], cause: "D", responsibility: "measured-adverse" }),
      ])],
    }).block;
    expect(block.totals).toEqual({ questions: 1, open: 1, issuer: 0, documentation: 0, obligations: 1 });
    expect(block.byCard[0]!.openBucketObligationsCarried).toBe(1);
  });

  it("prefers documentation over issuer and publishes the documentation split", () => {
    const controlGap = gap({ gapId: "alpha:gap:control:mint-a:keyCustody", causeScope: scope({ componentKey: "control:mint-meta:alpha:aaaa", factorKey: "keyCustody", requiredDatum: "keyCustody" }), cause: "C" });
    const otherGap = gap({ gapId: "alpha:gap:economic-control:mint", causeScope: scope() });
    const documentation: V9DocumentationGapClassifier = (value) => value.gapId === controlGap.gapId ? "no-scoring-path" : null;
    const { block } = count({
      assets: [asset("alpha", [controlGap, otherGap])],
      isDocumentationGap: documentation,
      evaluated: [card("alpha", [
        fact({ code: "unresolved-control-identity", sourceGapId: controlGap.gapId, responsibility: "issuer-undisclosed", cause: "C" }),
        fact({ code: "unresolved-control-identity", sourceGapId: otherGap.gapId }),
      ])],
    });
    expect(block.totals).toEqual({ questions: 2, open: 1, issuer: 0, documentation: 1, obligations: 2 });
    expect(block.documentation).toEqual({
      questions: 1, datums: 1, facts: 1, reasons: [{ reason: "no-scoring-path", datums: 1 }],
    });
    expect(block.owners).toEqual([{ responsibility: "unresearched", questions: 1, obligations: 1 }]);
  });

  it("merges reserve-dust documentation into one residual question per root", () => {
    const dustA = gap({ gapId: "frax-frax:gap:reserve:reserve:aaaaaaaa:maturity", causeScope: scope({ pillar: "backing", componentKey: "reserve-exposure", factorKey: "maturity", exposureId: "reserve:aaaaaaaa", requiredDatum: "maturityDaysMax" }) });
    const dustB = gap({ gapId: "frax-frax:gap:reserve:reserve:bbbbbbbb:maturity", causeScope: scope({ pillar: "backing", componentKey: "reserve-exposure", factorKey: "maturity", exposureId: "reserve:bbbbbbbb", requiredDatum: "maturityDaysMax" }) });
    const meaningful = gap({ gapId: "frax-frax:gap:reserve:reserve:cccccccc:maturity", causeScope: scope({ pillar: "backing", componentKey: "reserve-exposure", factorKey: "maturity", exposureId: "reserve:cccccccc", requiredDatum: "maturityDaysMax" }) });
    const documentation: V9DocumentationGapClassifier = (value) =>
      value.gapId === dustA.gapId || value.gapId === dustB.gapId ? "reserve-dust" : null;
    const { block } = count({
      assets: [asset("frax-frax", [dustA, dustB, meaningful])],
      isDocumentationGap: documentation,
      evaluated: [card("frax-frax", [dustA, dustB, meaningful].map((row) =>
        fact({ code: "material-reserve-slice-unstructured", sourceGapId: row.gapId })
      ))],
    });
    expect(block.totals).toEqual({ questions: 2, open: 1, issuer: 0, documentation: 1, obligations: 3 });
    expect(block.documentation).toEqual({
      questions: 1, datums: 2, facts: 2, reasons: [{ reason: "reserve-dust", datums: 2 }],
    });
    expect(block.byCard[0]).toMatchObject({ openBucketQuestionsCarried: 1, openBucketObligationsCarried: 1, documentationObligationsCarried: 2 });
  });

  it("dates the issuer copy only from recorded review proofs", () => {
    const newer = gap({ gapId: "alpha:gap:one", causeScope: scope() , cause: "C", reviewedAt: "2026-10-01" });
    const older = gap({ gapId: "beta:gap:two", causeScope: scope({ componentKey: "economic-control:oracle", requiredDatum: "economic-control:oracle" }), cause: "C", reviewedAt: "2026-09-01" });
    const undated = gap({ gapId: "gamma:gap:three", causeScope: scope({ pillar: "backing", componentKey: "reserve-composition", requiredDatum: "reserve-composition" }) });
    const { block } = count({
      assets: [asset("alpha", [newer]), asset("beta", [older]), asset("gamma", [undated])],
      evaluated: [
        card("alpha", [fact({ code: "unresolved-control-identity", sourceGapId: newer.gapId, responsibility: "issuer-undisclosed", cause: "C" })]),
        card("beta", [fact({ code: "unresolved-control-identity", sourceGapId: older.gapId, responsibility: "issuer-undisclosed", cause: "C" })]),
        // Cause C without a C proof on the gap publishes no date.
        card("gamma", [fact({ code: "missing-reserve-composition", sourceGapId: undated.gapId, responsibility: "issuer-undisclosed", cause: "C" })]),
      ],
    });
    expect(block.issuer).toEqual({
      questions: 3,
      assets: 3,
      oldestReviewedAtSec: Date.parse("2026-09-01") / 1000,
      newestReviewedAtSec: Date.parse("2026-10-01") / 1000,
    });
    expect(block.byCard.find((row) => row.id === "gamma")?.issuerNondisclosureReviewedAtSec).toBeUndefined();
    expect(block.byCard.find((row) => row.id === "beta")?.issuerNondisclosureReviewedAtSec)
      .toBe(Date.parse("2026-09-01") / 1000);
  });

  it("partitions the open bucket across owners and reports the mixed remainder", () => {
    const gapA = gap({ gapId: "alpha:gap:one", causeScope: scope() });
    const gapB = gap({ gapId: "alpha:gap:two", causeScope: scope({ componentKey: "economic-control:oracle", requiredDatum: "economic-control:oracle" }) });
    const gapC = gap({ gapId: "alpha:gap:three", causeScope: scope({ pillar: "backing", componentKey: "reserve-composition", requiredDatum: "reserve-composition" }) });
    const { block } = count({
      assets: [asset("alpha", [gapA, gapB, gapC])],
      evaluated: [card("alpha", [
        // One question (one source gap) carried by two owners is the mixed remainder.
        fact({ code: "unresolved-control-identity", sourceGapId: gapA.gapId, responsibility: "issuer-undisclosed" }),
        fact({ code: "unresolved-control-identity", sourceGapId: gapA.gapId, responsibility: "producer-failed" }),
        fact({ code: "unresolved-control-identity", sourceGapId: gapB.gapId, responsibility: "producer-failed" }),
        fact({ code: "missing-reserve-composition", sourceGapId: gapC.gapId, responsibility: "producer-failed" }),
        fact({ code: "missing-reserve-composition", sourceGapId: null, causeGapIds: [], responsibility: "producer-failed" }),
      ])],
    });
    expect(block.totals.open).toBe(4);
    expect(block.owners).toEqual([
      { responsibility: "producer-failed", questions: 3, obligations: 3 },
      { responsibility: "mixed", questions: 1, obligations: 2 },
    ]);
    expect(block.owners.reduce((sum, row) => sum + row.questions, 0)).toBe(block.totals.open);
  });

  it("seals the streaming counter", () => {
    const counter = createV9OpenEvidenceCounter([], NEVER_DOCUMENTATION);
    counter.add(card("alpha", []));
    expect(() => counter.add(card("alpha", []))).toThrow(/twice/u);
    const finished = counter.finish();
    expect(counter.finish()).toBe(finished);
    expect(() => counter.add(card("beta", []))).toThrow(/sealed/u);
    expect(finished.totals).toEqual({ questions: 0, open: 0, issuer: 0, documentation: 0, obligations: 0 });
    expect(V9OpenEvidenceSchema.parse(finished).byCard).toEqual([]);
  });

  it("is identical when fed per asset instead of in one batch", () => {
    const one = gap({ gapId: "alpha:gap:one", causeScope: scope() });
    const two = gap({ gapId: "beta:gap:two", causeScope: scope({ componentKey: "economic-control:oracle", requiredDatum: "economic-control:oracle" }), cause: "C" });
    const assets = [asset("alpha", [one]), asset("beta", [two])];
    const evaluated = [
      card("alpha", [fact({ code: "unresolved-control-identity", sourceGapId: one.gapId })]),
      card("beta", [fact({ code: "unresolved-control-identity", sourceGapId: two.gapId, responsibility: "issuer-undisclosed", cause: "C" })]),
    ];
    const batch = countV9OpenEvidence({ assets, evaluated, isDocumentationGap: NEVER_DOCUMENTATION });
    const counter = createV9OpenEvidenceCounter(assets, NEVER_DOCUMENTATION);
    for (const row of evaluated) counter.add(row);
    expect(counter.finish()).toEqual(batch);
    expect(V9OpenEvidenceSchema.parse(batch)).toEqual(batch);
    expect(batch.documentation).toEqual({ questions: 0, datums: 0, facts: 0, reasons: [] });
  });

  it("uses the authored bridge control identity when the control fact carries one", () => {
    const controlKey = "bridge-meta:usdc-circle:a0e8ef792b5045c3fb88";
    const bridgeGap = gap({
      gapId: `usdc-circle:gap:control:${controlKey}:incidentState`,
      causeScope: scope({
        componentKey: `control:${controlKey}`, factorKey: "incidentState",
        requiredDatum: "incidentState",
      }),
    });
    const evaluated = [card("usdc-circle", [fact({ code: "unresolved-control-identity", sourceGapId: bridgeGap.gapId })])];
    const authored = count({
      assets: [asset("usdc-circle", [bridgeGap], [{
        controlKey, deploymentKey: "ethereum:0x1111111111111111111111111111111111111111", authoredControlId: "dvn-set",
      }])],
      evaluated,
    }).block;
    expect(questionKeyForGap(bridgeGap, "usdc-circle", "authored:usdc-circle|ethereum:0x1111111111111111111111111111111111111111|dvn-set"))
      .toBe(`usdc-circle|control|authored:usdc-circle|ethereum:0x1111111111111111111111111111111111111111|dvn-set`);
    // The authored token changes the question key only; counts stay identical.
    const digest = count({ assets: [asset("usdc-circle", [bridgeGap])], evaluated }).block;
    expect(authored.totals).toEqual(digest.totals);
    expect(V9OpenEvidenceSchema.parse(authored).totals).toEqual(digest.totals);
  });
});
