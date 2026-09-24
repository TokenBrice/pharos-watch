import { loadRpcProviderTrialReport } from "../lib/rpc-provider-parity/report";
import { jsonResponse } from "../lib/api-response";
import type { DwellirBudgetEnv } from "../lib/rpc-provider-budget";

/**
 * Route context for the Dwellir trial report. `dwellirBudgetEnv` is hydrated by
 * `dwellirBudgetEnv` in `worker/src/routes/dependency-hydrators.ts`; the values
 * never reach the response.
 */
export interface RpcProviderTrialRouteContext {
  db: D1Database;
  dwellirBudgetEnv: DwellirBudgetEnv;
}

/**
 * Operator-only read of the Dwellir supplemental-RPC trial report: the credit
 * ledger, the `dwellir-evm` circuit row, and per-chain parity against each
 * chain's incumbent operator.
 *
 * Diagnostic only: it never feeds scoring or public health, and a report whose
 * observation window could not be read still answers `200` with
 * `observationError` set, because a degraded sample store is exactly the state
 * an operator needs to see.
 */
export async function handleRpcProviderTrialReport(
  context: RpcProviderTrialRouteContext,
): Promise<Response> {
  const report = await loadRpcProviderTrialReport(
    context.db,
    context.dwellirBudgetEnv,
    Math.floor(Date.now() / 1000),
  );
  return jsonResponse(report, { noStore: true });
}
