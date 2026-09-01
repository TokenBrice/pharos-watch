import {
  getActiveDexCoverageWaiver,
  getGeckoTerminalDiscoveryTarget,
  encodeDexCensusAttemptResult,
  type DexCensusAttemptResult,
  type DexDeploymentOutcome,
} from "@shared/lib/dex-deployment-coverage";
import {
  canonicalExitRouteAssetKey,
  canonicalExitRouteChain,
  canonicalExitRouteScopedId,
} from "@shared/lib/exit-route-identity";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { ContractDeployment } from "@shared/types/core";
import { batchExecute } from "../../lib/db";
import type { DexDeploymentProviderCheck, StagedPool } from "./types";
import {
  getRuntimeDexDiscoveryProviders,
  isRuntimeDexDiscoveryProviderExhaustive,
} from "./provider-registry";
import {
  resolveDexCensusAttempt,
  type DexCensusAttemptSignals,
} from "./census-state-machine";

export interface DexDeploymentOutcomeWrite {
  stablecoinId: string;
  chain: string;
  address: string;
  outcome: DexDeploymentOutcome;
  providers: string[];
  reason: string;
  observedPoolCount: number;
  observedAt: number;
}

const UPSERT_OUTCOME_SQL = `INSERT INTO dex_deployment_outcomes
  (stablecoin_id, chain, contract_address, outcome, provider_set_json, reason,
   observed_pool_count, observed_at, waiver_owner, waiver_reason, waiver_expires_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(stablecoin_id, chain, contract_address) DO UPDATE SET
  outcome = excluded.outcome,
  provider_set_json = excluded.provider_set_json,
  reason = excluded.reason,
  observed_pool_count = excluded.observed_pool_count,
  observed_at = excluded.observed_at,
  waiver_owner = excluded.waiver_owner,
  waiver_reason = excluded.waiver_reason,
  waiver_expires_at = excluded.waiver_expires_at`;

const DELETE_SUPERSEDED_OUTCOME_SQL = `DELETE FROM dex_deployment_outcomes
WHERE stablecoin_id = ? AND chain = ? AND contract_address = ?`;

function deploymentKey(chain: string, address: string): string {
  return canonicalExitRouteAssetKey(chain, address);
}

function legacyCensusColumns(
  attemptResult: DexCensusAttemptResult,
  legacyReason: string,
): Pick<DexDeploymentOutcomeWrite, "outcome" | "reason"> {
  return encodeDexCensusAttemptResult({ attemptResult, legacyReason });
}

function legacyCensusColumnsForSignals(
  signals: DexCensusAttemptSignals,
): Pick<DexDeploymentOutcomeWrite, "outcome" | "reason"> {
  const attempt = resolveDexCensusAttempt(signals);
  return legacyCensusColumns(attempt.attemptResult, attempt.legacyReason);
}

/**
 * Rows written before non-EVM identities were preserved case-sensitively are
 * keyed under a lowercased address, so the canonical upsert cannot reach them.
 * They freeze at their last pre-canonical outcome and stay in the census as a
 * second deployment for the same mint. Delete the superseded twin alongside the
 * canonical write instead of leaving every reader to filter it out.
 */
function supersededLowercaseAddress(canonicalAddress: string): string | null {
  const lowercased = canonicalAddress.toLowerCase();
  return lowercased === canonicalAddress ? null : lowercased;
}

function matchesDeployment(pool: StagedPool, deployment: ContractDeployment): boolean {
  if (canonicalExitRouteChain(pool.chain) !== canonicalExitRouteChain(deployment.chain)) return false;
  const canonicalAddress = (address: string): string =>
    pool.source === "gecko_terminal"
      ? (getGeckoTerminalDiscoveryTarget(deployment.chain, address)?.address ??
        canonicalExitRouteScopedId(deployment.chain, address))
      : canonicalExitRouteScopedId(deployment.chain, address);
  const address = canonicalAddress(deployment.address);
  return (
    canonicalAddress(pool.baseToken ?? "") === address ||
    canonicalAddress(pool.quoteToken ?? "") === address
  );
}

export function classifyDexDeploymentOutcomes(params: {
  stablecoinId: string;
  deployments: ContractDeployment[];
  pools: StagedPool[];
  providerChecks: DexDeploymentProviderCheck[];
  nowSec: number;
}): DexDeploymentOutcomeWrite[] {
  const exhaustiveSuccessfulChecks = new Set(
    params.providerChecks
      .filter((check) => check.status === "success" && isRuntimeDexDiscoveryProviderExhaustive(check.provider))
      .map((check) => deploymentKey(check.chain, check.address)),
  );
  const nonExhaustiveSuccessfulEmptyChecks = new Set(
    params.providerChecks
      .filter(
        (check) =>
          check.status === "success" &&
          !isRuntimeDexDiscoveryProviderExhaustive(check.provider) &&
          (check.observedPoolCount ?? 0) === 0,
      )
      .map((check) => deploymentKey(check.chain, check.address)),
  );
  const failedChecks = new Set(
    params.providerChecks
      .filter((check) => check.status === "failure" && check.retryable !== true)
      .map((check) => deploymentKey(check.chain, check.address)),
  );
  const degradedChecks = new Set(
    params.providerChecks
      .filter((check) => check.status === "degraded")
      .map((check) => deploymentKey(check.chain, check.address)),
  );

  return params.deployments.map((deployment) => {
    const providers = getRuntimeDexDiscoveryProviders(deployment.chain, deployment.address);
    const key = deploymentKey(deployment.chain, deployment.address);
    const stagedPoolCount = params.pools.filter((pool) => matchesDeployment(pool, deployment)).length;
    const providerObservedPoolCount = params.providerChecks
      .filter((check) => check.status === "success" && deploymentKey(check.chain, check.address) === key)
      .reduce((max, check) => Math.max(max, check.observedPoolCount ?? 0), 0);
    const observedPoolCount = Math.max(stagedPoolCount, providerObservedPoolCount);
    const attempt = resolveDexCensusAttempt({
      observedPoolCount,
      providerCount: providers.length,
      exhaustiveSucceeded: exhaustiveSuccessfulChecks.has(key),
      nonExhaustiveSucceededEmpty: nonExhaustiveSuccessfulEmptyChecks.has(key),
      providerDegraded: degradedChecks.has(key),
      providerFailed: failedChecks.has(key),
    });
    return {
      stablecoinId: params.stablecoinId,
      chain: deployment.chain,
      address: deployment.address,
      ...legacyCensusColumns(attempt.attemptResult, attempt.legacyReason),
      providers,
      observedPoolCount,
      observedAt: params.nowSec,
    };
  });
}

export function buildStaticInaccessibleDeploymentOutcomes(nowSec: number): DexDeploymentOutcomeWrite[] {
  return ACTIVE_STABLECOINS.flatMap((meta) =>
    [...(meta.contracts ?? []), ...(meta.tradedContracts ?? [])]
      .filter((deployment) => getRuntimeDexDiscoveryProviders(deployment.chain, deployment.address).length === 0)
      .map((deployment) => ({
        stablecoinId: meta.id,
        chain: deployment.chain,
        address: deployment.address,
        ...legacyCensusColumnsForSignals({
          observedPoolCount: 0,
          providerCount: 0,
          exhaustiveSucceeded: false,
          nonExhaustiveSucceededEmpty: false,
          providerDegraded: false,
          providerFailed: false,
        }),
        providers: [],
        observedPoolCount: 0,
        observedAt: nowSec,
      })),
  );
}

export function buildFailedCrawlDeploymentOutcomes(params: {
  stablecoinId: string;
  deployments: readonly ContractDeployment[];
  nowSec: number;
}): DexDeploymentOutcomeWrite[] {
  return params.deployments.map((deployment) => {
    const providers = getRuntimeDexDiscoveryProviders(deployment.chain, deployment.address);
    const attempt = resolveDexCensusAttempt({
      observedPoolCount: 0,
      providerCount: providers.length,
      exhaustiveSucceeded: false,
      nonExhaustiveSucceededEmpty: false,
      providerDegraded: false,
      providerFailed: false,
      boundedReason: "crawl-failed",
    });
    return {
      stablecoinId: params.stablecoinId,
      chain: deployment.chain,
      address: deployment.address,
      ...legacyCensusColumns(attempt.attemptResult, attempt.legacyReason),
      providers,
      observedPoolCount: 0,
      observedAt: params.nowSec,
    };
  });
}

export async function upsertDexDeploymentOutcomes(
  db: D1Database,
  outcomes: readonly DexDeploymentOutcomeWrite[],
  signal?: AbortSignal,
): Promise<number> {
  if (outcomes.length === 0) return 0;
  const statements = outcomes.flatMap((outcome) => {
    const waiver = getActiveDexCoverageWaiver(outcome.stablecoinId, outcome.chain, outcome.observedAt);
    const address = canonicalExitRouteScopedId(outcome.chain, outcome.address);
    const superseded = supersededLowercaseAddress(address);
    const cleanupStmt = superseded
      ? db.prepare(DELETE_SUPERSEDED_OUTCOME_SQL).bind(outcome.stablecoinId, outcome.chain, superseded)
      : null;
    const upsertStmt = db
      .prepare(UPSERT_OUTCOME_SQL)
      .bind(
        outcome.stablecoinId,
        outcome.chain,
        address,
        outcome.outcome,
        JSON.stringify(outcome.providers),
        outcome.reason,
        outcome.observedPoolCount,
        outcome.observedAt,
        waiver?.owner ?? null,
        waiver?.reason ?? null,
        waiver?.expiresAt ?? null,
      );
    return cleanupStmt ? [cleanupStmt, upsertStmt] : [upsertStmt];
  });
  await batchExecute(db, statements, { chunkSize: 50, signal });
  return outcomes.length;
}
