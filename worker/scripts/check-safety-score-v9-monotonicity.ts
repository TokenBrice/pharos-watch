/**
 * Standing Safety Score V9 synthetic monotonicity sweep.
 *
 * Runs offline against the full-registry V9 fixture (enriched with deterministic
 * multi-chain bridge shares across every authored `bridgeRouteRisk.routes[]`
 * chain), or against a supplied production capture via `--capture <path>`:
 *   1. Whole-profile bridge expiry (`reviewedAt = "2020-01-01"` across all
 *      assets with `bridgeRouteRisk`): asserts 0 score rises, 0 preCap rises,
 *      0 monotonicity violations, and 0 new quarantines.
 *   2. Whole-profile bridge retirement (`retired` tombstone across all assets
 *      with `bridgeRouteRisk`): asserts 0 score rises, 0 preCap rises,
 *      0 monotonicity violations, and 0 new quarantines.
 *   3. Per-route retirement (`reviewDisposition: "retired"` on one
 *      `external-lock-mint` route of every multi-signal ELM asset): asserts
 *      0 score rises, 0 preCap rises, and 0 monotonicity violations.
 *   4. Negative self-test: verifies `detectMonotonicityViolations` catches a
 *      counterfactual removed-evidence rise and rejects mismatched `fixedInput`
 *      / missing `evaluatedSet.assets` with `CliUsageError` (exit 2).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ACTIVE_META_BY_ID, ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/constants";
import { computeRedemptionPayloadFingerprint, computeReportCardsRegistryFingerprint } from "@shared/lib/report-cards-fixed-input-identity";
import { resolveChainId } from "@shared/types/chain-identity";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import {
  CliUsageError,
  parseStrictCliArgs,
  runCliEntrypoint,
  writeCliHelpIfRequested,
} from "../../scripts/lib/cli-args.mjs";
import { buildSafetyScoreV9Candidate } from "../src/lib/safety-score-v9/candidate";
import {
  computeNativeDexLiquidityPayloadFingerprint,
  normalizeNativeV9Input,
  normalizeSafetyScoreV9CompilerInput,
  type NativeDexLiquidityRow,
  type SafetyScoreV9CompilerInput,
} from "../src/lib/safety-score-v9/native-input";
import {
  parseSafetyScoreV9ReplayLaneScreening,
  replayLaneIncidentCertificates,
} from "../src/lib/safety-score-v9/publication-replay-capture";
import { parseSafetyScoreV9TransferMaterialityGeneration } from "../src/lib/safety-score-v9/transfer-materiality";
import {
  assertMatchingFixedInput,
  detectMonotonicityViolations,
  type MonotonicityViolation,
} from "./diff-safety-score-v9-replays";

const USAGE = `Usage: npm run safety-score-v9:check-monotonicity -- [options]

Options:
  --capture <path>   Optional V9 capture JSON to sweep instead of the offline full-registry fixture
  --json             Emit machine-readable JSON summary
  -h, --help         Show this help`;

interface SweepOutcome {
  name: string;
  mutatedAssets: number;
  checkedAssets: number;
  scoreRises: string[];
  preCapRises: string[];
  newQuarantines: string[];
  violations: MonotonicityViolation[];
}

function deriveSweepClockSec(): number {
  let maxSec = Math.floor(Date.parse("2026-11-25T00:00:00.000Z") / 1_000);
  const scan = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) scan(item);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) {
        if ((key === "reviewedAt" || key === "compositionAsOf") && typeof entry === "string") {
          const sec = Math.floor(Date.parse(entry.length === 10 ? `${entry}T00:00:00.000Z` : entry) / 1_000);
          if (Number.isFinite(sec) && sec > maxSec) maxSec = sec;
        } else {
          scan(entry);
        }
      }
    }
  };
  scan(ACTIVE_STABLECOINS);
  return maxSec + 86_400;
}

function buildMultiChainFullRegistryInput(): SafetyScoreV9CompilerInput {
  const clockSec = deriveSweepClockSec();
  const dexUpdatedAtSec = clockSec - 100;
  const dexGenerationId = `dex-liquidity-${dexUpdatedAtSec}`;
  const dexLiqMap: Record<string, NativeDexLiquidityRow> = Object.fromEntries(
    ACTIVE_STABLECOINS.map((coin) => [
      coin.id,
      {
        updatedAt: dexUpdatedAtSec,
        exitRouteObservations: [
          {
            routeId: `dex:sweep:${coin.id}`,
            routeFamily: "dex-amm" as const,
            scope: {
              kind: "chain-contract" as const,
              chain: "ethereum",
              contractOrPoolId: `${coin.id}:sweep-pool`,
              protocol: "sweep-fixture",
            },
            requestedNotionalUsd: 100_000,
            settlementHorizonSec: 300,
            maxCostBps: 200,
            executableUsd: 80_000,
            completionRatio: 0.8,
            output: { kind: "fiat" as const, currency: "USD", assetKeys: ["fiat:USD"] },
            evidenceKind: "reserve-based-amm-simulation" as const,
            confidence: "high" as const,
            scoreEligible: true,
            observedAt: dexUpdatedAtSec,
            freshnessSeconds: clockSec - dexUpdatedAtSec,
            commonModeKeys: ["chain:ethereum", "protocol:sweep-fixture"],
            capacityCurve: [100_000, 1_000_000, 10_000_000, 100_000_000].map((notional) => ({
              requestedNotionalUsd: notional,
              maxCostBps: 200,
              executableUsd: notional * 0.8,
              completionRatio: 0.8,
            })),
          },
        ],
        exitRouteObservationCoverage: {
          status: "populated" as const,
          capabilityMatrixVersion: "p4a.4",
          retainedPoolCount: 1,
          observationCount: 1,
          scoreEligibleObservationCount: 1,
          scoreEligiblePoolCount: 1,
          scoreEligibleCapabilityPoolCount: 1,
          unsupportedPoolCount: 0,
          evidenceCounts: { "reserve-based-amm-simulation": 1 },
          unsupportedReasons: {},
        },
      },
    ]),
  );
  const chainCirculatingById: Record<string, Record<string, { current: number }>> = {};
  for (const coin of ACTIVE_STABLECOINS) {
    const routes = coin.bridgeRouteRisk?.routes ?? [];
    const isNativeRoute = (route: (typeof routes)[number]) =>
      route.routeClass === "native" || route.issuanceModel === "native-issuance";
    const nativeChains = [
      ...new Set(
        routes
          .filter(isNativeRoute)
          .map((route) => resolveChainId(route.destinationChain))
          .filter((chain): chain is string => chain !== null),
      ),
    ];
    const bridgedChains = [
      ...new Set(
        routes
          .filter((route) => !isNativeRoute(route))
          .map((route) => resolveChainId(route.destinationChain))
          .filter((chain): chain is string => chain !== null && !nativeChains.includes(chain)),
      ),
    ];
    const allChains = [...nativeChains, ...bridgedChains];
    if (allChains.length <= 1) {
      chainCirculatingById[coin.id] = { ethereum: { current: 10_000_000 } };
    } else if (nativeChains.length > 0 && bridgedChains.length > 0) {
      const rows: Record<string, { current: number }> = {};
      // Mirror realistic multi-chain supply skew (75% native, 25% geometric across
      // bridged routes) so every bridged route stays populated and both >=10% and
      // <10% bridged shares are exercised without artificially placing 6+ chains on
      // the 10% common-mode knife edge simultaneously.
      const perNative = Math.round(7_500_000 / nativeChains.length);
      for (const chain of nativeChains) rows[chain] = { current: perNative };
      const weights = bridgedChains.map((_, idx) => 2 ** Math.max(0, bridgedChains.length - 1 - idx));
      const weightSum = weights.reduce((sum, w) => sum + w, 0);
      bridgedChains.forEach((chain, idx) => {
        rows[chain] = { current: Math.max(10_000, Math.round((2_500_000 * weights[idx]!) / weightSum)) };
      });
      chainCirculatingById[coin.id] = rows;
    } else {
      const rows: Record<string, { current: number }> = {};
      const weights = allChains.map((_, idx) => 2 ** Math.max(0, allChains.length - 1 - idx));
      const weightSum = weights.reduce((sum, w) => sum + w, 0);
      allChains.forEach((chain, idx) => {
        rows[chain] = { current: Math.max(10_000, Math.round((10_000_000 * weights[idx]!) / weightSum)) };
      });
      chainCirculatingById[coin.id] = rows;
    }
  }
  const redemptionGenerationId = "redemption-backstops-unavailable";
  return normalizeNativeV9Input({
    schemaVersion: 4,
    captureKind: "native-v9-inputs",
    activeAssetIds: ACTIVE_STABLECOINS.map((coin) => coin.id),
    capturedAt: new Date(clockSec * 1_000).toISOString(),
    sourceGeneration: `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:${clockSec}`,
    dexGenerationId,
    dexPayloadFingerprint: computeNativeDexLiquidityPayloadFingerprint(dexLiqMap, dexGenerationId),
    redemptionGenerationId,
    redemptionPayloadFingerprint: computeRedemptionPayloadFingerprint({}, redemptionGenerationId),
    registryRevision: "safety-score-v9-monotonicity-sweep",
    registryFingerprint: computeReportCardsRegistryFingerprint(),
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    clockSec,
    updatedAt: clockSec,
    liquidityStale: false,
    redemptionStale: true,
    inputFreshness: {
      dexLiquidity: { updatedAt: dexUpdatedAtSec, ageSeconds: 100, stale: false },
      redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: true },
    },
    inputMethodologyVersions: {
      safetyScore: SAFETY_SCORE_METHODOLOGY_VERSION,
      dexLiquidity: ["sweep-fixture"],
      pegScore: ["sweep-fixture"],
      redemptionBackstop: [],
    },
    v9PublicationInputHealth: {
      dex: { state: "current", generationId: dexGenerationId, updatedAtSec: dexUpdatedAtSec },
      redemption: { state: "unavailable", generationId: null, updatedAtSec: null },
      liveReserves: { state: "available", coverageRatio: 1 },
    },
    pegDataById: Object.fromEntries(
      ACTIVE_STABLECOINS.map((coin) => [
        coin.id,
        {
          id: coin.id,
          symbol: coin.symbol,
          name: coin.name,
          pegType: "peggedUSD",
          pegCurrency: "USD",
          governance: coin.flags.governance,
          currentDeviationBps: 1,
          pegScore: 100,
          priceSource: "sweep-fixture",
          priceObservedAt: dexUpdatedAtSec,
          pegPct: 100,
          severityScore: 100,
          spreadPenalty: 0,
          eventCount: 0,
          worstDeviationBps: null,
          activeDepeg: false,
          lastEventAt: null,
          trackingSpanDays: 365,
          historyCoverage: {
            startedAt: clockSec - 365 * 24 * 60 * 60,
            source: "asset-age" as const,
            status: "assumed" as const,
          },
          methodologyVersion: "sweep-fixture",
        },
      ]),
    ),
    activeDepegPeakBpsById: {},
    dexLiqMap,
    redemptionBackstopMap: {},
    liveReserveMap: Object.fromEntries(
      ACTIVE_STABLECOINS.map((coin) => [
        coin.id,
        [
          {
            name: "Sweep fixture reserves",
            pct: 100,
            risk: "very-low" as const,
            assetClass: "cash" as const,
            issuerOrObligor: `issuer:${coin.id}`,
            riskFactors: ["custody", "counterparty"],
            liquidityHorizon: "immediate" as const,
            maturityDaysMax: 0,
          },
        ],
      ]),
    ),
    liveReserveProvenanceMap: Object.fromEntries(
      ACTIVE_STABLECOINS.map((coin) => [
        coin.id,
        { source: "sweep-fixture", fetchedAt: dexUpdatedAtSec },
      ]),
    ),
    aggregateCirculatingById: Object.fromEntries(
      ACTIVE_STABLECOINS.map((coin) => [
        coin.id,
        { circulating: { peggedUSD: 10_000_000 }, observedAtSec: dexUpdatedAtSec },
      ]),
    ),
    chainCirculatingById,
    dexDeploymentSupplyCoverageById: {},
    liveToFallbackCoins: [],
  });
}

function loadCaptureInput(capturePath: string) {
  const raw = JSON.parse(readFileSync(capturePath, "utf8")) as Record<string, unknown>;
  const fixedInput = normalizeSafetyScoreV9CompilerInput(raw.fixedInput ?? raw);
  const transferMaterialityGeneration = raw.transferMaterialityGeneration
    ? parseSafetyScoreV9TransferMaterialityGeneration(raw.transferMaterialityGeneration)
    : null;
  const laneScreening = raw.laneScreening
    ? parseSafetyScoreV9ReplayLaneScreening(raw.laneScreening)
    : null;
  const laneIncidentCertificates = laneScreening
    ? replayLaneIncidentCertificates(laneScreening)
    : undefined;
  const laneEmitterDescriptors = laneScreening?.descriptors;
  return {
    fixedInput,
    transferMaterialityGeneration,
    laneIncidentCertificates,
    laneEmitterDescriptors,
  };
}

function cloneMetaMap(
  mutate: (assetId: string, meta: StablecoinMeta) => StablecoinMeta | null,
): { metaById: Map<string, StablecoinMeta>; mutatedCount: number } {
  const metaById = new Map<string, StablecoinMeta>();
  let mutatedCount = 0;
  for (const [assetId, meta] of ACTIVE_META_BY_ID) {
    const next = mutate(assetId, meta);
    if (next !== null) {
      metaById.set(assetId, next);
      mutatedCount += 1;
    } else {
      metaById.set(assetId, meta);
    }
  }
  return { metaById, mutatedCount };
}

function summarizeSweep(
  name: string,
  mutatedAssets: number,
  beforePipeline: Awaited<ReturnType<typeof buildSafetyScoreV9Candidate>>,
  afterPipeline: Awaited<ReturnType<typeof buildSafetyScoreV9Candidate>>,
): SweepOutcome {
  const beforeArtifact = { pipeline: beforePipeline };
  const afterArtifact = { pipeline: afterPipeline };
  const { violations, checkedAssetCount } = detectMonotonicityViolations(beforeArtifact, afterArtifact);
  const beforeById = new Map(beforePipeline.evaluatedSet.assets.map((asset) => [asset.assetId, asset]));
  const scoreRises: string[] = [];
  const preCapRises: string[] = [];
  for (const afterAsset of afterPipeline.evaluatedSet.assets) {
    const beforeAsset = beforeById.get(afterAsset.assetId);
    if (!beforeAsset) continue;
    if (
      beforeAsset.trace.finalScore !== null &&
      afterAsset.trace.finalScore !== null &&
      afterAsset.trace.finalScore > beforeAsset.trace.finalScore + 1e-6
    ) {
      scoreRises.push(
        `${afterAsset.assetId}:${beforeAsset.trace.finalScore}->${afterAsset.trace.finalScore}`,
      );
    }
    if (
      beforeAsset.trace.preCapScore !== null &&
      afterAsset.trace.preCapScore !== null &&
      afterAsset.trace.preCapScore > beforeAsset.trace.preCapScore + 1e-6
    ) {
      preCapRises.push(
        `${afterAsset.assetId}:${beforeAsset.trace.preCapScore.toFixed(4)}->${afterAsset.trace.preCapScore.toFixed(4)}`,
      );
    }
  }
  const beforeQuarantines = new Set(beforePipeline.quarantines.map((q) => q.assetId));
  const newQuarantines = afterPipeline.quarantines
    .map((q) => q.assetId)
    .filter((assetId) => !beforeQuarantines.has(assetId))
    .sort();
  return {
    name,
    mutatedAssets,
    checkedAssets: checkedAssetCount,
    scoreRises,
    preCapRises,
    newQuarantines,
    violations,
  };
}

function runNegativeSelfTest(
  baselinePipeline: Awaited<ReturnType<typeof buildSafetyScoreV9Candidate>>,
): void {
  // 1. Mismatched fixedInput must throw CliUsageError (exit 2).
  let mismatchedRejected = false;
  try {
    assertMatchingFixedInput(
      { pipeline: baselinePipeline },
      {
        pipeline: {
          ...baselinePipeline,
          fixedInput: { ...baselinePipeline.fixedInput, clockSec: baselinePipeline.fixedInput.clockSec + 60 },
        },
      },
    );
  } catch (error) {
    mismatchedRejected = error instanceof CliUsageError;
  }
  if (!mismatchedRejected) {
    throw new Error("Monotonicity self-test failed: mismatched fixedInput did not throw CliUsageError");
  }

  // 2. Missing evaluatedSet.assets must throw CliUsageError (exit 2).
  let missingEvalRejected = false;
  try {
    assertMatchingFixedInput(
      { pipeline: baselinePipeline },
      { pipeline: { fixedInput: baselinePipeline.fixedInput, candidate: baselinePipeline.candidate } },
    );
  } catch (error) {
    missingEvalRejected = error instanceof CliUsageError;
  }
  if (!missingEvalRejected) {
    throw new Error("Monotonicity self-test failed: missing evaluatedSet.assets did not throw CliUsageError");
  }

  // 3. Removed-evidence score rise must be caught by detectMonotonicityViolations.
  const target = baselinePipeline.evaluatedSet.assets.find(
    (asset) =>
      asset.trace.finalScore !== null &&
      asset.scoreInput.pillars.exit.score !== null &&
      asset.scoreInput.pillars.exit.score < 50 &&
      asset.exit.routes.length > 0,
  ) ?? baselinePipeline.evaluatedSet.assets.find(
    (asset) => asset.trace.finalScore !== null && asset.exit.routes.length > 0,
  );
  if (!target) {
    throw new Error("Monotonicity self-test failed: could not locate an asset with exit routes");
  }
  const mutatedEval = baselinePipeline.evaluatedSet.assets.map((asset) => {
    if (asset.assetId !== target.assetId) return asset;
    const beforeExit = asset.scoreInput.pillars.exit.score ?? 40;
    const beforeFinal = asset.trace.finalScore ?? 50;
    return {
      ...asset,
      exit: { ...asset.exit, routes: [], primaryRouteKey: null },
      scoreInput: {
        ...asset.scoreInput,
        pillars: {
          ...asset.scoreInput.pillars,
          exit: {
            ...asset.scoreInput.pillars.exit,
            score: Math.max(50, beforeExit + 5),
            evidenceLevel: "limited" as const,
            limitedEvidenceCauses: ["U" as const],
            supportedComponentKeys: [],
          },
        },
      },
      trace: {
        ...asset.trace,
        preCapScore: (asset.trace.preCapScore ?? beforeFinal) + 3,
        finalScore: beforeFinal + 3,
      },
    };
  });
  const mutatedCards = baselinePipeline.candidate.cards.map((card) =>
    card.id === target.assetId && card.score !== null ? { ...card, score: card.score + 3 } : card,
  );
  const selfTest = detectMonotonicityViolations(
    { pipeline: baselinePipeline },
    {
      pipeline: {
        ...baselinePipeline,
        evaluatedSet: { ...baselinePipeline.evaluatedSet, assets: mutatedEval },
        candidate: { ...baselinePipeline.candidate, cards: mutatedCards },
      },
    },
  );
  if (!selfTest.violations.some((v) => v.assetId === target.assetId)) {
    throw new Error(
      `Monotonicity self-test failed: removed-evidence rise on ${target.assetId} was not detected`,
    );
  }
}

async function main(): Promise<void> {
  const { values } = parseStrictCliArgs(process.argv.slice(2), {
    options: {
      capture: { type: "string" },
      json: { type: "boolean" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE)) return;

  const captureInput =
    typeof values.capture === "string"
      ? loadCaptureInput(String(values.capture))
      : {
          fixedInput: buildMultiChainFullRegistryInput(),
          transferMaterialityGeneration: null,
          laneIncidentCertificates: undefined,
          laneEmitterDescriptors: undefined,
        };

  const runCandidate = async (metaById?: Map<string, StablecoinMeta>) =>
    buildSafetyScoreV9Candidate({
      fixedInput: captureInput.fixedInput,
      publishedAtSec: captureInput.fixedInput.clockSec,
      allowRegistryMismatch: true,
      transferMaterialityGeneration: captureInput.transferMaterialityGeneration,
      laneIncidentCertificates: captureInput.laneIncidentCertificates,
      laneEmitterDescriptors: captureInput.laneEmitterDescriptors,
      ...(metaById ? { registry: { metaById } } : {}),
    });

  const baseline = await runCandidate();
  runNegativeSelfTest(baseline);

  const sweeps: SweepOutcome[] = [];

  // Sweep 1: Whole-profile bridge review expiry across all assets with bridgeRouteRisk
  const expired = cloneMetaMap((_id, meta) =>
    meta.bridgeRouteRisk
      ? { ...meta, bridgeRouteRisk: { ...meta.bridgeRouteRisk, reviewedAt: "2020-01-01" } }
      : null,
  );
  sweeps.push(
    summarizeSweep(
      "whole-profile-bridge-expiry",
      expired.mutatedCount,
      baseline,
      await runCandidate(expired.metaById),
    ),
  );

  // Sweep 2: Whole-profile bridge retirement tombstone across all assets with bridgeRouteRisk
  const retiredDate = new Date(captureInput.fixedInput.clockSec * 1_000).toISOString().slice(0, 10);
  const retiredWhole = cloneMetaMap((_id, meta) =>
    meta.bridgeRouteRisk
      ? {
          ...meta,
          bridgeRouteRisk: {
            ...meta.bridgeRouteRisk,
            retired: {
              reviewedAt: retiredDate >= meta.bridgeRouteRisk.reviewedAt ? retiredDate : meta.bridgeRouteRisk.reviewedAt,
              reviewer: "v9-monotonicity-sweep",
              reason: "Synthetic whole-profile bridge retirement verification",
            },
          },
        }
      : null,
  );
  sweeps.push(
    summarizeSweep(
      "whole-profile-bridge-retirement",
      retiredWhole.mutatedCount,
      baseline,
      await runCandidate(retiredWhole.metaById),
    ),
  );

  // Sweep 3: Per-route retirement of one external-lock-mint route across all multi-signal ELM assets
  const retiredElmRoute = cloneMetaMap((_id, meta) => {
    const routes = meta.bridgeRouteRisk?.routes;
    if (!meta.bridgeRouteRisk || !routes || routes.length < 2) return null;
    const elmIndex = routes.findIndex(
      (route) => route.reviewDisposition === "reviewed" && route.riskTier === "external-lock-mint",
    );
    if (elmIndex < 0) return null;
    const targetRoute = routes[elmIndex]!;
    const nextRoutes = routes.map((route, index) =>
      index === elmIndex
        ? {
            id: route.id,
            destinationChain: route.destinationChain,
            contractAddress: route.contractAddress,
            protocol: route.protocol,
            ...(route.sourceChain ? { sourceChain: route.sourceChain } : {}),
            ...(route.failureDomainKeys ? { failureDomainKeys: route.failureDomainKeys } : {}),
            issuanceModel: "unknown" as const,
            routeClass: "unknown" as const,
            riskTier: "opaque-or-unknown" as const,
            semantics: "unknown" as const,
            scope: "unknown" as const,
            reviewDisposition: "retired" as const,
            retiredReason: `Synthetic per-route retirement monotonicity check for ${targetRoute.id}`,
          }
        : route,
    );
    const nextControls = (meta.bridgeRouteRisk.controls ?? [])
      .map((control) => ({
        ...control,
        routeRefs: control.routeRefs.filter((ref) => ref.toLowerCase() !== targetRoute.id.toLowerCase()),
      }))
      .filter((control) => control.routeRefs.length > 0);
    const remainingControlIds = new Set(nextControls.map((control) => control.id.toLowerCase()));
    const nextScopedQuestions = meta.bridgeRouteRisk.scopedQuestions?.filter((question) =>
      remainingControlIds.has(question.controlRef.toLowerCase()),
    );
    return {
      ...meta,
      bridgeRouteRisk: {
        ...meta.bridgeRouteRisk,
        routes: nextRoutes,
        controls: nextControls.length > 0 ? nextControls : undefined,
        ...(meta.bridgeRouteRisk.scopedQuestions
          ? { scopedQuestions: nextScopedQuestions && nextScopedQuestions.length > 0 ? nextScopedQuestions : undefined }
          : {}),
      },
    };
  });
  sweeps.push(
    summarizeSweep(
      "per-route-elm-retirement",
      retiredElmRoute.mutatedCount,
      baseline,
      await runCandidate(retiredElmRoute.metaById),
    ),
  );

  const failures = sweeps.filter(
    (s) => s.scoreRises.length > 0 || s.preCapRises.length > 0 || s.newQuarantines.length > 0 || s.violations.length > 0,
  );
  if (values.json === true) {
    process.stdout.write(`${JSON.stringify({ clockSec: captureInput.fixedInput.clockSec, sweeps, negativeSelfTest: "passed" }, null, 2)}\n`);
  } else {
    for (const s of sweeps) {
      process.stdout.write(
        `${s.name}: mutated=${s.mutatedAssets} checked=${s.checkedAssets} scoreRises=${s.scoreRises.length} preCapRises=${s.preCapRises.length} newQuarantines=${s.newQuarantines.length} violations=${s.violations.length}\n`,
      );
      if (s.scoreRises.length > 0) process.stderr.write(`  scoreRises: ${s.scoreRises.slice(0, 15).join(", ")}\n`);
      if (s.preCapRises.length > 0) process.stderr.write(`  preCapRises: ${s.preCapRises.slice(0, 15).join(", ")}\n`);
      if (s.newQuarantines.length > 0) process.stderr.write(`  newQuarantines: ${s.newQuarantines.join(", ")}\n`);
      for (const v of s.violations.slice(0, 15)) {
        process.stderr.write(`  violation ${v.assetId}: ${v.scoreBefore}->${v.scoreAfter} [${v.witnesses.map((w) => w.code).join(",")}]\n`);
      }
    }
    process.stdout.write("negative-self-test: passed (caught removed-evidence rise, mismatched fixedInput, missing evaluatedSet)\n");
  }
  if (failures.length > 0) {
    throw new Error(
      `V9 monotonicity sweep failed in ${failures.map((f) => f.name).join(", ")}`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void runCliEntrypoint(main, { label: "safety-score-v9:check-monotonicity", usage: USAGE });
}
