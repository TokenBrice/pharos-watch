import { describe, expect, it } from "vitest";
import { DEX_MEASURED_ADAPTER_PROFILE_IDS } from "@shared/types/measured-execution";
import { compileV9FactSetV3 } from "@shared/lib/safety-score-v9/compile";
import { V9_ACCESS_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/access-posture";
import { V9_REVIEW_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/evidence";
import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import { evaluateV9Exit, projectV9ExitEvaluationRoute } from "@shared/lib/safety-score-v9/exit";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { buildSafetyScoreV9BaselineExtension, type V9ExtensionRegistryMeta } from "../safety-score-v9-extension";
import { buildSafetyScoreV9RetainedRedemptionRoutes, buildSafetyScoreV9RouteReviews } from "../safety-score-v9-extension-routes";
import { getSafetyScoreV9OperationalResilienceOverlay } from "../safety-score-v9-extension-operational-resilience";
import { selectSafetyScoreV9CdpShockMeasurement } from "../safety-score-v9-extension-shock";
import { compileSafetyScoreV9FactSetFromFixedInput, compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension, materializeSafetyScoreV9FactSetExtension } from "../safety-score-v9-fact-set";
import {
  V9_FIXTURE_CLOCK_SEC as AS_OF_SEC,
  V9_EVALUATION_TEST_TIMEOUT_MS,
  makeV9FixedInput as exactFixedInput,
  makeV9TwoAssetFixedInput as exactTwoAssetFixedInput,
  makeV9Extension as extension,
  v9NotApplicableStatus as notApplicableStatus,
  v9ExitRouteObservation as route,
  v9RouteReview as routeReview,
  v9Status as status,
} from "../../test-helpers/v9-fixed-input";
import {
  alphaMeta,
  attestedReserveMeta,
  buildTransferBaseline,
  commodityOracleMeta,
  dependencyMeta,
  deriveReportCardsBaseInputGenerationId,
  metaMap,
  nativeSavingsFixedAndMeta,
  pinnedUusdMeta,
  reviewedDependencyMeta,
  reviewedResearchMeta,
  transferFact,
  usdtMeta,
} from "./safety-score-v9-fact-set.test-support";

describe("Safety Score v9 exact base fact-set adapter — peg and mechanism evidence", { timeout: V9_EVALUATION_TEST_TIMEOUT_MS }, () => {
  it("keeps oracle-free archetypes not-applicable while CDP remains required", () => {
    const mintAuthority = commodityOracleMeta().mintAuthority;
    const oracle = (mechanismArchetype: NonNullable<V9ExtensionRegistryMeta["mechanismArchetype"]>) => buildSafetyScoreV9BaselineExtension(exactFixedInput(), {
      metaById: metaMap(alphaMeta({ mechanismArchetype, mintAuthority })),
    }).assets[0]!.economicControlReview?.oracle.status;
    expect(oracle("commodity-claim")).toMatchObject({ applicability: { state: "not-applicable", rationale: expect.stringContaining("no oracle- or liquidation-dependent") } });
    expect(oracle("cdp")).toMatchObject({ observationState: "missing" });
  });

  it("materializes fuzzy quarter implementation dates at the conservative quarter end", () => {
    const fixed = exactFixedInput({ clockSec: Date.parse("2026-07-28T00:00:00Z") / 1_000 });
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, { metaById: metaMap(alphaMeta({ mechanismArchetype: "synthetic-delta-neutral", implementationLaunchDate: "2024-Q4" })) });
    expect(baseline.assets[0]!.launchedAtSec).toBe(Date.parse("2024-12-31T23:59:59Z") / 1_000);
  });

  it.each([
    ["same-day mechanism admission", "btcusd-btcfi", "2026-08-08T09:17:27.000Z"],
    ["same-day partial mechanism admission", "uusd-anything-labs", "2026-08-08T09:17:27.000Z"],
  ] as const)("attributes %s to the admission method", (_label, assetId, clock) => {
    const fixed = exactFixedInput({ assetId, clockSec: Date.parse(clock) / 1_000 });
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: assetId === "uusd-anything-labs" ? pinnedUusdMeta() : metaMap(alphaMeta({ id: assetId, mechanismArchetype: "cdp" })),
    });
    expect(baseline.assets[0]!.mechanismReviewGapDisposition?.responsibility).toBe("method-unsupported");
    expect(compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline).assets[0]!.gaps).toContainEqual(expect.objectContaining({ reasonCode: "bounded-mechanism-review", responsibility: "method-unsupported" }));
  });

  it("attributes reviewed unavailable mechanism components to issuer nondisclosure after the date gate", () => {
    const fixed = exactFixedInput({ assetId: "uusd-anything-labs", clockSec: Date.parse("2026-08-09T00:00:00Z") / 1_000 });
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, { metaById: pinnedUusdMeta() });
    expect(baseline.assets[0]).not.toHaveProperty("mechanismReviewGapDisposition");
    expect(baseline.assets[0]!.mechanismReviewedUnavailable).toEqual(expect.arrayContaining([
      expect.objectContaining({ componentKey: "assuranceAndReconciliation", reviewedAt: "2026-08-08" }),
      expect.objectContaining({ componentKey: "claimAndSegregation", reviewedAt: "2026-08-08" }),
      expect.objectContaining({ componentKey: "custodyContinuity", reviewedAt: "2026-08-08" }),
    ]));
    const asset = compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline).assets[0]!;
    for (const componentKey of ["assuranceAndReconciliation", "claimAndSegregation", "custodyContinuity"]) expect(asset.gaps).toContainEqual(expect.objectContaining({ path: { kind: "local-component", componentKey: `mechanism-review:${componentKey}` }, responsibility: "issuer-undisclosed", reasonCode: "bounded-mechanism-review" }));
  });

  it("compiles current operational-resilience evidence and rejects a missing evidence binding", () => {
    const clockSec = Date.parse("2026-08-09T00:00:00Z") / 1_000;
    const fixed = exactFixedInput({ assetId: "usdt-tether", clockSec });
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, { metaById: metaMap(usdtMeta()) });
    const overlay = getSafetyScoreV9OperationalResilienceOverlay("usdt-tether", clockSec);
    expect(overlay).not.toBeNull();
    expect(baseline.assets[0]!.operationalResilience).toEqual(overlay);
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline);
    const asset = compiled.assets[0]!;
    expect(asset.evidence.filter((evidence) => evidence.evidenceId.startsWith("usdt-tether:operational-resilience:"))).toHaveLength(23);
    expect(evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!.operationalResilience).toMatchObject({ eligible: true, blockerCodes: [], rawPillarCredits: { backing: 2.55, exit: 1.5, control: 2.55 } });
    const retained = structuredClone(compiled);
    const removed = asset.evidence.find((evidence) => evidence.evidenceId.startsWith("usdt-tether:operational-resilience:"))!.evidenceId;
    retained.assets[0]!.evidence = retained.assets[0]!.evidence.filter((evidence) => evidence.evidenceId !== removed);
    const { v9FactSetDigest: _digest, ...core } = retained;
    expect(() => compileV9FactSetV3(core)).toThrow(`Unknown evidence reference ${removed}`);
  });

  it("keeps operational-resilience captures null before their review window", () => {
    const clockSec = Date.parse("2026-07-23T12:37:18Z") / 1_000;
    const fixed = exactFixedInput({ assetId: "usdt-tether", clockSec });
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, { metaById: metaMap(alphaMeta({ id: "usdt-tether" })) });
    expect(baseline.assets[0]!.operationalResilience).toBeNull();
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline).assets[0]!;
    expect(compiled.operationalResilience).toBeNull();
    expect(compiled.evidence.some((evidence) => evidence.evidenceId.includes("operational-resilience"))).toBe(false);
    const future = getSafetyScoreV9OperationalResilienceOverlay("usdt-tether", Date.parse("2026-07-24T00:00:00Z") / 1_000);
    const injected = structuredClone(baseline);
    injected.assets[0]!.operationalResilience = future;
    expect(() => compileSafetyScoreV9FactSetFromFixedInput(fixed, injected)).toThrow(/outside its exact review window/);
  });

  it.each([
    ["nav", "nav:alpha", "nav"],
    ["VAR", "unreviewed:var", "other"],
    ["OTHER", "unreviewed:other", "other"],
  ] as const)("publishes %s peg metadata as an explicit reference", (pegCurrency, referenceKey, referenceKind) => {
    const fixed = exactFixedInput({ omitPegRow: true });
    const flags: NonNullable<V9ExtensionRegistryMeta["flags"]> = pegCurrency === "nav"
      ? { backing: "rwa-backed" as const, pegCurrency: "USD", governance: "centralized" as const, yieldBearing: true, rwa: true, navToken: true }
      : { backing: "rwa-backed" as const, pegCurrency: pegCurrency as "VAR" | "OTHER", governance: "centralized" as const, yieldBearing: false, rwa: false, navToken: false };
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, { metaById: metaMap(alphaMeta({ flags })) });
    expect(baseline.assets[0]!.pegReference).toMatchObject({ referenceKind, referenceKey });
    expect(compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline).assets[0]!.peg).toMatchObject({ referenceKind, referenceKey });
  });

  it("keeps reviewed dependency edges bounded until live reserve exposure maps them", () => {
    const fixed = exactTwoAssetFixedInput();
    const metaById = dependencyMeta();
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, { metaById });
    expect(baseline.assets.find((asset) => asset.assetId === "alpha")!.dependencies).toMatchObject({ source: "manual", diagnostics: { graphState: "unresolved" }, edges: [{ upstreamAssetId: "beta", weight: 0.5 }] });
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline);
    expect(compiled.assets[0]!.dependencies.status).toMatchObject({ observationState: "bounded-unknown" });
    expect(compiled.assets[0]!.dependencies.edges[0]!.evidenceRefIds).toEqual(compiled.assets[0]!.dependencies.status.evidenceRefIds);
    expect(evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!.scoreInput.dependencyReasons.map((reason) => reason.code)).toContain("unreviewed-dependency-relationships");
    const reviewed = metaById.get("alpha")!.dependencyReview!;
    const weightDrift = new Map(metaById);
    weightDrift.set("alpha", { ...metaById.get("alpha")!, dependencyReview: { ...reviewed, relationships: [{ ...reviewed.relationships[0]!, weight: 0.4 }] } });
    expect(buildSafetyScoreV9BaselineExtension(fixed, { metaById: weightDrift }).assets[0]!.dependencies).toMatchObject({ diagnostics: { graphState: "unresolved" } });
    const structuralDrift = new Map(metaById);
    structuralDrift.set("alpha", { ...metaById.get("alpha")!, dependencyReview: { ...reviewed, relationships: [{ ...reviewed.relationships[0]!, id: "gamma" }] } });
    expect(buildSafetyScoreV9BaselineExtension(fixed, { metaById: structuralDrift }).assets[0]!.dependencies?.diagnostics.issueCodes).toContain("dependency-review-mismatch");
    const mappedFixed = exactTwoAssetFixedInput({ mapAlphaCollateral: true });
    const mapped = buildSafetyScoreV9BaselineExtension(mappedFixed, { metaById });
    const mappedAsset = compileSafetyScoreV9FactSetFromFixedInput(mappedFixed, mapped).assets[0]!;
    expect(mappedAsset.dependencies.status.observationState).toBe("known");
    expect(mappedAsset.reserveExposures).toContainEqual(expect.objectContaining({ trackedAssetId: "beta", weight: 0.5, status: expect.objectContaining({ observationState: "known" }) }));
    expect(evaluateV9FactSet(compileSafetyScoreV9FactSetFromFixedInput(mappedFixed, mapped), V9_CANDIDATE_POLICY_V1).assets[0]!.scoreInput.dependencyReasons.map((reason) => reason.code)).not.toContain("unreviewed-dependency-relationships");
    const liveMeta = new Map(metaById);
    liveMeta.set("alpha", { ...metaById.get("alpha")!, ...reviewedDependencyMeta() });
    const live = compileSafetyScoreV9FactSetFromFixedInput(mappedFixed, buildSafetyScoreV9BaselineExtension(mappedFixed, { metaById: liveMeta })).assets[0]!;
    expect(live.dependencies).toMatchObject({ source: "live-reserve", dependencyFromLive: true, diagnostics: { graphState: "valid" } });
    const nullClassified = structuredClone(mapped);
    nullClassified.assets[0]!.reserveClassifications.find((classification) => classification.issuerOrObligorKey === "asset:beta")!.assetClass = null;
    expect(compileSafetyScoreV9FactSetFromFixedInput(mappedFixed, nullClassified).assets[0]!.reserveExposures).toContainEqual(expect.objectContaining({ trackedAssetId: "beta", assetClass: "stablecoin" }));
    const mismatch = structuredClone(mapped);
    mismatch.assets[0]!.dependencies!.edges[0]!.weight = 0.4;
    expect(compileSafetyScoreV9FactSetFromFixedInput(mappedFixed, mismatch).assets[0]!.dependencies).toMatchObject({ status: { observationState: "bounded-unknown" }, diagnostics: { graphState: "unresolved" } });
  });

  it("preserves duplicate dependency roles as distinct V3 paths", () => {
    const fixed = exactTwoAssetFixedInput({ omitAlphaReserve: true });
    const meta = alphaMeta({ dependencies: [{ id: "beta", weight: 1, type: "mechanism" }], dependencyReview: {
      reviewedAt: "1970-01-01", reviewer: "Fixture reviewer", confidence: "verified", sources: [{ label: "Role review", url: "https://example.com/dependencies/alpha" }], rationale: "Beta supplies both reviewed paths.",
      relationships: [{ id: "beta", weight: 1, type: "mechanism", economicRole: "exit-dependency", reason: "Beta is the redemption output." }, { id: "beta", weight: 1, type: "mechanism", economicRole: "oracle-nav", reason: "Beta is the reference unit." }],
    } });
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, buildSafetyScoreV9BaselineExtension(fixed, { metaById: metaMap(meta, alphaMeta({ id: "beta" })) }));
    expect(compiled.assets[0]!.dependencies.edges).toEqual([
      expect.objectContaining({ edgeKey: "exit-dependency:mechanism:beta", economicRole: "exit-dependency", pathKind: "local-component" }),
      expect.objectContaining({ edgeKey: "oracle-nav:mechanism:beta", economicRole: "oracle-nav", pathKind: "local-component" }),
    ]);
  });

  it("shares documented-redemption admission with native savings exit evaluation", () => {
    const { fixed, meta } = nativeSavingsFixedAndMeta();
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, { metaById: meta });
    const asset = baseline.assets[0]!;
    asset.routeReviews = buildSafetyScoreV9RouteReviews(fixed, "alpha");
    asset.retainedRoutes = buildSafetyScoreV9RetainedRedemptionRoutes(fixed, "alpha");
    asset.economicControlReview = {
      mint: { status: notApplicableStatus("v9.control.mint-review"), controlKey: null, reconciliation: "not-applicable", supervision: "none", latestResolvedIncidentAtSec: null, upgrade: { state: "not-applicable", controlKey: null } },
      oracle: { status: notApplicableStatus("v9.control.oracle-review"), tier: null, branches: [] },
      bridge: { status: notApplicableStatus("v9.control.bridge-review"), routes: [] },
    };
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline);
    const compiledAlpha = compiled.assets[0]!;
    const documentedRoute = compiledAlpha.exitRoutes.find((route) => route.lane === "redemption")!;
    expect(documentedRoute).toMatchObject({ scoreEligible: false, status: { observationState: "known" } });
    const evaluated = evaluateV9Exit({ circulatingUsd: compiledAlpha.supply.circulatingUsd, portfolioStatus: "reviewed-complete", routes: compiledAlpha.exitRoutes.map(projectV9ExitEvaluationRoute) }, V9_CANDIDATE_POLICY_V1);
    expect(evaluated.routes.find((route) => route.routeKey === documentedRoute.routeKey)).toMatchObject({ included: true });
    expect(compiledAlpha.peg).toMatchObject({ status: { observationState: "known" }, referenceKind: "nav" });
    expect(compiledAlpha.wrapperLocalFacts).toMatchObject({ applicability: "wrapper", form: "native-staked", facts: { strategyComplexity: { assessment: "low" }, measuredUnwind: { assessment: "none" } } });
  });

  it("admits only live-backed or explicitly eligible reserve compositions", () => {
    const meta = alphaMeta({ reserves: [{ name: "Beta stablecoin", pct: 50, risk: "low", coinId: "beta", depType: "collateral" }] });
    const missing = exactTwoAssetFixedInput({ omitAlphaReserve: true, liveToFallbackCoins: ["alpha"] });
    const curated = buildSafetyScoreV9BaselineExtension(missing, { metaById: metaMap(meta, alphaMeta({ id: "beta" })) });
    const curatedAsset = compileSafetyScoreV9FactSetFromFixedInput(missing, curated).assets[0]!;
    expect(curatedAsset.gaps).toContainEqual(expect.objectContaining({ reasonCode: "missing-reserve-composition" }));
    expect(curatedAsset.dependencies.status.observationState).toBe("known");
    const noAdapter = exactTwoAssetFixedInput({ omitAlphaReserve: true });
    const noAdapterAsset = compileSafetyScoreV9FactSetFromFixedInput(noAdapter, buildSafetyScoreV9BaselineExtension(noAdapter, { metaById: metaMap(meta, alphaMeta({ id: "beta" })) })).assets[0]!;
    expect(noAdapterAsset.dependencies.edges).toEqual([]);
    expect(noAdapterAsset.gaps).toContainEqual(expect.objectContaining({ reasonCode: "missing-reserve-composition" }));
    expect(buildSafetyScoreV9BaselineExtension(exactTwoAssetFixedInput(), { metaById: metaMap(meta, alphaMeta({ id: "beta" })) }).assets[0]!.dependencies).toMatchObject({ diagnostics: { graphState: "unresolved" } });
  });

  it("compiles eligible issuer-attested reserves, independent reports, and curated fallbacks", () => {
    const noLive = exactFixedInput({ omitLiveReserve: true });
    const meta = attestedReserveMeta();
    const issuer = buildSafetyScoreV9BaselineExtension(noLive, { metaById: metaMap(meta) });
    expect(issuer.assets[0]!.reviewedStaticReserveRows).toMatchObject({ evidenceClass: "issuer-attested" });
    expect(compileSafetyScoreV9FactSetFromFixedInput(noLive, issuer).assets[0]!.reserveExposures).toHaveLength(2);
    const independentMeta = { ...meta, reserveReview: { ...meta.reserveReview!, sources: meta.proofOfReserves!.latestReport!.sources } };
    expect(buildSafetyScoreV9BaselineExtension(noLive, { metaById: metaMap(independentMeta) }).assets[0]!.reviewedStaticReserveRows).toMatchObject({ evidenceClass: "independent" });
    expect(buildSafetyScoreV9BaselineExtension(exactFixedInput(), { metaById: metaMap(meta) }).assets[0]!.reviewedStaticReserveRows).toBeNull();
    const fallback = structuredClone(noLive);
    fallback.liveToFallbackCoins = ["alpha"];
    fallback.baseInputGenerationId = deriveReportCardsBaseInputGenerationId(fallback);
    const fallbackMeta: V9ExtensionRegistryMeta = { ...meta, proofOfReserves: undefined, liveReservesConfig: { adapter: "curated-validated", version: 1, semantics: "collateral-mix", inputs: { primary: { kind: "onchain-solana" } } }, mintAuthority: { ...meta.mintAuthority!, supervision: "attestation-only" as const } } as V9ExtensionRegistryMeta;
    expect(buildSafetyScoreV9BaselineExtension(fallback, { metaById: metaMap(fallbackMeta) }).assets[0]!.reviewedStaticReserveRows).toMatchObject({ evidenceClass: "static-validated", provenance: "curated-fallback" });
    const standalone = buildSafetyScoreV9BaselineExtension(fallback, { metaById: metaMap({ ...fallbackMeta, liveReservesConfig: undefined }) });
    expect(standalone.assets[0]!.reviewedStaticReserveRows).toMatchObject({ evidenceClass: "static-validated", provenance: "curated" });
    expect(buildSafetyScoreV9BaselineExtension(exactFixedInput({ omitLiveReserve: true }), { metaById: metaMap({ ...fallbackMeta, variantOf: "beta" } as V9ExtensionRegistryMeta) }).assets[0]!.reviewedStaticReserveRows).toBeNull();
  });

  it("reclassifies evidenced structural freeze dispositions without changing score state", () => {
    const bounded = { applicability: { state: "required" as const, policyRuleId: "v9.access.freeze-review", rationale: null, gapId: null }, observationState: "bounded-unknown" as const, evidenceRefIds: ["placeholder:evidence"], gapIds: ["placeholder:gap"] };
    const reviewed = structuredClone(extension());
    const freeze = reviewed.assets[0]!.accessReview!.freeze;
    freeze.status = structuredClone(bounded);
    freeze.reviews = [{ reviewKey: "blacklist:alpha", source: "upstream", status: structuredClone(bounded), reach: "possible", controlKey: null, upstreamAssetId: "alpha", failureDomains: [{ kind: "mint-control", key: "asset:alpha" }] }];
    freeze.structuralDisposition = "inherited-upstream";
    const gaps = (asset: { gaps: Array<{ gapId: string; reasonCode: string; responsibility: string }> }) => asset.gaps.filter((gap) => gap.gapId.includes(":gap:access:freeze"));
    expect(gaps(compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), reviewed).assets[0]!).every((gap) => gap.reasonCode === "inherited-access-exposure" && gap.responsibility === "measured-adverse")).toBe(true);
    const missing = structuredClone(reviewed);
    delete missing.assets[0]!.accessReview!.freeze.structuralDisposition;
    expect(gaps(compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), missing).assets[0]!).every((gap) => gap.reasonCode === "missing-access-review")).toBe(true);
    const possible = structuredClone(reviewed);
    possible.assets[0]!.accessReview!.freeze.structuralDisposition = "reviewed-possible";
    possible.assets[0]!.accessReview!.freeze.reviews[0] = { ...possible.assets[0]!.accessReview!.freeze.reviews[0]!, source: "blacklist", upstreamAssetId: null, failureDomains: [] };
    expect(gaps(compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), possible).assets[0]!).every((gap) => gap.reasonCode === "reviewed-possible-access")).toBe(true);
  });

  it("distinguishes measured, stale, and producer-failed supply-floor peg gaps", () => {
    const pegGaps = (fixed: ReturnType<typeof exactFixedInput>) => compileSafetyScoreV9FactSetFromFixedInput(fixed, extension()).assets[0]!.gaps.filter((gap) => gap.reasonCode === "peg-supply-floor-withheld" || gap.reasonCode === "missing-peg-input");
    expect(pegGaps(exactFixedInput({ currentDeviationBps: null, depegEventCoverageLimited: true }))).toMatchObject([{ reasonCode: "peg-supply-floor-withheld", responsibility: "measured-adverse" }]);
    expect(pegGaps(exactFixedInput({ currentDeviationBps: null, depegEventCoverageLimited: true, pegObservedAtSec: AS_OF_SEC - 1_000 }))).toMatchObject([{ reasonCode: "missing-peg-input", observationState: "stale" }]);
    expect(pegGaps(exactFixedInput({ currentDeviationBps: null }))).toMatchObject([{ reasonCode: "missing-peg-input", responsibility: "producer-failed" }]);
  });

  it("keeps active depeg evidence bounded when the peak is unavailable", () => {
    const active = compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput({ pegScore: 27, currentDeviationBps: null, activeDepeg: true, activeDepegPeakBps: 5_783 }), extension()).assets[0]!;
    expect(active.peg).toMatchObject({ status: { observationState: "bounded-unknown" }, activeDepeg: true, activeDepegBps: 5_783 });
    expect(active.gaps).toContainEqual(expect.objectContaining({ reasonCode: "missing-peg-input" }));
    const missing = compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput({ pegScore: 27, currentDeviationBps: null, activeDepeg: true }), extension()).assets[0]!;
    expect(missing.peg).toMatchObject({ status: { observationState: "bounded-unknown" }, activeDepeg: null, activeDepegBps: null });
    expect(missing.gaps).toContainEqual(expect.objectContaining({ reasonCode: "missing-peg-input", responsibility: "producer-failed" }));
  });

  it.each([
    ["xtusd-xt", { eventCount: 0, worstDeviationBps: null }, 0],
    ["nxusd-nereus", { eventCount: 1, worstDeviationBps: -376 }, null],
  ] as const)("handles %s quiet-history peg rows without fabricating observations", (assetId, history, currentDeviationBps) => {
    const fixed = exactFixedInput({ assetId, pegScore: 100, currentDeviationBps, activeDepeg: false, ...history, lastEventAt: history.eventCount ? AS_OF_SEC - 1 : null, pegPct: 100, severityScore: 100, spreadPenalty: 0 });
    const reviewed = extension();
    reviewed.registryFingerprint = fixed.registryFingerprint;
    reviewed.assets[0]!.assetId = assetId;
    const asset = compileSafetyScoreV9FactSetFromFixedInput(fixed, reviewed).assets[0]!;
    expect(asset.peg.currentDeviationBps).toBe(currentDeviationBps);
    if (currentDeviationBps === null) expect(asset.gaps).toContainEqual(expect.objectContaining({ reasonCode: "missing-peg-input" }));
    else expect(asset.gaps.map((gap) => gap.reasonCode)).not.toContain("missing-peg-input");
  });

  it("canonicalizes extension ordering and retains the exact fact-set digest", () => {
    const ordered = extension();
    const reversed = structuredClone(ordered);
    const review = reversed.assets[0]!.routeReviews[0]!;
    review.executionCosts.reverse();
    review.failureDomains.reverse();
    review.physicalResourceKeys.reverse();
    const mechanism = reversed.assets[0]!.mechanismRiskReview!;
    if (mechanism.archetype !== "fiat-cash") throw new Error("Fixture archetype changed");
    mechanism.claimAndSegregation.status.evidenceRefIds = ["other:placeholder"];
    const left = compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), ordered);
    const right = compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), reversed);
    expect(right).toEqual(left);
    expect(right.v9FactSetDigest).toBe(left.v9FactSetDigest);
  });

  it("rebinds non-measured metric evidence to mechanism-review evidence", () => {
    const cdp = extension();
    cdp.assets[0]!.archetype = "cdp";
    cdp.assets[0]!.mechanismRiskReview = {
      archetype: "cdp", collateralizationRatio: 1.5, liquidationCapacityRatio: null,
      metricApplicability: { collateralizationRatio: { state: "measured" }, liquidationCapacityRatio: { state: "not-applicable", rationale: "No liquidation venue exists for this fixture branch.", evidenceRefIds: ["extension-evidence:mechanism:liquidation-capacity-ratio"] } },
      collateralizationParameters: { status: status(), quality: "strong", failureDomains: [] }, liquidationMechanics: { status: status(), quality: "strong", failureDomains: [] }, backstop: { status: status(), quality: "strong", failureDomains: [] }, branchIsolation: { status: status(), quality: "strong", failureDomains: [] }, shutdownAndBadDebt: { status: status(), quality: "strong", failureDomains: [] }, structuralRedemption: { status: status(), quality: "strong", failureDomains: [] },
    };
    const cdpAsset = compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), cdp).assets[0]!;
    const cdpReview = cdpAsset.mechanismRiskReview.review;
    if (!cdpReview || cdpReview.archetype !== "cdp") throw new Error("Expected CDP mechanism review");
    expect(cdpReview.metricApplicability.liquidationCapacityRatio).toMatchObject({ state: "not-applicable", evidenceRefIds: ["alpha:research-overlay"] });
    const rwa = extension();
    rwa.assets[0]!.archetype = "rwa-credit-fund";
    const component = { status: status(), quality: "limited" as const, failureDomains: [] };
    rwa.assets[0]!.mechanismRiskReview = { archetype: "rwa-credit-fund", weightedAverageMaturityDays: null, valuationCadenceDays: 30, metricApplicability: { weightedAverageMaturityDays: { state: "unavailable", rationale: "No maturity ladder.", evidenceRefIds: ["extension-evidence:mechanism:wam"] }, valuationCadenceDays: { state: "measured" } }, creditQuality: component, seniority: component, legalEnforceability: component, valuationCadence: component, maturityAndLiquidity: component, custody: component, recovery: component };
    const rwaAsset = compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), rwa).assets[0]!;
    const rwaReview = rwaAsset.mechanismRiskReview.review;
    if (!rwaReview || rwaReview.archetype !== "rwa-credit-fund") throw new Error("Expected RWA mechanism review");
    expect(rwaReview.metricApplicability?.weightedAverageMaturityDays).toMatchObject({ state: "unavailable", evidenceRefIds: ["alpha:research-overlay"] });
  });

  it("turns unavailable dimensions into typed gaps and keeps causal output ownership", () => {
    const incomplete = extension();
    const asset = incomplete.assets[0]!;
    asset.mechanismRiskReview = null;
    asset.dependencies = null;
    asset.controlReview = null;
    asset.economicControlReview = null;
    asset.accessReview = null;
    asset.supplyReview = null;
    asset.routeReviews[0]!.output!.valuation = null;
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput({ classifiedReserve: false }), incomplete);
    expect(compiled.assets[0]!.gaps.map((gap) => gap.reasonCode)).toEqual(expect.arrayContaining(["material-reserve-slice-unstructured", "unresolved-exit-output", "unreviewed-dependency-relationships", "missing-upgradeability-review", "missing-mint-authority", "missing-oracle-profile", "missing-bridge-routes"]));
    for (const responsibility of ["producer-failed", "issuer-undisclosed"] as const) {
      const reviewed = extension();
      reviewed.assets[0]!.routeReviews[0]!.output = null;
      reviewed.assets[0]!.routeReviews[0]!.unresolvedOutputResponsibility = responsibility;
      expect(compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), reviewed).assets[0]!.gaps).toContainEqual(expect.objectContaining({ reasonCode: "unresolved-exit-output", responsibility }));
    }
  });

  it("preserves supplied stale and rejected route observations", () => {
    const reviewed = extension();
    reviewed.assets[0]!.retainedRoutes = [
      { lane: "dex", observation: route("dex:stale", 8_000), disposition: "observed", rejection: null },
      { lane: "dex", observation: route("dex:rejected", 9_800), disposition: "rejected", rejection: { code: "unsupported-pool", reason: "Producer rejected the pool model.", rejectedAtSec: 9_900 } },
    ];
    reviewed.assets[0]!.routeReviews = [routeReview(), routeReview("dex:stale", 8_000), routeReview("dex:rejected", 9_800)];
    const asset = compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), reviewed).assets[0]!;
    expect(asset.exitRoutes.find((route) => route.routeId === "dex:stale")).toMatchObject({ status: { observationState: "stale" } });
    expect(asset.exitRoutes.find((route) => route.routeId === "dex:rejected")).toMatchObject({ status: { observationState: "unsupported" }, scoreEligible: false });
  });

  it("rejects reconstructed inputs, score-shaped fields, active-set drift, and conflicting outputs", () => {
    expect(() => compileSafetyScoreV9FactSetFromFixedInput({ cards: [], overallScore: 99 }, extension())).toThrow(/Malformed fixed report-card input/);
    expect(() => compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), { ...extension(), overallScore: 99 })).toThrow(/Unrecognized key/);
    const shaped = extension();
    expect(() => compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), { ...shaped, assets: [{ ...shaped.assets[0]!, dimensions: {}, baseScore: 99 }] })).toThrow(/Unrecognized key/);
    const wrong = extension();
    wrong.assets[0]!.assetId = "beta";
    expect(() => compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), wrong)).toThrow(/active set mismatch/);
    const conflicting = extension();
    conflicting.assets[0]!.routeReviews[0]!.output!.assetKeys = ["fiat:EUR"];
    const materialized = materializeSafetyScoreV9FactSetExtension(exactFixedInput(), conflicting);
    expect(compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension(exactFixedInput(), materialized).quarantines).toEqual([{ assetId: "alpha", code: "fact-build-failed" }]);
  });

  it("prefers reviewed transfer facts and preserves absent, mismatched, and stale fallbacks", () => {
    const fixed = exactFixedInput();
    const build = (reviewedStatus: true | false | "possible", transfer?: ReturnType<typeof transferFact>, input = fixed, options: Parameters<typeof buildTransferBaseline>[3] = {}) => buildTransferBaseline(input, reviewedStatus, transfer, options);
    expect(compileSafetyScoreV9FactSetFromFixedInput(fixed, build(true)).assets[0]!.accessReview.transfer).toMatchObject({ posture: "restrictable", status: { observationState: "known" } });
    expect(compileSafetyScoreV9FactSetFromFixedInput(fixed, build(false)).assets[0]!.accessReview.transfer).toMatchObject({ posture: null, status: { observationState: "missing" } });
    expect(compileSafetyScoreV9FactSetFromFixedInput(fixed, build("possible")).assets[0]!.accessReview.transfer).toMatchObject({ posture: null, status: { observationState: "bounded-unknown" } });
    for (const posture of ["permissionless", "restrictable", "permissioned"] as const) expect(compileSafetyScoreV9FactSetFromFixedInput(fixed, build(true, transferFact(posture))).assets[0]!.accessReview.transfer).toMatchObject({ posture });
    const wrong = transferFact("permissionless");
    wrong.deployments[0]!.contractOrTokenId = "0xwrong";
    expect(compileSafetyScoreV9FactSetFromFixedInput(fixed, build(true, wrong)).assets[0]!.accessReview.transfer.status.observationState).toBe("bounded-unknown");
    const stale = exactFixedInput({ clockSec: V9_ACCESS_EVIDENCE_MAX_AGE_SEC + 1 });
    expect(compileSafetyScoreV9FactSetFromFixedInput(stale, build(true, transferFact("permissionless"), stale, { blacklistReviewedAt: "1971-01-01" })).assets[0]!.accessReview.transfer.status.observationState).toBe("stale");
  });

  it("derives research, route, measured-adapter, and CDP shock freshness windows", () => {
    const clockSec = Date.UTC(2026, 6, 19) / 1_000;
    const compileResearch = (reviewedAt: string) => {
      const fixed = exactFixedInput({ clockSec });
      const baseline = buildSafetyScoreV9BaselineExtension(fixed, { metaById: metaMap(reviewedResearchMeta(reviewedAt)) });
      return { baseline, asset: compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline).assets[0]! };
    };
    const current = compileResearch("2026-07-19");
    expect(current.asset.economicControlReview.oracle.status.observationState).toBe("known");
    for (const sourceId of ["stablecoin-meta.bridge-route-risk", "stablecoin-meta.mint-authority", "stablecoin-meta.oracle-risk"]) expect(current.asset.evidence.find((evidence) => evidence.sourceId === sourceId)).toMatchObject({ freshness: { state: "current", maxAgeSec: V9_REVIEW_EVIDENCE_MAX_AGE_SEC } });
    expect(compileResearch("2024-01-01").asset.economicControlReview.oracle.status.observationState).toBe("stale");
    const fixed = exactFixedInput({ clockSec });
    const base = buildSafetyScoreV9BaselineExtension(fixed, { metaById: metaMap(alphaMeta()) });
    expect(compileSafetyScoreV9FactSetFromFixedInput(fixed, base).assets[0]!.evidence.find((evidence) => evidence.evidenceId.includes(":route-valuation:"))).toMatchObject({ freshness: { state: "current", maxAgeSec: V9_REVIEW_EVIDENCE_MAX_AGE_SEC } });
    const staleExtension = buildSafetyScoreV9BaselineExtension(fixed, { metaById: metaMap(alphaMeta()) });
    staleExtension.assets[0]!.routeReviews[0]!.output!.valuation!.observedAtSec = clockSec - V9_REVIEW_EVIDENCE_MAX_AGE_SEC - 1;
    expect(compileSafetyScoreV9FactSetFromFixedInput(fixed, staleExtension).assets[0]!.exitRoutes[0]!.output.status.observationState).toBe("stale");
    const compileMeasured = (adapterProfileId: string) => {
      const measured = structuredClone(exactFixedInput());
      const observation = measured.dexLiqMap.alpha!.exitRouteObservations![0]!;
      observation.evidenceKind = "measured-executable-depth";
      observation.adapterProfileId = adapterProfileId;
      observation.observedAt = AS_OF_SEC - 4_000;
      observation.freshnessSeconds = 4_000;
      measured.baseInputGenerationId = deriveReportCardsBaseInputGenerationId(measured);
      return compileSafetyScoreV9FactSetFromFixedInput(measured, extension()).assets[0]!.evidence.find((evidence) => evidence.evidenceId.includes(":route:dex:"))!;
    };
    for (const profile of [DEX_MEASURED_ADAPTER_PROFILE_IDS.curveStableSwap, "uniswap-v3-quoter-v2"]) expect(compileMeasured(profile)).toMatchObject({ freshness: { state: "current", maxAgeSec: 10_800 } });
    const measurement = selectSafetyScoreV9CdpShockMeasurement("lusd-liquity", 1_784_225_942);
    if (!measurement?.source) throw new Error("Expected a pinned LUSD shock measurement");
    const shockClock = measurement.source.block.timestampUnix + 100;
    const fixedShock = exactFixedInput({ assetId: "lusd-liquity", clockSec: shockClock });
    const shock = extension({ assetId: "lusd-liquity", clockSec: shockClock });
    shock.assets[0]!.archetype = "cdp";
    shock.assets[0]!.cdpStressCoverage = measurement;
    const component = { status: status(), quality: "strong" as const, failureDomains: [] };
    shock.assets[0]!.mechanismRiskReview = { archetype: "cdp", collateralizationRatio: 1.5, liquidationCapacityRatio: 0.25, metricApplicability: { collateralizationRatio: { state: "measured" }, liquidationCapacityRatio: { state: "measured" } }, collateralizationParameters: component, liquidationMechanics: component, backstop: component, branchIsolation: component, shutdownAndBadDebt: component, structuralRedemption: component };
    shock.registryFingerprint = fixedShock.registryFingerprint;
    expect(compileSafetyScoreV9FactSetFromFixedInput(fixedShock, shock).assets[0]!.evidence.find((evidence) => evidence.evidenceId.includes(":cdp-shock-coverage:"))).toMatchObject({ freshness: { state: "current", maxAgeSec: 259_200 } });
  });
});
