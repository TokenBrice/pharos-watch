import { describe, expect, it } from "vitest";
import type { ContractDeployment } from "@shared/types/core";
import {
  classifyDexPlaceholderCoverage,
  resolveDexDeploymentCensusMaxAgeSec,
} from "../../dex-liquidity/deployment-census-coverage";
import {
  classifyDexCensusReplayCoverage,
  createDexCensusReplayVisit,
  replayDexCensusSweep,
  type DexCensusReplayVisit,
} from "./census-replay.test-support";
import { discoveryTargetCursorKey, estimateDiscoverySweepWindowCount } from "../target-window";

const START_SEC = 1_800_000_000;
const RUN_INTERVAL_SEC = 20 * 60 * 60;

function deployment(index: number): ContractDeployment {
  return {
    chain: "osmosis",
    address: `ibc/${index.toString(16).padStart(64, "0").toUpperCase()}`,
    decimals: 6,
  };
}

const TARGETS = Array.from({ length: 10 }, (_, index) => deployment(index + 1));
const TARGET_KEYS = TARGETS.map(discoveryTargetCursorKey);

function emptySweep(runs: number) {
  return replayDexCensusSweep({
    stablecoinId: "synthetic-empty",
    targets: TARGETS,
    visitPlans: new Map(
      TARGET_KEYS.map((key) => [key, [
        createDexCensusReplayVisit("verified-empty"),
        createDexCensusReplayVisit("verified-empty"),
      ]]),
    ),
    startNowSec: START_SEC,
    maxAgeSec: 2 * RUN_INTERVAL_SEC,
    runs,
    runIntervalSec: RUN_INTERVAL_SEC,
  });
}

describe("DEX census rotating replay", () => {
  it("does not declare complete-empty before every rotating target is reviewed", () => {
    const runs = estimateDiscoverySweepWindowCount(TARGETS);
    expect(runs).toBeGreaterThan(1);

    const firstRun = emptySweep(1);
    expect(firstRun.allTargetsVisited).toBe(false);
    expect(firstRun.completeEmpty).toBe(false);
    expect(classifyDexCensusReplayCoverage(firstRun)).toBe("missing");

    const firstCoverage = classifyDexPlaceholderCoverage({
      deployments: TARGETS,
      outcomeRows: firstRun.rows,
      nowSec: firstRun.finalNowSec,
    });
    expect(firstCoverage.state).toBe("discovery-deferral");
    expect(firstCoverage.coverage.unsupportedReasons.deploymentCensusMissingOutcome).toBeGreaterThan(0);

    const complete = emptySweep(runs);
    expect(complete.allTargetsVisited).toBe(true);
    expect(complete.completeEmpty).toBe(true);
    expect(classifyDexCensusReplayCoverage(complete)).toBe("complete-empty");

    const finalCoverage = classifyDexPlaceholderCoverage({
      deployments: TARGETS,
      outcomeRows: complete.rows,
      nowSec: complete.finalNowSec,
    });
    expect(finalCoverage.state).toBe("complete-empty");
    expect(finalCoverage.census.missingOutcomeCount).toBe(0);
    expect(finalCoverage.census.staleOutcomeCount).toBe(0);
  });

  it("keeps cursor progress and provider pricing identical to the production selector", () => {
    const replay = emptySweep(estimateDiscoverySweepWindowCount(TARGETS));
    const totalCostMs = replay.runs[0]!.totalEstimatedCostMs;

    expect(replay.runs.every((run) => run.providerCostParity)).toBe(true);
    expect(replay.runs.every((run) => run.totalEstimatedCostMs === totalCostMs)).toBe(true);
    expect(replay.runs[0]!.cursorAfter).not.toBeNull();
    expect(replay.runs[1]!.cursorBefore).toBe(replay.runs[0]!.cursorAfter);
    expect(replay.runs[0]!.targetKeys).not.toEqual(replay.runs[1]!.targetKeys);
    expect(new Set(replay.visitedKeys)).toEqual(new Set(TARGET_KEYS));
    expect(replay.runs.every((run) => run.estimatedCostMs <= 25_000)).toBe(true);
  });

  it("keeps an unsupported footprint explicit instead of treating it as a failed crawl", () => {
    const unsupportedTarget = {
      chain: "unknown-chain",
      address: "synthetic-unsupported",
      decimals: 6,
    } satisfies ContractDeployment;
    const replay = replayDexCensusSweep({
      stablecoinId: "synthetic-unsupported",
      targets: [unsupportedTarget],
      visitPlans: {
        [discoveryTargetCursorKey(unsupportedTarget)]: [
          createDexCensusReplayVisit("unsupported"),
        ],
      },
      startNowSec: START_SEC,
      maxAgeSec: RUN_INTERVAL_SEC,
      runs: 1,
    });

    expect(replay.rowByKey.get(discoveryTargetCursorKey(unsupportedTarget))).toMatchObject({
      outcome: "provider_inaccessible",
      provider_set_json: "[]",
    });
    expect(replay.statesByKey.get(discoveryTargetCursorKey(unsupportedTarget))).toMatchObject({
      attemptResult: "unsupported_scope",
      disposition: "unsupported-scope",
    });
    expect(classifyDexCensusReplayCoverage(replay)).toBe("unsupported-scope");
    expect(classifyDexPlaceholderCoverage({
      deployments: [unsupportedTarget],
      outcomeRows: replay.rows,
      nowSec: replay.finalNowSec,
    }).state).toBe("unsupported-method");
  });

  it("replays bounded, retryable, outage, non-exhaustive, superseded, stale, observed, and empty cases", () => {
    const boundedKey = TARGET_KEYS[0]!;
    const retryableKey = TARGET_KEYS[1]!;
    const outageKey = TARGET_KEYS[2]!;
    const nonExhaustiveKey = TARGET_KEYS[3]!;
    const supersededKey = TARGET_KEYS[4]!;
    const staleKey = TARGET_KEYS[5]!;
    const observedKey = TARGET_KEYS[6]!;
    const verifiedKey = TARGET_KEYS[7]!;

    const plans = new Map<string, readonly DexCensusReplayVisit[]>([
      [boundedKey, [
        createDexCensusReplayVisit("bounded"),
        createDexCensusReplayVisit("verified-empty"),
        createDexCensusReplayVisit("verified-empty"),
        createDexCensusReplayVisit("verified-empty"),
      ]],
      [retryableKey, [
        createDexCensusReplayVisit("retryable"),
        createDexCensusReplayVisit("verified-empty"),
        createDexCensusReplayVisit("verified-empty"),
        createDexCensusReplayVisit("verified-empty"),
      ]],
      [outageKey, [
        createDexCensusReplayVisit("outage"),
        createDexCensusReplayVisit("outage"),
        createDexCensusReplayVisit("outage"),
        createDexCensusReplayVisit("outage"),
      ]],
      [nonExhaustiveKey, [
        createDexCensusReplayVisit("non-exhaustive"),
        createDexCensusReplayVisit("non-exhaustive"),
        createDexCensusReplayVisit("non-exhaustive"),
        createDexCensusReplayVisit("non-exhaustive"),
      ]],
      [supersededKey, [
        createDexCensusReplayVisit("bounded", { persistence: "fence-only" }),
        createDexCensusReplayVisit("bounded", { persistence: "fence-only" }),
        createDexCensusReplayVisit("bounded", { persistence: "fence-only" }),
        createDexCensusReplayVisit("bounded", { persistence: "fence-only" }),
      ]],
      [staleKey, [
        createDexCensusReplayVisit("bounded", { persistence: "retain", checked: false }),
        createDexCensusReplayVisit("bounded", { persistence: "retain", checked: false }),
        createDexCensusReplayVisit("bounded", { persistence: "retain", checked: false }),
        createDexCensusReplayVisit("bounded", { persistence: "retain", checked: false }),
      ]],
      [observedKey, [
        createDexCensusReplayVisit("observed", { observedPoolCount: 2 }),
        createDexCensusReplayVisit("observed", { observedPoolCount: 2 }),
        createDexCensusReplayVisit("observed", { observedPoolCount: 2 }),
        createDexCensusReplayVisit("observed", { observedPoolCount: 2 }),
      ]],
      [verifiedKey, [
        createDexCensusReplayVisit("verified-empty"),
        createDexCensusReplayVisit("verified-empty"),
        createDexCensusReplayVisit("verified-empty"),
        createDexCensusReplayVisit("verified-empty"),
      ]],
      [TARGET_KEYS[8]!, [
        createDexCensusReplayVisit("verified-empty"),
        createDexCensusReplayVisit("verified-empty"),
        createDexCensusReplayVisit("verified-empty"),
        createDexCensusReplayVisit("verified-empty"),
      ]],
      [TARGET_KEYS[9]!, [
        createDexCensusReplayVisit("verified-empty"),
        createDexCensusReplayVisit("verified-empty"),
        createDexCensusReplayVisit("verified-empty"),
        createDexCensusReplayVisit("verified-empty"),
      ]],
    ]);
    const replay = replayDexCensusSweep({
      stablecoinId: "synthetic-adverse",
      targets: TARGETS,
      visitPlans: plans,
      seeds: [
        {
          deployment: TARGETS[4]!,
          outcome: "verified_no_pools",
          reason: "A provider completed the direct-token query with no eligible pool",
          observedPoolCount: 0,
          observedAt: START_SEC - 1_000,
          discoveryLastCrawlAt: START_SEC - 1_000,
        },
        {
          deployment: TARGETS[5]!,
          outcome: "verified_no_pools",
          reason: "A provider completed the direct-token query with no eligible pool",
          observedPoolCount: 0,
          observedAt: START_SEC - 200_000,
          discoveryLastCrawlAt: START_SEC - 200_000,
        },
      ],
      startNowSec: START_SEC,
      maxAgeSec: 2 * RUN_INTERVAL_SEC,
      runs: 4,
      runIntervalSec: RUN_INTERVAL_SEC,
    });

    expect(replay.allTargetsVisited).toBe(true);
    expect(replay.completeEmpty).toBe(false);
    expect(classifyDexCensusReplayCoverage(replay)).toBe("superseded");
    expect(replay.statesByKey.get(boundedKey)).toMatchObject({
      attemptResult: "verified_no_pools",
      evidenceState: "current",
    });
    expect(replay.statesByKey.get(retryableKey)).toMatchObject({
      attemptResult: "verified_no_pools",
      evidenceState: "current",
    });
    expect(replay.statesByKey.get(outageKey)).toMatchObject({
      attemptResult: "provider_outage",
      disposition: "provider-outage",
    });
    expect(replay.statesByKey.get(nonExhaustiveKey)).toMatchObject({
      attemptResult: "provider_non_exhaustive",
      disposition: "provider-outage",
    });
    expect(replay.statesByKey.get(supersededKey)).toMatchObject({
      evidenceState: "superseded",
      disposition: "superseded",
    });
    expect(replay.statesByKey.get(staleKey)).toMatchObject({
      evidenceState: "stale",
      disposition: "verified-no-pools",
    });
    expect(replay.statesByKey.get(observedKey)).toMatchObject({
      attemptResult: "observed_pools",
      disposition: "observed-pools",
    });
    expect(replay.statesByKey.get(verifiedKey)).toMatchObject({
      attemptResult: "verified_no_pools",
      evidenceState: "current",
    });

    const classifyOne = (index: number) => classifyDexPlaceholderCoverage({
      deployments: [TARGETS[index]!],
      outcomeRows: [replay.rowByKey.get(TARGET_KEYS[index]!)!],
      nowSec: replay.finalNowSec,
    });
    expect(classifyOne(0).state).toBe("complete-empty");
    expect(classifyOne(1).state).toBe("complete-empty");
    expect(classifyOne(2)).toMatchObject({
      state: "provider-outage",
      coverage: { unsupportedReasons: { deploymentCensusProviderOutage: 1 } },
    });
    expect(classifyOne(3)).toMatchObject({
      state: "provider-outage",
      coverage: { unsupportedReasons: { deploymentCensusProviderOutage: 1 } },
    });
    expect(classifyOne(4)).toMatchObject({
      state: "discovery-deferral",
      coverage: { unsupportedReasons: { deploymentCensusSupersededOutcome: 1 } },
    });
    expect(classifyOne(5)).toMatchObject({
      state: "discovery-deferral",
      coverage: { unsupportedReasons: { deploymentCensusStaleOutcome: 1 } },
    });
    expect(classifyOne(6)).toMatchObject({
      state: "pools-lost-before-scoring",
      coverage: { unsupportedReasons: { deploymentCensusObservedPoolsWithoutScoredPool: 1 } },
    });
    expect(classifyOne(7).state).toBe("complete-empty");
    expect(resolveDexDeploymentCensusMaxAgeSec(TARGETS)).toBeGreaterThan(0);
  });
});
