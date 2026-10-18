import type { CronProgressReporter, CronResult } from "../lib/cron-logger";
import type { ChainRpcConfig } from "../lib/chain-registry";
import { runYieldCoordinatorFetchStage } from "./yield-sync/coordinator";
import { runYieldCoordinatorHealthTelemetryStage } from "./yield-sync/coordinator";
import { runYieldCoordinatorNormalizeStage } from "./yield-sync/coordinator";
import { runYieldCoordinatorPersistStage } from "./yield-sync/coordinator";

export async function syncYieldData(
  db: D1Database,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
  coingeckoApiKey?: string | null,
  etherscanApiKey?: string | null,
  reportProgress?: CronProgressReporter,
): Promise<CronResult> {
  const fetched = await runYieldCoordinatorFetchStage({
    db,
    signal,
    chainRpcs,
    etherscanApiKey,
    reportProgress,
  });
  if (!fetched.ok) return fetched.result;

  const normalized = await runYieldCoordinatorNormalizeStage({
    db,
    signal,
    chainRpcs,
    coingeckoApiKey,
    fetched: fetched.context,
  });
  const health = await runYieldCoordinatorHealthTelemetryStage({
    db,
    fetched: fetched.context,
    normalized,
  });
  if (!health.ok) return health.result;

  return runYieldCoordinatorPersistStage({
    db,
    signal,
    fetched: fetched.context,
    normalized,
    health: health.context,
  });
}
