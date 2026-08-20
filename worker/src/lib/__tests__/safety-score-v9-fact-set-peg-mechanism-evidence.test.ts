/**
 * Split out of the 6,063-line `safety-score-v9-fact-set.test.ts`. Assertions are
 * unchanged; the fixture builders now come from the shared V9 helper, imported
 * under their original local names so the bodies read exactly as before.
 */

import { describe, expect, it } from "vitest";
import { deriveReportCardsBaseInputGenerationId } from "@shared/lib/report-cards-base-input-identity";
import usdtMetaSource from "@shared/data/stablecoins/coins/usdt-tether.json";
import usdtComplianceSource from "@shared/data/stablecoins/domains/compliance/usdt-tether.json";
import usdtMintAuthoritySource from "@shared/data/stablecoins/domains/mint-authority/usdt-tether.json";
import usdtReserveSource from "@shared/data/stablecoins/domains/reserves/usdt-tether.json";
import usdtRiskReviewSource from "@shared/data/stablecoins/domains/risk-review/usdt-tether.json";

function withoutId<T extends { id: string }>({ id: _id, ...fields }: T): Omit<T, "id"> {
  return fields;
}
import { compileV9FactSetV3 } from "@shared/lib/safety-score-v9/compile";
import { V9_ACCESS_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/access-posture";
import { V9_REVIEW_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/evidence";
import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import {
  evaluateV9Exit,
  projectV9ExitEvaluationRoute,
} from "@shared/lib/safety-score-v9/exit";
import {
  V9_CANDIDATE_POLICY_V1,
  resolveV9ReasonPolicy,
} from "@shared/lib/safety-score-v9/policy";
import { createReportCardsFixedInput } from "../report-cards-fixed-input";
import {
  compileSafetyScoreV9FactSetFromFixedInput,
  compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension,
  materializeSafetyScoreV9FactSetExtension,
} from "../safety-score-v9-fact-set";
import {
  buildSafetyScoreV9BaselineExtension,
  type V9ExtensionRegistryMeta,
} from "../safety-score-v9-extension";
import {
  buildSafetyScoreV9RetainedRedemptionRoutes,
  buildSafetyScoreV9RouteReviews,
} from "../safety-score-v9-extension-routes";
import { getSafetyScoreV9OperationalResilienceOverlay } from "../safety-score-v9-extension-operational-resilience";
import { selectSafetyScoreV9CdpShockMeasurement } from "../safety-score-v9-extension-shock";
import type { SafetyScoreV9ReviewedTransferFact } from "../safety-score-v9-extension-transfer";
import {
  V9_FIXTURE_CLOCK_SEC as AS_OF_SEC,
  V9_EVALUATION_TEST_TIMEOUT_MS,
  makeV9FixedInput as exactFixedInput,
  makeV9TwoAssetFixedInput as exactTwoAssetFixedInput,
  makeV9Extension as extension,
  v9NotApplicableStatus as notApplicableStatus,
  makeV9QueuedRedemptionFixedInput as queuedRedemptionFixedInput,
  v9ExitRouteObservation as route,
  v9RouteReview as routeReview,
  v9Status as status,
} from "../../test-helpers/v9-fixed-input";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";

/**
 * Fixture-local clone of the committed uusd-anything-labs registry meta with
 * the mint-authority review date pinned before the pinned mechanism-gate
 * clocks. The two date-gate cases below anchor on the coin's committed
 * 2026-08-08 mechanism overlay; without this pin, every later live
 * mint-authority curation pass (e.g. the 2026-08-15 economic-posture batch)
 * would trip the unrelated future-dated mint-review guard and invalidate the
 * anchor.
 */
function uusdMetaWithPinnedMintReview(): Map<string, V9ExtensionRegistryMeta> {
  const meta = structuredClone(ACTIVE_META_BY_ID.get("uusd-anything-labs")!);
  meta.mintAuthority!.review.reviewedAt = "2026-08-08";
  return new Map([["uusd-anything-labs", meta as V9ExtensionRegistryMeta]]);
}

describe("Safety Score v9 exact base fact-set adapter — peg and mechanism evidence", { timeout: V9_EVALUATION_TEST_TIMEOUT_MS }, () => {
  it("publishes a not-applicable oracle review for a commodity claim", () => {
    // v9.14 regression. A claim on identified metal has no oracle- or
    // liquidation-dependent stabilization path, so it belongs in
    // `ORACLE_FREE_ARCHETYPES` alongside fiat-cash and tbill. Phase 1 could not
    // catch the omission — its guard held zero coins on the archetype — and the
    // migration measurement showed every gold token acquiring a spurious
    // `missing-oracle-profile` gap and a collapsed control pillar.
    // A reviewed mint authority is what makes the economic-control block exist
    // at all; the oracle branch inside it is what this case is about.
    const mintAuthority = {
      mintPath: "issuer-direct-mint",
      authorityPosture: "concentrated-admin",
      confidence: "verified",
      summary: "Prudential issuer fixture.",
      supervision: "prudential",
      review: {
        sources: [{ label: "Supervisor", url: "https://example.com/supervisor" }],
        evidence: "The issuer is prudentially supervised.",
        reviewer: "Fixture reviewer",
        reviewedAt: "1970-01-01",
      },
    };
    const oracleStatus = (archetype: string) =>
      buildSafetyScoreV9BaselineExtension(exactFixedInput(), {
        metaById: new Map([
          ["alpha", { id: "alpha", mechanismArchetype: archetype, launchDate: "2020-01-01", mintAuthority }],
        ]) as never,
      }).assets[0]!.economicControlReview?.oracle.status;

    expect(oracleStatus("commodity-claim")).toMatchObject({
      applicability: {
        state: "not-applicable",
        rationale: expect.stringContaining("no oracle- or liquidation-dependent stabilization path"),
      },
    });
    // A CDP still has to answer the question.
    expect(oracleStatus("cdp")).toMatchObject({ observationState: "missing" });
  });

  it("materializes fuzzy quarter implementation dates at the conservative quarter end", () => {
    const clockSec = Date.parse("2026-07-28T00:00:00Z") / 1_000;
    const fixed = exactFixedInput({ clockSec });
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "alpha",
          {
            id: "alpha",
            mechanismArchetype: "synthetic-delta-neutral",
            implementationLaunchDate: "2024-Q4",
          },
        ],
      ]),
    });

    expect(baseline.assets[0]!.launchedAtSec).toBe(Date.parse("2024-12-31T23:59:59Z") / 1_000);
  });

  it("attributes a same-day mechanism admission wait to the exact policy", () => {
    // Anchored on btcusd-btcfi: its committed cdp mechanism overlay is reviewed
    // 2026-08-08 and it carries no transfer-review overlay row, so the clock can
    // sit inside the overlay's UTC day without tripping the access-review
    // future-dated guard (safety-score-v9-extension-transfer.ts:121). The former
    // ybold-yearn anchor cannot host this case any more: its mechanism overlay is
    // still 2026-07-28 while its transfer review moved to 2026-08-08, so no clock
    // satisfies both gates at once.
    const fixed = exactFixedInput({
      assetId: "btcusd-btcfi",
      clockSec: Date.parse("2026-08-08T09:17:27.000Z") / 1_000,
    });
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "btcusd-btcfi",
          {
            id: "btcusd-btcfi",
            mechanismArchetype: "cdp",
            launchDate: "2025-01-01",
          },
        ],
      ]),
    });
    expect(baseline.assets[0]).toMatchObject({
      mechanismRiskReview: null,
      mechanismReviewGapDisposition: {
        responsibility: "method-unsupported",
        rationale: expect.stringContaining("UTC day has elapsed"),
        componentKeys: expect.arrayContaining(["backstop"]),
      },
    });
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline);
    expect(compiled.assets[0]!.gaps).toContainEqual(
      expect.objectContaining({
        reasonCode: "bounded-mechanism-review",
        responsibility: "method-unsupported",
      }),
    );
  });

  it("attributes a same-day partial mechanism component to the admission method", () => {
    // The clock sits inside the UTC day of the committed uusd-anything-labs
    // overlay review (2026-08-08), so the overlay exists but cannot yet be
    // admitted; the fiat-cash fallback still publishes a partial review.
    const fixed = exactFixedInput({
      assetId: "uusd-anything-labs",
      clockSec: Date.parse("2026-08-08T09:17:27.000Z") / 1_000,
    });
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: uusdMetaWithPinnedMintReview(),
    });
    expect(baseline.assets[0]).toMatchObject({
      mechanismRiskReview: {
        archetype: "fiat-cash",
        assuranceAndReconciliation: {
          status: { observationState: "missing" },
        },
      },
      mechanismReviewGapDisposition: {
        responsibility: "method-unsupported",
        componentKeys: [
          "assuranceAndReconciliation",
          "claimAndSegregation",
          "custodyContinuity",
        ],
      },
    });

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline);
    expect(compiled.assets[0]!.gaps).toContainEqual(
      expect.objectContaining({
        path: {
          kind: "local-component",
          componentKey: "mechanism-review:assuranceAndReconciliation",
        },
        responsibility: "method-unsupported",
      }),
    );
  });

  it("attributes reviewed unavailable mechanism components to issuer nondisclosure after the date gate", () => {
    // One UTC day after the committed 2026-08-08 overlay review, so all three
    // reviewed-unavailable fiat-cash components are admitted as bounded facts.
    const fixed = exactFixedInput({
      assetId: "uusd-anything-labs",
      clockSec: Date.parse("2026-08-09T00:00:00.000Z") / 1_000,
    });
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: uusdMetaWithPinnedMintReview(),
    });
    expect(baseline.assets[0]).not.toHaveProperty("mechanismReviewGapDisposition");

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline);
    for (const componentKey of [
      "assuranceAndReconciliation",
      "claimAndSegregation",
      "custodyContinuity",
    ]) {
      expect(compiled.assets[0]!.gaps).toContainEqual(
        expect.objectContaining({
          path: {
            kind: "local-component",
            componentKey: `mechanism-review:${componentKey}`,
          },
          responsibility: "issuer-undisclosed",
        }),
      );
    }
  });

  it("compiles clock-valid operational-resilience claims with one evidence record per cited source", () => {
    // Inside the committed usdt-tether operational-resilience review window
    // (2026-07-23T12:37:19Z .. 2027-07-23T12:37:19Z) and at or after the
    // reviewed control/access dates the production metadata now carries.
    const clockSec = Date.parse("2026-08-09T00:00:00Z") / 1_000;
    const fixed = exactFixedInput({ assetId: "usdt-tether", clockSec });
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "usdt-tether",
          // The asset is base file + its four domain sidecars; scoring an
          // uncomposed base file would read owned facts as undisclosed.
          {
            ...usdtMetaSource,
            ...withoutId(usdtComplianceSource),
            ...withoutId(usdtMintAuthoritySource),
            ...withoutId(usdtReserveSource),
            ...withoutId(usdtRiskReviewSource),
          } as unknown as V9ExtensionRegistryMeta,
        ],
      ]),
    });
    const overlay = getSafetyScoreV9OperationalResilienceOverlay("usdt-tether", clockSec);
    expect(baseline.assets[0]!.operationalResilience).toEqual(
      overlay,
    );
    expect(overlay).not.toBeNull();

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline);
    const asset = compiled.assets[0]!;
    const operationalEvidence = asset.evidence.filter((evidence) =>
      evidence.evidenceId.startsWith("usdt-tether:operational-resilience:"),
    );
    expect(operationalEvidence).toHaveLength(23);
    expect(new Set(operationalEvidence.map((evidence) => evidence.sourceId))).toEqual(
      new Set(overlay!.sources.map((source) => source.sourceId)),
    );
    expect(asset.operationalResilience).toMatchObject({
      schemaVersion: 1,
      redemptionThroughput: {
        cumulativeLifetimeRedeemedSupplyRatio: null,
        stressWindows: [
          {
            episodeKey: "terra-ust-market-stress-2022-05",
            redeemedSupplyRatioLowerBound: 0.12,
            settlement: { state: "settled-in-full", verification: "issuer-reported" },
            confidence: "issuer-reported",
          },
        ],
      },
      stressEpisodes: [
        {
          episodeKey: "terra-ust-market-stress-2022-05",
          recoveredWithinSec: null,
          confidence: "issuer-reported",
        },
      ],
      reserveReconciliation: {
        reportHistory: {
          firstReportPeriodEnd: "2021-03-31",
          latestReportPeriodEnd: "2026-03-31",
          observedReportHistoryMonths: 60,
          reportedCadence: "quarterly",
          continuityEvidence: "independently-verified",
          missedMaterialPeriods: 0,
          confidence: "independent-assurance",
        },
        latestAssurance: {
          level: "reasonable-assurance",
          confidence: "independent-assurance",
        },
      },
      incidentReview: { state: "not-reviewed" },
    });
    const evaluated = evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!;
    expect(evaluated.operationalResilience?.blockerCodes).toEqual([]);
    expect(evaluated.operationalResilience).toMatchObject({
      eligible: true,
      rawPillarCredits: { backing: 2.55, exit: 1.5, control: 2.55 },
      pillarCredits: { backing: 2.55, exit: 1.5, control: 2.55 },
    });
    expect(
      evaluated.operationalResilience?.contributions.map(
        ({ component, pillar, confidence, confidenceMultiplier, points }) => ({
          component,
          pillar,
          confidence,
          confidenceMultiplier,
          points,
        }),
      ),
    ).toEqual([
      {
        component: "stress-redemption",
        pillar: "exit",
        confidence: "issuer-reported",
        confidenceMultiplier: 0.5,
        points: 1.5,
      },
      {
        component: "reserve-reconciliation",
        pillar: "backing",
        confidence: "independent-assurance",
        confidenceMultiplier: 0.85,
        points: 2.55,
      },
      {
        component: "reserve-reconciliation",
        pillar: "control",
        confidence: "independent-assurance",
        confidenceMultiplier: 0.85,
        points: 2.55,
      },
    ]);
    expect(evaluated.scoreInput.pillars.exit.score).toBe(
      Math.min(100, evaluated.exit.score! + 1.5),
    );
    expect(evaluated.scoreInput.pillars.backing.score).toBe(
      Math.min(100, evaluated.backing.score! + 2.55),
    );
    expect(evaluated.scoreInput.pillars.control.score).toBe(
      Math.min(100, evaluated.control.score! + 2.55),
    );
    expect(evaluated.trace.operationalResilience).toEqual(evaluated.operationalResilience);

    const retainedCore = structuredClone(compiled);
    const removedEvidenceId = operationalEvidence[0]!.evidenceId;
    retainedCore.assets[0]!.evidence = retainedCore.assets[0]!.evidence.filter(
      (evidence) => evidence.evidenceId !== removedEvidenceId,
    );
    const { v9FactSetDigest: _digest, ...core } = retainedCore;
    expect(() => compileV9FactSetV3(core)).toThrow(`Unknown evidence reference ${removedEvidenceId}`);
  });

  it("keeps pre-review operational-resilience captures explicit null", () => {
    const clockSec = Date.parse("2026-07-23T12:37:18Z") / 1_000;
    const fixed = exactFixedInput({ assetId: "usdt-tether", clockSec });
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "usdt-tether",
          {
            id: "usdt-tether",
            mechanismArchetype: "fiat-cash",
            launchDate: "2014-10-06",
          },
        ],
      ]),
    });
    expect(baseline.assets[0]!.operationalResilience).toBeNull();
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline);
    expect(compiled.assets[0]!.operationalResilience).toBeNull();
    expect(
      compiled.assets[0]!.evidence.some((evidence) =>
        evidence.evidenceId.startsWith("usdt-tether:operational-resilience:"),
      ),
    ).toBe(false);

    const futureOverlay = getSafetyScoreV9OperationalResilienceOverlay(
      "usdt-tether",
      Date.parse("2026-07-24T00:00:00Z") / 1_000,
    );
    expect(futureOverlay).not.toBeNull();
    const injected = structuredClone(baseline);
    injected.assets[0]!.operationalResilience = futureOverlay;
    expect(() => compileSafetyScoreV9FactSetFromFixedInput(fixed, injected)).toThrow(
      /outside its exact review window/,
    );
  });

  it("marks pure NAV tokens as reviewed not-applicable for fixed-peg scoring", () => {
    const fixed = exactFixedInput({ omitPegRow: true });
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "alpha",
          {
            id: "alpha",
            mechanismArchetype: "fiat-cash",
            launchDate: "2020-01-01",
            flags: {
              backing: "rwa-backed",
              pegCurrency: "USD",
              governance: "centralized",
              yieldBearing: true,
              rwa: true,
              navToken: true,
            },
          },
        ],
      ]),
    });

    expect(baseline.assets[0]!.pegReference).toEqual({
      referenceKind: "nav",
      referenceKey: "nav:alpha",
      failureDomains: [],
    });
    expect(compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline).assets[0]!.peg).toMatchObject({
      status: { applicability: { state: "not-applicable" }, observationState: "known" },
      referenceKind: "nav",
      referenceKey: "nav:alpha",
      pegScore: null,
    });
  });

  it.each(["VAR", "OTHER"] as const)("publishes an explicit unreviewed reference for %s peg metadata", (pegCurrency) => {
    const fixed = exactFixedInput({ omitPegRow: true });
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "alpha",
          {
            id: "alpha",
            mechanismArchetype: "fiat-cash",
            launchDate: "2020-01-01",
            flags: {
              backing: "rwa-backed",
              pegCurrency,
              governance: "centralized",
              yieldBearing: false,
              rwa: false,
              navToken: false,
            },
          },
        ],
      ]),
    });

    expect(baseline.assets[0]!.pegReference).toEqual({
      referenceKind: "other",
      referenceKey: `unreviewed:${pegCurrency.toLowerCase()}`,
      failureDomains: [],
    });
    expect(compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline).assets[0]!.peg).toMatchObject({
      referenceKind: "other",
      referenceKey: `unreviewed:${pegCurrency.toLowerCase()}`,
    });
  });

  it("keeps reviewed fallback collateral bounded until an exact reserve exposure maps it", () => {
    const fixed = exactTwoAssetFixedInput();
    const dependencyReview = {
      reviewedAt: "1970-01-01",
      reviewer: "Fixture reviewer",
      confidence: "manual-review" as const,
      sources: [{ label: "Fixture dependency analysis", url: "https://example.com/dependencies/alpha" }],
      rationale: "Beta is a reviewed collateral dependency.",
      relationships: [
        {
          id: "beta",
          weight: 0.5,
          type: "collateral" as const,
          reason: "Half of the reviewed backing is Beta.",
        },
      ],
    };
    const metaById = new Map<string, V9ExtensionRegistryMeta>([
      [
        "alpha",
        {
          id: "alpha",
          mechanismArchetype: "fiat-cash" as const,
          launchDate: "1970-01-01",
          dependencies: [{ id: "beta", weight: 0.5, type: "collateral" as const }],
          dependencyReview,
        },
      ],
      [
        "beta",
        {
          id: "beta",
          mechanismArchetype: "fiat-cash" as const,
          launchDate: "1970-01-01",
        },
      ],
    ]);

    const baseline = buildSafetyScoreV9BaselineExtension(fixed, { metaById });
    const alpha = baseline.assets.find((asset) => asset.assetId === "alpha")!;
    expect(alpha.dependencies).toMatchObject({
      source: "manual",
      diagnostics: {
        graphState: "unresolved",
        issueCodes: ["collateral-edge-exposure-unmapped:beta"],
      },
      edges: [{ upstreamAssetId: "beta", dependencyType: "collateral", weight: 0.5 }],
    });
    expect(alpha.researchEvidence).toEqual([
      expect.objectContaining({
        sourceId: "stablecoin-meta.dependency-review",
        url: "https://example.com/dependencies/alpha",
        confidence: "manual-review",
        contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(alpha.componentEvidence).toEqual([expect.objectContaining({ componentKey: "dependencies" })]);

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline);
    const compiledAlpha = compiled.assets.find((asset) => asset.assetId === "alpha")!;
    expect(compiledAlpha.dependencies.status).toMatchObject({ observationState: "bounded-unknown" });
    expect(compiledAlpha.dependencies.diagnostics.issueCodes).toContain("collateral-edge-exposure-unmapped:beta");
    expect(compiledAlpha.dependencies.edges[0]!.evidenceRefIds).toEqual(
      compiledAlpha.dependencies.status.evidenceRefIds,
    );
    expect(compiledAlpha.dependencies.status.evidenceRefIds[0]).toContain("stablecoin-meta.dependency-review");
    expect(
      evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1)
        .assets.find((asset) => asset.assetId === "alpha")!
        .scoreInput.dependencyReasons.map((reason) => reason.code),
    ).toContain("unreviewed-dependency-relationships");

    const weightDriftMeta = new Map(metaById);
    weightDriftMeta.set("alpha", {
      ...metaById.get("alpha")!,
      dependencyReview: {
        ...dependencyReview,
        relationships: [{ ...dependencyReview.relationships[0]!, weight: 0.4 }],
      },
    });
    const weightDrift = buildSafetyScoreV9BaselineExtension(fixed, { metaById: weightDriftMeta });
    expect(weightDrift.assets.find((asset) => asset.assetId === "alpha")!.dependencies).toMatchObject({
      diagnostics: {
        graphState: "unresolved",
        issueCodes: ["collateral-edge-exposure-unmapped:beta"],
      },
      edges: [{ upstreamAssetId: "beta", dependencyType: "collateral", weight: 0.5 }],
    });

    const structuralDriftMeta = new Map(metaById);
    structuralDriftMeta.set("alpha", {
      ...metaById.get("alpha")!,
      dependencyReview: {
        ...dependencyReview,
        relationships: [{ ...dependencyReview.relationships[0]!, id: "gamma" }],
      },
    });
    const structuralDrift = buildSafetyScoreV9BaselineExtension(fixed, { metaById: structuralDriftMeta });
    expect(structuralDrift.assets.find((asset) => asset.assetId === "alpha")!.dependencies).toMatchObject({
      diagnostics: {
        graphState: "unresolved",
        issueCodes: expect.arrayContaining(["dependency-review-mismatch"]),
      },
      edges: [
        expect.objectContaining({
          upstreamAssetId: "beta",
          dependencyType: "collateral",
          economicRole: "basket-exposure",
          weight: 0.5,
        }),
      ],
    });

    const mappedFixed = exactTwoAssetFixedInput({ mapAlphaCollateral: true });
    const mapped = buildSafetyScoreV9BaselineExtension(mappedFixed, { metaById });
    expect(mapped.assets.find((asset) => asset.assetId === "alpha")!.dependencies).toMatchObject({
      source: "live-reserve",
      diagnostics: { graphState: "valid", issueCodes: [] },
      edges: [{ upstreamAssetId: "beta", dependencyType: "collateral", weight: 0.5 }],
    });
    const compiledMapped = compileSafetyScoreV9FactSetFromFixedInput(mappedFixed, mapped);
    const compiledMappedAlpha = compiledMapped.assets.find((asset) => asset.assetId === "alpha")!;
    expect(compiledMappedAlpha.dependencies.status.observationState).toBe("known");
    expect(compiledMappedAlpha.reserveExposures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          trackedAssetId: "beta",
          assetClass: "stablecoin",
          weight: 0.5,
          status: expect.objectContaining({ observationState: "known" }),
        }),
      ]),
    );
    expect(
      evaluateV9FactSet(compiledMapped, V9_CANDIDATE_POLICY_V1)
        .assets.find((asset) => asset.assetId === "alpha")!
        .scoreInput.dependencyReasons.map((reason) => reason.code),
    ).not.toContain("unreviewed-dependency-relationships");

    const reviewedLiveLinkMeta = new Map(metaById);
    reviewedLiveLinkMeta.set("alpha", {
      ...metaById.get("alpha")!,
      reserves: [
        {
          name: "Beta stablecoin",
          pct: 50,
          risk: "low",
          coinId: "beta",
          depType: "collateral",
          assetClass: "stablecoin",
          issuerOrObligor: "Beta issuer",
          riskFactors: ["counterparty"],
          liquidityHorizon: "immediate",
        },
        {
          name: "Custodied cash",
          pct: 50,
          risk: "very-low",
          assetClass: "cash",
          issuerOrObligor: "issuer:alpha",
          riskFactors: ["custody", "counterparty"],
          liquidityHorizon: "immediate",
          maturityDaysMax: 0,
        },
      ],
      reserveReview: {
        reviewedAt: "1970-01-01",
        reviewer: "Fixture reviewer",
        confidence: "verified",
        sources: [{ label: "Fixture reserve review", url: "https://example.com/reserves/alpha" }],
        rationale: "The live Beta reserve row is linked by a reviewed one-to-one identity.",
        compositionBasis: "Fixture composition",
        compositionAsOf: "1970-01-01",
        scope: "full-composition",
        knownUnknownExposure: "No unknown exposure.",
        knownUnknownExposurePct: 0,
      },
    });
    const reviewedLiveLinkOriginal = exactTwoAssetFixedInput({ mapAlphaCollateral: true });
    const reviewedLiveReserveMap = structuredClone(reviewedLiveLinkOriginal.liveReserveMap);
    delete reviewedLiveReserveMap.alpha![0]!.coinId;
    delete reviewedLiveReserveMap.alpha![0]!.depType;
    const {
      schemaVersion: omittedReviewedSchemaVersion,
      activeAssetIds: omittedReviewedActiveAssetIds,
      dexPayloadFingerprint: omittedReviewedDexPayloadFingerprint,
      redemptionPayloadFingerprint: omittedReviewedRedemptionPayloadFingerprint,
      registryFingerprint: omittedReviewedRegistryFingerprint,
      inputMethodologyVersions: omittedReviewedInputMethodologyVersions,
      baseInputGenerationId: omittedReviewedBaseInputGenerationId,
      ...reviewedLiveLinkDraft
    } = reviewedLiveLinkOriginal;
    void [
      omittedReviewedSchemaVersion,
      omittedReviewedActiveAssetIds,
      omittedReviewedDexPayloadFingerprint,
      omittedReviewedRedemptionPayloadFingerprint,
      omittedReviewedRegistryFingerprint,
      omittedReviewedInputMethodologyVersions,
      omittedReviewedBaseInputGenerationId,
    ];
    const reviewedLiveLinkFixed = createReportCardsFixedInput({
      ...reviewedLiveLinkDraft,
      activeAssetIds: ["alpha", "beta"],
      liveReserveMap: reviewedLiveReserveMap,
    });
    const reviewedLiveLink = buildSafetyScoreV9BaselineExtension(reviewedLiveLinkFixed, {
      metaById: reviewedLiveLinkMeta,
    });
    expect(reviewedLiveLink.assets.find((asset) => asset.assetId === "alpha")!.dependencies).toMatchObject({
      source: "live-reserve",
      dependencyFromLive: true,
      diagnostics: { graphState: "valid", issueCodes: [] },
      edges: [{ upstreamAssetId: "beta", dependencyType: "collateral", weight: 0.5 }],
    });
    const compiledReviewedLiveLink = compileSafetyScoreV9FactSetFromFixedInput(
      reviewedLiveLinkFixed,
      reviewedLiveLink,
    );
    expect(
      compiledReviewedLiveLink.assets
        .find((asset) => asset.assetId === "alpha")!
        .reserveExposures.find((exposure) => exposure.trackedAssetId === "beta"),
    ).toMatchObject({
      weight: 0.5,
      assetClass: "stablecoin",
      status: { observationState: "known" },
    });

    const retainedNullClassification = structuredClone(mapped);
    retainedNullClassification.assets
      .find((asset) => asset.assetId === "alpha")!
      .reserveClassifications.find((classification) => classification.issuerOrObligorKey === "asset:beta")!.assetClass =
      null;
    expect(
      compileSafetyScoreV9FactSetFromFixedInput(mappedFixed, retainedNullClassification)
        .assets.find((asset) => asset.assetId === "alpha")!
        .reserveExposures.find((exposure) => exposure.trackedAssetId === "beta"),
    ).toMatchObject({ assetClass: "stablecoin", status: { observationState: "known" } });

    const mismatchedMapping = structuredClone(mapped);
    mismatchedMapping.assets.find((asset) => asset.assetId === "alpha")!.dependencies!.edges[0]!.weight = 0.4;
    const compiledMismatch = compileSafetyScoreV9FactSetFromFixedInput(mappedFixed, mismatchedMapping);
    expect(compiledMismatch.assets.find((asset) => asset.assetId === "alpha")!.dependencies).toMatchObject({
      status: { observationState: "bounded-unknown" },
      diagnostics: {
        graphState: "unresolved",
        issueCodes: ["collateral-edge-exposure-weight-mismatch:beta"],
      },
    });
  });

  it("compiles duplicate reviewed relationships as distinct role-specific V3 paths", () => {
    const fixed = exactTwoAssetFixedInput({ omitAlphaReserve: true });
    const metaById = new Map<string, V9ExtensionRegistryMeta>([
      [
        "alpha",
        {
          id: "alpha",
          mechanismArchetype: "fiat-cash",
          launchDate: "1970-01-01",
          dependencies: [{ id: "beta", weight: 1, type: "mechanism" }],
          dependencyReview: {
            reviewedAt: "1970-01-01",
            reviewer: "Fixture reviewer",
            confidence: "verified",
            sources: [{ label: "Role review", url: "https://example.com/dependencies/alpha" }],
            rationale: "Beta supplies both the reviewed exit asset and reference unit.",
            relationships: [
              {
                id: "beta",
                weight: 1,
                type: "mechanism",
                economicRole: "exit-dependency",
                reason: "Beta is the redemption output.",
              },
              {
                id: "beta",
                weight: 1,
                type: "mechanism",
                economicRole: "oracle-nav",
                reason: "Beta is the reference unit.",
              },
            ],
          },
        },
      ],
      ["beta", { id: "beta", mechanismArchetype: "fiat-cash", launchDate: "1970-01-01" }],
    ]);
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, { metaById });
    expect(baseline.assets.find((asset) => asset.assetId === "alpha")!.dependencies).toMatchObject({
      diagnostics: { graphState: "valid", issueCodes: [] },
      edges: [
        expect.objectContaining({ upstreamAssetId: "beta", economicRole: "exit-dependency" }),
        expect.objectContaining({ upstreamAssetId: "beta", economicRole: "oracle-nav" }),
      ],
    });

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline);
    const edges = compiled.assets.find((asset) => asset.assetId === "alpha")!.dependencies.edges;
    expect(edges).toEqual([
      expect.objectContaining({
        edgeKey: "exit-dependency:mechanism:beta",
        pathKind: "local-component",
        economicRole: "exit-dependency",
        evidenceRefIds: expect.any(Array),
      }),
      expect.objectContaining({
        edgeKey: "oracle-nav:mechanism:beta",
        pathKind: "local-component",
        economicRole: "oracle-nav",
        evidenceRefIds: expect.any(Array),
      }),
    ]);
    expect(edges.every((edge) => edge.evidenceRefIds.length > 0)).toBe(true);
  });

  it("derives native savings facts and shares documented-redemption admission with exit evaluation", () => {
    const original = exactTwoAssetFixedInput({ mapAlphaCollateral: true });
    const {
      schemaVersion: omittedSchemaVersion,
      activeAssetIds: omittedActiveAssetIds,
      dexPayloadFingerprint: omittedDexPayloadFingerprint,
      redemptionPayloadFingerprint: omittedRedemptionPayloadFingerprint,
      registryFingerprint: omittedRegistryFingerprint,
      inputMethodologyVersions: omittedInputMethodologyVersions,
      baseInputGenerationId: omittedBaseInputGenerationId,
      ...draft
    } = original;
    void [
      omittedSchemaVersion,
      omittedActiveAssetIds,
      omittedDexPayloadFingerprint,
      omittedRedemptionPayloadFingerprint,
      omittedRegistryFingerprint,
      omittedInputMethodologyVersions,
      omittedBaseInputGenerationId,
    ];
    const parentReserve = structuredClone(original.liveReserveMap.alpha![0]!);
    parentReserve.pct = 100;
    const documentedRedemptionInput = queuedRedemptionFixedInput();
    const documentedRedemption = structuredClone(documentedRedemptionInput.redemptionBackstopMap.alpha!);
    const documentedObservation = documentedRedemption.capacityProfile!.exitRouteObservations![0]!;
    documentedObservation.requestedNotionalUsd = 10_000_000;
    documentedObservation.executableUsd = 10_000_000;
    documentedObservation.completionRatio = 1;
    documentedObservation.capacityCurve = [
      ...documentedObservation.capacityCurve!,
      {
        requestedNotionalUsd: 10_000_000,
        maxCostBps: 200,
        executableUsd: 10_000_000,
        completionRatio: 1,
      },
    ];
    const fixed = createReportCardsFixedInput({
      ...draft,
      activeAssetIds: ["alpha", "beta"],
      liveReserveMap: { ...draft.liveReserveMap, alpha: [parentReserve] },
      redemptionGenerationId: documentedRedemptionInput.redemptionGenerationId,
      redemptionBackstopMap: { alpha: documentedRedemption },
      redemptionStale: false,
      inputFreshness: {
        ...draft.inputFreshness,
        redemptionBackstops: documentedRedemptionInput.inputFreshness.redemptionBackstops,
      },
    });
    const metaById = new Map<string, V9ExtensionRegistryMeta>([
      [
        "alpha",
        {
          id: "alpha",
          mechanismArchetype: "fiat-cash",
          launchDate: "1970-01-01",
          variantOf: "beta",
          variantKind: "savings-passthrough",
          flags: {
            backing: "crypto-backed",
            pegCurrency: "USD",
            governance: "decentralized",
            yieldBearing: true,
            rwa: false,
            navToken: true,
          },
        },
      ],
      ["beta", { id: "beta", mechanismArchetype: "fiat-cash", launchDate: "1970-01-01" }],
    ]);
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, { metaById });
    const alpha = baseline.assets.find((asset) => asset.assetId === "alpha")!;
    alpha.routeReviews = buildSafetyScoreV9RouteReviews(fixed, "alpha");
    alpha.retainedRoutes = buildSafetyScoreV9RetainedRedemptionRoutes(fixed, "alpha");
    alpha.economicControlReview = {
      mint: {
        status: notApplicableStatus("v9.control.mint-review"),
        controlKey: null,
        reconciliation: "not-applicable",
        supervision: "none",
        latestResolvedIncidentAtSec: null,
        upgrade: { state: "not-applicable", controlKey: null },
      },
      oracle: {
        status: notApplicableStatus("v9.control.oracle-review"),
        tier: null,
        branches: [],
      },
      bridge: {
        status: notApplicableStatus("v9.control.bridge-review"),
        routes: [],
      },
    };

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline);
    const compiledAlpha = compiled.assets.find((asset) => asset.assetId === "alpha")!;
    const documentedRoute = compiledAlpha.exitRoutes.find((route) => route.lane === "redemption")!;
    expect(documentedRoute).toMatchObject({
      scoreEligible: false,
      status: { observationState: "known" },
    });
    const evaluatedExit = evaluateV9Exit(
      {
        circulatingUsd: compiledAlpha.supply.circulatingUsd,
        portfolioStatus: "reviewed-complete",
        routes: compiledAlpha.exitRoutes.map(projectV9ExitEvaluationRoute),
      },
      V9_CANDIDATE_POLICY_V1,
    );
    const evaluatedDocumentedRoute = evaluatedExit.routes.find(
      (route) => route.routeKey === documentedRoute.routeKey,
    );
    expect(evaluatedDocumentedRoute, JSON.stringify(evaluatedDocumentedRoute)).toMatchObject({
      included: true,
    });
    expect(compiledAlpha.economicControlReview.mint).toMatchObject({
      status: { observationState: "known" },
      reconciliation: "not-applicable",
    });
    expect(compiledAlpha.peg.status.observationState).toBe("known");
    expect(compiledAlpha.peg.referenceKind).toBe("nav");
    const wrapper = compiledAlpha.wrapperLocalFacts;
    expect(wrapper).toMatchObject({
      applicability: "wrapper",
      form: "native-staked",
      facts: {
        custodyEscrow: { disposition: "issuer-undisclosed", assessment: null },
        strategyComplexity: { disposition: "reviewed", assessment: "low" },
        leverage: { disposition: "issuer-undisclosed", assessment: null },
        rehypothecationCorrelation: { disposition: "issuer-undisclosed", assessment: null },
        shareAccountingNavOracle: { disposition: "reviewed", assessment: "moderate" },
        measuredUnwind: {
          disposition: "reviewed",
          assessment: "none",
          signals: expect.arrayContaining(["wrapper-measured-unwind-route-count:2"]),
        },
      },
    });
    if (wrapper.applicability !== "wrapper") throw new Error("Expected wrapper-local facts");
    for (const factKey of [
      "strategyComplexity",
      "shareAccountingNavOracle",
    ] as const) {
      expect(wrapper.facts[factKey].evidenceRefIds.length).toBeGreaterThan(0);
    }
  });

  it("drops inadmissible curated collateral when no live reserve snapshot exists", () => {
    const metaById = new Map<string, V9ExtensionRegistryMeta>([
      [
        "alpha",
        {
          id: "alpha",
          mechanismArchetype: "fiat-cash",
          launchDate: "1970-01-01",
          reserves: [{ name: "Beta stablecoin", pct: 50, risk: "low", coinId: "beta", depType: "collateral" }],
        },
      ],
      ["beta", { id: "beta", mechanismArchetype: "fiat-cash", launchDate: "1970-01-01" }],
    ]);
    // `liveToFallbackCoins` is exactly the set of assets that declare a
    // live-reserve adapter and published no snapshot this run, so alpha here
    // HAS a producer and that producer failed.
    const noLiveSnapshot = exactTwoAssetFixedInput({
      omitAlphaReserve: true,
      liveToFallbackCoins: ["alpha"],
    });

    const curated = buildSafetyScoreV9BaselineExtension(noLiveSnapshot, { metaById });
    expect(curated.assets.find((asset) => asset.assetId === "alpha")!.dependencies).toMatchObject({
      source: "curated-reserve",
      diagnostics: { graphState: "valid", issueCodes: [] },
      edges: [],
    });
    const compiledCurated = compileSafetyScoreV9FactSetFromFixedInput(noLiveSnapshot, curated);
    const compiledCuratedAlpha = compiledCurated.assets.find((asset) => asset.assetId === "alpha")!;
    expect(compiledCuratedAlpha.gaps).toContainEqual(
      expect.objectContaining({
        reasonCode: "missing-reserve-composition",
      }),
    );
    expect(compiledCuratedAlpha.dependencies.status.observationState).toBe("known");
    expect(
      evaluateV9FactSet(compiledCurated, V9_CANDIDATE_POLICY_V1)
        .assets.find((asset) => asset.assetId === "alpha")!
        .scoreInput.dependencyReasons.map((reason) => reason.code),
    ).not.toContain("unreviewed-dependency-relationships");

    // The same inadmissible curated composition on an asset with NO live-reserve
    // adapter also stays on the envelope-side reserve gap; it does not create a
    // dependency gap for an edge that was never scorable this cycle.
    const noAdapter = exactTwoAssetFixedInput({ omitAlphaReserve: true });
    const noAdapterExtension = buildSafetyScoreV9BaselineExtension(noAdapter, { metaById });
    const compiledNoAdapter = compileSafetyScoreV9FactSetFromFixedInput(noAdapter, noAdapterExtension);
    const compiledNoAdapterAlpha = compiledNoAdapter.assets.find((asset) => asset.assetId === "alpha")!;
    expect(compiledNoAdapterAlpha.dependencies.edges).toEqual([]);
    expect(compiledNoAdapterAlpha.gaps).toContainEqual(
      expect.objectContaining({
        reasonCode: "missing-reserve-composition",
      }),
    );
    expect(
      evaluateV9FactSet(compiledNoAdapter, V9_CANDIDATE_POLICY_V1)
        .assets.find((asset) => asset.assetId === "alpha")!
        .scoreInput.dependencyReasons.map((reason) => reason.code),
    ).not.toContain("unreviewed-dependency-relationships");

    const liveSnapshot = exactTwoAssetFixedInput();
    const liveMismatch = buildSafetyScoreV9BaselineExtension(liveSnapshot, { metaById });
    expect(liveMismatch.assets.find((asset) => asset.assetId === "alpha")!.dependencies).toMatchObject({
      source: "curated-reserve",
      diagnostics: {
        graphState: "unresolved",
        issueCodes: ["collateral-edge-exposure-unmapped:beta"],
      },
    });
  });

  it("compiles eligible issuer-attested reserves and gives live rows precedence", () => {
    const meta: V9ExtensionRegistryMeta = {
      id: "alpha",
      mechanismArchetype: "fiat-cash",
      launchDate: "1970-01-01",
      reserves: [
        {
          name: "Treasury bills",
          pct: 70.01,
          risk: "very-low",
          assetClass: "treasury-bill",
          issuerOrObligor: "United States Treasury",
          riskFactors: ["duration", "liquidity", "custody"],
          liquidityHorizon: "one-day",
          maturityDaysMax: 30,
        },
        {
          name: "Cash",
          pct: 30,
          risk: "very-low",
          assetClass: "bank-deposit",
          issuerOrObligor: "Commercial banks",
          riskFactors: ["counterparty", "custody"],
          liquidityHorizon: "immediate",
        },
      ],
      reserveReview: {
        reviewedAt: "1970-01-01",
        reviewer: "Fixture reviewer",
        confidence: "verified",
        sources: [{ label: "Composition", url: "https://example.com/composition" }],
        rationale: "Complete composition from the signed report.",
        compositionBasis: "Signed report",
        compositionAsOf: "1970-01-01",
        scope: "full-composition",
        knownUnknownExposure: "None",
        knownUnknownExposurePct: 0,
      },
      proofOfReserves: {
        type: "independent-audit",
        url: "https://example.com/transparency",
        provider: "Independent LLP",
        attestorTier: "regional",
        cadence: "monthly",
        latestReport: {
          periodEnd: "1970-01-01",
          publishedAt: "1970-01-01",
          assuranceMethod: "examination",
          scope: "assets-and-liabilities",
          liabilityReconciliation: "full",
          reviewer: "Fixture reviewer",
          confidence: "verified",
          sources: [{ label: "Signed report", url: "https://example.com/report.pdf" }],
        },
      },
      mintAuthority: {
        mintPath: "issuer-direct-mint",
        authorityPosture: "concentrated-admin",
        confidence: "verified",
        summary: "Prudential issuer fixture.",
        supervision: "prudential",
        review: {
          sources: [{ label: "Supervisor", url: "https://example.com/supervisor" }],
          evidence: "The issuer is prudentially supervised.",
          reviewer: "Fixture reviewer",
          reviewedAt: "1970-01-01",
        },
      },
    };
    const metaById = new Map([["alpha", meta]]);
    const noLive = exactFixedInput({ omitLiveReserve: true });
    const issuerAttested = buildSafetyScoreV9BaselineExtension(noLive, { metaById });
    expect(issuerAttested.assets[0]!.reviewedStaticReserveRows).toMatchObject({
      evidenceClass: "issuer-attested",
    });
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(noLive, issuerAttested).assets[0]!;
    expect(compiled.reserveExposures).toHaveLength(2);
    expect(compiled.reserveExposures.every((exposure) => exposure.evidenceClass === "issuer-attested")).toBe(true);
    expect(compiled.reserveExposures.reduce((sum, exposure) => sum + exposure.weight, 0)).toBeCloseTo(1, 12);

    const reportSources = meta.proofOfReserves!.latestReport!.sources;
    const independentlyExaminedMeta: V9ExtensionRegistryMeta = {
      ...meta,
      reserveReview: {
        ...meta.reserveReview!,
        sources: reportSources,
      },
    };
    const independentExtension = buildSafetyScoreV9BaselineExtension(noLive, {
      metaById: new Map([["alpha", independentlyExaminedMeta]]),
    });
    expect(independentExtension.assets[0]!.reviewedStaticReserveRows).toMatchObject({
      evidenceClass: "independent",
    });
    const independentlyCompiled = compileSafetyScoreV9FactSetFromFixedInput(
      noLive,
      independentExtension,
    ).assets[0]!;
    expect(
      independentlyCompiled.reserveExposures.every((exposure) => exposure.evidenceClass === "independent"),
    ).toBe(true);

    const withLive = exactFixedInput();
    const liveFirst = buildSafetyScoreV9BaselineExtension(withLive, { metaById });
    expect(liveFirst.assets[0]!.reviewedStaticReserveRows).toBeNull();
    const liveExposures = compileSafetyScoreV9FactSetFromFixedInput(withLive, liveFirst).assets[0]!.reserveExposures;
    expect(liveExposures).toEqual([expect.objectContaining({ provenance: "live", weight: 1 })]);
    expect(liveExposures[0]).not.toHaveProperty("evidenceClass");

    const curatedFallbackFixed = structuredClone(noLive);
    curatedFallbackFixed.liveToFallbackCoins = ["alpha"];
    curatedFallbackFixed.baseInputGenerationId = deriveReportCardsBaseInputGenerationId(curatedFallbackFixed);
    const curatedFallbackMeta: V9ExtensionRegistryMeta = {
      ...meta,
      proofOfReserves: undefined,
      liveReservesConfig: {
        adapter: "curated-validated",
        version: 1,
        semantics: "collateral-mix",
        inputs: { primary: { kind: "onchain-solana" } },
      },
      mintAuthority: {
        ...meta.mintAuthority!,
        supervision: "attestation-only",
      },
    };
    const curatedFallbackExtension = buildSafetyScoreV9BaselineExtension(curatedFallbackFixed, {
      metaById: new Map([["alpha", curatedFallbackMeta]]),
    });
    expect(curatedFallbackExtension.assets[0]!.reviewedStaticReserveRows).toMatchObject({
      evidenceClass: "static-validated",
      provenance: "curated-fallback",
    });
    expect(curatedFallbackExtension.assets[0]!.researchEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: "stablecoin-meta.reviewed-curated-fallback-reserves",
        }),
      ]),
    );
    const curatedFallbackExposures = compileSafetyScoreV9FactSetFromFixedInput(
      curatedFallbackFixed,
      curatedFallbackExtension,
    ).assets[0]!.reserveExposures;
    expect(curatedFallbackExposures).toHaveLength(2);
    expect(curatedFallbackExposures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provenance: "curated-fallback",
          evidenceClass: "static-validated",
        }),
      ]),
    );

    const noFallbackSignal = structuredClone(noLive);
    noFallbackSignal.baseInputGenerationId = deriveReportCardsBaseInputGenerationId(noFallbackSignal);
    const configuredWithoutFallback = buildSafetyScoreV9BaselineExtension(noFallbackSignal, {
      metaById: new Map([["alpha", curatedFallbackMeta]]),
    });
    expect(configuredWithoutFallback.assets[0]!.reviewedStaticReserveRows).toBeNull();

    const standaloneMeta: V9ExtensionRegistryMeta = {
      ...curatedFallbackMeta,
      liveReservesConfig: undefined,
    };
    const standaloneExtension = buildSafetyScoreV9BaselineExtension(noFallbackSignal, {
      metaById: new Map([["alpha", standaloneMeta]]),
    });
    expect(standaloneExtension.assets[0]!.reviewedStaticReserveRows).toMatchObject({
      evidenceClass: "static-validated",
      provenance: "curated",
    });
    const standaloneAsset = standaloneExtension.assets[0]!;
    expect(standaloneAsset.researchEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: "stablecoin-meta.reviewed-standalone-reserves",
        }),
      ]),
    );
    const standaloneExposures = compileSafetyScoreV9FactSetFromFixedInput(
      noFallbackSignal,
      standaloneExtension,
    ).assets[0]!.reserveExposures;
    expect(standaloneExposures).toHaveLength(2);
    expect(standaloneExposures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provenance: "curated",
          evidenceClass: "static-validated",
        }),
      ]),
    );

    const wrapperExtension = buildSafetyScoreV9BaselineExtension(noFallbackSignal, {
      metaById: new Map([["alpha", { ...standaloneMeta, variantOf: "beta" }]]),
    });
    expect(wrapperExtension.assets[0]!.reviewedStaticReserveRows).toBeNull();

    const standaloneWithStrayFallbackSignal = buildSafetyScoreV9BaselineExtension(curatedFallbackFixed, {
      metaById: new Map([["alpha", standaloneMeta]]),
    });
    expect(standaloneWithStrayFallbackSignal.assets[0]!.reviewedStaticReserveRows).toMatchObject({
      evidenceClass: "static-validated",
      provenance: "curated",
    });
  });

  it("suppresses missing-access-review gaps for evidenced structural freeze dispositions only", () => {
    const boundedFreezeStatus = {
      applicability: {
        state: "required" as const,
        policyRuleId: "v9.access.freeze-review",
        rationale: null,
        gapId: null,
      },
      observationState: "bounded-unknown" as const,
      evidenceRefIds: ["placeholder:evidence"],
      gapIds: ["placeholder:gap"],
    };
    const withDisposition = structuredClone(extension());
    const freezeReview = withDisposition.assets[0]!.accessReview!.freeze;
    freezeReview.status = structuredClone(boundedFreezeStatus);
    freezeReview.reviews = [
      {
        reviewKey: "blacklist:alpha",
        source: "upstream",
        status: structuredClone(boundedFreezeStatus),
        reach: "possible",
        controlKey: null,
        upstreamAssetId: "alpha",
        failureDomains: [{ kind: "mint-control", key: "asset:alpha" }],
      },
    ];
    freezeReview.structuralDisposition = "inherited-upstream";
    const structural = compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), withDisposition).assets[0]!;
    const accessFreezeGaps = (asset: typeof structural) =>
      asset.gaps.filter((gap) => gap.gapId.includes(":gap:access:freeze"));
    // Scoring-visible state and the gap invariant are untouched; the gap is
    // reclassified from missing data to a measured structural fact.
    expect(accessFreezeGaps(structural).length).toBeGreaterThan(0);
    expect(
      accessFreezeGaps(structural).every(
        (gap) => gap.reasonCode === "inherited-access-exposure" && gap.responsibility === "measured-adverse",
      ),
    ).toBe(true);
    expect(structural.accessReview.freeze.status.observationState).toBe("bounded-unknown");
    expect(structural.accessReview.freeze.reviews[0]!.status.observationState).toBe("bounded-unknown");
    expect(structural.accessReview.freeze.structuralDisposition).toBe("inherited-upstream");

    const withoutDisposition = structuredClone(withDisposition);
    delete withoutDisposition.assets[0]!.accessReview!.freeze.structuralDisposition;
    const gapped = compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), withoutDisposition).assets[0]!;
    expect(accessFreezeGaps(gapped).length).toBeGreaterThan(0);
    expect(accessFreezeGaps(gapped).every((gap) => gap.reasonCode === "missing-access-review")).toBe(true);

    const possibleDisposition = structuredClone(withDisposition);
    possibleDisposition.assets[0]!.accessReview!.freeze.structuralDisposition = "reviewed-possible";
    possibleDisposition.assets[0]!.accessReview!.freeze.reviews[0] = {
      ...possibleDisposition.assets[0]!.accessReview!.freeze.reviews[0]!,
      source: "blacklist",
      upstreamAssetId: null,
      failureDomains: [],
    };
    const possible = compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), possibleDisposition).assets[0]!;
    expect(accessFreezeGaps(possible).length).toBeGreaterThan(0);
    expect(
      accessFreezeGaps(possible).every(
        (gap) => gap.reasonCode === "reviewed-possible-access" && gap.responsibility === "measured-adverse",
      ),
    ).toBe(true);
  });

  it("classifies a supply-floor-withheld peg deviation as measured, not missing", () => {
    const pegGaps = (fixed: ReturnType<typeof exactFixedInput>) =>
      compileSafetyScoreV9FactSetFromFixedInput(fixed, extension())
        .assets[0]!.gaps.filter((gap) =>
          gap.reasonCode === "peg-supply-floor-withheld" || gap.reasonCode === "missing-peg-input",
        );

    // Deviation withheld by the $1M supply floor: deliberate methodology,
    // classified measured-structural with the same peg-unverified ceiling.
    const floorWithheld = exactFixedInput({ currentDeviationBps: null, depegEventCoverageLimited: true });
    expect(pegGaps(floorWithheld)).toMatchObject([
      { reasonCode: "peg-supply-floor-withheld", responsibility: "measured-adverse" },
    ]);

    const staleFloorWithheld = exactFixedInput({
      currentDeviationBps: null,
      depegEventCoverageLimited: true,
      pegObservedAtSec: AS_OF_SEC - 1_000,
    });
    expect(pegGaps(staleFloorWithheld)).toMatchObject([
      {
        reasonCode: "missing-peg-input",
        responsibility: "producer-failed",
        observationState: "stale",
      },
    ]);

    // The same null deviation without the floor flag stays a producer gap.
    expect(pegGaps(exactFixedInput({ currentDeviationBps: null }))).toMatchObject([
      { reasonCode: "missing-peg-input", responsibility: "producer-failed" },
    ]);
  });

  it("treats a pure NAV peg reference as not-applicable while fiat assets still require a peg row", () => {
    const withoutPegRow = () => exactFixedInput({ omitPegRow: true });
    const navExtension = extension();
    navExtension.assets[0]!.pegReference = { referenceKind: "nav", referenceKey: "nav:alpha", failureDomains: [] };
    const navCompiled = compileSafetyScoreV9FactSetFromFixedInput(withoutPegRow(), navExtension);
    const navPeg = navCompiled.assets[0]!.peg;
    expect(navPeg.status.applicability.state).toBe("not-applicable");
    expect(navPeg.status.observationState).toBe("known");
    expect(navPeg.pegScore).toBeNull();
    const navEvaluated = evaluateV9FactSet(navCompiled, V9_CANDIDATE_POLICY_V1);
    expect(navEvaluated.assets[0]!.trace.finalGrade).not.toBe("NR");

    const fiatCompiled = compileSafetyScoreV9FactSetFromFixedInput(withoutPegRow(), extension());
    expect(fiatCompiled.assets[0]!.peg.status.observationState).toBe("missing");
    // A missing producer row is an availability failure, not measured peg
    // safety. The latent peg multiplier remains visible and the rating remains
    // provisional under the configured bounded-evidence ceiling.
    const fiatTrace = evaluateV9FactSet(fiatCompiled, V9_CANDIDATE_POLICY_V1).assets[0]!.trace;
    const missingPegCeiling = resolveV9ReasonPolicy(
      V9_CANDIDATE_POLICY_V1,
      "missing-peg-input",
    ).ceiling!;
    expect(fiatTrace.finalGrade).not.toBe("NR");
    expect(fiatTrace.finalScore).toBeLessThanOrEqual(missingPegCeiling.limit);
    expect(fiatTrace.pegMultiplier).toBe(1);
    expect(fiatTrace.caps).toContainEqual(
      expect.objectContaining({
        source: "evidence",
        kind: missingPegCeiling.kind,
        limit: missingPegCeiling.limit,
      }),
    );
    expect(fiatTrace.unresolvedFacts).toContainEqual(
      expect.objectContaining({ code: "missing-peg-input", responsibility: "producer-failed" }),
    );
    expect(fiatTrace.nrReasons).toEqual([]);
  });

  it("retains an independently observed active depeg when current deviation is unavailable", () => {
    const fixed = exactFixedInput({
      pegScore: 27,
      currentDeviationBps: null,
      activeDepeg: true,
      activeDepegPeakBps: 5_783,
    });
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension());

    expect(compiled.assets[0]!.peg).toMatchObject({
      status: { observationState: "bounded-unknown" },
      pegScore: 27,
      currentDeviationBps: null,
      activeDepeg: true,
      activeDepegBps: 5_783,
    });
    const trace = evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!.trace;
    expect(trace.pegMultiplier).toBeCloseTo(0.592305, 6);
    expect(trace.caps).toContainEqual(
      expect.objectContaining({ source: "active-depeg", kind: "active-depeg:f", limit: 39 }),
    );
    const missingPeak = exactFixedInput({ pegScore: 27, currentDeviationBps: null, activeDepeg: true });
    const missingPeakTrace = evaluateV9FactSet(
      compileSafetyScoreV9FactSetFromFixedInput(missingPeak, extension()),
      V9_CANDIDATE_POLICY_V1,
    ).assets[0]!.trace;
    expect(trace.finalGrade).toBe("F");
    expect(trace.nrReasons).toEqual([]);
    expect(missingPeakTrace.finalGrade).not.toBe("NR");
    expect(missingPeakTrace.nrReasons).toEqual([]);
    expect(trace.preCapScore).toBeLessThan(missingPeakTrace.preCapScore!);
  });

  it("treats XTUSD's quiet scored peg history as explicit zero current deviation", () => {
    const fixed = exactFixedInput({
      assetId: "xtusd-xt",
      pegScore: 100,
      currentDeviationBps: null,
      activeDepeg: false,
      eventCount: 0,
      worstDeviationBps: null,
      lastEventAt: null,
      pegPct: 100,
      severityScore: 100,
      spreadPenalty: 0,
    });

    const reviewed = extension();
    reviewed.registryFingerprint = fixed.registryFingerprint;
    reviewed.assets[0]!.assetId = "xtusd-xt";
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, reviewed);
    const peg = compiled.assets[0]!.peg;

    expect(compiled.assets[0]!.assetId).toBe("xtusd-xt");
    expect(peg).toMatchObject({
      status: { observationState: "known" },
      pegScore: 100,
      currentDeviationBps: 0,
      activeDepeg: false,
      activeDepegBps: null,
    });
    expect(compiled.assets[0]!.gaps.map((gap) => gap.reasonCode)).not.toContain("missing-peg-input");
  });

  it("keeps NXUSD's event-bearing peg row a producer gap instead of quiet zero deviation", () => {
    // NXUSD carries a resolved -376 bps incident inside its tracked window and
    // has no usable current price, so its null deviation is unobserved rather
    // than quiet. Coercing it to 0 bps would publish a peg reading that the
    // live DEX check contradicts, so the quiet-observation rule must stop at
    // rows with no recorded events.
    const fixed = exactFixedInput({
      assetId: "nxusd-nereus",
      pegScore: 100,
      currentDeviationBps: null,
      depegEventCoverageLimited: false,
      activeDepeg: false,
      eventCount: 1,
      worstDeviationBps: -376,
      lastEventAt: AS_OF_SEC - 1,
      pegPct: 99.67,
      severityScore: 99.44,
      spreadPenalty: 0,
    });

    const reviewed = extension();
    reviewed.registryFingerprint = fixed.registryFingerprint;
    reviewed.assets[0]!.assetId = "nxusd-nereus";
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, reviewed);

    expect(compiled.assets[0]!.assetId).toBe("nxusd-nereus");
    expect(compiled.assets[0]!.peg).toMatchObject({
      status: { observationState: "bounded-unknown" },
      pegScore: null,
      currentDeviationBps: null,
    });
    expect(compiled.assets[0]!.gaps).toContainEqual(
      expect.objectContaining({ reasonCode: "missing-peg-input", responsibility: "producer-failed" }),
    );
  });

  it("keeps an active peg row suppressed when its depeg peak is absent", () => {
    const fixed = exactFixedInput({ pegScore: 27, currentDeviationBps: null, activeDepeg: true });
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension());

    expect(compiled.assets[0]!.peg).toMatchObject({
      status: { observationState: "bounded-unknown" },
      pegScore: null,
      currentDeviationBps: null,
      activeDepeg: null,
      activeDepegBps: null,
    });
    const trace = evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!.trace;
    const missingPegCeiling = resolveV9ReasonPolicy(
      V9_CANDIDATE_POLICY_V1,
      "missing-peg-input",
    ).ceiling!;
    expect(trace.finalGrade).not.toBe("NR");
    expect(trace.finalScore).toBeLessThanOrEqual(missingPegCeiling.limit);
    expect(trace.caps).toContainEqual(
      expect.objectContaining({
        source: "evidence",
        kind: missingPegCeiling.kind,
        limit: missingPegCeiling.limit,
      }),
    );
    expect(trace.unresolvedFacts).toContainEqual(
      expect.objectContaining({ code: "missing-peg-input", responsibility: "producer-failed" }),
    );
    expect(trace.nrReasons).toEqual([]);
    expect(trace.caps.some((cap) => cap.source === "active-depeg")).toBe(false);
  });

  it("canonicalizes extension ordering and produces a deterministic digest", () => {
    const ordered = extension();
    const reversed = structuredClone(ordered);
    const review = reversed.assets[0]!.routeReviews[0]!;
    review.executionCosts.reverse();
    review.failureDomains.reverse();
    review.physicalResourceKeys.reverse();
    const reversedMechanism = reversed.assets[0]!.mechanismRiskReview!;
    if (reversedMechanism.archetype !== "fiat-cash") throw new Error("Fixture archetype changed");
    reversedMechanism.claimAndSegregation.status.evidenceRefIds = ["other:placeholder"];
    const left = compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), ordered);
    const right = compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), reversed);
    expect(right).toEqual(left);
    expect(right.v9FactSetDigest).toBe(left.v9FactSetDigest);
  });

  it("rebinds non-measured metric evidence refs to the mechanism review evidence", () => {
    const cdp = extension();
    cdp.assets[0]!.archetype = "cdp";
    cdp.assets[0]!.mechanismRiskReview = {
      archetype: "cdp",
      collateralizationRatio: 1.5,
      liquidationCapacityRatio: null,
      metricApplicability: {
        collateralizationRatio: { state: "measured" },
        liquidationCapacityRatio: {
          state: "not-applicable",
          rationale: "No liquidation venue exists for this fixture branch.",
          evidenceRefIds: ["extension-evidence:mechanism:liquidation-capacity-ratio"],
        },
      },
      collateralizationParameters: {
        status: status("known", "v9.backing.mechanism-review"),
        quality: "strong",
        failureDomains: [],
      },
      liquidationMechanics: {
        status: status("known", "v9.backing.mechanism-review"),
        quality: "strong",
        failureDomains: [],
      },
      backstop: {
        status: status("known", "v9.backing.mechanism-review"),
        quality: "strong",
        failureDomains: [],
      },
      branchIsolation: {
        status: status("known", "v9.backing.mechanism-review"),
        quality: "strong",
        failureDomains: [],
      },
      shutdownAndBadDebt: {
        status: status("known", "v9.backing.mechanism-review"),
        quality: "strong",
        failureDomains: [],
      },
      structuralRedemption: {
        status: status("known", "v9.backing.mechanism-review"),
        quality: "strong",
        failureDomains: [],
      },
    };

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), cdp).assets[0]!;
    if (compiled.mechanismRiskReview.review?.archetype !== "cdp") throw new Error("Fixture archetype changed");

    const applicability = compiled.mechanismRiskReview.review.metricApplicability.liquidationCapacityRatio;
    expect(applicability.state).toBe("not-applicable");
    if (applicability.state !== "not-applicable") throw new Error("Fixture applicability changed");
    const metricEvidenceRefs = applicability.evidenceRefIds;
    expect(metricEvidenceRefs).toEqual(compiled.mechanismRiskReview.status.evidenceRefIds);
    expect(metricEvidenceRefs).toEqual(["alpha:research-overlay"]);
    expect(compiled.evidence.map((evidence) => evidence.evidenceId)).toContain(metricEvidenceRefs[0]);

    const component = {
      status: status("known", "v9.backing.mechanism-review"),
      quality: "limited" as const,
      failureDomains: [],
    };
    const rwa = extension();
    rwa.assets[0]!.archetype = "rwa-credit-fund";
    rwa.assets[0]!.mechanismRiskReview = {
      archetype: "rwa-credit-fund",
      weightedAverageMaturityDays: null,
      valuationCadenceDays: 30,
      metricApplicability: {
        weightedAverageMaturityDays: {
          state: "unavailable",
          rationale: "The reviewed disclosure has no maturity ladder or WAM.",
          evidenceRefIds: ["extension-evidence:mechanism:weighted-average-maturity-days"],
        },
        valuationCadenceDays: { state: "measured" },
      },
      creditQuality: component,
      seniority: component,
      legalEnforceability: component,
      valuationCadence: component,
      maturityAndLiquidity: component,
      custody: component,
      recovery: component,
    };

    const compiledRwa = compileSafetyScoreV9FactSetFromFixedInput(
      exactFixedInput(),
      rwa,
    ).assets[0]!;
    if (compiledRwa.mechanismRiskReview.review?.archetype !== "rwa-credit-fund") {
      throw new Error("Fixture archetype changed");
    }
    const unavailable =
      compiledRwa.mechanismRiskReview.review.metricApplicability
        ?.weightedAverageMaturityDays;
    expect(unavailable?.state).toBe("unavailable");
    if (unavailable?.state !== "unavailable") throw new Error("Fixture applicability changed");
    expect(unavailable.evidenceRefIds).toEqual(["alpha:research-overlay"]);
  });

  it("turns unavailable classifications, valuation, dependencies, and controls into typed gaps", () => {
    const incomplete = extension();
    const asset = incomplete.assets[0]!;
    asset.mechanismRiskReview = null;
    asset.dependencies = null;
    asset.controlReview = null;
    asset.economicControlReview = null;
    asset.accessReview = null;
    asset.supplyReview = null;
    asset.routeReviews[0]!.output!.valuation = null;

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(
      exactFixedInput({ classifiedReserve: false }),
      incomplete,
    );
    expect(compiled.schemaVersion).toBe(3);
    const alpha = compiled.assets[0]!;
    const reasons = alpha.gaps.map((gap) => gap.reasonCode);
    expect(reasons).toEqual(
      expect.arrayContaining([
        "material-reserve-slice-unstructured",
        "unresolved-exit-output",
        "unreviewed-dependency-relationships",
        "missing-upgradeability-review",
        "missing-mint-authority",
        "missing-oracle-profile",
        "missing-bridge-routes",
        "runtime-bridge-materiality-unavailable",
      ]),
    );
    expect(alpha.reserveExposures[0]).toMatchObject({
      assetClass: null,
      status: { observationState: "bounded-unknown" },
    });
    expect(alpha.exitRoutes[0]!.output).toMatchObject({ valuation: null, status: { observationState: "missing" } });
    expect(alpha.controls).toEqual([]);
    expect(alpha.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reasonCode: "material-reserve-slice-unstructured",
          responsibility: "integration-missing",
        }),
        expect.objectContaining({
          reasonCode: "unresolved-exit-output",
          responsibility: "producer-failed",
        }),
        expect.objectContaining({
          reasonCode: "missing-upgradeability-review",
          responsibility: "integration-missing",
        }),
      ]),
    );
    expect(evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!.trace.unresolvedFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "material-reserve-slice-unstructured",
          responsibility: "integration-missing",
        }),
        // Since 9.19 the unresolved output is counted once, under the exit
        // pillar's own reason code, carrying the causal gap identity.
        expect.objectContaining({
          code: "missing-same-notional-route",
          responsibility: "producer-failed",
          sourceGapId: "alpha:gap:route:dex:dex-liquidity-9900:dex:primary:output",
        }),
      ]),
    );
  });

  it("keeps unresolved output ownership causal without making the output scoreable", () => {
    const reviewedExternal = extension();
    reviewedExternal.assets[0]!.routeReviews[0]!.output = null;
    reviewedExternal.assets[0]!.routeReviews[0]!.unresolvedOutputResponsibility = "producer-failed";
    const external = compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), reviewedExternal).assets[0]!;
    expect(external.exitRoutes[0]!.output).toMatchObject({
      valuation: null,
      status: { observationState: "missing" },
    });
    expect(external.gaps).toContainEqual(
      expect.objectContaining({
        reasonCode: "unresolved-exit-output",
        responsibility: "producer-failed",
      }),
    );

    const undisclosed = extension();
    undisclosed.assets[0]!.routeReviews[0]!.output = null;
    undisclosed.assets[0]!.routeReviews[0]!.unresolvedOutputResponsibility = "issuer-undisclosed";
    const issuer = compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), undisclosed).assets[0]!;
    expect(issuer.gaps).toContainEqual(
      expect.objectContaining({
        reasonCode: "unresolved-exit-output",
        responsibility: "issuer-undisclosed",
      }),
    );

    const knownIdentityWithoutValuation = extension();
    knownIdentityWithoutValuation.assets[0]!.routeReviews[0]!.output!.valuation = null;
    const producer = compileSafetyScoreV9FactSetFromFixedInput(
      exactFixedInput(),
      knownIdentityWithoutValuation,
    ).assets[0]!;
    expect(producer.gaps).toContainEqual(
      expect.objectContaining({
        reasonCode: "unresolved-exit-output",
        responsibility: "producer-failed",
      }),
    );
  });

  it("preserves supplied stale and rejected last-known route observations", () => {
    const withRetained = extension();
    const asset = withRetained.assets[0]!;
    asset.retainedRoutes = [
      { lane: "dex", observation: route("dex:stale", 8_000), disposition: "observed", rejection: null },
      {
        lane: "dex",
        observation: route("dex:rejected", 9_800),
        disposition: "rejected",
        rejection: { code: "unsupported-pool", reason: "Producer rejected the pool model.", rejectedAtSec: 9_900 },
      },
    ];
    asset.routeReviews = [routeReview(), routeReview("dex:stale", 8_000), routeReview("dex:rejected", 9_800)];

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), withRetained);
    const stale = compiled.assets[0]!.exitRoutes.find((candidate) => candidate.routeId === "dex:stale")!;
    const rejected = compiled.assets[0]!.exitRoutes.find((candidate) => candidate.routeId === "dex:rejected")!;
    expect(stale).toMatchObject({
      status: { observationState: "stale" },
      request: { requestedNotionalUsd: 100_000 },
    });
    expect(stale.capacityCurve).toHaveLength(2);
    expect(rejected).toMatchObject({ status: { observationState: "unsupported" }, scoreEligible: false });
    const rejectedEvidence = compiled.assets[0]!.evidence.find((evidence) =>
      rejected.status.evidenceRefIds.includes(evidence.evidenceId),
    );
    expect(rejectedEvidence).toMatchObject({ disposition: "rejected", rejection: { code: "unsupported-pool" } });
  });

  it("rejects reconstructed/report-card inputs, score-shaped extension fields, and active-set drift", () => {
    expect(() => compileSafetyScoreV9FactSetFromFixedInput({ cards: [], overallScore: 99 }, extension())).toThrow(
      /Malformed fixed report-card input/,
    );
    expect(() =>
      compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), { ...extension(), overallScore: 99 }),
    ).toThrow(/Unrecognized key/);
    const scoreShapedAsset = extension();
    expect(() =>
      compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), {
        ...scoreShapedAsset,
        assets: [{ ...scoreShapedAsset.assets[0]!, dimensions: {}, baseScore: 99 }],
      }),
    ).toThrow(/Unrecognized key/);
    const wrongAsset = extension();
    wrongAsset.assets[0]!.assetId = "beta";
    expect(() => compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), wrongAsset)).toThrow(
      /active set mismatch/,
    );

    const conflictingOutput = extension();
    conflictingOutput.assets[0]!.routeReviews[0]!.output!.assetKeys = ["fiat:EUR"];
    const conflictingFixedInput = exactFixedInput();
    const conflictingMaterialized = materializeSafetyScoreV9FactSetExtension(
      conflictingFixedInput,
      conflictingOutput,
    );
    expect(
      compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension(
        conflictingFixedInput,
        conflictingMaterialized,
      ).quarantines,
    ).toEqual(
      [{ assetId: "alpha", code: "fact-build-failed" }],
    );
  });

  it("prefers reviewed deployment transfer facts and preserves the absent-fact fallback", () => {
    const fixed = exactFixedInput();
    const reviewBase = {
      sources: [{ label: "Reviewed token controls", url: "https://example.com/token-controls" }],
      evidence: "The reviewed token controls establish the authored blacklist status.",
      reviewer: "Fixture reviewer",
      reviewedAt: "1970-01-01",
    };
    const transferFact = (
      posture: "permissionless" | "restrictable" | "permissioned",
    ): SafetyScoreV9ReviewedTransferFact => ({
      assetId: "alpha",
      reviewedAt: "1970-01-01",
      reviewer: "Fixture reviewer",
      deployments: [
        {
          chainId: "ethereum",
          contractOrTokenId: "0xalpha",
          scope: "canonical",
          posture,
          evidence: "The verified token implementation establishes this deployment posture.",
          sources: [{ label: "Verified token source", url: "https://example.com/token-source" }],
        },
      ],
    });
    const build = (
      reviewedStatus: true | false | "possible",
      transferReview?: SafetyScoreV9ReviewedTransferFact,
      input = fixed,
      options: {
        blacklistReviewedAt?: string;
        contracts?: Array<{ chain: string; address: string; decimals: number }>;
      } = {},
    ) =>
      buildSafetyScoreV9BaselineExtension(input, {
        metaById: new Map([
          [
            "alpha",
            {
              id: "alpha",
              mechanismArchetype: "fiat-cash" as const,
              contracts: options.contracts ?? [
                { chain: "ethereum", address: "0xalpha", decimals: 18 },
                { chain: "base", address: "0xbeta", decimals: 18 },
              ],
              blacklistabilityReview: {
                ...reviewBase,
                reviewedAt: options.blacklistReviewedAt ?? reviewBase.reviewedAt,
                reviewedStatus,
              },
            },
          ],
        ]),
        reviewedTransferFacts: new Map(transferReview ? [["alpha", transferReview]] : []),
      });

    const restrictable = compileSafetyScoreV9FactSetFromFixedInput(fixed, build(true)).assets[0]!;
    expect(restrictable.accessReview.transfer).toMatchObject({
      posture: "restrictable",
      status: { observationState: "known" },
    });
    expect(restrictable.accessReview.freeze.reviews[0]).toMatchObject({
      source: "blacklist",
      reach: "individual",
      status: { observationState: "known" },
    });
    expect(
      restrictable.evidence.find((candidate) => candidate.sourceId === "stablecoin-meta.blacklistability-review"),
    ).toMatchObject({
      url: "https://example.com/token-controls",
      freshness: { state: "current", maxAgeSec: V9_ACCESS_EVIDENCE_MAX_AGE_SEC },
    });

    const noBlacklist = compileSafetyScoreV9FactSetFromFixedInput(fixed, build(false)).assets[0]!;
    expect(noBlacklist.accessReview.transfer).toMatchObject({
      posture: null,
      status: { observationState: "missing" },
    });
    expect(noBlacklist.accessReview.freeze.reviews[0]).toMatchObject({ reach: "none" });

    const possible = compileSafetyScoreV9FactSetFromFixedInput(fixed, build("possible")).assets[0]!;
    expect(possible.accessReview.transfer).toMatchObject({
      posture: null,
      status: { observationState: "bounded-unknown" },
    });
    expect(possible.accessReview.freeze.reviews[0]).toMatchObject({
      reach: "possible",
      status: { observationState: "bounded-unknown" },
    });

    for (const posture of ["permissionless", "restrictable", "permissioned"] as const) {
      const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, build(true, transferFact(posture))).assets[0]!;
      expect(compiled.accessReview.transfer).toMatchObject({ posture, status: { observationState: "known" } });
      expect(compiled.accessReview.freeze.reviews[0]).toMatchObject({
        reach: "individual",
        status: { observationState: "known" },
      });
      expect(
        compiled.evidence.find((candidate) => candidate.sourceId === "safety-score-v9.reviewed-transfer-overlay"),
      ).toMatchObject({
        url: "https://example.com/token-source",
        freshness: { state: "current", maxAgeSec: V9_ACCESS_EVIDENCE_MAX_AGE_SEC },
      });
    }

    const multiChain = exactFixedInput({
      chainSupplyByChain: {
        ethereum: {
          current: 9_000_000,
          circulatingPrevDay: 9_000_000,
          circulatingPrevWeek: 9_000_000,
          circulatingPrevMonth: 9_000_000,
        },
        base: {
          current: 1_000_000,
          circulatingPrevDay: 1_000_000,
          circulatingPrevWeek: 1_000_000,
          circulatingPrevMonth: 1_000_000,
        },
      },
    });
    const incomplete = compileSafetyScoreV9FactSetFromFixedInput(
      multiChain,
      build(true, transferFact("permissionless"), multiChain),
    ).assets[0]!;
    expect(incomplete.accessReview.transfer).toMatchObject({
      posture: null,
      status: { observationState: "bounded-unknown" },
    });

    const wrongContract = transferFact("permissionless");
    wrongContract.deployments[0]!.contractOrTokenId = "0xwrong";
    expect(
      compileSafetyScoreV9FactSetFromFixedInput(fixed, build(true, wrongContract)).assets[0]!.accessReview.transfer,
    ).toMatchObject({ posture: null, status: { observationState: "bounded-unknown" } });

    const wrongScope: SafetyScoreV9ReviewedTransferFact = {
      ...transferFact("permissionless"),
      deployments: [
        { ...transferFact("permissionless").deployments[0]!, scope: "additional" },
        {
          ...transferFact("permissionless").deployments[0]!,
          chainId: "base",
          contractOrTokenId: "0xbeta",
        },
      ],
    };
    expect(
      compileSafetyScoreV9FactSetFromFixedInput(fixed, build(true, wrongScope)).assets[0]!.accessReview.transfer,
    ).toMatchObject({ posture: null, status: { observationState: "bounded-unknown" } });

    expect(
      compileSafetyScoreV9FactSetFromFixedInput(
        fixed,
        build(true, transferFact("permissionless"), fixed, {
          contracts: [
            { chain: "ethereum", address: "0xalpha", decimals: 18 },
            { chain: "ethereum", address: "0xalpha2", decimals: 18 },
          ],
        }),
      ).assets[0]!.accessReview.transfer,
    ).toMatchObject({ posture: null, status: { observationState: "bounded-unknown" } });

    const staleInput = exactFixedInput({ clockSec: V9_ACCESS_EVIDENCE_MAX_AGE_SEC + 1 });
    const stale = compileSafetyScoreV9FactSetFromFixedInput(
      staleInput,
      build(true, transferFact("permissionless"), staleInput, { blacklistReviewedAt: "1971-01-01" }),
    ).assets[0]!;
    expect(stale.accessReview.transfer).toMatchObject({ posture: null, status: { observationState: "stale" } });
    expect(stale.accessReview.freeze.status.observationState).toBe("known");
    expect(
      stale.evidence.find((candidate) => candidate.sourceId === "safety-score-v9.reviewed-transfer-overlay"),
    ).toMatchObject({ freshness: { state: "stale", maxAgeSec: V9_ACCESS_EVIDENCE_MAX_AGE_SEC } });

    expect(build(true).registryFingerprint).toBe(build(true, transferFact("permissionless")).registryFingerprint);
  });

  it("derives reviewed bridge/mint/oracle research freshness on the D11 review cadence", () => {
    const clockSec = Date.UTC(2026, 6, 19) / 1_000;
    const researchReviewMeta = (reviewedAt: string): V9ExtensionRegistryMeta => ({
      id: "alpha",
      mechanismArchetype: "cdp" as const,
      oracleRisk: {
        tier: "redundant-with-failover" as const,
        summary: "The fixture has reviewed oracle and liquidation branch behavior.",
        branchModel: "multi-branch" as const,
        branchApplicability: {
          disposition: "branches-required" as const,
          reviewedAt,
          reviewer: "Fixture reviewer",
          rationale: "The collateral market requires explicit branch evidence.",
          sources: [{ label: "Branch docs", url: "https://example.com/branches" }],
        },
        reviewedAt,
        reviewer: "Fixture reviewer",
        confidence: "verified" as const,
        sources: [{ label: "Oracle docs", url: "https://example.com/oracle" }],
        branches: [
          {
            id: "eth",
            label: "ETH branch",
            tier: "redundant-with-failover" as const,
            summary: "The ETH branch has complete reviewed controls.",
            feeds: [{ provider: "Fixture", path: "ETH/USD", chain: "ethereum" }],
            collateralParameters: [{ asset: "ETH", minimumCollateralRatioPct: 120 }],
            liquidationMechanism: "Immediate permissionless liquidation through the branch.",
            liquidationDelaySec: 0,
            backstop: "A dedicated stability pool absorbs liquidated debt.",
            shutdownOrBadDebtBehavior: "The branch shuts down and exposes residual bad debt explicitly.",
            sources: [{ label: "Branch docs", url: "https://example.com/branches" }],
          },
        ],
      },
      mintAuthority: {
        mintPath: "issuer-direct-mint" as const,
        authorityPosture: "concentrated-admin" as const,
        confidence: "verified" as const,
        summary: "The fixture token is reviewed immutable with no direct mint control.",
        upgradeability: {
          model: "immutable" as const,
          canChangeMintLogic: false,
          sources: [{ label: "Mint docs", url: "https://example.com/mint" }],
        },
        controls: [],
        review: {
          sources: [{ label: "Mint docs", url: "https://example.com/mint" }],
          evidence: "The fixture mint path is reviewed and immutable.",
          reviewer: "Fixture reviewer",
          reviewedAt,
        },
      },
      bridgeRouteRisk: {
        tier: "external-lock-mint" as const,
        summary: "A reviewed external bridge route represents the fixture token.",
        reviewedAt,
        reviewer: "Fixture reviewer",
        confidence: "verified" as const,
        sources: [{ label: "Bridge docs", url: "https://example.com/bridge" }],
        routes: [
          {
            id: "ethereum:0x1111111111111111111111111111111111111111",
            destinationChain: "ethereum",
            canonicalChain: "ethereum",
            contractAddress: "0x1111111111111111111111111111111111111111",
            protocol: "Fixture native issuance",
            issuanceModel: "native-issuance" as const,
            routeClass: "native" as const,
            riskTier: "single-chain-or-native" as const,
            semantics: "native-mint" as const,
            scope: "canonical" as const,
            reviewDisposition: "reviewed" as const,
            observedAt: reviewedAt,
            sources: [{ label: "Bridge docs", url: "https://example.com/bridge" }],
          },
          {
            id: "base:0x3333333333333333333333333333333333333333",
            sourceChain: "ethereum",
            destinationChain: "base",
            canonicalChain: "ethereum",
            contractAddress: "0x3333333333333333333333333333333333333333",
            protocol: "Fixture bridge",
            issuanceModel: "bridge-representation" as const,
            routeClass: "third-party" as const,
            riskTier: "external-lock-mint" as const,
            semantics: "lock-mint" as const,
            scope: "peripheral" as const,
            reviewDisposition: "reviewed" as const,
            observedAt: reviewedAt,
            sources: [{ label: "Bridge docs", url: "https://example.com/bridge" }],
          },
        ],
      },
    });
    const researchSourceIds = [
      "stablecoin-meta.bridge-route-risk",
      "stablecoin-meta.mint-authority",
      "stablecoin-meta.oracle-risk",
    ];
    const compileWithReview = (reviewedAt: string) => {
      const fixed = exactFixedInput({ clockSec });
      const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
        metaById: new Map([["alpha", researchReviewMeta(reviewedAt)]]),
      });
      return { baseline, compiled: compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline).assets[0]! };
    };

    // A same-day review is inside the 365-day review window and stays current.
    const current = compileWithReview("2026-07-19");
    expect(current.baseline.assets[0]!.controlReview).toMatchObject({ state: "reviewed-controls" });
    expect(current.compiled.economicControlReview.oracle.status.observationState).toBe("known");
    expect(current.compiled.economicControlReview.mint.status.observationState).toBe("known");
    expect(current.compiled.economicControlReview.bridge.status.observationState).toBe("known");
    for (const sourceId of researchSourceIds) {
      expect(
        current.compiled.evidence.find((candidate) => candidate.sourceId === sourceId),
        `${sourceId} must derive current inside the review window`,
      ).toMatchObject({ freshness: { state: "current", maxAgeSec: V9_REVIEW_EVIDENCE_MAX_AGE_SEC } });
    }

    // A 2024 review is beyond the window: the facts degrade to stale honestly,
    // and the stale reviews no longer carry the umbrella control inventory.
    const stale = compileWithReview("2024-01-01");
    expect(stale.baseline.assets[0]!.controlReview).toBeNull();
    expect(stale.compiled.economicControlReview.oracle.status.observationState).toBe("stale");
    expect(stale.compiled.economicControlReview.mint.status.observationState).toBe("stale");
    expect(stale.compiled.economicControlReview.bridge.status.observationState).toBe("stale");
    for (const sourceId of researchSourceIds) {
      expect(
        stale.compiled.evidence.find((candidate) => candidate.sourceId === sourceId),
        `${sourceId} must derive stale beyond the review window`,
      ).toMatchObject({ freshness: { state: "stale", maxAgeSec: V9_REVIEW_EVIDENCE_MAX_AGE_SEC } });
    }
  });

  it("derives route output valuation freshness on the D11 review cadence", () => {
    const clockSec = Date.UTC(2026, 6, 19) / 1_000;
    const fixed = exactFixedInput({ clockSec });
    const buildBaseline = () =>
      buildSafetyScoreV9BaselineExtension(fixed, {
        metaById: new Map([["alpha", { id: "alpha", mechanismArchetype: "fiat-cash" as const }]]),
      });

    const current = compileSafetyScoreV9FactSetFromFixedInput(fixed, buildBaseline()).assets[0]!;
    expect(current.evidence.find((candidate) => candidate.evidenceId.includes(":route-valuation:"))).toMatchObject({
      freshness: { state: "current", maxAgeSec: V9_REVIEW_EVIDENCE_MAX_AGE_SEC },
    });

    const staleExtension = buildBaseline();
    staleExtension.assets[0]!.routeReviews[0]!.output!.valuation!.observedAtSec =
      clockSec - V9_REVIEW_EVIDENCE_MAX_AGE_SEC - 1;
    const stale = compileSafetyScoreV9FactSetFromFixedInput(fixed, staleExtension).assets[0]!;
    expect(stale.evidence.find((candidate) => candidate.evidenceId.includes(":route-valuation:"))).toMatchObject({
      freshness: { state: "stale", maxAgeSec: V9_REVIEW_EVIDENCE_MAX_AGE_SEC },
    });
    expect(stale.exitRoutes[0]!.output.status.observationState).toBe("stale");
  });

  it("uses the measured adapter freshness window for DEX route evidence", () => {
    const compileMeasured = (adapterProfileId: string, ageSec = 4_000) => {
      const fixed = structuredClone(exactFixedInput());
      const observation = fixed.dexLiqMap.alpha!.exitRouteObservations![0]!;
      observation.evidenceKind = "measured-executable-depth";
      observation.adapterProfileId = adapterProfileId;
      observation.observedAt = AS_OF_SEC - ageSec;
      observation.freshnessSeconds = ageSec;
      fixed.baseInputGenerationId = deriveReportCardsBaseInputGenerationId(fixed);
      const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension()).assets[0]!;
      return compiled.evidence.find((candidate) => candidate.evidenceId.includes(":route:dex:"))!;
    };

    expect(compileMeasured("curve-stableswap-main-registry-get-dy-v1")).toMatchObject({
      freshness: { state: "current", maxAgeSec: 7_200, ageSec: 4_000 },
    });
    expect(compileMeasured("uniswap-v3-quoter-v2")).toMatchObject({
      freshness: { state: "current", maxAgeSec: 7_200, ageSec: 4_000 },
    });
    expect(compileMeasured("uniswap-v3-quoter-v2", 7_201)).toMatchObject({
      freshness: { state: "stale", maxAgeSec: 7_200, ageSec: 7_201 },
    });
  });

  it("derives cdp shock-coverage freshness on the D12 72-hour policy window", () => {
    const maxAgeSec =
      V9_CANDIDATE_POLICY_V1.policy.semantic.backing.structural.cdp.stressMeasurementFreshness.maxAgeSec;
    expect(maxAgeSec).toBe(259_200);
    const measurement = selectSafetyScoreV9CdpShockMeasurement("lusd-liquity", 1_784_225_942);
    if (!measurement || measurement.source === null) throw new Error("Expected a pinned LUSD shock measurement");
    const blockSec = measurement.source.block.timestampUnix;
    const cdpComponent = () => ({ status: status(), quality: "strong" as const, failureDomains: [] });

    const compileWithShockClock = (clockSec: number) => {
      const fixed = exactFixedInput({ clockSec, assetId: "lusd-liquity" });
      const ext = extension();
      ext.compiledAtSec = clockSec;
      ext.registryFingerprint = fixed.registryFingerprint;
      ext.sources.researchOverlays.observedAtSec = clockSec - 100;
      const asset = ext.assets[0]!;
      asset.assetId = "lusd-liquity";
      asset.archetype = "cdp";
      asset.mechanismRiskReview = {
        archetype: "cdp" as const,
        collateralizationRatio: 1.5,
        liquidationCapacityRatio: 0.25,
        metricApplicability: {
          collateralizationRatio: { state: "measured" as const },
          liquidationCapacityRatio: { state: "measured" as const },
        },
        collateralizationParameters: cdpComponent(),
        liquidationMechanics: cdpComponent(),
        backstop: cdpComponent(),
        branchIsolation: cdpComponent(),
        shutdownAndBadDebt: cdpComponent(),
        structuralRedemption: cdpComponent(),
      };
      asset.cdpStressCoverage = measurement;
      return compileSafetyScoreV9FactSetFromFixedInput(fixed, ext).assets[0]!;
    };

    // A measurement inside the 72-hour window stays current.
    const current = compileWithShockClock(blockSec + 100);
    expect(
      current.evidence.find((candidate) => candidate.evidenceId.startsWith("lusd-liquity:cdp-shock-coverage:")),
    ).toMatchObject({ freshness: { state: "current", maxAgeSec } });

    // A measurement older than 72 hours derives stale honestly.
    const stale = compileWithShockClock(blockSec + maxAgeSec + 1);
    expect(
      stale.evidence.find((candidate) => candidate.evidenceId.startsWith("lusd-liquity:cdp-shock-coverage:")),
    ).toMatchObject({ freshness: { state: "stale", maxAgeSec } });
  });

});
