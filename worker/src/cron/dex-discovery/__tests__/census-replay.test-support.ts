import {
  encodeDexCensusAttemptResult,
  getDexDiscoveryProviders,
  type DexCensusAttemptResult,
  type DexDiscoveryProvider,
  type DexDeploymentOutcome,
} from "@shared/lib/dex-deployment-coverage";
import type { ContractDeployment } from "@shared/types/core";
import {
  advanceDiscoveryTargetCursor,
  DEX_DISCOVERY_PER_COIN_BUDGET_MS,
  discoveryTargetCursorKey,
  DISCOVERY_WINDOWED_CRAWL_INTERVAL_SEC,
  estimateDeploymentCrawlCostMs,
  selectDiscoveryTargetWindow,
} from "../target-window";
import {
  classifyStoredDexCensusState,
  isCurrentDexCensusStateComplete,
  resolveDexCensusAttempt,
  type DexCensusAttemptSignals,
  type DexStoredCensusState,
} from "../census-state-machine";
import type { DexDeploymentCensusRow } from "../../dex-liquidity/deployment-census-coverage";

export type DexCensusReplayPersistence = "outcome" | "fence-only" | "retain";
export type DexCensusReplayCursorMode = "normal" | "failed-window" | "hold";

export type DexCensusReplayCase =
  | "bounded"
  | "retryable"
  | "outage"
  | "degraded"
  | "non-exhaustive"
  | "verified-empty"
  | "observed"
  | "unsupported";

export interface DexCensusReplayVisit {
  signals?: Partial<Omit<DexCensusAttemptSignals, "providerCount">>;
  providerIds?: readonly DexDiscoveryProvider[];
  persistence?: DexCensusReplayPersistence;
  cursorMode?: DexCensusReplayCursorMode;
  checked?: boolean;
  observedAt?: number;
}

export interface DexCensusReplayVisitOptions {
  signals?: Partial<Omit<DexCensusAttemptSignals, "providerCount">>;
  providerIds?: readonly DexDiscoveryProvider[];
  persistence?: DexCensusReplayPersistence;
  cursorMode?: DexCensusReplayCursorMode;
  checked?: boolean;
  observedAt?: number;
  observedPoolCount?: number;
}

/** Build a readable synthetic provider result without bypassing the leaf resolver. */
export function createDexCensusReplayVisit(
  kind: DexCensusReplayCase,
  options: DexCensusReplayVisitOptions = {},
): DexCensusReplayVisit {
  const observedPoolCount = options.observedPoolCount ??
    options.signals?.observedPoolCount ??
    (kind === "observed" ? 1 : 0);
  const signals: Partial<Omit<DexCensusAttemptSignals, "providerCount">> = {
    exhaustiveSucceeded: kind === "verified-empty",
    nonExhaustiveSucceededEmpty: kind === "non-exhaustive",
    providerDegraded: kind === "degraded",
    providerFailed: kind === "outage" || kind === "retryable",
    retryableProviderFailure: kind === "retryable",
    ...options.signals,
    observedPoolCount,
  };
  const providerIds = options.providerIds ?? (kind === "unsupported" ? [] : undefined);
  return {
    signals,
    ...(providerIds ? { providerIds } : {}),
    ...(options.persistence ? { persistence: options.persistence } : {}),
    ...(options.cursorMode ? { cursorMode: options.cursorMode } : {}),
    ...(options.checked === undefined ? {} : { checked: options.checked }),
    ...(options.observedAt === undefined ? {} : { observedAt: options.observedAt }),
  };
}

export interface DexCensusReplaySeed {
  deployment: ContractDeployment;
  outcome: DexDeploymentOutcome;
  reason: string;
  observedPoolCount: number;
  observedAt: number;
  discoveryLastCrawlAt: number | null;
  providerIds?: readonly DexDiscoveryProvider[];
}

type DexCensusReplayPlan = ReadonlyMap<string, readonly DexCensusReplayVisit[]> |
  Readonly<Record<string, readonly DexCensusReplayVisit[]>>;

export interface DexCensusReplayInput {
  stablecoinId: string;
  targets: readonly ContractDeployment[];
  visitPlans?: DexCensusReplayPlan;
  seeds?: readonly DexCensusReplaySeed[];
  startNowSec: number;
  maxAgeSec: number;
  runs: number;
  runIntervalSec?: number;
  budgetMs?: number;
}

export interface DexCensusReplayRun {
  runNumber: number;
  nowSec: number;
  cursorBefore: string | null;
  cursorAfter: string | null;
  targetKeys: string[];
  checkedDeploymentKeys: string[];
  fencedDeploymentKeys: string[];
  persistedDeploymentKeys: string[];
  estimatedCostMs: number;
  providerCostMs: number;
  totalEstimatedCostMs: number;
  providerCostParity: boolean;
}

export interface DexCensusReplayResult {
  stablecoinId: string;
  targetKeys: string[];
  runs: DexCensusReplayRun[];
  rows: DexDeploymentCensusRow[];
  rowByKey: Map<string, DexDeploymentCensusRow>;
  statesByKey: Map<string, DexStoredCensusState>;
  missingKeys: string[];
  visitedKeys: string[];
  allTargetsVisited: boolean;
  finalCursor: string | null;
  finalNowSec: number;
  completeEmpty: boolean;
}

export type DexCensusReplayCoverageState =
  | "complete-empty"
  | "observed-pools"
  | "bounded-pending"
  | "provider-outage"
  | "provider-non-exhaustive"
  | "unsupported-scope"
  | "superseded"
  | "stale"
  | "invalid"
  | "missing"
  | "incomplete";

interface ReplayStoredRow {
  row: DexDeploymentCensusRow;
  providerCount: number;
  providerSetSuperseded: boolean;
}

function targetKey(target: ContractDeployment): string {
  return discoveryTargetCursorKey(target);
}

function dedupeTargets(targets: readonly ContractDeployment[]): ContractDeployment[] {
  const seen = new Set<string>();
  const unique: ContractDeployment[] = [];
  for (const target of targets) {
    const key = targetKey(target);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(target);
  }
  return unique;
}

function planFor(
  plans: DexCensusReplayPlan | undefined,
  key: string,
): readonly DexCensusReplayVisit[] {
  if (!plans) return [];
  if (typeof (plans as ReadonlyMap<string, readonly DexCensusReplayVisit[]>).get === "function") {
    return (plans as ReadonlyMap<string, readonly DexCensusReplayVisit[]>).get(key) ?? [];
  }
  return (plans as Readonly<Record<string, readonly DexCensusReplayVisit[]>>)[key] ?? [];
}

function validateReplayInput(input: DexCensusReplayInput): void {
  if (!Number.isInteger(input.startNowSec) || input.startNowSec <= 0) {
    throw new TypeError("startNowSec must be a positive integer");
  }
  if (!Number.isFinite(input.maxAgeSec) || input.maxAgeSec < 0) {
    throw new TypeError("maxAgeSec must be a non-negative finite number");
  }
  if (!Number.isInteger(input.runs) || input.runs < 0) {
    throw new TypeError("runs must be a non-negative integer");
  }
  if (input.runIntervalSec !== undefined &&
    (!Number.isInteger(input.runIntervalSec) || input.runIntervalSec <= 0)) {
    throw new TypeError("runIntervalSec must be a positive integer when provided");
  }
  if (input.budgetMs !== undefined &&
    (!Number.isFinite(input.budgetMs) || input.budgetMs <= 0)) {
    throw new TypeError("budgetMs must be positive when provided");
  }
}

function seedStoredRow(
  stablecoinId: string,
  seed: DexCensusReplaySeed,
): ReplayStoredRow {
  const currentProviderIds = getDexDiscoveryProviders(seed.deployment.chain, seed.deployment.address);
  const providerIds = [...(seed.providerIds ?? currentProviderIds)];
  return {
    row: {
      stablecoin_id: stablecoinId,
      chain: seed.deployment.chain,
      contract_address: seed.deployment.address,
      outcome: seed.outcome,
      provider_set_json: JSON.stringify(providerIds),
      reason: seed.reason,
      observed_pool_count: seed.observedPoolCount,
      observed_at: seed.observedAt,
      discovery_last_crawl_at: seed.discoveryLastCrawlAt,
    },
    providerCount: providerIds.length,
    providerSetSuperseded: providerIds.length === 0 && currentProviderIds.length > 0,
  };
}

function defaultReplayVisit(): DexCensusReplayVisit {
  return createDexCensusReplayVisit("bounded");
}

/**
 * Replay only the durable census mechanics. No network or D1 work is performed.
 * The selector and cost function are the production functions, while the
 * per-target fence models the identity that a rotating sweep must preserve.
 */
export function replayDexCensusSweep(input: DexCensusReplayInput): DexCensusReplayResult {
  validateReplayInput(input);
  const targets = dedupeTargets(input.targets);
  const targetByKey = new Map(targets.map((target) => [targetKey(target), target]));
  const targetKeys = targets.map(targetKey);
  const rowsByKey = new Map<string, ReplayStoredRow>();
  for (const seed of input.seeds ?? []) {
    const key = targetKey(seed.deployment);
    if (targetByKey.has(key)) rowsByKey.set(key, seedStoredRow(input.stablecoinId, seed));
  }

  const visitIndexes = new Map<string, number>();
  const visitedKeys = new Set<string>();
  let cursor: string | null = null;
  const runs: DexCensusReplayRun[] = [];
  const runIntervalSec = input.runIntervalSec ?? DISCOVERY_WINDOWED_CRAWL_INTERVAL_SEC;
  const budgetMs = input.budgetMs ?? DEX_DISCOVERY_PER_COIN_BUDGET_MS;

  for (let index = 0; index < input.runs; index++) {
    const nowSec = input.startNowSec + index * runIntervalSec;
    const selected = selectDiscoveryTargetWindow({
      targets,
      cursor,
      budgetMs,
    });
    const cursorBefore = cursor;
    const checkedDeploymentKeys = new Set<string>();
    const fencedDeploymentKeys: string[] = [];
    const persistedDeploymentKeys: string[] = [];
    let failedWindow = false;

    for (const target of selected.targets) {
      const key = targetKey(target);
      visitedKeys.add(key);
      const visits = planFor(input.visitPlans, key);
      const visitIndex = visitIndexes.get(key) ?? 0;
      visitIndexes.set(key, visitIndex + 1);
      const visit = visits[visitIndex] ?? defaultReplayVisit();
      const persistence = visit.persistence ?? "outcome";
      const providerIds = [
        ...(visit.providerIds ?? getDexDiscoveryProviders(target.chain, target.address)),
      ];
      const providerCount = providerIds.length;
      const signals: DexCensusAttemptSignals = {
        exhaustiveSucceeded: false,
        nonExhaustiveSucceededEmpty: false,
        providerDegraded: false,
        providerFailed: false,
        ...visit.signals,
        observedPoolCount: visit.signals?.observedPoolCount ?? 0,
        providerCount,
      };

      if (visit.cursorMode === "failed-window") failedWindow = true;
      if (visit.checked !== false && visit.cursorMode !== "hold") checkedDeploymentKeys.add(key);

      // `retain` represents a provider that the bounded crawl did not reach.
      // It is intentionally not fenced: an unvisited deployment's prior row
      // must not become superseded merely because another target was attempted.
      if (persistence === "retain") continue;
      fencedDeploymentKeys.push(key);

      if (persistence === "fence-only") {
        const prior = rowsByKey.get(key);
        if (prior) {
          rowsByKey.set(key, {
            ...prior,
            row: { ...prior.row, discovery_last_crawl_at: nowSec },
          });
        }
        continue;
      }

      const attempt = resolveDexCensusAttempt(signals);
      const legacy = encodeDexCensusAttemptResult(attempt);
      rowsByKey.set(key, {
        row: {
          stablecoin_id: input.stablecoinId,
          chain: target.chain,
          contract_address: target.address,
          ...legacy,
          provider_set_json: JSON.stringify(providerIds),
          observed_pool_count: signals.observedPoolCount,
          observed_at: visit.observedAt ?? nowSec,
          discovery_last_crawl_at: nowSec,
        },
        providerCount,
        providerSetSuperseded: providerCount === 0 &&
          getDexDiscoveryProviders(target.chain, target.address).length > 0,
      });
      persistedDeploymentKeys.push(key);
    }

    if (!selected.windowed) {
      cursor = null;
    } else {
      const nextCursor = failedWindow
        ? targetKey(selected.targets[selected.targets.length - 1]!)
        : advanceDiscoveryTargetCursor(selected.targets, checkedDeploymentKeys);
      if (nextCursor != null) cursor = nextCursor;
    }

    const providerCostMs = selected.targets.reduce(
      (sum, target) => sum + estimateDeploymentCrawlCostMs(target.chain, target.address),
      0,
    );
    runs.push({
      runNumber: index + 1,
      nowSec,
      cursorBefore,
      cursorAfter: cursor,
      targetKeys: selected.targets.map(targetKey),
      checkedDeploymentKeys: [...checkedDeploymentKeys],
      fencedDeploymentKeys,
      persistedDeploymentKeys,
      estimatedCostMs: selected.estimatedCostMs,
      providerCostMs,
      totalEstimatedCostMs: selected.totalEstimatedCostMs,
      providerCostParity: selected.estimatedCostMs === providerCostMs,
    });
  }

  const finalNowSec = runs[runs.length - 1]?.nowSec ?? input.startNowSec;
  const rowByKey = new Map<string, DexDeploymentCensusRow>();
  const statesByKey = new Map<string, DexStoredCensusState>();
  for (const key of targetKeys) {
    const stored = rowsByKey.get(key);
    if (!stored) continue;
    rowByKey.set(key, stored.row);
    statesByKey.set(key, classifyStoredDexCensusState({
      outcome: stored.row.outcome,
      reason: stored.row.reason,
      observedPoolCount: stored.row.observed_pool_count,
      observedAt: stored.row.observed_at,
      discoveryLastCrawlAt: stored.row.discovery_last_crawl_at,
      providerCount: stored.providerCount,
      nowSec: finalNowSec,
      maxAgeSec: input.maxAgeSec,
      providerSetSuperseded: stored.providerSetSuperseded,
    }));
  }

  const missingKeys = targetKeys.filter((key) => !rowByKey.has(key));
  const completeEmpty = targetKeys.length > 0 &&
    missingKeys.length === 0 &&
    targetKeys.every((key) => {
      const state = statesByKey.get(key);
      return state != null && isCurrentDexCensusStateComplete(state) &&
        state.attemptResult === ("verified_no_pools" satisfies DexCensusAttemptResult);
    });

  return {
    stablecoinId: input.stablecoinId,
    targetKeys,
    runs,
    rows: targetKeys.flatMap((key) => {
      const row = rowByKey.get(key);
      return row ? [row] : [];
    }),
    rowByKey,
    statesByKey,
    missingKeys,
    visitedKeys: [...visitedKeys],
    allTargetsVisited: targetKeys.every((key) => visitedKeys.has(key)),
    finalCursor: cursor,
    finalNowSec,
    completeEmpty,
  };
}

/** Aggregate one replay without weakening any per-deployment evidence state. */
export function classifyDexCensusReplayCoverage(
  replay: DexCensusReplayResult,
): DexCensusReplayCoverageState {
  if (replay.completeEmpty) return "complete-empty";
  if (replay.missingKeys.length > 0) return "missing";

  const states = replay.targetKeys
    .map((key) => replay.statesByKey.get(key))
    .filter((state): state is DexStoredCensusState => state != null);
  if (states.some((state) => state.evidenceState === "invalid" || state.disposition === "invalid")) {
    return "invalid";
  }
  if (states.some((state) => state.evidenceState === "superseded" || state.disposition === "superseded")) {
    return "superseded";
  }
  if (states.some((state) => state.evidenceState === "stale")) return "stale";
  if (states.some((state) => state.disposition === "observed-pools")) return "observed-pools";
  if (states.some((state) => state.attemptResult === "provider_non_exhaustive")) {
    return "provider-non-exhaustive";
  }
  if (states.some((state) => state.disposition === "provider-outage")) return "provider-outage";
  if (states.some((state) => state.disposition === "bounded-pending")) return "bounded-pending";
  if (states.some((state) => state.disposition === "unsupported-scope")) return "unsupported-scope";
  return "incomplete";
}
