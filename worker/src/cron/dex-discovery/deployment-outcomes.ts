import {
  getActiveDexCoverageWaiver,
  getDexDiscoveryProviders,
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

function deploymentKey(chain: string, address: string): string {
  return canonicalExitRouteAssetKey(chain, address);
}

function matchesDeployment(pool: StagedPool, deployment: ContractDeployment): boolean {
  if (canonicalExitRouteChain(pool.chain) !== canonicalExitRouteChain(deployment.chain)) return false;
  const address = canonicalExitRouteScopedId(deployment.chain, deployment.address);
  return (
    canonicalExitRouteScopedId(pool.chain, pool.baseToken ?? "") === address ||
    canonicalExitRouteScopedId(pool.chain, pool.quoteToken ?? "") === address
  );
}

export function classifyDexDeploymentOutcomes(params: {
  stablecoinId: string;
  deployments: ContractDeployment[];
  pools: StagedPool[];
  providerChecks: DexDeploymentProviderCheck[];
  nowSec: number;
}): DexDeploymentOutcomeWrite[] {
  const successfulChecks = new Set(
    params.providerChecks
      .filter((check) => check.status === "success")
      .map((check) => deploymentKey(check.chain, check.address)),
  );
  const failedChecks = new Set(
    params.providerChecks
      .filter((check) => check.status === "failure")
      .map((check) => deploymentKey(check.chain, check.address)),
  );

  return params.deployments.map((deployment) => {
    const providers = getDexDiscoveryProviders(deployment.chain);
    const key = deploymentKey(deployment.chain, deployment.address);
    const stagedPoolCount = params.pools.filter((pool) => matchesDeployment(pool, deployment)).length;
    const providerObservedPoolCount = params.providerChecks
      .filter((check) => check.status === "success" && deploymentKey(check.chain, check.address) === key)
      .reduce((max, check) => Math.max(max, check.observedPoolCount ?? 0), 0);
    const observedPoolCount = Math.max(stagedPoolCount, providerObservedPoolCount);
    if (observedPoolCount > 0) {
      return {
        stablecoinId: params.stablecoinId,
        chain: deployment.chain,
        address: deployment.address,
        outcome: "observed_pools",
        providers,
        reason: "At least one eligible direct-token pool was observed",
        observedPoolCount,
        observedAt: params.nowSec,
      };
    }
    if (successfulChecks.has(key)) {
      return {
        stablecoinId: params.stablecoinId,
        chain: deployment.chain,
        address: deployment.address,
        outcome: "verified_no_pools",
        providers,
        reason: "A provider completed the direct-token query with no eligible pool",
        observedPoolCount: 0,
        observedAt: params.nowSec,
      };
    }
    return {
      stablecoinId: params.stablecoinId,
      chain: deployment.chain,
      address: deployment.address,
      outcome: "provider_inaccessible",
      providers,
      reason:
        providers.length === 0
          ? "No registered token-pool provider supports this chain"
          : failedChecks.has(key)
            ? "All attempted token-pool provider queries failed"
            : "No provider completed a query for this deployment in the bounded crawl",
      observedPoolCount: 0,
      observedAt: params.nowSec,
    };
  });
}

export function buildStaticInaccessibleDeploymentOutcomes(nowSec: number): DexDeploymentOutcomeWrite[] {
  return ACTIVE_STABLECOINS.flatMap((meta) =>
    [...(meta.contracts ?? []), ...(meta.tradedContracts ?? [])]
      .filter((deployment) => getDexDiscoveryProviders(deployment.chain).length === 0)
      .map((deployment) => ({
        stablecoinId: meta.id,
        chain: deployment.chain,
        address: deployment.address,
        outcome: "provider_inaccessible" as const,
        providers: [],
        reason: "No registered token-pool provider supports this chain",
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
  return params.deployments.map((deployment) => ({
    stablecoinId: params.stablecoinId,
    chain: deployment.chain,
    address: deployment.address,
    outcome: "provider_inaccessible",
    providers: getDexDiscoveryProviders(deployment.chain),
    reason: "Bounded discovery crawl failed before a complete deployment census",
    observedPoolCount: 0,
    observedAt: params.nowSec,
  }));
}

export async function upsertDexDeploymentOutcomes(
  db: D1Database,
  outcomes: readonly DexDeploymentOutcomeWrite[],
  signal?: AbortSignal,
): Promise<number> {
  if (outcomes.length === 0) return 0;
  const statements = outcomes.map((outcome) => {
    const waiver = getActiveDexCoverageWaiver(outcome.stablecoinId, outcome.chain, outcome.observedAt);
    return db
      .prepare(UPSERT_OUTCOME_SQL)
      .bind(
        outcome.stablecoinId,
        outcome.chain,
        canonicalExitRouteScopedId(outcome.chain, outcome.address),
        outcome.outcome,
        JSON.stringify(outcome.providers),
        outcome.reason,
        outcome.observedPoolCount,
        outcome.observedAt,
        waiver?.owner ?? null,
        waiver?.reason ?? null,
        waiver?.expiresAt ?? null,
      );
  });
  await batchExecute(db, statements, { chunkSize: 50, signal });
  return outcomes.length;
}
