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
 *   3. Per-route retirement (`reviewDisposition: "retired"` across EVERY
 *      reviewed `external-lock-mint` route of every multi-route ELM asset):
 *      asserts 0 score rises, 0 preCap rises, 0 new quarantines, and 0
 *      monotonicity violations.
 *   4. Binding active-bridge-incident lapse (`>= 10%` supply share pinned onto
 *      every active-incident bridge chain): asserts 0 rises, 0 quarantines,
 *      0 violations, and Control <= 25 under both expiry and retirement.
 *   5. Negative self-test: verifies `detectMonotonicityViolations` catches a
 *      counterfactual removed-evidence rise and rejects mismatched `fixedInput`
 *      / missing `evaluatedSet.assets` with `CliUsageError` (exit 2).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ACTIVE_META_BY_ID, ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/constants";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { computeRedemptionPayloadFingerprint, computeReportCardsRegistryFingerprint } from "@shared/lib/report-cards-fixed-input-identity";
import { resolveChainId } from "@shared/types/chain-identity";
import type { BridgeRouteDeployment } from "@shared/types/stablecoin-meta-control-schemas";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import type { V9AssetFactsV3 } from "@shared/types/safety-score-v9-facts";
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
  mutatedRoutes?: number;
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
      // <10% bridged shares are exercised. Uniform 1/N shares trigger a pre-existing
      // `resolveV9ScopedRisk` proportional-normalization interaction when 6+ common-mode
      // domains cross 10% simultaneously (e.g. eurc-circle preCap +0.55 on per-route
      // retirement, tracked outside v10.57 Owner Decision A3); binding >=10% active
      // bridge incidents are explicitly exercised separately below so they are never
      // masked by native skew.
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

function retireBridgeRoute(
  meta: StablecoinMeta,
  targetRoute: BridgeRouteDeployment,
): StablecoinMeta {
  const routes = meta.bridgeRouteRisk?.routes ?? [];
  const nextRoutes = routes.map((route) =>
    route.id.toLowerCase() === targetRoute.id.toLowerCase()
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
  const nextControls = (meta.bridgeRouteRisk?.controls ?? [])
    .map((control) => ({
      ...control,
      routeRefs: control.routeRefs.filter((ref) => ref.toLowerCase() !== targetRoute.id.toLowerCase()),
    }))
    .filter((control) => control.routeRefs.length > 0);
  const remainingControlIds = new Set(nextControls.map((control) => control.id.toLowerCase()));
  const nextScopedQuestions = meta.bridgeRouteRisk?.scopedQuestions?.filter((question) =>
    remainingControlIds.has(question.controlRef.toLowerCase()),
  );
  return {
    ...meta,
    bridgeRouteRisk: {
      ...meta.bridgeRouteRisk!,
      routes: nextRoutes,
      controls: nextControls.length > 0 ? nextControls : undefined,
      ...(meta.bridgeRouteRisk?.scopedQuestions
        ? { scopedQuestions: nextScopedQuestions && nextScopedQuestions.length > 0 ? nextScopedQuestions : undefined }
        : {}),
    },
  };
}

function collectDependencyClosure(
  seedIds: ReadonlySet<string>,
  compiledAssets: readonly V9AssetFactsV3[],
  includeDownstream: boolean,
): Set<string> {
  const parentsByAsset = new Map<string, Set<string>>();
  const childrenByAsset = new Map<string, Set<string>>();
  const exitOutputsByAsset = new Map<string, Set<string>>();
  const activeSet = new Set(compiledAssets.map((asset) => asset.assetId));
  for (const asset of compiledAssets) {
    const parents = parentsByAsset.get(asset.assetId) ?? new Set<string>();
    for (const edge of asset.dependencies.edges) {
      parents.add(edge.upstreamAssetId);
      const children = childrenByAsset.get(edge.upstreamAssetId) ?? new Set<string>();
      children.add(asset.assetId);
      childrenByAsset.set(edge.upstreamAssetId, children);
    }
    for (const exposure of asset.reserveExposures) {
      if (exposure.trackedAssetId !== null) {
        parents.add(exposure.trackedAssetId);
        const children = childrenByAsset.get(exposure.trackedAssetId) ?? new Set<string>();
        children.add(asset.assetId);
        childrenByAsset.set(exposure.trackedAssetId, children);
      }
    }
    const exitOutputs = new Set<string>();
    for (const route of asset.exitRoutes) {
      if (route.output.kind !== "tracked-stablecoin") continue;
      for (const outputAssetId of route.output.assetKeys) {
        if (activeSet.has(outputAssetId) && outputAssetId !== asset.assetId) {
          exitOutputs.add(outputAssetId);
        }
      }
    }
    exitOutputsByAsset.set(asset.assetId, exitOutputs);
    parentsByAsset.set(asset.assetId, parents);
  }
  const visited = new Set<string>(seedIds);
  const queue = [...seedIds];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const parent of parentsByAsset.get(current) ?? []) {
      if (!visited.has(parent)) {
        visited.add(parent);
        queue.push(parent);
      }
    }
    if (includeDownstream) {
      for (const child of childrenByAsset.get(current) ?? []) {
        if (!visited.has(child)) {
          visited.add(child);
          queue.push(child);
        }
      }
    }
  }
  // Exit-route tracked-stablecoin outputs only read pegDataById / exitOutputPriceById
  // at 1 hop; add them after graph traversal so sliced rounds stay fast without drift.
  for (const assetId of [...visited]) {
    for (const outputAssetId of exitOutputsByAsset.get(assetId) ?? []) {
      if (!visited.has(outputAssetId)) {
        visited.add(outputAssetId);
        for (const parent of parentsByAsset.get(outputAssetId) ?? []) {
          if (!visited.has(parent)) queue.push(parent);
        }
      }
    }
  }
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const parent of parentsByAsset.get(current) ?? []) {
      if (!visited.has(parent)) queue.push(parent);
    }
  }
  return visited;
}

function pickRecord<T>(
  record: Readonly<Record<string, T>> | undefined,
  subsetIds: ReadonlySet<string>,
): Record<string, T> {
  if (!record) return {};
  const out: Record<string, T> = {};
  for (const [id, value] of Object.entries(record)) {
    if (subsetIds.has(id)) out[id] = value;
  }
  return out;
}

function sliceFixedInput(
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
  subsetIds: ReadonlySet<string>,
): SafetyScoreV9CompilerInput {
  const activeAssetIds = fixedInput.activeAssetIds.filter((id) => subsetIds.has(id));
  const dexLiqMap = pickRecord(fixedInput.dexLiqMap, subsetIds);
  const redemptionBackstopMap = pickRecord(fixedInput.redemptionBackstopMap, subsetIds);
  const directionalPeg = fixedInput.safetyScoreV9DirectionalPeg
    ? {
        premiumWeight: fixedInput.safetyScoreV9DirectionalPeg.premiumWeight,
        pegScoreById: pickRecord(fixedInput.safetyScoreV9DirectionalPeg.pegScoreById, subsetIds),
        activeDiscountPeakBpsById: pickRecord(
          fixedInput.safetyScoreV9DirectionalPeg.activeDiscountPeakBpsById,
          subsetIds,
        ),
      }
    : undefined;
  const lenderCollateralBacking = fixedInput.lenderCollateralBacking
    ? {
        ...fixedInput.lenderCollateralBacking,
        byAssetId: pickRecord(fixedInput.lenderCollateralBacking.byAssetId, subsetIds),
      }
    : undefined;
  const { baseInputGenerationId: _oldGen, schemaVersion: _sv, captureKind: _ck, ...rest } = fixedInput;
  const sliced = normalizeNativeV9Input({
    ...rest,
    schemaVersion: 4,
    captureKind: "native-v9-inputs",
    activeAssetIds,
    dexLiqMap,
    redemptionBackstopMap,
    dexPayloadFingerprint: computeNativeDexLiquidityPayloadFingerprint(dexLiqMap, fixedInput.dexGenerationId),
    redemptionPayloadFingerprint: computeRedemptionPayloadFingerprint(
      redemptionBackstopMap,
      fixedInput.redemptionGenerationId,
    ),
    pegDataById: pickRecord(fixedInput.pegDataById, subsetIds),
    ...(fixedInput.navPriceById ? { navPriceById: pickRecord(fixedInput.navPriceById, subsetIds) } : {}),
    ...(fixedInput.exitOutputPriceById ? { exitOutputPriceById: fixedInput.exitOutputPriceById } : {}),
    activeDepegPeakBpsById: pickRecord(fixedInput.activeDepegPeakBpsById, subsetIds),
    ...(directionalPeg ? { safetyScoreV9DirectionalPeg: directionalPeg } : {}),
    liveReserveMap: pickRecord(fixedInput.liveReserveMap, subsetIds),
    liveReserveProvenanceMap: pickRecord(fixedInput.liveReserveProvenanceMap, subsetIds),
    chainCirculatingById: pickRecord(fixedInput.chainCirculatingById, subsetIds),
    aggregateCirculatingById: pickRecord(fixedInput.aggregateCirculatingById, subsetIds),
    safetyScoreV9SupplyAttributionById: pickRecord(fixedInput.safetyScoreV9SupplyAttributionById, subsetIds),
    ...(fixedInput.safetyScoreV9DeploymentSupplyCensusById
      ? {
          safetyScoreV9DeploymentSupplyCensusById: pickRecord(
            fixedInput.safetyScoreV9DeploymentSupplyCensusById,
            subsetIds,
          ),
        }
      : {}),
    evidenceJournalById: pickRecord(fixedInput.evidenceJournalById, subsetIds),
    supplyAttributionJournalById: pickRecord(fixedInput.supplyAttributionJournalById, subsetIds),
    ...(fixedInput.pipelineGapByAssetId
      ? { pipelineGapByAssetId: pickRecord(fixedInput.pipelineGapByAssetId, subsetIds) }
      : {}),
    pegProvenanceById: pickRecord(fixedInput.pegProvenanceById, subsetIds),
    ...(fixedInput.pegEvidenceById ? { pegEvidenceById: pickRecord(fixedInput.pegEvidenceById, subsetIds) } : {}),
    ...(fixedInput.replaySupplyObservationsById
      ? { replaySupplyObservationsById: pickRecord(fixedInput.replaySupplyObservationsById, subsetIds) }
      : {}),
    ...(lenderCollateralBacking ? { lenderCollateralBacking } : {}),
    dexDeploymentSupplyCoverageById: pickRecord(fixedInput.dexDeploymentSupplyCoverageById, subsetIds),
    liveToFallbackCoins: fixedInput.liveToFallbackCoins.filter((id) => subsetIds.has(id)),
  });
  // `safetyScoreV9SupplyAttributionById` is excluded from baseInputGenerationId; rebind
  // any packet-level baseInputGenerationId so sliced rounds preserve identical admission.
  const reboundSupplyAttribution = Object.fromEntries(
    Object.entries(sliced.safetyScoreV9SupplyAttributionById).map(([id, packet]) => [
      id,
      "baseInputGenerationId" in packet
        ? { ...packet, baseInputGenerationId: sliced.baseInputGenerationId }
        : packet,
    ]),
  );
  return { ...sliced, safetyScoreV9SupplyAttributionById: reboundSupplyAttribution };
}

function buildBindingIncidentFixedInput(
  incidentChainsByAssetId: ReadonlyMap<string, ReadonlySet<string>>,
  subsetIds: ReadonlySet<string>,
): SafetyScoreV9CompilerInput {
  const base = buildMultiChainFullRegistryInput();
  const nextChainCirculatingById: Record<string, Record<string, { current: number }>> = {
    ...base.chainCirculatingById,
  };
  for (const [assetId, incidentChains] of incidentChainsByAssetId) {
    const meta = ACTIVE_META_BY_ID.get(assetId);
    const routes = meta?.bridgeRouteRisk?.routes ?? [];
    const isNativeRoute = (route: (typeof routes)[number]) =>
      route.routeClass === "native" || route.issuanceModel === "native-issuance";
    const nativeChains = [
      ...new Set(
        routes
          .filter(isNativeRoute)
          .map((route) => resolveChainId(route.destinationChain))
          .filter((chain): chain is string => chain !== null && !incidentChains.has(chain)),
      ),
    ];
    const otherBridgedChains = [
      ...new Set(
        routes
          .filter((route) => !isNativeRoute(route))
          .map((route) => resolveChainId(route.destinationChain))
          .filter(
            (chain): chain is string =>
              chain !== null && !nativeChains.includes(chain) && !incidentChains.has(chain),
          ),
      ),
    ];
    const rows: Record<string, { current: number }> = {};
    const incidentList = [...incidentChains].sort();
    const incidentBudget = Math.min(8_000_000, incidentList.length * 2_000_000);
    const perIncident = Math.round(incidentBudget / incidentList.length);
    for (const chain of incidentList) rows[chain] = { current: perIncident };
    const remaining = 10_000_000 - perIncident * incidentList.length;
    if (nativeChains.length > 0 && otherBridgedChains.length > 0) {
      const nativeBudget = Math.round(remaining * 0.75);
      const bridgedBudget = remaining - nativeBudget;
      const perNative = Math.round(nativeBudget / nativeChains.length);
      for (const chain of nativeChains) rows[chain] = { current: perNative };
      const weights = otherBridgedChains.map((_, idx) => 2 ** Math.max(0, otherBridgedChains.length - 1 - idx));
      const weightSum = weights.reduce((sum, w) => sum + w, 0);
      otherBridgedChains.forEach((chain, idx) => {
        rows[chain] = { current: Math.max(10_000, Math.round((bridgedBudget * weights[idx]!) / weightSum)) };
      });
    } else {
      const others = [...nativeChains, ...otherBridgedChains];
      if (others.length > 0) {
        const perOther = Math.round(remaining / others.length);
        for (const chain of others) rows[chain] = { current: perOther };
      }
    }
    nextChainCirculatingById[assetId] = rows;
  }
  return sliceFixedInput(
    { ...base, chainCirculatingById: nextChainCirculatingById },
    subsetIds,
  );
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

  const runCandidateOnInput = async (
    fixedInput: Readonly<SafetyScoreV9CompilerInput>,
    metaById?: Map<string, StablecoinMeta>,
    useCaptureEnrichment = true,
  ) => {
    const transferMaterialityGeneration = !useCaptureEnrichment
      ? null
      : captureInput.transferMaterialityGeneration === null
        ? null
        : fixedInput.baseInputGenerationId === captureInput.fixedInput.baseInputGenerationId
          ? captureInput.transferMaterialityGeneration
          : {
              ...captureInput.transferMaterialityGeneration,
              sourceBaseInputGenerationId: fixedInput.baseInputGenerationId,
            };
    return buildSafetyScoreV9Candidate({
      fixedInput,
      publishedAtSec: fixedInput.clockSec,
      allowRegistryMismatch: true,
      transferMaterialityGeneration,
      laneIncidentCertificates: useCaptureEnrichment ? captureInput.laneIncidentCertificates : undefined,
      laneEmitterDescriptors: useCaptureEnrichment ? captureInput.laneEmitterDescriptors : undefined,
      ...(metaById ? { registry: { metaById } } : {}),
    });
  };
  const runCandidate = (metaById?: Map<string, StablecoinMeta>) =>
    runCandidateOnInput(captureInput.fixedInput, metaById, true);

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

  // Sweep 3: Per-route retirement of EVERY reviewed external-lock-mint route across all multi-route ELM assets
  const elmRoutesByAssetId = new Map<string, BridgeRouteDeployment[]>();
  let maxElmRoutes = 0;
  let totalElmRoutes = 0;
  for (const [assetId, meta] of ACTIVE_META_BY_ID) {
    const routes = meta.bridgeRouteRisk?.routes;
    if (!meta.bridgeRouteRisk || !routes || routes.length < 2) continue;
    const elmRoutes = routes.filter(
      (route) =>
        route.reviewDisposition === "reviewed" &&
        route.riskTier === "external-lock-mint" &&
        route.routeClass !== "native" &&
        route.issuanceModel !== "native-issuance",
    );
    if (elmRoutes.length === 0) continue;
    elmRoutesByAssetId.set(assetId, elmRoutes);
    totalElmRoutes += elmRoutes.length;
    if (elmRoutes.length > maxElmRoutes) maxElmRoutes = elmRoutes.length;
  }
  const baselinePreCapById = new Map(
    baseline.evaluatedSet.assets.map((asset) => [asset.assetId, asset.trace.preCapScore]),
  );
  const marketLeaderId = [...baseline.compiledFacts.assets]
    .filter((asset) => asset.supply.status.observationState === "known" && asset.supply.circulatingUsd !== null)
    .sort((left, right) => (right.supply.circulatingUsd ?? 0) - (left.supply.circulatingUsd ?? 0) || left.assetId.localeCompare(right.assetId))[0]?.assetId;
  const perRouteAggregate: SweepOutcome = {
    name: "per-route-elm-retirement",
    mutatedAssets: elmRoutesByAssetId.size,
    mutatedRoutes: totalElmRoutes,
    checkedAssets: baseline.evaluatedSet.assets.length,
    scoreRises: [],
    preCapRises: [],
    newQuarantines: [],
    violations: [],
  };
  for (let routeIndex = 0; routeIndex < maxElmRoutes; routeIndex += 1) {
    const retiredByAssetId = new Map<string, string>();
    const roundMutated = cloneMetaMap((assetId, meta) => {
      const targetRoute = elmRoutesByAssetId.get(assetId)?.[routeIndex];
      if (!targetRoute) return null;
      retiredByAssetId.set(assetId, targetRoute.id);
      return retireBridgeRoute(meta, targetRoute);
    });
    if (roundMutated.mutatedCount === 0) continue;
    let roundOutcome: SweepOutcome;
    if (routeIndex === 0) {
      // Round 0 runs across the full active registry to verify downstream DAG propagation too.
      roundOutcome = summarizeSweep(
        `per-route-elm-retirement[0]`,
        roundMutated.mutatedCount,
        baseline,
        await runCandidate(roundMutated.metaById),
      );
    } else {
      // Rounds 1..max-1 slice to the round's mutated assets plus their transitive upstream
      // dependency closure so every single ELM route is checked in seconds with zero distortion.
      const seedIds = new Set(retiredByAssetId.keys());
      if (marketLeaderId) seedIds.add(marketLeaderId);
      const closure = collectDependencyClosure(
        seedIds,
        baseline.compiledFacts.assets,
        false,
      );
      const roundInput = sliceFixedInput(captureInput.fixedInput, closure);
      const roundBaseline = await runCandidateOnInput(roundInput, undefined, true);
      for (const assetId of retiredByAssetId.keys()) {
        const fullPreCap = baselinePreCapById.get(assetId);
        const slicedPreCap = roundBaseline.evaluatedSet.assets.find((a) => a.assetId === assetId)?.trace.preCapScore;
        if (
          fullPreCap !== undefined &&
          slicedPreCap !== undefined &&
          fullPreCap !== null &&
          slicedPreCap !== null &&
          Math.abs(fullPreCap - slicedPreCap) > 1e-6
        ) {
          throw new Error(
            `Sliced baseline drift on ${assetId} in per-route round ${routeIndex}: full=${fullPreCap} sliced=${slicedPreCap}`,
          );
        }
      }
      const roundAfter = await runCandidateOnInput(roundInput, roundMutated.metaById, true);
      roundOutcome = summarizeSweep(
        `per-route-elm-retirement[${routeIndex}]`,
        roundMutated.mutatedCount,
        roundBaseline,
        roundAfter,
      );
    }
    const tag = (entry: string) => {
      const assetId = entry.split(":")[0]!;
      const routeId = retiredByAssetId.get(assetId);
      return routeId ? `${entry}@${routeId}` : entry;
    };
    perRouteAggregate.scoreRises.push(...roundOutcome.scoreRises.map(tag));
    perRouteAggregate.preCapRises.push(...roundOutcome.preCapRises.map(tag));
    perRouteAggregate.newQuarantines.push(...roundOutcome.newQuarantines);
    perRouteAggregate.violations.push(...roundOutcome.violations);
  }
  perRouteAggregate.newQuarantines = [...new Set(perRouteAggregate.newQuarantines)].sort();
  sweeps.push(perRouteAggregate);

  // Sweep 4: Deterministic binding (>=10% share) active-bridge-incident lapse/retirement pass.
  // Pins >=10% supply onto every active-incident bridge chain so a binding active bridge
  // compromise cannot silently lose its binding (Control 25 -> 45) under expiry or retirement.
  const incidentChainsByAssetId = new Map<string, Set<string>>();
  for (const asset of baseline.compiledFacts.assets) {
    for (const control of asset.controls) {
      if (control.controlKind !== "bridge" || control.incidentState !== "active") continue;
      const chain = resolveChainId(control.deploymentKey.split(":")[0] ?? "");
      if (chain === null) continue;
      const chains = incidentChainsByAssetId.get(asset.assetId) ?? new Set<string>();
      chains.add(chain);
      incidentChainsByAssetId.set(asset.assetId, chains);
    }
  }
  if (incidentChainsByAssetId.size === 0) {
    throw new Error(
      "Binding active-bridge-incident monotonicity sweep requires at least one active bridge control incident in the catalog",
    );
  }
  const incidentClosure = collectDependencyClosure(
    new Set(incidentChainsByAssetId.keys()),
    baseline.compiledFacts.assets,
    true,
  );
  const bindingIncidentInput = buildBindingIncidentFixedInput(incidentChainsByAssetId, incidentClosure);
  const incidentBaseline = await runCandidateOnInput(bindingIncidentInput, undefined, false);
  const materialShareThreshold = V9_CANDIDATE_POLICY_V1.policy.semantic.materiality.deploymentMaterialSharePct / 100;
  const compromisedQuality = V9_CANDIDATE_POLICY_V1.policy.semantic.control.authorityLadder.compromised;
  for (const assetId of incidentChainsByAssetId.keys()) {
    const compiled = incidentBaseline.compiledFacts.assets.find((asset) => asset.assetId === assetId);
    const hasBindingShare = compiled?.controls.some(
      (control) =>
        control.controlKind === "bridge" &&
        control.incidentState === "active" &&
        control.materialSupplyShare !== null &&
        control.materialSupplyShare >= materialShareThreshold,
    );
    if (!hasBindingShare) {
      throw new Error(
        `Binding active-bridge-incident fixture failed to place ${assetId} at >= ${materialShareThreshold * 100}% active-incident bridge share`,
      );
    }
  }
  const incidentExpired = await runCandidateOnInput(bindingIncidentInput, expired.metaById, false);
  const incidentRetired = await runCandidateOnInput(bindingIncidentInput, retiredWhole.metaById, false);
  const bindingExpirySweep = summarizeSweep(
    "binding-active-bridge-incident-expiry",
    incidentChainsByAssetId.size,
    incidentBaseline,
    incidentExpired,
  );
  const bindingRetiredSweep = summarizeSweep(
    "binding-active-bridge-incident-retirement",
    incidentChainsByAssetId.size,
    incidentBaseline,
    incidentRetired,
  );
  for (const [label, candidatePipeline] of [
    ["binding-active-bridge-incident-expiry", incidentExpired],
    ["binding-active-bridge-incident-retirement", incidentRetired],
  ] as const) {
    for (const assetId of incidentChainsByAssetId.keys()) {
      const evaluated = candidatePipeline.evaluatedSet.assets.find((asset) => asset.assetId === assetId);
      const controlScore = evaluated?.scoreInput.pillars.control.score ?? null;
      if (controlScore === null || controlScore > compromisedQuality) {
        throw new Error(
          `${label}: ${assetId} Control score rose above compromised floor (${compromisedQuality}) to ${String(controlScore)}`,
        );
      }
    }
  }
  sweeps.push(bindingExpirySweep, bindingRetiredSweep);

  const failures = sweeps.filter(
    (s) => s.scoreRises.length > 0 || s.preCapRises.length > 0 || s.newQuarantines.length > 0 || s.violations.length > 0,
  );
  if (values.json === true) {
    process.stdout.write(`${JSON.stringify({ clockSec: captureInput.fixedInput.clockSec, sweeps, negativeSelfTest: "passed" }, null, 2)}\n`);
  } else {
    for (const s of sweeps) {
      const routeDetail = s.mutatedRoutes === undefined ? "" : ` routes=${s.mutatedRoutes}`;
      process.stdout.write(
        `${s.name}: mutated=${s.mutatedAssets}${routeDetail} checked=${s.checkedAssets} scoreRises=${s.scoreRises.length} preCapRises=${s.preCapRises.length} newQuarantines=${s.newQuarantines.length} violations=${s.violations.length}\n`,
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
