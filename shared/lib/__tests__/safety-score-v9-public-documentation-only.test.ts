import { describe, expect, it } from "vitest";
import { V9OpenEvidenceSchema, type V9OpenEvidence } from "../../types/safety-score-v9-public";
import type { V9AssetFactsV3, V9DeploymentControlFactV2, V9FactGapV3 } from "../../types/safety-score-v9-facts";
import { createV9FactGapV3 } from "../safety-score-v9/reasons";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import {
  buildV9DocumentationCarriers,
  collectV9DocumentationGapIds,
  type V9DocumentationCarrierCard,
} from "../safety-score-v9/public";
import type { V9DocumentationAssetFacts, V9DocumentationPillarWitness } from "../safety-score-v9/documentation";
import { compileNativeV3FactSet, coreFixture } from "./safety-score-v9-facts.fixture-support";

const compiled = compileNativeV3FactSet(coreFixture());
const baseFacts = compiled.assets.find((asset) => asset.assetId === "alpha") as V9AssetFactsV3;
const baseControl = baseFacts.controls[0]!;
const POLICY = V9_CANDIDATE_POLICY_V1;

function datum(assetId: string, controlKey: string, factorKey: string): V9FactGapV3 {
  const componentKey = `control:${controlKey}`;
  return createV9FactGapV3({
    gapId: `${assetId}:gap:${componentKey}:${factorKey}`,
    reasonCode: "unresolved-control-identity",
    ownerDomain: "control",
    policyRuleId: `${assetId}:${componentKey}:${factorKey}`,
    observationState: "missing",
    path: { kind: "local-component", componentKey },
    message: "Fixture documentation datum.",
    causeProof: { cause: "U", reason: "not-yet-researched", evidenceRefIds: [] },
    causeScope: {
      pillar: "control", componentKey, factorKey, routeKey: null, exposureId: null, requiredDatum: componentKey,
    },
  });
}

function control(controlKey: string, materialSupplyShare: number | null): V9DeploymentControlFactV2 {
  return {
    ...baseControl,
    controlKey,
    deploymentKey: "ethereum",
    scope: "deployment",
    controlKind: "bridge",
    economicLossScope: "deployment",
    claimImpairment: "bounded",
    materialSupplyShare,
  };
}

function assetFacts(assetId: string, controls: V9DeploymentControlFactV2[], gaps: V9FactGapV3[]): V9DocumentationAssetFacts {
  return {
    assetId,
    archetype: baseFacts.archetype,
    controlStatus: baseFacts.controlStatus,
    controls,
    gaps,
    supply: baseFacts.supply,
    economicControlReview: baseFacts.economicControlReview,
    reserveExposures: [],
    exitRoutes: [],
  };
}

function witness(
  pillar: V9DocumentationPillarWitness["pillar"],
  evidenceLevel: V9DocumentationPillarWitness["evidenceLevel"],
  limitingCauseGapIds?: readonly string[],
): V9DocumentationPillarWitness {
  return { pillar, evidenceLevel, ...(limitingCauseGapIds === undefined ? {} : { limitingCauseGapIds }) };
}

function evidence(byCard: V9OpenEvidence["byCard"]): V9OpenEvidence {
  const questions = byCard.reduce((sum, entry) => sum + entry.openBucketQuestionsCarried, 0);
  return {
    semantics: "open-question-v1",
    totals: { questions, open: questions, issuer: 0, documentation: 0, obligations: questions },
    owners: questions === 0 ? [] : [{ responsibility: "unresearched", questions, obligations: questions }],
    reasons: [],
    documentation: { questions: 0, datums: 0, facts: 0, reasons: [] },
    issuer: { questions: 0, assets: 0, oldestReviewedAtSec: null, newestReviewedAtSec: null },
    byCard,
  };
}

function card(id: string, openQuestions: number): V9OpenEvidence["byCard"][number] {
  return {
    id,
    openBucketQuestionsCarried: openQuestions,
    inheritedOpenBucketQuestionsCarried: 0,
    openBucketObligationsCarried: openQuestions,
    documentationObligationsCarried: 0,
  };
}

const smallDatum = datum("alpha", "bridge-meta:small", "incidentState");
const largeDatum = datum("alpha", "bridge-meta:large", "incidentState");
const alpha = assetFacts("alpha", [
  control("bridge-meta:small", 0.005),
  control("bridge-meta:large", 0.02),
], [smallDatum, largeDatum]);
const betaDatum = datum("beta", "bridge-meta:small", "incidentState");
const beta = assetFacts("beta", [control("bridge-meta:small", 0.005)], [betaDatum]);
const gamma = assetFacts("gamma", [], []);

describe("Safety Score v9 documentation carriers", () => {
  it("annotates only documentation-only limited pillars and leaves the rest of the block untouched", () => {
    const gapIds = collectV9DocumentationGapIds(POLICY, [alpha, beta]);
    expect([...gapIds.keys()].sort()).toEqual([smallDatum.gapId, betaDatum.gapId].sort());

    const block = evidence([card("alpha", 1), card("beta", 1), card("gamma", 0)]);
    const cards: V9DocumentationCarrierCard[] = [
      {
        asset: alpha,
        pillars: [
          witness("backing", "strong", [smallDatum.gapId]),
          witness("control", "limited", [smallDatum.gapId]),
          witness("exit", "limited", []),
        ],
      },
      { asset: beta, pillars: [witness("control", "limited", [betaDatum.gapId])] },
      { asset: gamma, pillars: [witness("backing", "limited", [])] },
    ];
    const carriers = buildV9DocumentationCarriers({ envelope: POLICY, gapIds, cards, openEvidence: block });

    expect(carriers.documentationOnlyLimited.get("alpha")).toEqual(["control"]);
    expect(carriers.documentationOnlyLimited.get("beta")).toEqual(["control"]);
    expect(carriers.documentationOnlyLimited.has("gamma")).toBe(false);
    expect(carriers.causeGapIds).toEqual([smallDatum.gapId, betaDatum.gapId].sort());
    expect(carriers.openEvidence.byCard).toEqual([
      { ...block.byCard[0]!, documentationOnlyLimited: ["control"] },
      { ...block.byCard[1]!, documentationOnlyLimited: ["control"] },
      block.byCard[2],
    ]);
    expect(V9OpenEvidenceSchema.safeParse(carriers.openEvidence).success).toBe(true);
    // The source block is never mutated.
    expect(block.byCard[0]!.documentationOnlyLimited).toBeUndefined();
  });

  it("keeps every fail-closed witness shape unlisted", () => {
    const gapIds = collectV9DocumentationGapIds(POLICY, [alpha]);
    const carriers = buildV9DocumentationCarriers({
      envelope: POLICY,
      gapIds,
      cards: [{
        asset: alpha,
        pillars: [
          // One non-documentation witness (0.02 share is at or above the 1% bar).
          witness("backing", "limited", [largeDatum.gapId]),
          // A documentation witness mixed with an id that resolves nowhere.
          witness("control", "limited", [smallDatum.gapId, "alpha:gap:nowhere"]),
          // Non-limited pillar: never annotated even with documentation witnesses.
          witness("exit", "adequate", [smallDatum.gapId]),
          // The arcusdc-galaxy shape: limited without witnesses.
          witness("backing", "limited", []),
          // A witness that resolves to no gap at all.
          witness("exit", "limited", ["unknown:gap:absent"]),
        ],
      }],
      openEvidence: evidence([card("alpha", 1)]),
    });
    expect(carriers.documentationOnlyLimited.size).toBe(0);
    expect(carriers.openEvidence.byCard[0]!.documentationOnlyLimited).toBeUndefined();
    expect(V9OpenEvidenceSchema.safeParse(carriers.openEvidence).success).toBe(true);
  });

  it("resolves an inherited documentation witness through the publication union, not the local asset", () => {
    const gapIds = collectV9DocumentationGapIds(POLICY, [alpha, beta]);
    const carriers = buildV9DocumentationCarriers({
      envelope: POLICY,
      gapIds,
      cards: [{ asset: alpha, pillars: [witness("control", "limited", [betaDatum.gapId])] }],
      openEvidence: evidence([card("alpha", 1)]),
    });
    expect(carriers.documentationOnlyLimited.get("alpha")).toEqual(["control"]);
  });

  it("publishes only the union it was given and still resolves local witnesses on the card", () => {
    const localOnly = buildV9DocumentationCarriers({
      envelope: POLICY,
      gapIds: new Map(),
      cards: [{ asset: alpha, pillars: [witness("control", "limited", [smallDatum.gapId])] }],
      openEvidence: evidence([card("alpha", 1)]),
    });
    expect(localOnly.causeGapIds).toEqual([]);
    expect(localOnly.documentationOnlyLimited.get("alpha")).toEqual(["control"]);

    const undocumented = buildV9DocumentationCarriers({
      envelope: POLICY,
      gapIds: new Map(),
      cards: [{ asset: alpha, pillars: [witness("control", "limited", [largeDatum.gapId])] }],
      openEvidence: evidence([card("alpha", 1)]),
    });
    expect(undocumented.documentationOnlyLimited.size).toBe(0);

    const absent = buildV9DocumentationCarriers({
      envelope: POLICY,
      gapIds: collectV9DocumentationGapIds(POLICY, [alpha]),
      cards: [{ asset: alpha, pillars: [witness("control", "limited", [smallDatum.gapId])] }],
      openEvidence: evidence([]),
    });
    expect(absent.documentationOnlyLimited.get("alpha")).toEqual(["control"]);
    expect(absent.openEvidence.byCard).toEqual([]);
  });
});
