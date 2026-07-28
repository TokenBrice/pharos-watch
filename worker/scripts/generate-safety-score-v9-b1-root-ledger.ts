import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalExitRouteAssetKey } from "../../shared/lib/exit-route-identity";
import { computeDexLiquidityPayloadFingerprint } from "../../shared/lib/report-cards-fixed-input-identity";
import { REPORT_CARDS_REGISTRY_FINGERPRINT } from "../../shared/data/stablecoins/report-card-registry-fingerprint.generated";
import { ACTIVE_STABLECOINS } from "../../shared/lib/stablecoins/registry";
import type { ContractDeployment } from "../../shared/types/core";
import type { DexExitRouteObservation } from "../../shared/types/market";
import {
  assertCliUsage,
  parseCliInteger,
  parseStrictCliArgs,
  runCliEntrypoint,
  writeCliHelpIfRequested,
} from "../../scripts/lib/cli-args.mjs";
import {
  buildDexKnownEmptyRouteCoverage,
  classifyDexPlaceholderCoverage,
  type DexDeploymentCensusRow,
} from "../src/cron/dex-liquidity/deployment-census-coverage";

interface Args {
  registry: string;
  fixedInput: string;
  deploymentCensus: string | null;
  censusCapturedAtSec: number | null;
  postFixFixedInputOutput: string | null;
  output: string;
}

interface MissingItem {
  taskId: string;
  gapId: string;
  reasonCode: string;
  message: string;
  workType: string;
  responsibility: string;
  observationState: string;
}

interface ProjectionGap {
  projectionId: string;
  source: string;
  reasonCode: string;
  path: string;
  coveredByTaskIds: string[];
}

interface RegistryAsset {
  assetId: string;
  symbol: string;
  name: string;
  missingItems: MissingItem[];
  scoreProjectionGaps: ProjectionGap[];
}

interface MissingDataRegistry {
  snapshot: {
    asOfSec: number;
    asOfIso: string;
    candidateId: string;
    publicationGenerationId: string;
    baseInputGenerationId: string;
    factSetDigest: string;
    resultDigest: string;
    policyDigest: string;
    evaluationBuildDigest: string;
  };
  stablecoins: RegistryAsset[];
}

interface DexCoverage {
  status: "populated" | "unsupported" | "unknown";
  capabilityMatrixVersion: string;
  retainedPoolCount: number;
  observationCount: number;
  scoreEligibleObservationCount: number;
  scoreEligiblePoolCount?: number;
  scoreEligibleCapabilityPoolCount?: number;
  unsupportedPoolCount: number;
  evidenceCounts: Record<string, number>;
  unsupportedReasons: Record<string, number>;
}

interface FixedDexRow {
  liquidityScore: number | null;
  concentrationHhi: number | null;
  poolCount: number;
  chainCount: number;
  deploymentCoverage?: {
    observedPools: number;
    verifiedNoPools: number;
    providerInaccessible: number;
  } | null;
  exitRouteObservations?: DexExitRouteObservation[];
  exitRouteObservationCoverage?: DexCoverage;
  updatedAt: number;
}

interface FixedInput {
  captureKind: "exact-publication-inputs";
  clockSec: number;
  capturedAt: string;
  methodologyVersion: string;
  baseInputGenerationId: string;
  dexGenerationId: string;
  dexPayloadFingerprint: string;
  registryFingerprint: string;
  registryRevision: string;
  activeAssetIds: string[];
  dexLiqMap: Record<string, FixedDexRow>;
}

interface B1CounterfactualFixedInputArtifact {
  schemaVersion: 1;
  kind: "safety-score-v9-b1-counterfactual-fixed-input";
  publicationExact: false;
  provenance: {
    sourceCaptureKind: "exact-publication-inputs";
    sourceBaseInputGenerationId: string;
    sourceDexGenerationId: string;
    changedAssetIds: string[];
    changeScope: [
      "dexLiqMap.exitRouteObservations",
      "dexLiqMap.exitRouteObservationCoverage",
      "dexPayloadFingerprint",
      "baseInputGenerationId",
    ];
    censusUse: "fail-closed-corroboration-only";
  };
  fixedInput: Omit<FixedInput, "baseInputGenerationId">;
}

type LedgerRouteState =
  | "complete-empty"
  | "incomplete-inaccessible"
  | "pools-lost-before-scoring"
  | "diagnostic-only"
  | "executable";

const USAGE = `Usage: npm run safety-score-v9:b1-root-ledger -- [options]

Options:
  --registry <path>                       Accepted missing-data registry JSON (required)
  --fixed-input <path>                    Publication-exact fixed input JSON (required)
  --deployment-census <path>              Optional pinned Wrangler D1 census JSON
  --census-captured-at-sec <epoch>        Census capture epoch; required with census
  --post-fix-fixed-input-output <path>     Optional chronology-safe B1 counterfactual envelope
  --output <path>                         Root-ledger JSON (required)
  -h, --help                              Show this help`;

function parseArgs(argv: readonly string[]): Args | null {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      registry: { type: "string" },
      "fixed-input": { type: "string" },
      "deployment-census": { type: "string" },
      "census-captured-at-sec": { type: "string" },
      "post-fix-fixed-input-output": { type: "string" },
      output: { type: "string" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE)) return null;
  assertCliUsage(typeof values.registry === "string", "--registry is required");
  assertCliUsage(typeof values["fixed-input"] === "string", "--fixed-input is required");
  assertCliUsage(typeof values.output === "string", "--output is required");
  const deploymentCensus =
    typeof values["deployment-census"] === "string"
      ? values["deployment-census"]
      : null;
  const censusCapturedAtSec =
    values["census-captured-at-sec"] === undefined
      ? null
      : parseCliInteger(values["census-captured-at-sec"], {
          name: "--census-captured-at-sec",
          min: 1,
        });
  assertCliUsage(
    (deploymentCensus === null) === (censusCapturedAtSec === null),
    "--deployment-census and --census-captured-at-sec must be provided together",
  );
  assertCliUsage(
    values["post-fix-fixed-input-output"] === undefined ||
      deploymentCensus !== null,
    "--post-fix-fixed-input-output requires a pinned deployment census",
  );
  return {
    registry: String(values.registry),
    fixedInput: String(values["fixed-input"]),
    output: String(values.output),
    deploymentCensus,
    censusCapturedAtSec,
    postFixFixedInputOutput:
      typeof values["post-fix-fixed-input-output"] === "string"
        ? values["post-fix-fixed-input-output"]
        : null,
  };
}

async function readJson<T>(path: string): Promise<T> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- explicit local operator input path.
  return JSON.parse(await readFile(resolve(path), "utf8")) as T;
}

function extractD1Rows(raw: unknown): DexDeploymentCensusRow[] {
  if (
    Array.isArray(raw) &&
    raw.length > 0 &&
    typeof raw[0] === "object" &&
    raw[0] !== null &&
    Array.isArray((raw[0] as { results?: unknown }).results)
  ) {
    return (raw[0] as { results: DexDeploymentCensusRow[] }).results;
  }
  if (
    typeof raw === "object" &&
    raw !== null &&
    Array.isArray((raw as { results?: unknown }).results)
  ) {
    return (raw as { results: DexDeploymentCensusRow[] }).results;
  }
  if (Array.isArray(raw)) return raw as DexDeploymentCensusRow[];
  throw new Error("Deployment census input is not a Wrangler D1 result or row array");
}

function coverageCategories(coverage: DexCoverage | undefined): string[] {
  if (!coverage) return ["deferral"];
  const categories = new Set<string>();
  const reasons = Object.keys(coverage.unsupportedReasons ?? {});
  if (
    coverage.retainedPoolCount > 0 &&
    (coverage.scoreEligibleCapabilityPoolCount ?? 0) === 0
  ) {
    categories.add("diagnostics");
  }
  for (const reason of reasons) {
    const normalized = reason.toLowerCase();
    if (normalized.includes("overflow")) categories.add("overflow");
    else if (
      normalized.includes("invalid") ||
      normalized.includes("mismatch") ||
      normalized.includes("conflict") ||
      normalized.includes("malformed")
    ) {
      categories.add("validation-failure");
    } else if (
      normalized.includes("defer") ||
      normalized.includes("budget") ||
      normalized.includes("stale")
    ) {
      categories.add("deferral");
    } else if (
      normalized.includes("provider") ||
      normalized.includes("transport") ||
      normalized.includes("unavailable")
    ) {
      categories.add("outage");
    } else {
      categories.add("unsupported-method");
    }
  }
  if (categories.size === 0 && coverage.status !== "populated") {
    categories.add(
      coverage.retainedPoolCount > 0 ? "unsupported-method" : "deferral",
    );
  }
  return [...categories].sort();
}

function uniqueDeployments(assetId: string) {
  const meta = ACTIVE_STABLECOINS.find((row) => row.id === assetId);
  if (!meta) throw new Error(`Active registry is missing ${assetId}`);
  const byKey = new Map<string, ContractDeployment>();
  for (const deployment of [
    ...(meta.contracts ?? []),
    ...(meta.tradedContracts ?? []),
  ]) {
    const key = canonicalExitRouteAssetKey(
      deployment.chain,
      deployment.address,
    );
    if (!byKey.has(key)) byKey.set(key, deployment);
  }
  return [...byKey.values()];
}

async function generateB1RootLedger(args: Args): Promise<void> {
  const [registry, fixedInput] = await Promise.all([
    readJson<MissingDataRegistry>(args.registry),
    readJson<FixedInput>(args.fixedInput),
  ]);
  if (fixedInput.captureKind !== "exact-publication-inputs") {
    throw new Error(
      `B1 baseline requires an exact publication capture, received ${String(fixedInput.captureKind)}`,
    );
  }
  if (
    fixedInput.registryFingerprint !== REPORT_CARDS_REGISTRY_FINGERPRINT ||
    fixedInput.registryRevision !==
      `sha256:${REPORT_CARDS_REGISTRY_FINGERPRINT}`
  ) {
    throw new Error(
      `Fixed-input registry identity ${fixedInput.registryFingerprint}/${fixedInput.registryRevision} does not match the checked-out registry ${REPORT_CARDS_REGISTRY_FINGERPRINT}`,
    );
  }
  if (
    registry.snapshot.baseInputGenerationId !==
    fixedInput.baseInputGenerationId
  ) {
    throw new Error(
      `Missing-data registry base input ${registry.snapshot.baseInputGenerationId} does not match fixed input ${fixedInput.baseInputGenerationId}`,
    );
  }
  const censusRows =
    args.deploymentCensus == null
      ? []
      : extractD1Rows(await readJson<unknown>(args.deploymentCensus));
  const censusById = new Map<string, DexDeploymentCensusRow[]>();
  for (const row of censusRows) {
    const rows = censusById.get(row.stablecoin_id) ?? [];
    rows.push(row);
    censusById.set(row.stablecoin_id, rows);
  }

  const producerTaskIds = new Set(
    registry.stablecoins.flatMap((asset) =>
      asset.missingItems
        .filter((item) => item.responsibility === "producer-failed")
        .map((item) => item.taskId),
    ),
  );
  const clearableTaskIds = new Set<string>();
  const completeEmptyIds = new Set<string>();
  const currentRuntimeCompleteEmptyIds = new Set<string>();
  for (const asset of registry.stablecoins) {
    const dex = fixedInput.dexLiqMap[asset.assetId];
    const deployment = dex?.deploymentCoverage;
    const expectedDeploymentCount = uniqueDeployments(asset.assetId).length;
    const reviewedCount =
      (deployment?.observedPools ?? 0) +
      (deployment?.verifiedNoPools ?? 0) +
      (deployment?.providerInaccessible ?? 0);
    const completeEmpty =
      dex?.poolCount === 0 &&
      (dex.exitRouteObservations?.length ?? 0) === 0 &&
      expectedDeploymentCount > 0 &&
      reviewedCount === expectedDeploymentCount &&
      deployment?.observedPools === 0 &&
      deployment.providerInaccessible === 0 &&
      deployment.verifiedNoPools === expectedDeploymentCount;
    if (!completeEmpty) continue;
    const roots = asset.missingItems.filter(
      (item) => item.responsibility === "producer-failed",
    );
    if (roots.length !== 1) {
      throw new Error(
        `Complete-empty cohort member ${asset.assetId} has ${roots.length} producer roots`,
      );
    }
    completeEmptyIds.add(asset.assetId);
    clearableTaskIds.add(roots[0]!.taskId);
  }

  const assets = registry.stablecoins
    .map((asset) => {
      const roots = asset.missingItems.filter(
        (item) => item.responsibility === "producer-failed",
      );
      if (roots.length === 0) return null;
      const fanOut = asset.scoreProjectionGaps.filter((gap) =>
        gap.coveredByTaskIds.some((taskId) => producerTaskIds.has(taskId)),
      );
      const clearableFanOut = fanOut.filter(
        (gap) =>
          gap.coveredByTaskIds.length > 0 &&
          gap.coveredByTaskIds.every((taskId) => clearableTaskIds.has(taskId)),
      );
      const dex = fixedInput.dexLiqMap[asset.assetId];
      const coverage = dex?.exitRouteObservationCoverage;
      const deployments = uniqueDeployments(asset.assetId);
      const baselineDeployment = dex?.deploymentCoverage ?? null;
      const routeAgeSec =
        dex == null ? null : Math.max(0, fixedInput.clockSec - dex.updatedAt);
      const hasRetainedOrObservedPools =
        (coverage?.retainedPoolCount ?? 0) > 0 ||
        (coverage?.observationCount ?? 0) > 0 ||
        (dex?.poolCount ?? 0) > 0;
      const isFixedPlaceholder =
        dex?.poolCount === 0 &&
        (dex.exitRouteObservations?.length ?? 0) === 0 &&
        (coverage?.retainedPoolCount ?? 0) === 0 &&
        (coverage?.observationCount ?? 0) === 0 &&
        (coverage?.scoreEligibleObservationCount ?? 0) === 0;
      const currentCensus =
        args.censusCapturedAtSec == null || !isFixedPlaceholder
          ? null
          : classifyDexPlaceholderCoverage({
              deployments,
              outcomeRows: censusById.get(asset.assetId) ?? [],
              nowSec: args.censusCapturedAtSec,
              censusAvailable: args.deploymentCensus != null,
            });
      const currentRuntimeCompleteEmpty =
        isFixedPlaceholder && currentCensus?.state === "complete-empty";
      if (currentRuntimeCompleteEmpty) {
        currentRuntimeCompleteEmptyIds.add(asset.assetId);
      }
      const categories = new Set(coverageCategories(coverage));
      if (currentCensus && isFixedPlaceholder) {
        if (currentCensus.state === "provider-outage") categories.add("outage");
        if (currentCensus.state === "discovery-deferral") categories.add("deferral");
        if (currentCensus.state === "unsupported-method") categories.add("unsupported-method");
        if (currentCensus.state === "validation-failure") categories.add("validation-failure");
        if (currentCensus.state === "pools-lost-before-scoring") {
          categories.add("validation-failure");
        }
      }
      let routeState: LedgerRouteState;
      if ((coverage?.scoreEligibleObservationCount ?? 0) > 0) {
        routeState = "executable";
      } else if (hasRetainedOrObservedPools) {
        routeState = "diagnostic-only";
      } else if (currentCensus?.state === "pools-lost-before-scoring") {
        routeState = "pools-lost-before-scoring";
      } else if (currentRuntimeCompleteEmpty) {
        routeState = "complete-empty";
      } else {
        routeState = "incomplete-inaccessible";
      }
      if (routeState === "complete-empty") categories.clear();
      if (routeState === "diagnostic-only") categories.add("diagnostics");
      return {
        assetId: asset.assetId,
        symbol: asset.symbol,
        name: asset.name,
        roots: roots.map((root) => ({
          taskId: root.taskId,
          gapId: root.gapId,
          workType: root.workType,
          reasonCode: root.reasonCode,
          observationState: root.observationState,
          message: root.message,
        })),
        fanOut: fanOut.map((gap) => ({
          projectionId: gap.projectionId,
          source: gap.source,
          reasonCode: gap.reasonCode,
          path: gap.path,
          coveredByTaskIds: [...gap.coveredByTaskIds].sort(),
          clearsWithB1: clearableFanOut.includes(gap),
        })),
        coverage: {
          routeState,
          priorState: coverage?.status ?? "absent",
          denominator: {
            retainedPoolCount: coverage?.retainedPoolCount ?? 0,
            scoreEligibleCapabilityPoolCount:
              coverage?.scoreEligibleCapabilityPoolCount ?? 0,
          },
          observationCount: coverage?.observationCount ?? 0,
          scoreEligibleObservationCount:
            coverage?.scoreEligibleObservationCount ?? 0,
          unsupportedPoolCount: coverage?.unsupportedPoolCount ?? 0,
          unsupportedReasons: coverage?.unsupportedReasons ?? {},
          diagnosticCategories: [...categories].sort(),
        },
        pools: {
          scoringPoolCount: dex?.poolCount ?? null,
          chainCount: dex?.chainCount ?? null,
          retainedPoolCount: coverage?.retainedPoolCount ?? null,
        },
        deploymentCensus: {
          expectedDeploymentCount: deployments.length,
          baseline: baselineDeployment,
          currentClassificationScope: isFixedPlaceholder
            ? "zero-scoring-placeholder"
            : "not-a-placeholder",
          current:
            currentCensus == null
              ? null
              : {
                  state: currentCensus.state,
                  ...currentCensus.census,
                },
        },
        reason: {
          producerReasonCodes: roots.map((root) => root.reasonCode).sort(),
          diagnosticCategories: [...categories].sort(),
        },
        generation: {
          dexGenerationId: fixedInput.dexGenerationId,
          dexPayloadFingerprint: fixedInput.dexPayloadFingerprint,
          rowUpdatedAtSec: dex?.updatedAt ?? null,
          fixedClockSec: fixedInput.clockSec,
          rowAgeSec: routeAgeSec,
          routeFreshnessMaxAgeSec: 3_600,
          routeFreshnessState:
            routeAgeSec == null
              ? "missing"
              : routeAgeSec <= 3_600
                ? "current"
                : "stale",
          censusCapturedAtSec: args.censusCapturedAtSec,
        },
        expectedDelta: {
          auditedBaselineClearsB1: completeEmptyIds.has(asset.assetId),
          currentRuntimeEligible: currentRuntimeCompleteEmpty,
          auditedRootFacts:
            completeEmptyIds.has(asset.assetId) ? roots.length : 0,
          auditedFanOutFacts: clearableFanOut.length,
          auditedTotalFacts:
            (completeEmptyIds.has(asset.assetId) ? roots.length : 0) +
            clearableFanOut.length,
          currentRuntimeDirectRootFacts:
            currentRuntimeCompleteEmpty ? roots.length : 0,
        },
      };
    })
    .filter((asset): asset is NonNullable<typeof asset> => asset !== null)
    .sort((left, right) => left.assetId.localeCompare(right.assetId));

  const rootCount = assets.reduce((sum, asset) => sum + asset.roots.length, 0);
  const fanOutCount = assets.reduce((sum, asset) => sum + asset.fanOut.length, 0);
  const expectedRootDelta = assets.reduce(
    (sum, asset) => sum + asset.expectedDelta.auditedRootFacts,
    0,
  );
  const expectedFanOutDelta = assets.reduce(
    (sum, asset) => sum + asset.expectedDelta.auditedFanOutFacts,
    0,
  );
  const currentRuntimeCompleteEmptyDirectRootCount = assets.reduce(
    (sum, asset) =>
      sum + asset.expectedDelta.currentRuntimeDirectRootFacts,
    0,
  );
  const currentRuntimeAdditionalDirectRootCount = assets.reduce(
    (sum, asset) =>
      sum +
      (asset.expectedDelta.currentRuntimeEligible &&
      !asset.expectedDelta.auditedBaselineClearsB1
        ? asset.roots.length
        : 0),
    0,
  );
  const beforeFactCount = rootCount + fanOutCount;
  const afterFactCount =
    beforeFactCount - expectedRootDelta - expectedFanOutDelta;
  const currentRuntimeAdditionalAssetIds = [
    ...currentRuntimeCompleteEmptyIds,
  ]
    .filter((assetId) => !completeEmptyIds.has(assetId))
    .sort();
  const uncorroboratedAuditedAssetIds =
    args.deploymentCensus == null
      ? []
      : [...completeEmptyIds]
          .filter((assetId) => !currentRuntimeCompleteEmptyIds.has(assetId))
          .sort();
  const assertions = {
    affectedAssetCount: assets.length === 313,
    producerRootCount: rootCount === 316,
    producerFanOutCount: fanOutCount === 82,
    baselineFactCount: beforeFactCount === 398,
    auditedCompleteEmptyAssetCount: completeEmptyIds.size === 30,
    currentCensusCorroboratesAuditedCohort:
      uncorroboratedAuditedAssetIds.length === 0,
    expectedRootDelta: expectedRootDelta === 30,
    expectedFanOutDelta: expectedFanOutDelta === 3,
    expectedAfterFactCount: afterFactCount === 365,
  };
  if (Object.values(assertions).some((value) => !value)) {
    throw new Error(
      `B1 ledger reconciliation failed: ${JSON.stringify({
        assets: assets.length,
        rootCount,
        fanOutCount,
        beforeFactCount,
        auditedCompleteEmpty: completeEmptyIds.size,
        currentRuntimeCompleteEmpty: currentRuntimeCompleteEmptyIds.size,
        uncorroboratedAuditedAssetIds,
        expectedRootDelta,
        expectedFanOutDelta,
        afterFactCount,
      })}`,
    );
  }

  const output = {
    schemaVersion: 2,
    kind: "safety-score-v9-b1-root-ledger",
    snapshot: {
      ...registry.snapshot,
      methodologyVersion: fixedInput.methodologyVersion,
      fixedInputCapturedAt: fixedInput.capturedAt,
      fixedInputClockSec: fixedInput.clockSec,
      dexGenerationId: fixedInput.dexGenerationId,
      dexPayloadFingerprint: fixedInput.dexPayloadFingerprint,
      registryFingerprint: fixedInput.registryFingerprint,
      registryRevision: fixedInput.registryRevision,
      deploymentCensusCapturedAtSec: args.censusCapturedAtSec,
    },
    summary: {
      affectedAssetCount: assets.length,
      producerRootCount: rootCount,
      producerFanOutCount: fanOutCount,
      producerFactCountBefore: beforeFactCount,
      rootReasonCounts: Object.entries(
        assets
          .flatMap((asset) => asset.roots)
          .reduce<Record<string, number>>((counts, root) => {
            counts[root.reasonCode] = (counts[root.reasonCode] ?? 0) + 1;
            return counts;
          }, {}),
      )
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([reasonCode, count]) => ({ reasonCode, count })),
      auditedCompleteEmptyAssetCount: completeEmptyIds.size,
      expectedRootDelta,
      expectedFanOutDelta,
      expectedFactDelta: expectedRootDelta + expectedFanOutDelta,
      producerFactCountAfter: afterFactCount,
      auditedCompleteEmptyAssetIds: [...completeEmptyIds].sort(),
      currentRuntimeCompleteEmptyAssetCount:
        currentRuntimeCompleteEmptyIds.size,
      currentRuntimeCompleteEmptyAssetIds: [
        ...currentRuntimeCompleteEmptyIds,
      ].sort(),
      currentRuntimeAdditionalAssetIds,
      currentRuntimeCompleteEmptyDirectRootCount,
      currentRuntimeAdditionalDirectRootCount,
      assertions,
    },
    assets,
  };
  if (args.postFixFixedInputOutput != null) {
    if (args.deploymentCensus == null || args.censusCapturedAtSec == null) {
      throw new Error(
        "--post-fix-fixed-input-output requires a pinned deployment census and capture time",
      );
    }
    const postFix = structuredClone(fixedInput);
    for (const assetId of completeEmptyIds) {
      const row = postFix.dexLiqMap[assetId];
      if (!row) throw new Error(`Post-fix fixed input is missing ${assetId}`);
      const classification = classifyDexPlaceholderCoverage({
        deployments: uniqueDeployments(assetId),
        outcomeRows: censusById.get(assetId) ?? [],
        nowSec: args.censusCapturedAtSec,
      });
      if (classification.state !== "complete-empty") {
        throw new Error(
          `Pinned current census no longer proves complete-empty for ${assetId}: ${classification.state}`,
        );
      }
      row.exitRouteObservations = [];
      row.exitRouteObservationCoverage = buildDexKnownEmptyRouteCoverage();
    }
    postFix.dexPayloadFingerprint = computeDexLiquidityPayloadFingerprint(
      postFix.dexLiqMap,
      postFix.dexGenerationId,
    );
    const provenance: B1CounterfactualFixedInputArtifact["provenance"] = {
      sourceCaptureKind: fixedInput.captureKind,
      sourceBaseInputGenerationId: fixedInput.baseInputGenerationId,
      sourceDexGenerationId: fixedInput.dexGenerationId,
      changedAssetIds: [...completeEmptyIds].sort(),
      changeScope: [
        "dexLiqMap.exitRouteObservations",
        "dexLiqMap.exitRouteObservationCoverage",
        "dexPayloadFingerprint",
        "baseInputGenerationId",
      ],
      censusUse: "fail-closed-corroboration-only",
    };
    delete (postFix as Partial<FixedInput>).baseInputGenerationId;
    const postFixArtifact: B1CounterfactualFixedInputArtifact = {
      schemaVersion: 1,
      kind: "safety-score-v9-b1-counterfactual-fixed-input",
      publicationExact: false,
      provenance,
      fixedInput: postFix as Omit<FixedInput, "baseInputGenerationId">,
    };
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- explicit local operator output path.
    await writeFile(
      resolve(args.postFixFixedInputOutput),
      `${JSON.stringify(postFixArtifact, null, 2)}\n`,
    );
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- explicit local operator output path.
  await writeFile(resolve(args.output), `${JSON.stringify(output, null, 2)}\n`);
  process.stdout.write(
    `Wrote ${assets.length}-asset B1 ledger: ${beforeFactCount} -> ${afterFactCount} (${resolve(args.output)})\n`,
  );
}

export async function runSafetyScoreV9B1RootLedgerCli(
  argv: readonly string[],
): Promise<void> {
  const args = parseArgs(argv);
  if (args === null) return;
  await generateB1RootLedger(args);
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  void runCliEntrypoint(
    () => runSafetyScoreV9B1RootLedgerCli(process.argv.slice(2)),
    {
      label: "safety-score-v9:b1-root-ledger",
      usage: USAGE,
    },
  );
}
