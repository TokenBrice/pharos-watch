import { describe, expect, it } from "vitest";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/constants";
import { DEX_ROUTE_CAPABILITY_MATRIX_VERSION } from "@shared/lib/p4-exit-route-capability-policy";
import { DEX_MEASURED_ADAPTER_PROFILE_IDS as PROF_IDS } from "@shared/types/measured-execution";
import { evaluateV9Exit as evalExit, projectV9ExitEvaluationRoute as projExit, resolveV9DistinctExitCapacity as distCap } from "@shared/lib/safety-score-v9/exit";
import { V9_CANDIDATE_POLICY_V1 as POL } from "@shared/lib/safety-score-v9/policy";
import { getRedemptionBackstopConfig as getCfg, resolveReviewedRedemptionSettlement as resSettle, type RedemptionBackstopConfig as Cfg } from "@shared/lib/redemption-backstops";
import { fixedFee } from "@shared/lib/redemption-backstop-configs/shared";
import type { ExitExecutionCertificate as ExecCert, ExitRouteObservation as RouteObs } from "@shared/types/exit-route";
import { asRawDeviationBps, type ReferenceAdmission as RefAdm } from "@shared/types/reference-admission";
import { evaluateReferenceAdmission as evalRef, REFERENCE_INTRADAY_BUDGET_SEC as INTRADAY_SEC } from "@shared/lib/reference-admission";
import type { RedemptionBackstopEntry as RedEnt } from "@shared/types/redemption";
import type { ReportCardsFixedInput as FixedIn } from "../report-cards-fixed-input";
import type { SafetyScoreV9CompilerInput as CompIn } from "../safety-score-v9/native-input";
import { createReportCardsFixedInput as mkFixedIn } from "../../test-helpers/report-cards-fixed-input";
import { buildSafetyScoreV9BaselineExtensionFromNormalizedInput as buildBaseExt } from "../safety-score-v9/extension";
import { compileSafetyScoreV9FactSetFromFixedInput as compileFacts } from "../safety-score-v9/fact-set";
import { makeV9FixedInput as mkFixed, makeV9Extension as mkExt, makeV9QueuedRedemptionFixedInput as mkQueued } from "../../test-helpers/v9-fixed-input";
import { rebuildFixed } from "./safety-score-v9-fact-set.test-support";
import { buildSafetyScoreV9RetainedRedemptionRoutes as retRed, buildSafetyScoreV9RetainedRoutes as retRoutes, buildSafetyScoreV9RouteReviews as routeRevs } from "../safety-score-v9/extension-routes";
import { buildRedemptionExitRouteObservation as buildRedObs } from "../redemption-exit-route-observations";
import { makeSupplyFullRedemption as mkFull } from "./redemption-backstops-store.test-support";
import { dexRouteObservation as dexObs, withRedemptionBackstopConfig as withCfg } from "./safety-score-v9-extension-routes.test-support";
import { makeExitRoute } from "@shared/lib/__tests__/safety-score-v9-exit.test-support";
import { makeExecutionCertificate as mkCert } from "@shared/lib/__tests__/safety-score-v9-exit-execution.test-support";
import { exitExecutionInputGenerationId as execInGen, exitExecutionReviewDigest as execRevDig, validateExitExecutionModelReviews as valExecRevs } from "@shared/lib/safety-score-v9/exit-execution";
import { domainDigest } from "@shared/lib/safety-score-v9/primitives";
import executionReviews from "@shared/data/safety-score-v9/exit-execution-model-reviews-v1.json";

const utc = (...a: Parameters<typeof Date.UTC>) => Date.UTC(...a) / 1e3;
const iso = (s: string) => Date.parse(s) / 1e3;
const NOW = utc(2026, 6, 13), V9_CLK = utc(2027, 0, 1), DAY = 86_400;
const USDC = "usdc-circle", USDT = "usdt-tether", DAI = "dai-makerdao", THBILL = "thbill-theo", EURC = "eurc-circle", USDAF = "usdaf-asymmetry";
const USD = { kind: "fiat" as const, currency: "USD" };
const trk = (...trackedAssetIds: string[]) => ({ kind: "tracked-stablecoin" as const, trackedAssetIds });
const outPx = (priceUsd: number, ov: Record<string, unknown> = {}) => ({ priceUsd, sourceId: "coingecko", observedAtSec: NOW, confidence: "high" as const, admission: "multi-source" as const, ...ov });
const rev0 = (input: CompIn, id: string) => routeRevs(input, id)[0]!;
const val0 = (input: CompIn, id: string) => rev0(input, id)?.output?.valuation;
const setObs = (r: RedEnt, obs: RouteObs[]) => { r.capacityProfile = { ...r.capacityProfile!, exitRouteObservations: obs }; };
const setRawPeg = (f: FixedIn, p: Record<string, unknown>) => { (f as { pegDataById: Record<string, unknown> }).pegDataById = p; };
const setDex = (f: FixedIn, m: Record<string, unknown>) => { (f as { dexLiqMap: Record<string, unknown> }).dexLiqMap = m; };
const costPts = (pairs: readonly [number, number][]) => pairs.map(([requestedNotionalUsd, executionCostBps]) => ({ requestedNotionalUsd, maxCostBps: 200, executionCostBps }));

const singleDex = (route: RouteObs): Record<string, unknown> => ({
  exitRouteObservations: [route],
  exitRouteObservationCoverage: {
    status: "populated", capabilityMatrixVersion: DEX_ROUTE_CAPABILITY_MATRIX_VERSION, retainedPoolCount: 1,
    observationCount: 1, scoreEligibleObservationCount: 1, scoreEligiblePoolCount: 1, scoreEligibleCapabilityPoolCount: 1,
    unsupportedPoolCount: 0, evidenceCounts: { "reserve-based-amm-simulation": 1 }, unsupportedReasons: {},
  },
});

const stub = (row: RedEnt | undefined, clockSec = NOW): FixedIn => ({
  clockSec, dexGenerationId: "dex-liquidity-1", redemptionGenerationId: "redemption-backstops-1",
  dexLiqMap: {}, redemptionBackstopMap: row ? { [row.stablecoinId]: row } : {}, pegDataById: {},
}) as unknown as FixedIn;

const obs0 = (row: RedEnt, clockSec = NOW) => retRed(stub(row, clockSec), row.stablecoinId)[0]!.observation;

function setPeg(f: FixedIn, map: Record<string, unknown>): void {
  setRawPeg(f, Object.fromEntries(Object.entries(map).map(([id, peg]) => [id, { priceObservedAt: f.clockSec - 30, ...(peg as object) }])));
}

function withFx(f: FixedIn, id: string) {
  const c = f.clockSec;
  return Object.assign(f, { pegEvidenceById: { [id]: { referenceAdmission: {
    status: "admitted", reason: "live-reference", kind: "fx", source: "openExchangeRates", cadence: "intraday",
    quoteObservedAtSec: f.pegDataById[id]!.priceObservedAt!, referenceObservedAtSec: c - 60,
    decisionAtSec: c, budgetSec: 21_600, generation: "fixture-fx", sessionOpenedAtSec: null, policyVersion: 1,
  } satisfies RefAdm } } });
}

function redFx({ rowOverrides, output, pegDataById, clockSec = NOW, observationClockSec }: {
  rowOverrides: Partial<RedEnt>; output?: RouteObs["output"]; pegDataById?: Record<string, unknown>; clockSec?: number; observationClockSec?: number;
}) {
  const row = mkFull(rowOverrides);
  setObs(row, [{ ...obs0(row, observationClockSec ?? clockSec), ...(output ? { output } : {}) }]);
  const fixedInput = stub(row, clockSec);
  setPeg(fixedInput, pegDataById ?? {});
  return { fixedInput, row };
}

function dexFx({ assetId, routeOverrides, pegDataById = {}, clockSec = NOW }: {
  assetId: string; routeOverrides: Pick<RouteObs, "routeId" | "output"> & Partial<RouteObs>; pegDataById?: Record<string, unknown>; clockSec?: number;
}) {
  const fixedInput = stub(undefined, clockSec), route = dexObs(clockSec, routeOverrides);
  setDex(fixedInput, { [assetId]: singleDex(route) });
  setPeg(fixedInput, pegDataById);
  return { fixedInput, route };
}

function certDexFx() {
  const { fixedInput, route } = dexFx({ assetId: "alpha", routeOverrides: { routeId: "dex:alpha:certified-basket", maxCostBps: 500, output: trk(USDC, USDT) } });
  const leg = { assetKey: USDC, deployment: "ethereum:usdc", rawUnits: "300000000000", decimals: 6, unitValueUsd: 0.9, expectedUnitValueUsd: 1, sourceId: "fixture:price", sourceGenerationId: "fixture:price:1", observedAtSec: NOW - 5 };
  const certificate: ExecCert = {
    modelId: "stable-basket-withdraw", reviewDigest: "a".repeat(64),
    identity: { assetId: "alpha", deployment: "ethereum:alpha", endpoint: "withdraw", outputAssetKeys: [USDC, USDT], implementationIdentity: "fixture:implementation" },
    inputGenerationId: "fixture:input:1", observationGenerationId: "fixture:execution:1", observedAtSec: NOW, sourceMaxAgeSec: 300, priceMaxAgeSec: 300,
    source: { kind: "block", number: 100, hash: "fixture:block", timestamp: NOW, complete: true, truncated: false },
    holder: "any-holder", prerequisites: [],
    gates: [{ gateId: "execution", verdict: "passed", evidenceId: "fixture:execution", observedAtSec: NOW, reason: null }],
    inputReference: { ...leg, assetKey: "alpha", deployment: "ethereum:alpha", unitValueUsd: 1 }, feeReferences: [],
    points: [{
      requestedNotionalUsd: route.requestedNotionalUsd, maxCostBps: route.maxCostBps, requestedRawInput: "1000000000000", executedRawInput: "900000000000",
      executableUsd: 9e5, executionCostBps: 20, allInCostBps: 400, fees: [], certification: "exact-lower-bound", reason: null,
      outputs: [leg, { ...leg, assetKey: USDT, deployment: "ethereum:usdt", rawUnits: "300000000000000000000000", decimals: 18, unitValueUsd: 2, expectedUnitValueUsd: 2, observedAtSec: NOW - 10 }],
    }],
    capacityBasis: "transaction-simulation", settlement: { endpoint: "withdraw", maximumCompletionSec: 0, evidenceId: "fixture:settlement" },
    resourceKeys: ["pool:ethereum:certified-basket"], failureDomainKeys: ["protocol:fixture"],
  };
  route.executionCertificate = certificate;
  return { fixedInput, route, certificate };
}

const withTerms = <T,>(id: string, v9RouteReviewTerms: NonNullable<Cfg["v9RouteReviewTerms"]>, run: () => T): T => withCfg(id, { v9RouteReviewTerms }, run);
const FAST_SETTLE = { settlementModel: "days", settlementDelaySec: 2 * DAY, reviewedAt: "2026-07-01", docs: [{ label: "Issuer redemption terms", url: "https://example.com/redemption-terms", supports: ["settlement"] }] } satisfies NonNullable<Cfg["v9RouteReviewTerms"]>;

function navOutputIn(navObservedAtSec: number): FixedIn {
  const route = dexObs(V9_CLK, { routeId: `dex:${USDAF}:dl:ethereum%3Apool:ethereum%3Athbill-output`, output: trk(THBILL) });
  return mkFixedIn({
    captureKind: "public-reconstruction", activeAssetIds: [USDAF], capturedAt: new Date(V9_CLK * 1e3).toISOString(),
    sourceGeneration: "report-cards:nav-output-fixture", dexGenerationId: "dex-liquidity-nav-output-fixture", redemptionGenerationId: "redemption-backstops-unavailable",
    registryRevision: "registry:nav-output-fixture", methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION, clockSec: V9_CLK, updatedAt: V9_CLK,
    liquidityStale: false, redemptionStale: true,
    inputFreshness: { dexLiquidity: { updatedAt: V9_CLK, ageSeconds: 0, stale: false }, redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: true } },
    pegDataById: {}, navPriceById: { [THBILL]: { priceUsd: 1.0188, sourceId: "defillama-contract", observedAtSec: navObservedAtSec, confidence: "high" } },
    activeDepegPeakBpsById: {},
    dexLiqMap: { [USDAF]: { liquidityScore: 50, concentrationHhi: 0.5, poolCount: 1, chainCount: 1, ...singleDex(route), methodologyVersion: "dex:fixture-v1", updatedAt: V9_CLK } },
    redemptionBackstopMap: {}, bluechipMap: {}, resolvedBlacklistStatuses: { [USDAF]: false },
    liveReserveMap: {}, liveReserveProvenanceMap: {}, chainCirculatingById: {}, dexDeploymentSupplyCoverageById: {}, collateralDriftCoins: [], liveToFallbackCoins: [],
  });
}

function liveDirect(routeStatusSource: RedEnt["routeStatusSource"]): RedEnt {
  const row = mkFull();
  return {
    ...row, sourceMode: "dynamic", capacityConfidence: "live-direct", capacityKind: "live-direct-bounded", routeStatusSource, modelConfidence: "high",
    capacityProfile: { ...row.capacityProfile!, exitRouteObservations: [{ ...obs0(row), evidenceKind: "onchain-contract-state", confidence: "high", scoreEligible: true }] },
  };
}

describe("reviewed settlement output binding", () => {
  it("keys a venue-scoped redemption observation by venue and protocol so shared inventory dedupes", () => {
    const row = mkFull({ stablecoinId: USDC });
    setObs(row, [{ ...obs0(row), scope: { kind: "venue", venue: "reservoir-psm", protocol: "reservoir" } }]);
    expect(rev0(stub(row), USDC).physicalResourceKeys).toContain("venue:reservoir-psm:reservoir");
  });

  it("deduplicates Reservoir wrappers against one shared physical PSM inventory", () => {
    const key = "ethereum:reservoir-psm:0x4809010926aec940b550d34a46a52739f996d75d";
    const routes = ["rusd-reservoir", "srusd-reservoir", "wsrusd-reservoir"].map((id) => {
      const row = mkFull({ stablecoinId: id }), obs = obs0(row);
      setObs(row, [{ ...obs, sharedResourceKey: key }]);
      const rev = rev0(stub(row), id);
      expect(rev.physicalResourceKeys).toContain(key);
      return makeExitRoute({ routeKey: id, routeId: obs.routeId, physicalResourceKeys: rev.physicalResourceKeys });
    });
    const cap = distCap(routes, { requestedNotionalUsd: 1e5, maxCostBps: 200, comparisonWindowSec: 300, rawSupplyRequestUsd: 1e5 }, POL);
    expect(cap.includedRouteKeys).toHaveLength(3); expect(cap.valuedExecutableUsd).toBe(1e5);
  });

  it.each([[USD, null], [trk(USDC), null], [trk("usdon-ondo"), 3600]] as const)("does not lend the USDon instant SLA to a different captured endpoint (%j)", (output, sla) => {
    const id = "usyc-hashnote";
    withCfg(id, {
      settlementModel: "immediate",
      outputAssetType: "stable-single",
      outputAssets: ["usdon-ondo"],
      v9RouteReviewTerms: {
        settlementModel: "immediate",
        reviewedAt: "2026-09-01",
        docs: [{ label: "Fixture instant terms", url: "https://example.com/terms", supports: ["settlement"] }],
      },
    }, () => {
      const { fixedInput } = redFx({ rowOverrides: { stablecoinId: id, settlementModel: "days", outputAssetType: "nav" }, output, clockSec: utc(2026, 9, 5, 12) });
      expect(rev0(fixedInput, id)).toMatchObject({ settlementSlaSec: sla, settlementModel: "bounded-delay" });
    });
  });
});

describe("same-resource Exit alternatives", () => {
  function compileAlts(observations: RouteObs[]) {
    const fixed = mkFixed({ clockSec: NOW, aggregateCirculating: { peggedUSD: 2e6 }, chainSupplyByChain: { ethereum: { current: 2e6, circulatingPrevDay: 2e6, circulatingPrevWeek: 2e6, circulatingPrevMonth: 2e6 } } });
    fixed.dexLiqMap.alpha!.exitRouteObservations = observations;
    const cov = fixed.dexLiqMap.alpha!.exitRouteObservationCoverage!;
    cov.observationCount = observations.length; cov.scoreEligibleObservationCount = observations.filter((r) => r.scoreEligible).length;
    const reb = rebuildFixed(fixed), ext = mkExt({ clockSec: NOW, registryFingerprint: reb.registryFingerprint });
    ext.assets[0]!.routeReviews = routeRevs(reb, "alpha");
    const asset = compileFacts(reb, ext).assets[0]!;
    const routes = asset.exitRoutes.map((r) => ({ ...projExit(r), gaps: asset.gaps }));
    return { routes, result: evalExit({ circulatingUsd: asset.supply.circulatingUsd, portfolioStatus: "reviewed-complete", routes, gaps: asset.gaps }, POL) };
  }

  it.each(["stale", "diagnostic", "weaker"] as const)("keeps the current stronger singleton when a %s observation shares its pool", (kind) => {
    for (const rev of [false, true]) {
      const strong = dexObs(NOW, { routeId: rev ? "dex:a" : "dex:z", requestedNotionalUsd: 1e5, executableUsd: 9e4, completionRatio: 0.9, executionCostBps: 10, output: USD });
      const other = { ...strong, routeId: rev ? "dex:z" : "dex:a", executableUsd: 1e4, completionRatio: 0.1, ...(kind === "stale" ? { observedAt: NOW - 501, freshnessSeconds: 501 } : {}), ...(kind === "diagnostic" ? { scoreEligible: false } : {}) };
      const single = compileAlts([strong]);
      for (const list of [[other, strong], [strong, other]]) {
        const { routes, result } = compileAlts(list);
        expect(result).toMatchObject({ score: single.result.score, primaryRouteKey: single.result.primaryRouteKey, diversificationRouteKey: null, diversificationBonus: 0 });
        expect(result.primaryRouteKey).not.toBeNull();
        expect(result.routes.find((r) => r.routeKey === single.result.primaryRouteKey)!.included).toBe(true);
        const cap = distCap(routes, result.stressRequest!, POL);
        expect(cap.valuedExecutableUsd).toBe(9e4); expect(cap.includedRouteKeys).toHaveLength(kind === "weaker" ? 2 : 1);
      }
    }
  });

  it.each(["neither", "dex", "redemption", "both"] as const)("preserves cross-lane alternatives without duplicate capacity (%s certified)", (certLane) => {
    const rev = valExecRevs(executionReviews, POL).find((e) => e.identity.assetId === "susds-sky")!;
    const clk = Math.ceil(iso(rev.reviewedAt)), mod = POL.policy.semantic.exit.executionModels[rev.modelId]!, cert = mkCert();
    Object.assign(cert, { modelId: rev.modelId, identity: rev.identity, holder: rev.holder, reviewDigest: execRevDig(rev), observedAtSec: clk, sourceMaxAgeSec: mod.sourceMaxAgeSec, priceMaxAgeSec: mod.priceMaxAgeSec, resourceKeys: ["pool:ethereum:pool"] });
    cert.source.timestamp = clk;
    cert.observationGenerationId = domainDigest("safety-score-v10.exit-execution-source.v1", cert.source);
    Object.assign(cert.inputReference, { assetKey: rev.identity.assetId, deployment: rev.identity.deployment, decimals: rev.producer.inputDecimals, observedAtSec: clk });
    cert.inputGenerationId = execInGen(rev.identity.assetId, { requestedNotionalUsd: 1e5, maxCostBps: 200 }, cert.inputReference);
    cert.gates = mod.requiredGates.map((gateId) => ({ gateId, verdict: "passed", evidenceId: `observed:${gateId}`, observedAtSec: clk, reason: null }));
    Object.assign(cert.points[0]!, { requestedRawInput: "100000000000000000000000", executedRawInput: "100000000000000000000000", fees: [] });
    Object.assign(cert.points[0]!.outputs[0]!, { assetKey: rev.identity.outputAssetKeys[0], deployment: `${rev.producer.chain}:${rev.producer.outputToken}`, decimals: rev.producer.outputDecimals, observedAtSec: clk, rawUnits: "99900000000000000000000" });
    const obsList = (["dex", "redemption"] as const).map((lane) => dexObs(clk, {
      routeId: `${lane}:alternative`, routeFamily: lane === "dex" ? "dex-amm" : "protocol-redemption",
      requestedNotionalUsd: 1e5, executableUsd: 1e5, completionRatio: 1, executionCostBps: 10, output: USD,
      ...(certLane === lane || certLane === "both" ? { executionCertificate: cert } : {}),
    }));
    const row = mkFull({ stablecoinId: rev.identity.assetId });
    setObs(row, [obsList[1]!]);
    const fixed = stub(row, clk);
    Object.assign(fixed.dexLiqMap, { [row.stablecoinId]: singleDex(obsList[0]!) });
    const revs = routeRevs(fixed, row.stablecoinId);
    expect(revs).toHaveLength(2); expect(revs.every((r) => r.coverageClass !== "diagnostic")).toBe(true);
    const routes = revs.map((r) => {
      const obs = obsList.find((e) => e.routeId === r.routeId)!;
      return makeExitRoute({
        lane: r.lane, routeId: r.routeId, routeKey: `${r.lane}:${r.routeId}`, routeFamily: obs.routeFamily,
        evidenceKind: r.lane === "dex" ? "reserve-based-amm-simulation" : "onchain-contract-state",
        coverageClass: r.coverageClass, physicalResourceKeys: r.physicalResourceKeys, failureDomains: [`domain:${r.lane}`],
        ...(obs.executionCertificate ? { executionModelId: cert.modelId, executionCertificate: cert, capacityCurve: [{ requestedNotionalUsd: 1e5, maxCostBps: 200, executableUsd: 1e5, completionRatio: 1, executionCostBps: 10 }] } : {}),
      });
    });
    const ev = (alts: typeof routes) => evalExit({ circulatingUsd: 2e6, assetId: row.stablecoinId, clockSec: clk, routes: alts }, POL);
    const res = ev(routes);
    expect(res.routes.every((r) => r.included)).toBe(true);
    expect(res.score).toBe(Math.max(...routes.map((r) => ev([r]).score!)));
    expect(res).toMatchObject({ diversificationRouteKey: null, diversificationBonus: 0 });
    expect(ev([...routes].reverse())).toEqual(res);
    expect(distCap(routes, res.stressRequest!, POL).valuedExecutableUsd).toBe(certLane === "both" ? 1e5 : 1e6);
    if (certLane === "dex") {
      const leg = routes.filter((r) => r.lane === "redemption");
      for (const f of ["expired", "diagnostic"] as const) {
        cert.observedAtSec = f === "expired" ? clk - mod.sourceMaxAgeSec - 1 : clk;
        cert.points[0]!.certification = f === "diagnostic" ? "diagnostic" : "exact-lower-bound";
        cert.points[0]!.reason = f === "diagnostic" ? "execution-unavailable" : null;
        expect(ev(routes)).toMatchObject({ score: ev(leg).score, primaryRouteKey: leg[0]!.routeKey, diversificationRouteKey: null, diversificationBonus: 0 });
      }
    }
  });
});

describe("certified execution route outputs", () => {
  it("values raw output quantities across decimals and weights the basket by expected USD, not token units", () => {
    const r = rev0(certDexFx().fixedInput, "alpha");
    expect(r).toMatchObject({
      coverageClass: "exact-lower-bound", holderAccess: "permissionless", capacityScoringHorizon: "immediate", settlementModel: "atomic",
      output: { kind: "basket", assetKeys: [USDC, USDT], basketWeights: [{ assetKey: USDC, weight: 1 / 3 }, { assetKey: USDT, weight: 2 / 3 }], valuation: { expectedUnitValueUsd: 1, observedAtSec: NOW - 10, sourceGenerationId: "fixture:execution:1", maxAgeSec: 300 } },
    });
    expect(r.output!.valuation!.unitValueUsd).toBeCloseTo(29 / 30);
  });

  it.each(["different-notional", "different-cost", "diagnostic", "no-outputs", "zero-basket"] as const)("does not invent an output valuation for %s execution proof", (fault) => {
    const { fixedInput, certificate } = certDexFx(), pt = certificate.points[0]!;
    if (fault === "different-notional") { pt.requestedNotionalUsd *= 2; pt.requestedRawInput = (BigInt(pt.requestedRawInput) * 2n).toString(); }
    if (fault === "different-cost") pt.maxCostBps++;
    if (fault === "diagnostic") { pt.certification = "diagnostic"; pt.reason = "execution-unavailable"; }
    if (fault === "no-outputs") pt.outputs = [];
    if (fault === "no-outputs" || fault === "zero-basket") { pt.executableUsd = 0; pt.executedRawInput = "0"; for (const l of pt.outputs) l.rawUnits = "0"; }
    const r = rev0(fixedInput, "alpha");
    expect(r.output).toBeNull();
    if (fault === "different-notional" || fault === "different-cost" || fault === "diagnostic") expect(r.coverageClass).toBe("diagnostic");
  });

  it("retains observed single-output downside even when executable capacity is zero", () => {
    const { fixedInput, certificate } = certDexFx(), pt = certificate.points[0]!;
    pt.outputs = [{ ...pt.outputs[1]!, rawUnits: "0", unitValueUsd: 1.9 }];
    pt.executedRawInput = "0"; pt.executableUsd = 0; certificate.identity.outputAssetKeys = [USDT];
    expect(rev0(fixedInput, "alpha").output).toMatchObject({ kind: "tracked-stablecoin", assetKeys: [USDT], basketWeights: [], valuation: { unitValueUsd: 0.95, expectedUnitValueUsd: 1 } });
  });
});

describe("reviewed undisclosed output valuation", () => {
  it.each(["mixed-collateral", "stable-single"] as const)("does not assign implicit collateral or fiat par to undisclosed %s output", (outputAssetType) => {
    const row = mkFull({ stablecoinId: USDC, outputAssetType });
    withCfg(USDC, { outputAssetType, outputAssets: undefined, unresolvedOutputAssetKeys: undefined, unresolvedOutputDisposition: "issuer-undisclosed", reviewedAt: "2026-07-01" }, () => {
      const f = stub(row);
      expect(retRed(f, USDC)[0]!.observation.output).toEqual({ kind: "unresolved-asset" });
      expect(rev0(f, USDC)).toMatchObject({ output: null, unresolvedOutputResponsibility: "issuer-undisclosed" });
    });
  });
});

describe("buildSafetyScoreV9RouteReviews physical-commodity outputs", () => {
  const metalRef = (time: number, val: number, pre = val - 1): NonNullable<CompIn["directMetalReferences"]> => ({
    peggedGOLD: { observation: { pegKey: "peggedGOLD", source: "gold-api.com", cadence: "intraday", observedAtSec: time, usdPerUnit: val }, generation: "fixture-metal", preCloseUsdPerUnit: pre },
  });

  it.each([
    ["2026-10-01T12:00:00Z", "2026-10-01T11:55:00Z", true, false], ["2026-10-04T12:00:00Z", "2026-10-02T20:59:00Z", true, false],
    ["2026-10-04T12:00:00Z", "2026-10-04T11:55:00Z", false, false], ["2026-10-01T12:00:00Z", null, false, false],
    ["2026-10-04T22:10:00Z", "2026-10-04T22:05:00Z", false, true],
  ] as const)("uses the open-market or held-close metal observation %s / %s for physical capacity", (clock, obs, adm, hb) => {
    const id = "paxg-paxos", clk = iso(clock), obsAt = obs === null ? null : iso(obs);
    const row = mkFull({ stablecoinId: id, routeFamily: "offchain-issuer", routeStatus: "open", holderEligibility: "verified-customer" });
    const fixed = Object.assign(stub(row, clk), { aggregateCirculatingById: { [id]: { circulating: { peggedUSD: 2e7 } } }, directMetalReferences: obsAt === null ? {} : metalRef(obsAt, 1e3, hb ? 1e3 : 999) });
    fixed.pegDataById[id] = { pegCurrency: "GOLD", priceObservedAt: clk - DAY, pegReference: { valueUsd: 1010, usdPerTroyOunce: 1010, source: "median", contributorCount: 3, asOf: clk } } as FixedIn["pegDataById"][string];
    const p2u = structuredClone(getCfg(id)!.physicalToUsd!);
    p2u.fees = { issuerFeeBps: 0, issuerFixedUsd: 0, deliveryUsdPerLot: 0, insuranceBps: 0, assayUsdPerLot: 0, taxBps: 0, conversionBps: 0 };
    p2u.settlementLegs = [{ leg: "issuer-release", maximumBusinessDays: 1 }];
    withCfg(id, { physicalToUsd: p2u }, () => {
      const find = () => routeRevs(fixed, id).find((e) => e.routeId === `physical-to-usd:${id}`);
      const r = find();
      expect(r?.coverageClass).toBe(adm ? "modelled-terms-lower-bound" : "diagnostic");
      if (adm) expect(r?.output?.valuation).toMatchObject({ observedAtSec: obsAt, sourceGenerationId: "fixture-metal" });
      else expect(r?.output).toBeNull();
      if (obsAt === null) { Reflect.deleteProperty(fixed, "directMetalReferences"); expect(find()?.output?.valuation).toMatchObject({ observedAtSec: clk, sourceId: "physical-to-usd-modelled-endpoint" }); }
      row.routeStatus = "paused";
      expect(find()).toMatchObject({ coverageClass: "diagnostic", output: null });
    });
  });

  it("values reviewed physical outputs without token-price or fiat substitution", () => {
    const id = "dgld-gold-token-sa", row = mkFull({ stablecoinId: id, routeFamily: "offchain-issuer", settlementModel: "days", outputAssetType: "bluechip-collateral" });
    const fixed = Object.assign(stub(row), { directMetalReferences: metalRef(NOW, 5e3) });
    fixed.pegDataById[id] = { pegCurrency: "GOLD", pegReference: { valueUsd: 1e4, usdPerTroyOunce: 5e3, source: "fallback", contributorCount: 0, asOf: NOW } } as FixedIn["pegDataById"][string];
    withCfg(id, { reviewedAt: "2026-07-13", physicalToUsd: undefined }, () => expect(rev0(fixed, id)?.output).toBeNull());
    withCfg(id, { reviewedAt: "2026-07-12", physicalToUsd: undefined, outputAssetType: "physical-commodity-delivery", physicalCommodityDelivery: { commodity: "XAU", deliverableOuncesPerToken: 1, minimumDeliveryTokens: 1, deliveryTermsUnbounded: false, feeModel: { bps: 100, flatUsd: 100, deliveryUsd: 100 }, sameNotionalEligible: false } }, (c) => {
      row.outputAssetType = "physical-commodity-delivery";
      const out = rev0(fixed, id)?.output;
      expect(out).toMatchObject({ kind: "physical-commodity-delivery", sameNotionalEligible: false, valuation: { basis: "commodity-delivery", expectedUnitValueUsd: 5e3 } });
      expect(out?.valuation?.unitValueUsd).toBeLessThan(5e3);
      c.physicalCommodityDelivery!.deliveryTermsUnbounded = true;
      const unb = rev0(fixed, id)?.output;
      expect(unb).toMatchObject({ unboundedDeliveryCap: 55, sameNotionalEligible: false });
      expect(unb!.valuation!.unitValueUsd).toBeGreaterThan(out!.valuation!.unitValueUsd);
      delete fixed.directMetalReferences.peggedGOLD;
      expect(rev0(fixed, id)?.output).toBeNull();
      Reflect.deleteProperty(fixed, "directMetalReferences");
      expect(val0(fixed, id)).toMatchObject({ expectedUnitValueUsd: 5e3, observedAtSec: NOW, sourceId: "commodity-usd-per-troy-ounce:fallback" });
    });
  });
});

describe("buildSafetyScoreV9RetainedRedemptionRoutes", () => {
  it("derives one retained route for a full-supply row without observations", () => {
    const ret = retRed(stub(mkFull()), USDC);
    expect(ret).toHaveLength(1);
    expect(ret[0]).toMatchObject({ lane: "redemption", disposition: "observed", rejection: null, observation: { routeId: `redemption:${USDC}:offchain-issuer`, routeFamily: "issuer-redemption", scoreEligible: true, evidenceKind: "documented-terms" } });
  });

  it("pairs every retained route with a matching route review", () => {
    const f = stub(mkFull()), ret = retRed(f, USDC), revs = routeRevs(f, USDC);
    expect(revs.map((r) => `${r.lane}:${r.routeId}`)).toEqual(ret.map((r) => `${r.lane}:${r.observation.routeId}`));
    expect(revs[0]).toMatchObject({ settlementModel: "atomic", settlementSlaSec: 0, modelConfidence: "medium" });
  });

  it("keeps an unmarked documented-bound route scoreable under the existing projection", () => {
    const row = mkFull(), f = stub(row);
    expect(rev0(f, row.stablecoinId)).toMatchObject({ lane: "redemption", coverageClass: "exact-lower-bound" });
    expect(retRed(f, row.stablecoinId)[0]).toMatchObject({ observation: { evidenceKind: "documented-terms", scoreEligible: true } });
  });

  it("retains legal entitlement diagnostics without mutating the frozen redemption row", () => {
    const row = mkFull({ stablecoinId: "xo-exodus", settlementModel: "same-day", feeBps: 0 }), frozen = structuredClone(row), f = stub(row, utc(2026, 9, 7));
    withCfg(row.stablecoinId, {
      costModel: fixedFee(0, "Fixture same-request cost bound"),
      v9RouteReviewTerms: { scoringDisposition: "bounded-terms-gap", missingScoringFields: ["settlement"], reviewedAt: "2026-07-01", rationale: "Fixture terms establish cost but not a completed settlement bound.", docs: [{ label: "Fixture terms", url: "https://issuer.example/terms", supports: ["settlement"] }] },
    }, () => {
      expect(getCfg(row.stablecoinId)?.v9RouteReviewTerms).toMatchObject({ scoringDisposition: "bounded-terms-gap", missingScoringFields: ["settlement"] });
      expect(retRed(f, row.stablecoinId)[0]!.observation).toMatchObject({ evidenceKind: "documented-terms", scoreEligible: false, executableUsd: 5e6 });
      expect(rev0(f, row.stablecoinId)).toMatchObject({ lane: "redemption", coverageClass: "diagnostic", executionCosts: expect.arrayContaining([expect.objectContaining({ executionCostBps: 0 })]) });
      expect(row).toEqual(frozen); expect(row).not.toHaveProperty("v9RouteReviewTerms"); expect(row).not.toHaveProperty("scoringDisposition");
    });
  });

  it.each([["capacity"], ["settlement"], ["cost"]] as const)("retains captured terms while keeping only a %s capacity gap diagnostic", (field) => {
    const row = mkFull({ feeBps: 7 }), f = stub(row), frozen = structuredClone(row);
    expect(rev0(f, row.stablecoinId)?.coverageClass).toBe("exact-lower-bound");
    const before = retRed(f, row.stablecoinId);
    withTerms(row.stablecoinId, { scoringDisposition: "bounded-terms-gap", missingScoringFields: [field], reviewedAt: "2026-07-01", rationale: "The omitted terms have no reviewed bound.", docs: [{ label: "Terms", url: "https://example.com/terms", supports: ["settlement"] }] }, () => {
      const ret = retRed(f, row.stablecoinId), revs = routeRevs(f, row.stablecoinId);
      expect(ret).toEqual(before); expect(ret).toMatchObject([{ observation: { executableUsd: 5e6 } }]);
      expect(revs).toMatchObject([{ coverageClass: field === "capacity" ? "diagnostic" : "exact-lower-bound", settlementModel: "atomic", settlementSlaSec: 0 }]);
      expect([...revs[0]!.executionCosts].sort((a, b) => a.requestedNotionalUsd - b.requestedNotionalUsd)).toEqual(costPts([[1e5, 7], [1e6, 7], [5e6, 7], [25e6, 7]]));
      expect(row).toEqual(frozen);
    });
  });

  it("uses each request point's cost before a scalar and recomputes unlike legacy requests", () => {
    const row = mkFull({ feeBps: null }), obs = obs0(row);
    obs.requestedNotionalUsd = 1e6; obs.executionCostBps = 12;
    obs.capacityCurve = [
      { requestedNotionalUsd: 1e5, maxCostBps: 200, executableUsd: 1e5, completionRatio: 1, executionCostBps: 111 },
      { requestedNotionalUsd: 1e6, maxCostBps: 200, executableUsd: 1e6, completionRatio: 1 },
      { requestedNotionalUsd: 5e6, maxCostBps: 200, executableUsd: 5e6, completionRatio: 1 },
      { requestedNotionalUsd: 1e6, maxCostBps: 100, executableUsd: 1e6, completionRatio: 1 },
    ];
    setObs(row, [obs]);
    withCfg(row.stablecoinId, { costModel: { kind: "fee-bps", feeBps: 10, minFeeUsd: 1e3, gasOrBridgeCostUsd: 100 } }, () => {
      expect(rev0(stub(row), row.stablecoinId).executionCosts).toEqual(expect.arrayContaining([
        { requestedNotionalUsd: 1e5, maxCostBps: 200, executionCostBps: 111 }, { requestedNotionalUsd: 1e6, maxCostBps: 200, executionCostBps: 12 },
        { requestedNotionalUsd: 5e6, maxCostBps: 200, executionCostBps: expect.closeTo(10.2, 10) }, { requestedNotionalUsd: 1e6, maxCostBps: 100, executionCostBps: 11 },
      ]));
    });
  });

  it.each([{ feeBpsMin: 25 }, { minFeeUsd: 1e3 }])("withholds a same-notional cost bound for minimum-only fees %j", (min) => {
    const row = mkFull({ feeBps: null });
    withCfg(row.stablecoinId, { costModel: { kind: "dynamic-or-unclear", confidence: "formula", feeModelKind: "formula", ...min }, v9RouteCostTerms: undefined }, () => {
      expect(rev0(stub(row), row.stablecoinId)).toMatchObject({ feeEvidence: "disclosed-unquantified" });
    });
  });

  it("preserves the captured redemption model-confidence rollup", () => {
    expect(rev0(stub(mkFull({ modelConfidence: "high" })), USDC)).toMatchObject({ lane: "redemption", executionCertainty: "bounded", modelConfidence: "high" });
  });

  it("projects reviewed fixed and minimum fees when captured rows omit feeBps", () => {
    const u = mkFull({ stablecoinId: USDT, feeBps: null, feeConfidence: "undisclosed-reviewed", feeModelKind: "documented-variable" });
    expect(rev0(stub(u), USDT).executionCosts).toEqual(expect.arrayContaining(costPts([[1e5, 100], [1e6, 10], [5e6, 10], [25e6, 10]])));
    const o = mkFull({ stablecoinId: "ousd-origin-protocol", feeBps: null });
    expect([...rev0(stub(o), o.stablecoinId).executionCosts].sort((a, b) => a.requestedNotionalUsd - b.requestedNotionalUsd)).toEqual(costPts([[1e5, 25], [1e6, 25], [5e6, 25], [25e6, 25]]));
  });

  it("projects conservative USDT-only reviewed constraints without changing the captured row", () => {
    const row = mkFull({ stablecoinId: USDT, settlementModel: "same-day", settlementDelaySec: undefined, minRedeemUsd: undefined, holderEligibility: "verified-customer" });
    expect(rev0(stub(row), USDT)).toMatchObject({ holderAccess: "institutional-eligible", settlementModel: "bounded-delay", settlementSlaSec: null, settlementHorizonSec: 14 * DAY, minRedeemUsd: 1e5 });
    expect(row).toMatchObject({ settlementModel: "same-day", holderEligibility: "verified-customer" });
    expect(row.minRedeemUsd).toBeUndefined();
  });

  it.each([
    ["current review", NOW, { settlementModel: "bounded-delay", settlementSlaSec: 2 * DAY }, 14 * DAY],
    ["expired review", utc(2027, 6, 2), { settlementModel: "bounded-delay", settlementSlaSec: null, settlementHorizonSec: 14 * DAY }, null],
  ] as const)("projects %s settlement terms without widening captured bounds", (_sc, clk, exp, retH) => {
    const row = mkFull({ stablecoinId: "msusd-main-street", settlementModel: "days", settlementDelaySec: undefined }), f = stub(row, clk);
    withTerms(row.stablecoinId, FAST_SETTLE, () => {
      expect(rev0(f, row.stablecoinId)).toMatchObject(exp);
      if (retH !== null) { expect(retRed(f, row.stablecoinId)[0]?.observation.settlementHorizonSec).toBe(retH); expect(rev0(f, row.stablecoinId)?.settlementHorizonSec).toBe(2 * DAY); }
    });
  });

  it("expires a favorable settlement after the producer persisted its current reviewed model", () => {
    const id = "msusd-main-street";
    withTerms(id, { ...FAST_SETTLE, settlementModel: "atomic", settlementDelaySec: 0 }, () => {
      const cur = utc(2026, 7, 26), stale = utc(2027, 7, 26), ps = resSettle(getCfg(id)!, cur);
      const row = mkFull({ stablecoinId: id, settlementModel: ps, settlementDelaySec: 0 });
      expect(ps).toBe("atomic");
      expect(rev0(stub(row, cur), id)).toMatchObject({ settlementModel: "atomic", settlementSlaSec: 0 });
      expect(rev0(stub(row, stale), id)).toMatchObject({ settlementModel: "bounded-delay", settlementSlaSec: null, settlementHorizonSec: 14 * DAY });
    });
  });

  it("keeps pinned redemption fee and output valuation separate in the route review", () => {
    const row = mkFull({ stablecoinId: "fpi-frax", feeBps: null });
    setObs(row, [{ ...obs0(row), output: trk("frax-frax"), evidenceKind: "onchain-contract-state", executionCostBps: 30, outputUnitValueUsd: 0.98836526, outputUnitValueSourceId: "protocol-redeem", outputUnitValueObservedAt: NOW, observedAt: NOW, confidence: "high", allInCostBps: 145.9983578, modelConfidence: "high", scoreEligible: true }]);
    const f = stub(row);
    setRawPeg(f, { "frax-frax": { currentDeviationBps: -500, priceObservedAt: NOW } });
    const rev = rev0(f, row.stablecoinId);
    expect(rev.executionCosts).toEqual(costPts([[1e5, 200], [1e6, 200], [5e6, 30], [25e6, 200]]));
    expect(rev).toMatchObject({ executionCertainty: "bounded", modelConfidence: "high", output: { kind: "tracked-stablecoin", valuation: { basis: "price", referenceAssetKey: "frax-frax", unitValueUsd: 0.98836526, sourceId: "protocol-redeem", confidence: "high" } } });
  });

  it("keeps HBD payout cost unquantified even when a frozen row claims a zero fixed fee", () => {
    expect(getCfg("hbd-hive")!.costModel).toMatchObject({ kind: "dynamic-or-unclear", confidence: "formula", feeModelKind: "formula" });
    const row = mkFull({ stablecoinId: "hbd-hive", settlementModel: "days", feeBps: 0, feeConfidence: "fixed", feeModelKind: "fixed-bps" });
    const rev = rev0(stub(row, utc(2026, 9, 6)), row.stablecoinId);
    expect(rev).toMatchObject({ feeEvidence: "disclosed-unquantified", settlementSlaSec: null });
    expect(rev.executionCosts.length).toBeGreaterThan(0);
    expect(rev.executionCosts.every((p) => p.executionCostBps === p.maxCostBps)).toBe(true);
    expect(row).toMatchObject({ feeBps: 0, feeModelKind: "fixed-bps" });
  });

  it("admits live execution without requiring an onchain status-source label", () => {
    const row = liveDirect("static-config");
    expect(row.capacityProfile?.exitRouteObservations?.[0]?.scoreEligible).toBe(true);
    expect(rev0(stub(row), row.stablecoinId)).toMatchObject({ lane: "redemption", coverageClass: "exact-lower-bound", modelConfidence: "high" });
  });

  it.each([["unknown", "static-config"]] as const)("admits positive execution despite %s/%s labels", (rs, rss) => {
    const row = liveDirect(rss);
    row.routeStatus = rs;
    Object.assign(row.capacityProfile!.exitRouteObservations![0]!, { scoreEligible: false, observedAt: NOW, freshnessSeconds: 0 });
    const fixed = mkFixed({ assetId: row.stablecoinId, clockSec: NOW });
    Object.assign(fixed, { redemptionBackstopMap: { [row.stablecoinId]: row }, redemptionGenerationId: "redemption:unscored-positive-capacity", redemptionStale: false });
    fixed.inputFreshness.redemptionBackstops = { updatedAt: NOW, ageSeconds: 0, stale: false };
    fixed.dexLiqMap[row.stablecoinId]!.exitRouteObservations = [];
    Object.assign(fixed.dexLiqMap[row.stablecoinId]!.exitRouteObservationCoverage!, { retainedPoolCount: 0, observationCount: 0, scoreEligibleObservationCount: 0, scoreEligiblePoolCount: 0, scoreEligibleCapabilityPoolCount: 0 });
    const reb = rebuildFixed(fixed), reviewed = mkExt({ assetId: row.stablecoinId, clockSec: NOW, registryFingerprint: reb.registryFingerprint });
    reviewed.assets[0]!.routeReviews = routeRevs(reb, row.stablecoinId);
    reviewed.assets[0]!.retainedRoutes = retRed(reb, row.stablecoinId);
    const comp = compileFacts(reb, reviewed).assets[0]!;
    const res = evalExit({ circulatingUsd: comp.supply.circulatingUsd, portfolioStatus: "reviewed-complete", routes: comp.exitRoutes.map(projExit) }, POL);
    expect(comp.exitRoutes[0]!).toMatchObject({ scoreEligible: false, coverageClass: "exact-lower-bound" });
    expect(comp.exitRoutes[0]!.capacityCurve.some((p) => p.executableUsd > 0)).toBe(true);
    expect(res.routes[0]).toMatchObject({ included: true }); expect(res.score).toBeGreaterThan(0); expect(res.reasons).not.toContain("no-viable-exit-path");
  });

  it.each(["onchain", "protocol-api"] as const)("keeps %s-sourced live-direct evidence scoreable", (rss) => {
    const row = liveDirect(rss);
    expect(rev0(stub(row), row.stablecoinId)).toMatchObject({ lane: "redemption", coverageClass: "exact-lower-bound", modelConfidence: "high" });
  });

  it("carries a live 30-day queue and its capacity constraints into the v9 route review", () => {
    const row = liveDirect("protocol-api"), obs = row.capacityProfile!.exitRouteObservations![0]!;
    Object.assign(row, { settlementModel: "queued", queueEnabled: true, settlementDelaySec: 30 * DAY, queueDepthUsd: 12e6, dailyLimitUsd: 5e6, minRedeemUsd: 1e5 });
    row.capacityProfile = { ...row.capacityProfile!, scoringHorizon: "queued", dailyLimitUsd: 5e6, queuedUsd: 12e6, exitRouteObservations: [{ ...obs, settlementHorizonSec: 30 * DAY, scoreEligible: false }] };
    expect(rev0(stub(row), row.stablecoinId)).toMatchObject({ lane: "redemption", capacityScoringHorizon: "queued", settlementModel: "queued", settlementSlaSec: 30 * DAY, queueDepthUsd: 12e6, dailyLimitUsd: 5e6, minRedeemUsd: 1e5 });
  });

  it("projects the eEARN atomic producer route onto its unbounded queued v9 review", () => {
    const row = liveDirect("onchain"), obs = row.capacityProfile!.exitRouteObservations![0]!;
    row.stablecoinId = "eearn-ember";
    setObs(row, [{ ...obs, routeId: "redemption:eearn-ember:stablecoin-redeem", scope: { kind: "protocol", protocol: "eearn-ember", chain: "ethereum" }, output: trk(USDC), settlementHorizonSec: 300, settlementBoundUnproven: true, scoreEligible: false }]);
    expect(row).toMatchObject({ settlementModel: "atomic", queueEnabled: false });
    expect(rev0(stub(row), row.stablecoinId)).toMatchObject({ lane: "redemption", settlementModel: "queued", settlementSlaSec: null, settlementHorizonSec: 30 * DAY, coverageClass: "exact-lower-bound" });
    expect(row.capacityProfile?.exitRouteObservations?.[0]?.settlementBoundUnproven).toBe(true);
  });

  it("values a resolved stable-basket output at the weakest component's price", () => {
    const { fixedInput } = redFx({ rowOverrides: { stablecoinId: DAI }, output: trk(USDC, USDT), pegDataById: { [USDC]: { currentDeviationBps: 2, priceObservedAt: NOW }, [USDT]: { currentDeviationBps: -14, priceObservedAt: NOW } } });
    expect(rev0(fixedInput, DAI).output).toMatchObject({ kind: "tracked-stablecoin", assetKeys: [USDC, USDT], valuation: { basis: "price", referenceAssetKey: USDT, unitValueUsd: 1 - 14 / 1e4, confidence: "medium" } });
    setPeg(fixedInput, { [USDC]: { currentDeviationBps: 2, priceObservedAt: NOW } });
    expect(val0(fixedInput, DAI)).toBeNull();
  });

  it("compares non-USD basket components by value-to-expectation ratio", () => {
    const { fixedInput } = redFx({ rowOverrides: { stablecoinId: DAI }, output: trk(THBILL, USDT), pegDataById: { [USDT]: { currentDeviationBps: -14, priceObservedAt: NOW } } });
    fixedInput.navPriceById = { [THBILL]: { priceUsd: 0.8, sourceId: "non-usd-nav-fixture", observedAtSec: NOW, confidence: "high" } };
    expect(val0(fixedInput, DAI)).toMatchObject({ referenceAssetKey: USDT, unitValueUsd: 1 - 14 / 1e4, expectedUnitValueUsd: 1 });
  });

  it("preserves USD0 mixed-collateral identities through the reviewed route output", () => {
    const row = mkFull({ stablecoinId: "usd0-usual", routeFamily: "stablecoin-redeem", outputAssetType: "mixed-collateral" });
    setObs(row, [obs0(row)]);
    expect(rev0(stub(row), row.stablecoinId).output).toMatchObject({ kind: "collateral", assetKeys: ["asset:m", "asset:ustbl", "asset:usyc"], valuation: { referenceAssetKey: "asset:m", unitValueUsd: 1, expectedUnitValueUsd: 1, sourceId: "report-cards-dex-usd-normalized" } });
  });

  const dtrinity = { stablecoinId: "dusd-dtrinity", routeFamily: "stablecoin-redeem" as const, accessModel: "permissionless-onchain" as const, executionModel: "deterministic-basket" as const, outputAssetType: "stable-basket" as const };

  it.each([[utc(2026, 6, 13, 12), undefined], [utc(2026, 6, 27, 12), undefined], [utc(2026, 6, 28, 0, 0, 1), "producer-failed"]] as const)(
    "projects unresolved-output ownership at %s",
    (clockSec, exp) => {
      const { fixedInput, row } = redFx({ rowOverrides: dtrinity, clockSec, observationClockSec: utc(2026, 6, 13, 12) });
      expect(rev0(fixedInput, row.stablecoinId)?.unresolvedOutputResponsibility).toBe(exp);
    },
  );

  it("prices the dTRINITY vault-bridge receipt basket through each receipt's underlying", () => {
    const pegDataById = Object.fromEntries(([[USDC, 3], [USDT, -21], ["usds-sky", 1], ["susds-sky", 4], ["frxusd-frax", -2], ["sfrxusd-frax", 5], [DAI, -4], ["sdai-sky", 6], ["ausd-agora", -1]] as const).map(([id, currentDeviationBps]) => [id, { currentDeviationBps, priceObservedAt: NOW }]));
    const { fixedInput, row } = redFx({ rowOverrides: dtrinity, pegDataById });
    expect(rev0(fixedInput, row.stablecoinId).output).toMatchObject({
      kind: "basket", assetKeys: ["asset:vbusdc", "asset:vbusdt", "ausd-agora", DAI, "frxusd-frax", "sdai-sky", "sfrxusd-frax", "susds-sky", USDC, "usds-sky", USDT],
      valuation: { basis: "price", referenceAssetKey: "asset:vbusdt", unitValueUsd: 1 - 21 / 1e4, expectedUnitValueUsd: 1, sourceId: "safety-score-v9-extension-fixed-rate-receipt", confidence: "medium" },
    });
    const { [USDT]: _d, ...rest } = fixedInput.pegDataById;
    setPeg(fixedInput, rest);
    expect(rev0(fixedInput, row.stablecoinId).output).toBeNull();
  });

  it("leaves an unresolved basket unresolved when a leg has no reviewed conversion", () => {
    const { fixedInput, row } = redFx({ rowOverrides: dtrinity, pegDataById: { [USDC]: { currentDeviationBps: -5, priceObservedAt: NOW } }, clockSec: utc(2026, 6, 28, 0, 0, 1) });
    const rev = rev0(fixedInput, row.stablecoinId);
    expect(rev).toMatchObject({ output: null, unresolvedOutputResponsibility: "producer-failed" });
    expect((rev.physicalResourceKeys ?? []).some((k) => k.startsWith("execution-endpoint:"))).toBe(false);
  });

  it("admits dEURO's source-bound nine-member EUR output valuation without calling it fiat", () => {
    const row = mkFull({ stablecoinId: "deuro-deuro", routeFamily: "collateral-redeem", accessModel: "permissionless-onchain", executionModel: "deterministic-basket", outputAssetType: "stable-basket", feeBps: 0 });
    const base = obs0(row), assetKeys = ["asset:eura", "asset:eure-legacy-ethereum", "asset:eurt", "asset:veur", EURC, "euri-banking-circle", "europ-schuman", "eurr-stablr", "eurs-stasis"];
    Object.assign(row, { capacityConfidence: "live-direct", capacityKind: "live-direct-bounded", modelConfidence: "high" });
    row.capacityProfile = { ...row.capacityProfile!, scoringUsd: 5e5, scoringHorizon: "immediate", exitRouteObservations: [{ ...base, output: { kind: "unresolved-basket", assetKeys, basketWeights: assetKeys.map((assetId, i) => ({ assetId, weight: i === 4 ? 1 : 0 })) }, routeFamily: "protocol-redemption", evidenceKind: "onchain-contract-state", confidence: "high", executionCostBps: 0, outputUnitValueUsd: 1.15, outputExpectedUnitValueUsd: 1.15, outputUnitValueSourceId: "collateral-positions-api:deuro-bridge-basket:test", outputUnitValueObservedAt: NOW, allInCostBps: 0, scoreEligible: true, observedAt: NOW, freshnessSeconds: 0 }] };
    expect(rev0(stub(row), row.stablecoinId)?.output).toMatchObject({ kind: "basket", assetKeys, basketWeights: [{ assetKey: EURC, weight: 1 }], valuation: { basis: "price", unitValueUsd: 1.15, expectedUnitValueUsd: 1.15, sourceId: "collateral-positions-api:deuro-bridge-basket:test", confidence: "high" } });
  });

  it.each([
    ["srusd-reservoir", USDC, {}, { [USDC]: { currentDeviationBps: -3, priceObservedAt: NOW } }, 0.9997],
    ["zys-zephyr-protocol", "zsd-zephyr-protocol", { outputAssetType: "stable-single" as const }, { "zsd-zephyr-protocol": { currentDeviationBps: 0, priceObservedAt: NOW, pegScore: 100, activeDepeg: false, eventCount: 0, worstDeviationBps: null } }, 1],
  ] as const)("values %s through its tracked %s output", (id, outId, ov, pegDataById, expVal) => {
    const { fixedInput } = redFx({ rowOverrides: { stablecoinId: id, routeFamily: "stablecoin-redeem", accessModel: "permissionless-onchain", holderEligibility: "any-holder", ...ov }, output: trk(outId), pegDataById });
    expect(rev0(fixedInput, id)?.output).toMatchObject({ kind: "tracked-stablecoin", assetKeys: [outId], valuation: { basis: "price", referenceAssetKey: outId, unitValueUsd: expVal, expectedUnitValueUsd: 1, sourceId: "report-cards-peg-summary" } });
  });

  it("retains ZYS's tracked ZSD identity without inventing a price from quiet peg history", () => {
    const { fixedInput } = redFx({ rowOverrides: { stablecoinId: "zys-zephyr-protocol", routeFamily: "stablecoin-redeem", accessModel: "permissionless-onchain", holderEligibility: "any-holder", outputAssetType: "stable-single" }, output: trk("zsd-zephyr-protocol"), pegDataById: { "zsd-zephyr-protocol": { currentDeviationBps: null, pegScore: 100, activeDepeg: false, eventCount: 0, worstDeviationBps: null } } });
    expect(rev0(fixedInput, "zys-zephyr-protocol")?.output).toMatchObject({ kind: "tracked-stablecoin", assetKeys: ["zsd-zephyr-protocol"], valuation: null });
  });

  it("uses a complete source-bound producer valuation for CUSD when WTGXX has no peg row", () => {
    const reviewed = mkFull({ stablecoinId: "cusd-cap", routeFamily: "basket-redeem", accessModel: "permissionless-onchain", settlementModel: "atomic", executionModel: "deterministic-basket", outputAssetType: "stable-basket", feeBps: 0 });
    const row = { ...reviewed, sourceMode: "dynamic", routeStatusSource: "onchain", capacityConfidence: "live-direct", capacityKind: "live-direct-bounded", modelConfidence: "high" } satisfies RedEnt;
    row.capacityProfile = { ...row.capacityProfile!, scoringUsd: 3e7, scoringHorizon: "immediate", exitRouteObservations: [{ ...obs0(reviewed), output: { ...trk(USDC, "wtgxx-wisdomtree"), basketWeights: [{ assetId: USDC, weight: 0.93 }, { assetId: "wtgxx-wisdomtree", weight: 0.07 }] }, evidenceKind: "onchain-contract-state", confidence: "high", executionCostBps: 0, outputUnitValueUsd: 0.999983, outputUnitValueSourceId: "cap-vault:chainlink-nav:0xd13cb763c43b5c058e7ec40176962c5030f4eb49", outputUnitValueObservedAt: NOW - 120, allInCostBps: 0.17, scoreEligible: true, observedAt: NOW, freshnessSeconds: 0 }] };
    const f = stub(row);
    setRawPeg(f, { [USDC]: { currentDeviationBps: 2, priceObservedAt: NOW } });
    expect(rev0(f, "cusd-cap")?.output).toMatchObject({ basketWeights: [{ assetKey: USDC, weight: 0.93 }, { assetKey: "wtgxx-wisdomtree", weight: 0.07 }], valuation: { basis: "price", referenceAssetKey: "basket:redemption:cusd-cap:basket-redeem", unitValueUsd: 0.999983, expectedUnitValueUsd: 1, sourceId: "cap-vault:chainlink-nav:0xd13cb763c43b5c058e7ec40176962c5030f4eb49", observedAtSec: NOW - 120, confidence: "high" } });
    setRawPeg(f, { [USDC]: { currentDeviationBps: -5, priceObservedAt: NOW } });
    expect(val0(f, "cusd-cap")).toMatchObject({ referenceAssetKey: USDC, unitValueUsd: 0.9995, sourceId: "report-cards-peg-summary", confidence: "medium" });
  });

  it("values production-shaped tracked DEX output aliases by canonical stablecoin id", () => {
    const { fixedInput, route } = dexFx({
      assetId: "asset-input",
      routeOverrides: { routeId: "dex:asset-input:dl:ethereum%3Afp%3Aethereum%3Acurve%3Apool:ethereum%3A0xfa2b947eec368f42195f24f36d2af29f7c24cec2", output: { ...trk("usdf-falcon"), assetKeys: ["ethereum:0xfa2b947eec368f42195f24f36d2af29f7c24cec2"] }, outputUnitValueUsd: 0.95, outputUnitValueSourceId: "dex-amm-output-reference:curve:tracked-market", outputUnitValueObservedAt: NOW },
      pegDataById: { "usdf-falcon": { pegCurrency: "USD", currentDeviationBps: -12, priceObservedAt: NOW } },
    });
    expect(routeRevs(fixedInput, "asset-input")).toEqual([expect.objectContaining({ lane: "dex", routeId: route.routeId, modelConfidence: "medium", coverageClass: "exact-complete", output: expect.objectContaining({ kind: "tracked-stablecoin", assetKeys: ["usdf-falcon"], valuation: expect.objectContaining({ referenceAssetKey: "usdf-falcon", unitValueUsd: 0.9988, expectedUnitValueUsd: 1, sourceId: "report-cards-peg-summary" }) }) })]);
  });

  it("uses a source-bound exact DEX output reference when peg and NAV valuation are unavailable", () => {
    const { fixedInput, route } = dexFx({
      assetId: "scrvusd-curve",
      routeOverrides: { routeId: "dex:scrvusd-curve:dl:ethereum%3Ausdaf-output", executableUsd: 31_206.39, completionRatio: 0.03120639, output: trk(USDAF), outputUnitValueUsd: 0.9975, outputUnitValueSourceId: "dex-amm-output-reference:curve:tracked-market", outputUnitValueObservedAt: NOW - 30 },
      pegDataById: { [USDAF]: { pegCurrency: "USD", currentDeviationBps: null, pegScore: 75, activeDepeg: false, eventCount: 103, worstDeviationBps: -223 } },
    });
    const v = (i: CompIn = fixedInput) => val0(i, "scrvusd-curve");
    expect(v()).toMatchObject({ basis: "price", referenceAssetKey: USDAF, unitValueUsd: 0.9975, expectedUnitValueUsd: 1, sourceId: "dex-amm-output-reference:curve:tracked-market", observedAtSec: NOW - 30, confidence: "high" });
    route.outputUnitValueObservedAt = NOW + 61; expect(v()).toBeNull();
    route.outputUnitValueObservedAt = NOW - 30;
    setPeg(fixedInput, { [USDAF]: { pegCurrency: "EUR", currentDeviationBps: null, pegReference: null } }); expect(v()).toBeNull();
    route.outputUnitValueUsd = 1.1583;
    setPeg(fixedInput, { [USDAF]: { pegCurrency: "EUR", currentDeviationBps: null, pegReference: { valueUsd: 1.17, source: "fx", contributorCount: 1, asOf: NOW - 60 } } });
    expect(v()).toMatchObject({ expectedUnitValueUsd: 1.17 });
    expect(v(Object.assign(fixedInput, { pegEvidenceById: { other: { lastAffectedAtSec: NOW - 600 } } }))).toMatchObject({ expectedUnitValueUsd: 1.17 });
    fixedInput.pegDataById.other = { ...fixedInput.pegDataById[USDAF]!, admittedDeviationBps: null }; expect(v()).toBeNull();
    delete fixedInput.pegDataById.other;
    expect(v(Object.assign(fixedInput, { pegEvidenceById: {} }))).toBeNull();
    expect(v(withFx(fixedInput, USDAF))).toMatchObject({ unitValueUsd: 1.1583, expectedUnitValueUsd: 1.17, sourceId: "dex-amm-output-reference:curve:tracked-market" });
  });

  it.each([
    [{}, true, false], [{ outputUnitValueUsd: undefined }, false, false], [{ outputUnitValueSourceId: undefined }, false, false],
    [{ outputUnitValueSourceId: "protocol-par" }, false, false], [{ outputUnitValueObservedAt: undefined }, false, false],
    [{ outputUnitValueObservedAt: NOW - 1801 }, false, false], [{ outputUnitValueObservedAt: NOW + 1 }, false, false],
    [{ observedAt: NOW - 61 }, false, false], [{ outputUnitValueUsd: 2.01 }, false, false],
    [{ outputUnitValueSourceId: "dex-amm-output-reference:curve:source-token-usd" }, true, true],
  ])("shares tracked pin admission without sharing lane precedence: %o", (pin, valid, dexOnlyRej) => {
    for (const lane of ["dex", "redemption"] as const) {
      const output = trk(USDT), pegDataById = { [USDT]: { pegCurrency: "USD", currentDeviationBps: null } };
      const dex = lane === "dex" ? dexFx({ assetId: DAI, routeOverrides: { routeId: `dex:${DAI}:pin`, output }, pegDataById }) : null;
      const red = lane === "redemption" ? redFx({ rowOverrides: { stablecoinId: DAI }, output, pegDataById }) : null;
      const fixed = dex?.fixedInput ?? red!.fixedInput, obs = dex?.route ?? red!.row.capacityProfile!.exitRouteObservations![0]!;
      Object.assign(obs, { outputUnitValueUsd: 0.99, outputUnitValueSourceId: "dex-amm-output-reference:curve:tracked-market", outputUnitValueObservedAt: NOW, observedAt: NOW }, pin);
      const val = val0(fixed, DAI);
      if (valid && !(dexOnlyRej && lane === "dex")) expect(val).toMatchObject({ basis: "price", unitValueUsd: 0.99, expectedUnitValueUsd: 1, observedAtSec: NOW, sourceId: obs.outputUnitValueSourceId });
      else expect(val).toBeNull();
    }
  });

  it.each(["dex", "redemption"] as const)("preserves tracked output valuation in a pre-census fixed input for %s", (lane) => {
    const output = trk(USDC, USDT), pegDataById = { [USDC]: { pegCurrency: "USD", currentDeviationBps: -2 }, [USDT]: { pegCurrency: "USD", currentDeviationBps: -9 } };
    const f = lane === "dex" ? dexFx({ assetId: DAI, pegDataById, routeOverrides: { routeId: "dex:dai:tracked-basket", output } }).fixedInput : redFx({ rowOverrides: { stablecoinId: DAI }, output, pegDataById }).fixedInput;
    expect(f.exitOutputPriceById).toBeUndefined();
    expect(val0(f, DAI)).toMatchObject({ basis: "price", referenceAssetKey: USDT, unitValueUsd: 0.9991, expectedUnitValueUsd: 1, confidence: "medium", sourceId: "report-cards-peg-summary", maxAgeSec: 365 * DAY });
  });

  const dexUsdc = (peg: Record<string, unknown>, extra: Partial<RouteObs> = {}) =>
    dexFx({ assetId: "asset-input", routeOverrides: { routeId: "dex:asset-input:usdc", output: trk(USDC), ...extra }, pegDataById: { [USDC]: peg } });

  it.each([false, true])("retains the legacy payout clock and enforces its explicit removal (exact price %s)", (dated) => {
    const { fixedInput: f } = dexUsdc({ pegCurrency: "USD", currentDeviationBps: -200, priceObservedAt: undefined });
    if (dated) f.exitOutputPriceById = { [USDC]: outPx(0.997, { observedAtSec: NOW - 500 }) };
    const peg = f.pegDataById[USDC]!;
    delete peg.priceObservedAt;
    expect(val0(f, "asset-input")).toMatchObject({ unitValueUsd: 0.98, sourceId: "report-cards-peg-summary" });
    peg.priceUpdatedAt = NOW - 3600;
    expect(val0(f, "asset-input")?.observedAtSec).toBe(NOW - 3600);
    peg.priceObservedAt = null;
    if (dated) expect(val0(f, "asset-input")).toMatchObject({ unitValueUsd: 0.997, observedAtSec: NOW - 500 });
    else expect(val0(f, "asset-input")).toBeNull();
  });

  it("withholds an FX exit valuation when the current or retained token quote exceeds six hours", () => {
    const id = "eurcv-societe-generale-forge", clk = utc(2026, 10, 12, 12), qAt = clk - INTRADAY_SEC - 3600, rAt = clk - 5 * 3600;
    const { fixedInput: f } = dexFx({ assetId: id, clockSec: clk, routeOverrides: { routeId: `dex:${id}:eurc`, output: trk(EURC) }, pegDataById: { [EURC]: { pegCurrency: "EUR", priceObservedAt: qAt, currentDeviationBps: -300, pegReference: { valueUsd: 1.1, source: "fx", contributorCount: 1, asOf: rAt } } } });
    const adm = (decisionAtSec: number) => evalRef({ kind: "fx", purpose: "current", quoteObservedAtSec: qAt, decisionAtSec, rawDeviationBps: asRawDeviationBps(-300), preCloseUsdPerUnit: 1.11, generation: "fixture-fx", observation: { pegKey: "peggedEUR", source: "openExchangeRates", cadence: "intraday", usdPerUnit: 1.1, observedAtSec: rAt } });
    const bnd = clk - 3600, ret = adm(bnd), exp = adm(clk);
    expect(ret.status).toBe("admitted");
    expect(exp).toMatchObject({ status: "stale-reference", reason: "quote-over-budget", budgetSec: INTRADAY_SEC });
    expect(val0(f, id)?.unitValueUsd).toBeCloseTo(1.067);
    const wA = (referenceAdmission: RefAdm, clockSec: number): CompIn => ({ ...f, clockSec, pegEvidenceById: { [EURC]: { referenceAdmission, admittedDeviationBps: -300 } } });
    expect(val0(wA(ret, bnd), id)?.unitValueUsd).toBeCloseTo(1.067);
    expect(val0(wA(ret, clk), id)).toBeNull(); expect(val0(wA(exp, clk), id)).toBeNull();
  });

  it.each([
    ["xaut-tether", "GOLD", 4_181.47, -4, false], ["silver-fixture", "SILVER", 50, -10, true], ["xaut-tether", "GOLD", 4_181.47, -4, undefined],
  ] as const)("values %s (%s, ref %s, %s bps) by the captured reference evidence, held=%s", (id, pegCurrency, refUsd, bps, held) => {
    const { fixedInput: f } = dexFx({ assetId: "asset-input", routeOverrides: { routeId: `dex:asset-input:${id}`, output: trk(id) }, pegDataById: { [id]: { pegCurrency, currentDeviationBps: bps, pegReference: { valueUsd: refUsd, source: "median", contributorCount: 10, asOf: NOW - 91 } } } });
    const t = NOW - 30;
    const cap = held === undefined ? f : Object.assign(f, { pegEvidenceById: { [id]: { admittedDeviationBps: held ? null : bps, referenceAdmission: { ...(held ? { status: "held-closed-session", reason: "reference-market-closed" } : { status: "admitted", reason: "live-reference" }), kind: "median", source: "peer-median", cadence: "intraday", generation: "fixture-commodity", quoteObservedAtSec: t, referenceObservedAtSec: t, decisionAtSec: t, budgetSec: 21_600, sessionOpenedAtSec: null, policyVersion: 1 } satisfies RefAdm } } });
    const v = val0(cap, "asset-input");
    if (held === true) { expect(v).toBeNull(); return; }
    expect(v).toMatchObject({ expectedUnitValueUsd: refUsd, sourceId: "report-cards-peg-summary" });
    expect(v!.unitValueUsd / v!.expectedUnitValueUsd).toBeCloseTo(1 + bps / 1e4);
  });

  it.each(["fresh"] as const)("keeps the admitted summary path when the additional capture is %s", () => {
    const { fixedInput: f } = dexUsdc({ pegCurrency: "USD", currentDeviationBps: -2 });
    f.exitOutputPriceById = { [USDC]: outPx(0.99) };
    expect(val0(f, "asset-input")).toMatchObject({ unitValueUsd: 0.9998, expectedUnitValueUsd: 1, sourceId: "report-cards-peg-summary", maxAgeSec: 365 * DAY });
  });

  it("does not replace an already admitted DEX output pin with the additional current-price capture", () => {
    const { fixedInput: f } = dexUsdc({ pegCurrency: "USD", currentDeviationBps: null }, { outputUnitValueUsd: 0.9975, outputUnitValueSourceId: "dex-amm-output-reference:curve:tracked-market", outputUnitValueObservedAt: NOW - 30 });
    f.exitOutputPriceById = { [USDC]: outPx(0.99) };
    expect(val0(f, "asset-input")).toMatchObject({ unitValueUsd: 0.9975, expectedUnitValueUsd: 1, observedAtSec: NOW - 30, sourceId: "dex-amm-output-reference:curve:tracked-market" });
  });

  it("keeps an admitted summary when a redemption pin lacks independent provenance", () => {
    const { fixedInput: f, row } = redFx({ rowOverrides: { stablecoinId: DAI }, output: trk(USDC), pegDataById: { [USDC]: { pegCurrency: "USD", currentDeviationBps: -2 } } });
    row.capacityProfile!.exitRouteObservations![0]!.outputUnitValueUsd = 0.95;
    expect(val0(f, DAI)).toMatchObject({ unitValueUsd: 0.9998, sourceId: "report-cards-peg-summary" });
    setPeg(f, {}); expect(val0(f, DAI)).toBeNull();
  });

  it("retains the original NAV capture's admitted valuation independently of the optional census", () => {
    const { fixedInput: f } = dexFx({ assetId: "asset-input", routeOverrides: { routeId: "dex:asset-input:thbill", observedAt: NOW - 3600, output: trk(THBILL) } });
    f.navPriceById = { [THBILL]: { priceUsd: 1.0188, sourceId: "defillama-contract", observedAtSec: NOW - 3600, confidence: "high" } };
    f.exitOutputPriceById = {};
    expect(val0(f, "asset-input")).toMatchObject({ basis: "nav", unitValueUsd: 1.0188, expectedUnitValueUsd: 1.0188, sourceId: "defillama-contract", observedAtSec: NOW - 3600, maxAgeSec: 365 * DAY });
  });

  it("values a tracked output from its exact captured USD price despite unavailable peg deviation", () => {
    const { fixedInput: f } = dexFx({ assetId: "asset-input", routeOverrides: { routeId: "dex:asset-input:eurc", output: trk(EURC) }, pegDataById: { [EURC]: { pegCurrency: "EUR", currentDeviationBps: null, pegReference: { valueUsd: 1.17, source: "fx", contributorCount: 1, asOf: NOW - 60 } } } });
    f.exitOutputPriceById = { [EURC]: outPx(1.1583, { observedAtSec: NOW - 30 }) };
    expect(val0(withFx(f, EURC), "asset-input")).toMatchObject({ unitValueUsd: 1.1583, expectedUnitValueUsd: 1.17, observedAtSec: NOW - 30, sourceId: "coingecko", maxAgeSec: 1800 });
  });

  it("values an sUSN output using the admitted fresh protocol NAV, not USN parity", () => {
    const { fixedInput: f } = dexFx({ assetId: "usn-noon", routeOverrides: { routeId: "dex:usn-noon:susn", output: trk("susn-noon") } });
    f.exitOutputPriceById = { "susn-noon": outPx(1.0837, { sourceId: "protocol-redeem", observedAtSec: NOW - 30, admission: "guarded-nav" }) };
    expect(val0(f, "usn-noon")).toMatchObject({ basis: "nav", unitValueUsd: 1.0837, expectedUnitValueUsd: 1.0837, sourceId: "protocol-redeem", observedAtSec: NOW - 30 });
  });

  it.each(["stale", "future", "nominal", "rejected"] as const)("withholds newly valued tracked outputs for a %s current capture price", (fault) => {
    const { fixedInput: f } = dexUsdc({ pegCurrency: "USD", currentDeviationBps: null });
    f.exitOutputPriceById = fault === "rejected" ? {} : { [USDC]: outPx(0.99, { sourceId: fault === "nominal" ? "protocol-par" : "coingecko", observedAtSec: fault === "stale" ? NOW - 1801 : fault === "future" ? NOW + 1 : NOW }) };
    expect(val0(f, "asset-input")).toBeNull();
  });

  it.each(["unavailable", "nominal", "future", "expired"] as const)("does not revive a %s summary merely because a deviation is retained", (fault) => {
    const { fixedInput: f } = dexUsdc({ pegCurrency: "USD", currentDeviationBps: -2, currentPriceUnavailable: fault === "unavailable", priceSource: fault === "nominal" ? "protocol-par" : "coingecko", priceObservedAt: fault === "future" ? NOW + 1 : fault === "expired" ? NOW - 365 * DAY - 1 : NOW });
    expect(val0(f, "asset-input")).toBeNull();
  });

  it("does not value a quiet peg history without a current observed price", () => {
    expect(val0(dexUsdc({ pegCurrency: "USD", currentDeviationBps: null, pegScore: 100, activeDepeg: false, eventCount: 0, worstDeviationBps: null, currentPriceUnavailable: true }).fixedInput, "asset-input")).toBeNull();
  });

  it("keeps a tracked basket unvalued when a leg has neither a summary nor an admitted current price", () => {
    const { fixedInput: f } = redFx({ rowOverrides: { stablecoinId: DAI }, output: trk(USDC, USDT), pegDataById: { [USDC]: { pegCurrency: "USD", currentDeviationBps: null }, [USDT]: { pegCurrency: "USD", currentDeviationBps: null } } });
    f.exitOutputPriceById = { [USDC]: outPx(0.99) };
    expect(val0(f, DAI)).toBeNull();
  });

  it("values a complete basket using the existing summary plus an additional admitted output price", () => {
    const { fixedInput: f } = redFx({ rowOverrides: { stablecoinId: DAI }, output: trk(USDC, USDT), pegDataById: { [USDC]: { pegCurrency: "USD", currentDeviationBps: null }, [USDT]: { pegCurrency: "USD", currentDeviationBps: -9 } } });
    f.exitOutputPriceById = { [USDC]: outPx(0.99, { observedAtSec: NOW - 30 }) };
    expect(val0(f, DAI)).toMatchObject({ referenceAssetKey: USDC, unitValueUsd: 0.99, expectedUnitValueUsd: 1, observedAtSec: NOW - 30, sourceId: "coingecko", maxAgeSec: 1800 });
  });

  it("includes captured NAV observations in V9 peg-source provenance", () => {
    const oIn = navOutputIn(V9_CLK - 60), nIn = navOutputIn(V9_CLK - 30), oExt = buildBaseExt(oIn), nExt = buildBaseExt(nIn);
    expect(nIn.baseInputGenerationId).not.toBe(oIn.baseInputGenerationId);
    expect(nExt.sources.peg.observedAtSec).toBe(V9_CLK - 30);
    expect(nExt.sources.peg.generationId).not.toBe(oExt.sources.peg.generationId);
    expect(nExt.assets[0]?.routeReviews[0]?.output?.valuation).toMatchObject({ basis: "nav", sourceId: "defillama-contract", observedAtSec: V9_CLK - 30 });
  });

  it("binds exact output prices and their original clocks into both capture and peg-source identity", () => {
    const mk = (priceUsd: number) => {
      const { baseInputGenerationId: _id, ...draft } = navOutputIn(V9_CLK - 60);
      return mkFixedIn({ ...draft, navPriceById: {}, exitOutputPriceById: { [THBILL]: outPx(priceUsd, { sourceId: "protocol-redeem", observedAtSec: V9_CLK - 30, admission: "guarded-nav" }) } });
    };
    const a = mk(1.0188), b = mk(1.0191), aE = buildBaseExt(a), bE = buildBaseExt(b);
    expect(b.baseInputGenerationId).not.toBe(a.baseInputGenerationId);
    expect(bE.sources.peg.generationId).not.toBe(aE.sources.peg.generationId);
    expect(bE.sources.peg.observedAtSec).toBe(V9_CLK - 30);
    expect(bE.assets[0]?.routeReviews[0]?.output?.valuation).toMatchObject({ basis: "nav", unitValueUsd: 1.0191, observedAtSec: V9_CLK - 30 });
  });

  it("derives nothing when the row already carries observations or is absent", () => {
    const w = mkFull();
    setObs(w, [obs0(w)]);
    expect(retRed(stub(w), USDC)).toEqual([]);
    expect(retRed(stub(undefined), USDC)).toEqual([]);
  });
});

describe("buildSafetyScoreV9RetainedRoutes composed DEX exits", () => {
  it("composes a reviewed atomic wrap with captured intermediate market depth", () => {
    const f = stub(undefined);
    withCfg("m-m0", {
      v9ComposedDexExit: { intermediateAssetId: "wm-m0", conversionModel: "permissionless-atomic-wrap", chain: "ethereum", wrapperContract: "0x437cc33344a0B27A429f795ff6B469C72698B291", reviewedAt: "2026-07-01", docs: [{ label: "Fixture wrap", url: "https://issuer.example/wrap", supports: ["route", "fees", "access", "settlement"] }] },
    }, () => {
      const src: RouteObs = {
        routeId: "dex:wm-m0:uniswap-v3:wm-usdc", routeFamily: "dex-amm",
        scope: { kind: "chain-contract", chain: "ethereum", contractOrPoolId: "0x970a7749ecaa4394c8b2bf5f2471f41fd6b79288", protocol: "uniswap-v3" },
        requestedNotionalUsd: 1e6, settlementHorizonSec: 300, maxCostBps: 200, executableUsd: 1e6, completionRatio: 1,
        output: trk(USDC), evidenceKind: "measured-executable-depth", adapterProfileId: "uniswap-v3-quoter", executionCostBps: 1.6, confidence: "high", scoreEligible: true,
        observedAt: NOW, freshnessSeconds: 0, commonModeKeys: ["chain:ethereum", "protocol:uniswap-v3"],
        capacityCurve: [{ requestedNotionalUsd: 1e6, maxCostBps: 200, executableUsd: 1e6, completionRatio: 1, executionCostBps: 1.6 }],
      };
      setDex(f, { "wm-m0": { exitRouteObservations: [src] } });
      setRawPeg(f, { [USDC]: { currentDeviationBps: 0, priceObservedAt: NOW } });
      const ret = retRoutes(f, "m-m0");
      expect(ret).toHaveLength(1);
      expect(ret[0]).toMatchObject({ lane: "dex", observation: { routeId: `composed:m-m0:${src.routeId}`, executableUsd: 1e6, output: { trackedAssetIds: [USDC] } } });
      expect(src.routeId).toBe("dex:wm-m0:uniswap-v3:wm-usdc");
      expect(routeRevs(f, "m-m0")).toEqual([expect.objectContaining({
        lane: "dex", routeId: `composed:m-m0:${src.routeId}`, holderAccess: "permissionless", settlementModel: "atomic",
        executionCosts: [{ requestedNotionalUsd: 1e6, maxCostBps: 200, executionCostBps: 1.6 }],
        physicalResourceKeys: ["pool:ethereum:0x970a7749ecaa4394c8b2bf5f2471f41fd6b79288", "wrapper:ethereum:0x437cc33344a0b27a429f795ff6b469c72698b291"],
        failureDomains: [{ kind: "redemption-rail", key: "wrapper:ethereum:0x437cc33344a0b27a429f795ff6b469c72698b291" }],
      })]);
    });
  });
});

describe("buildDexRouteReview model-confidence derivation", () => {
  function dObs(ev: RouteObs["evidenceKind"], mature = false, adapterProfileId?: string): RouteObs {
    const o = dexObs(NOW, { routeId: `dex:${USDC}:dl:ethereum%3Apool:${ev}`, scope: { kind: "chain-contract", chain: "ethereum", contractOrPoolId: `pool-${ev}`, protocol: "curve" }, maxCostBps: 50, executableUsd: 95e4, completionRatio: 0.95, output: USD, evidenceKind: ev, ...(adapterProfileId ? { adapterProfileId } : {}) });
    if (ev === "measured-executable-depth" && mature) {
      const curve = [{ requestedNotionalUsd: o.requestedNotionalUsd, maxCostBps: o.maxCostBps, executableUsd: o.executableUsd, completionRatio: o.completionRatio }];
      o.observationHistory = { completeProducerCycleCount: 2, successfulObservationCount: 2, consecutiveSuccessCount: 2, observationWindowStartedAt: NOW - 1800, observationWindowEndedAt: NOW, latestOperationalFailureAt: null, conservativeStatistic: "pointwise-minimum", conservativeCapacityCurve: curve };
      o.capacityCurve = curve;
    }
    return o;
  }
  const dRevs = (obs: RouteObs[]) => { const f = stub(undefined); setDex(f, { [USDC]: { exitRouteObservations: obs } }); return routeRevs(f, USDC); };

  it("bounds a single measured cycle at medium model confidence", () => {
    expect(dRevs([dObs("measured-executable-depth")])[0]).toMatchObject({ lane: "dex", executionCertainty: "bounded", modelConfidence: "medium" });
  });

  it("uses realized measured cost and preserves the legacy request-bound fallback", () => {
    const o = dObs("measured-executable-depth");
    o.capacityCurve = [{ requestedNotionalUsd: o.requestedNotionalUsd, maxCostBps: o.maxCostBps, executableUsd: o.executableUsd, completionRatio: o.completionRatio, executionCostBps: 37 }];
    expect(dRevs([o])[0]?.executionCosts).toEqual([{ requestedNotionalUsd: 1e6, maxCostBps: 50, executionCostBps: 37 }]);
    delete o.capacityCurve[0]!.executionCostBps;
    expect(dRevs([o])[0]?.executionCosts).toEqual([{ requestedNotionalUsd: 1e6, maxCostBps: 50, executionCostBps: 50 }]);
  });

  it("grades repeated measured executable depth as high model confidence", () => {
    expect(dRevs([dObs("measured-executable-depth", true)])[0]).toMatchObject({ lane: "dex", executionCertainty: "bounded", modelConfidence: "high" });
  });

  it("uses the uniform three-hour measured-adapter confidence window", () => {
    const o = dObs("measured-executable-depth", true, PROF_IDS.curveStableSwap);
    o.observationHistory = { ...o.observationHistory!, completeProducerCycleCount: 3, successfulObservationCount: 3, consecutiveSuccessCount: 3, observationWindowStartedAt: NOW - 10_800, observationWindowEndedAt: NOW - 7_199 };
    expect(dRevs([o])[0]).toMatchObject({ modelConfidence: "high" });
    delete o.adapterProfileId;
    expect(dRevs([o])[0]).toMatchObject({ modelConfidence: "high" });
    o.observationHistory = { ...o.observationHistory!, observationWindowStartedAt: NOW - 10_900, observationWindowEndedAt: NOW - 10_801 };
    expect(dRevs([o])[0]).toMatchObject({ modelConfidence: "medium" });
  });

  it.each(["reserve-based-amm-simulation"] as const)("keeps %s evidence at medium model confidence", (ev) => {
    expect(dRevs([dObs(ev)])[0]).toMatchObject({ lane: "dex", executionCertainty: "bounded", modelConfidence: "medium" });
  });

  it("lifts only the measured route when evidence kinds are mixed", () => {
    const r = dRevs([dObs("reserve-based-amm-simulation"), dObs("measured-executable-depth", true)]);
    expect(r).toHaveLength(2);
    expect(r.find((x) => x.routeId.includes("measured-executable-depth"))).toMatchObject({ modelConfidence: "high" });
    expect(r.find((x) => x.routeId.includes("reserve-based-amm-simulation"))).toMatchObject({ modelConfidence: "medium" });
  });
});

describe("issuer stablecoin payout valuation", () => {
  it("requires actual captured USDC prices rather than synthesizing fiat par", () => {
    withCfg("usdo-openeden", { outputAssetType: "stable-single", outputAssets: [USDC], reviewedAt: "2026-07-13" }, () => {
      const { fixedInput: f, row } = redFx({ rowOverrides: { stablecoinId: "usdo-openeden", routeFamily: "offchain-issuer" }, pegDataById: { [USDC]: { currentDeviationBps: -100, priceObservedAt: NOW } } });
      expect(rev0(f, row.stablecoinId).output).toMatchObject({ kind: "tracked-stablecoin", assetKeys: [USDC], valuation: { basis: "price", unitValueUsd: 0.99, expectedUnitValueUsd: 1 } });
      setPeg(f, {}); expect(val0(f, row.stablecoinId)).toBeNull();
    });
  });

  it("withholds basket valuation when one issuer payout has no price", () => {
    withCfg("hlusd-hela", { reviewedAt: "2026-07-13" }, () => {
      const { fixedInput: f, row } = redFx({ rowOverrides: { stablecoinId: "hlusd-hela", routeFamily: "offchain-issuer", outputAssetType: "stable-basket" }, pegDataById: { [USDC]: { currentDeviationBps: 0, priceObservedAt: NOW } } });
      expect(rev0(f, row.stablecoinId).output).toMatchObject({ kind: "tracked-stablecoin", assetKeys: [USDC, USDT], valuation: null });
    });
  });
});

describe("Theo executed eligible-cohort rail", () => {
  it.each([["onchain", 5, "exact-lower-bound"], ["static-config", 5, "exact-lower-bound"]] as const)("projects %s openness with %s bps costs as %s", (routeStatusSource, feeBps, coverageClass) => {
    const clk = 1790748096, row = mkFull({
      stablecoinId: "thusd-theo", routeFamily: "stablecoin-redeem", accessModel: "whitelisted-onchain", holderEligibility: "whitelisted-primary",
      settlementModel: "immediate", settlementDelaySec: 0, executionModel: "deterministic-onchain", outputAssetType: "stable-basket",
      sourceMode: "dynamic", provider: "reserve-sync-metadata", capacityKind: "live-direct-bounded", capacityConfidence: "live-direct",
      freshnessKind: "same-run-onchain", capacitySemantics: "immediate-bounded",
      capacityProfile: { immediateUsd: 220400, scoringUsd: 220400, scoringHorizon: "immediate", capacityProfileConfidence: "live-direct", modeledExitSizeUsd: 1e7 },
      modelConfidence: "high", routeStatus: "open", routeStatusSource, feeBps, feeModelKind: "fixed-bps", feeConfidence: "fixed",
      immediateCapacityUsd: 220400, updatedAt: clk, sourceTimestamp: clk,
    });
    const f = stub(row, clk), obs = buildRedObs({
      stablecoinId: row.stablecoinId, config: getCfg(row.stablecoinId)!, capacityProfile: row.capacityProfile,
      scoringCapacityUsd: row.immediateCapacityUsd, supplyUsd: 132_370_676.056526, routeStatus: row.routeStatus, resolutionState: row.resolutionState,
      sourceMode: row.sourceMode, capacityConfidence: row.capacityConfidence, capacityKind: row.capacityKind, freshnessKind: row.freshnessKind,
      evidenceObservedAt: clk, settlementDelaySec: row.settlementDelaySec, resolvedFeeBps: row.feeBps, now: clk,
    });
    expect(obs).not.toBeNull();
    row.capacityProfile = { ...row.capacityProfile!, immediateUsd: 220400, scoringUsd: 220400, scoringHorizon: "immediate", exitRouteObservations: [{ ...obs!, modelConfidence: "high" }] };
    setPeg(f, { [USDC]: { currentDeviationBps: 0, priceObservedAt: clk }, [USDT]: { currentDeviationBps: 0, priceObservedAt: clk } });
    const rev = rev0(f, row.stablecoinId);
    expect(rev).toMatchObject({ coverageClass, settlementModel: "bounded-delay", settlementSlaSec: 0, minRedeemUsd: 1, modelConfidence: "high", output: { kind: "tracked-stablecoin", assetKeys: [USDC, USDT] } });
    expect(rev.executionCosts).toContainEqual({ requestedNotionalUsd: 1e7, maxCostBps: 200, executionCostBps: feeBps });
    expect(getCfg("thusd-theo")?.v9RouteReviewTerms?.scoringDisposition).toBeUndefined();
  });
});

describe("explicit holder restrictions remain separate from route evidence", () => {
  it.each([["verified-customer", "institutional-eligible"], ["whitelisted-primary", "allowlisted"], ["issuer-discretionary", "issuer-only"], ["unknown", "unknown"]] as const)(
    "preserves %s access instead of inferring permissionless eligibility",
    (elig, holderAccess) => {
      const f = mkQueued(300, true);
      f.redemptionBackstopMap.alpha!.holderEligibility = elig;
      expect(routeRevs(f, "alpha").find((r) => r.lane === "redemption")!).toMatchObject({ holderAccess, queueDepthUsd: 1.5e6, dailyLimitUsd: 1e6, minRedeemUsd: 1e6 });
    },
  );
});

describe("captured local-fiat output and cost references", () => {
  const ref = { valueUsd: 1.25, source: "fx", contributorCount: 0, asOf: NOW - 60 };

  it.each(["CHF"])("values %s fiat with the captured currency reference, not USD par", (currency) => {
    const { fixedInput: f } = redFx({ rowOverrides: { stablecoinId: USDC }, output: { kind: "fiat", currency }, pegDataById: { captured: { pegCurrency: currency, pegReference: ref } } });
    expect(val0(f, USDC)).toMatchObject({ unitValueUsd: 1.25, expectedUnitValueUsd: 1.25, observedAtSec: NOW - 60, sourceId: "captured-fiat-fx-reference", maxAgeSec: DAY });
  });

  it("resolves unpinned producer output at fact-build time and fails closed without captured FX", () => {
    const { fixedInput: f, row } = redFx({ rowOverrides: { stablecoinId: USDC }, pegDataById: { captured: { pegCurrency: "EUR", pegReference: ref } } });
    const config: Cfg = { routeFamily: "offchain-issuer", accessModel: "issuer-api", settlementModel: "atomic", executionModel: "rules-based-nav", outputAssetType: "stable-single", unresolvedOutputAssetKeys: ["fiat:EUR"], capacityModel: { kind: "fixed-usd", amountUsd: 1e8, confidence: "documented-bound" }, costModel: { kind: "fee-bps", feeBps: 10 }, docs: [{ label: "Synthetic terms", url: "https://example.com/terms", supports: ["capacity", "fees", "settlement"] }], reviewedAt: "2026-07-01" };
    const obs = buildRedObs({ stablecoinId: USDC, config, capacityProfile: { ...row.capacityProfile!, scoringHorizon: "immediate" }, scoringCapacityUsd: 1e8, supplyUsd: 1e8, routeStatus: "open", resolutionState: "resolved", sourceMode: "dynamic", capacityConfidence: "live-direct", capacityKind: "live-direct", freshnessKind: "same-run-api", evidenceObservedAt: NOW - 600, resolvedFeeBps: null, now: NOW, fiatReferences: { clockSec: NOW, pegDataById: { captured: { pegCurrency: "EUR", pegReference: { ...ref, source: "fx" } } } } })!;
    expect(obs).not.toHaveProperty("outputUnitValueUsd");
    row.capacityProfile!.exitRouteObservations = [obs];
    expect(val0(f, USDC)).toMatchObject({ unitValueUsd: 1.25, expectedUnitValueUsd: 1.25, observedAtSec: ref.asOf, sourceId: "captured-fiat-fx-reference", maxAgeSec: DAY });
    setPeg(f, {}); expect(rev0(f, USDC).output).toBeNull();
  });

  it("retains the fee-clock fiat quote instead of switching to a later FX generation", () => {
    const { fixedInput: f, row } = redFx({ rowOverrides: { stablecoinId: USDC }, output: { kind: "fiat", currency: "CHF" }, pegDataById: { captured: { pegCurrency: "CHF", pegReference: { ...ref, valueUsd: 2 } } } });
    const obs = row.capacityProfile!.exitRouteObservations![0]!;
    Object.assign(obs, { outputUnitValueUsd: 1.25, outputExpectedUnitValueUsd: 1.25, outputUnitValueObservedAt: NOW - 60, outputUnitValueSourceId: "captured-fiat-fx-reference:CHF", executionCostBps: 10, allInCostBps: 10 });
    expect(val0(f, USDC)?.unitValueUsd).toBe(1.25);
    obs.outputUnitValueObservedAt = NOW - DAY - 1;
    expect(rev0(f, USDC).output).toBeNull();
  });

  it.each([undefined, { ...ref, asOf: NOW + 1 }, { ...ref, asOf: NOW - DAY - 1 }, { ...ref, source: "fallback" }, { ...ref, source: "median", contributorCount: 1 }])(
    "withholds non-USD fiat output for missing, future, stale or unadmitted FX (case %#)",
    (pegReference) => {
      const { fixedInput: f } = redFx({ rowOverrides: { stablecoinId: USDC }, output: { kind: "fiat", currency: "CHF" }, pegDataById: { captured: { pegCurrency: "CHF", pegReference } } });
      expect(rev0(f, USDC).output).toBeNull();
    },
  );

  it.each(["issuer-redemption", "eventual-redemption"] as const)("values an explicit single external fiat identity on a %s issuer route", (rf) => {
    withCfg(USDC, { unresolvedOutputAssetKeys: ["fiat:JPY"] }, () => {
      const { fixedInput: f, row } = redFx({ rowOverrides: { stablecoinId: USDC }, output: { kind: "unresolved-asset", assetKeys: ["fiat:JPY"] }, pegDataById: { captured: { pegCurrency: "JPY", pegReference: ref } } });
      row.capacityProfile!.exitRouteObservations![0]!.routeFamily = rf;
      expect(rev0(f, USDC).output).toMatchObject({ kind: "fiat", assetKeys: ["fiat:JPY"], valuation: { unitValueUsd: 1.25 } });
    });
  });

  it("keeps delayed protocol fiat identities and ambiguous issuer outputs unresolved", () => {
    withCfg(USDC, { unresolvedOutputAssetKeys: ["fiat:JPY", "fiat:CHF"] }, () => {
      const { fixedInput: f, row } = redFx({ rowOverrides: { stablecoinId: USDC }, output: { kind: "unresolved-asset", assetKeys: ["fiat:JPY"] }, pegDataById: { captured: { pegCurrency: "JPY", pegReference: ref } } });
      const obs = row.capacityProfile!.exitRouteObservations![0]!;
      obs.routeFamily = "eventual-redemption"; obs.scope = { kind: "protocol", protocol: "synthetic-vault" };
      expect(rev0(f, USDC).output).toBeNull();
      obs.scope = { kind: "issuer", issuerId: USDC }; obs.output = { kind: "unresolved-asset", assetKeys: ["fiat:JPY", "fiat:CHF"] };
      expect(rev0(f, USDC).output).toBeNull();
      obs.output = { kind: "unresolved-asset", assetKeys: ["fiat:JPY"] }; setPeg(f, {});
      expect(rev0(f, USDC).output).toBeNull();
    });
  });

  it("fails closed on local cost FX even when a reusable zero-bps fallback exists", () => {
    withCfg(USDC, { costModel: { kind: "fee-bps", feeBps: 0, feeComponents: [{ currency: "CHF", terms: { flatAmount: 30 } }] } }, (config) => {
      const { fixedInput: f, row } = redFx({ rowOverrides: { stablecoinId: USDC, feeBps: 0 } }), obs = row.capacityProfile!.exitRouteObservations![0]!;
      row.capacityProfile!.exitRouteObservations = [{ ...obs, executionCostBps: undefined, capacityCurve: obs.capacityCurve?.map((p) => ({ ...p, executionCostBps: undefined })) }];
      expect(rev0(f, USDC).feeEvidence).toBe("disclosed-unquantified");
      setPeg(f, { captured: { pegCurrency: "CHF", pegReference: ref } });
      expect(rev0(f, USDC).executionCosts.find((p) => p.requestedNotionalUsd === obs.requestedNotionalUsd)?.executionCostBps).toBe(37.5 / obs.requestedNotionalUsd * 1e4);
      expect(buildRedObs({ stablecoinId: USDC, config, capacityProfile: row.capacityProfile, scoringCapacityUsd: 1e6, supplyUsd: 1e6, routeStatus: "open", resolutionState: "resolved", sourceMode: "static", capacityConfidence: "documented-bound", resolvedFeeBps: 0, now: NOW })).toMatchObject({ feeEvidence: "disclosed-unquantified", scoreEligible: false });
    });
  });

  it("admits bUSD0 wait-to-maturity queued settlement without altering capacity or cost gaps", () => {
    const clk = utc(2026, 11, 24, 2, 17, 58);
    const id = "busd0-usual";
    const routeId = `redemption:${id}:queue-redeem`;
    const row = mkFull({
      stablecoinId: id, routeFamily: "queue-redeem", settlementModel: "queued", settlementDelaySec: undefined,
      capacitySemantics: "eventual-only", capacityConfidence: "documented-bound", feeConfidence: "undisclosed-reviewed", updatedAt: clk,
    });
    setObs(row, [{
      ...obs0(row), routeId, routeFamily: "eventual-redemption", output: trk("usd0-usual"),
      settlementHorizonSec: 30 * DAY, scoreEligible: false, observedAt: clk, freshnessSeconds: 0,
    }]);
    const f = stub(row, clk);
    setRawPeg(f, { "usd0-usual": { currentDeviationBps: 0, priceObservedAt: clk } });
    expect(rev0(f, id)).toMatchObject({
      lane: "redemption", routeId, settlementModel: "queued", settlementSlaSec: 48_943_800,
      settlementBoundUnproven: false, settlementHorizonSec: 48_943_800, coverageClass: "diagnostic",
    });

    const fixed = mkFixed({ assetId: id, clockSec: clk });
    Object.assign(fixed, { redemptionBackstopMap: { [id]: row }, redemptionGenerationId: "redemption:busd0-maturity-test", redemptionStale: false });
    fixed.inputFreshness.redemptionBackstops = { updatedAt: clk, ageSeconds: 0, stale: false };
    fixed.pegDataById["usd0-usual"] = { ...fixed.pegDataById[id]!, id: "usd0-usual", symbol: "USD0", currentDeviationBps: 0, priceObservedAt: clk, priceUpdatedAt: clk };
    const rebuilt = rebuildFixed(fixed);
    const reviewed = mkExt({ assetId: id, clockSec: clk, registryFingerprint: rebuilt.registryFingerprint });
    reviewed.assets[0]!.routeReviews = routeRevs(rebuilt, id);
    reviewed.assets[0]!.retainedRoutes = retRed(rebuilt, id);
    const compiled = compileFacts(rebuilt, reviewed).assets[0]!;
    expect(compiled.exitRoutes.find((r) => r.routeId === routeId)).toMatchObject({
      settlementModel: "queued", settlementSlaSec: 48_943_800,
      factorStatuses: { settlement: { observationState: "known", gapIds: [] }, capacity: { observationState: "missing" } },
    });
    expect(compiled.gaps.some((g) => g.gapId.endsWith(":settlement"))).toBe(false);
    expect(compiled.gaps.some((g) => g.gapId.endsWith(":capacity"))).toBe(true);
  });
});
