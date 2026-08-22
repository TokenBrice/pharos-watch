import { CURVE_NATIVE_DISCOVERY_CHAINS } from "@shared/lib/dex-deployment-coverage";
import { canonicalExitRouteScopedId } from "@shared/lib/exit-route-identity";
import type { ContractDeployment } from "@shared/types/core";
import { USER_AGENT } from "../../lib/constants";
import { mapWithConcurrency } from "../../lib/concurrency";
import { fetchJsonWithRetry } from "../../lib/fetch-retry";
import {
  CURVE_API_BASE,
  CURVE_API_CHAIN_PATHS,
  DEX_LIQUIDITY_POOL_MIN_TVL_USD,
} from "../dex-liquidity/constants";
import type { CurveApiPayload } from "../dex-liquidity/types";
import { DISCOVERY_STAGE_TIMEOUT_MS, buildStageSignal, type CrawlStageContext } from "./staged-pool";
import type { DexDeploymentProviderCheck } from "./types";

const CURVE_DISCOVERY_FETCH_CONCURRENCY = 2;
// Curve getPools payloads are large but should stay below the generic 16 MiB body cap.
const CURVE_DISCOVERY_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface CurvePoolsStageResult {
  providerChecks: DexDeploymentProviderCheck[];
}

export async function crawlCurvePoolsStage(input: {
  coinTargets: ContractDeployment[];
  context: CrawlStageContext;
}): Promise<CurvePoolsStageResult> {
  const targetsByChain = new Map<string, ContractDeployment[]>();
  for (const target of input.coinTargets) {
    // Only chains where Curve is a registered discovery provider. The
    // deployment census attributes outcomes to the provider list this set
    // feeds, so a check produced outside it is evidence nothing can account
    // for — and, on the five chains the liquidity stage covers but the registry
    // does not, it was pure wasted request budget.
    if (!CURVE_NATIVE_DISCOVERY_CHAINS.has(target.chain)) continue;
    const targets = targetsByChain.get(target.chain) ?? [];
    targets.push(target);
    targetsByChain.set(target.chain, targets);
  }
  if (targetsByChain.size === 0 || input.context.timeExceeded()) return { providerChecks: [] };

  const checks = await mapWithConcurrency(
    [...targetsByChain],
    CURVE_DISCOVERY_FETCH_CONCURRENCY,
    async ([chain, targets]): Promise<DexDeploymentProviderCheck[]> => {
      try {
        const result = await fetchJsonWithRetry<CurveApiPayload>(
          // Curve addresses some chains under a different id than Pharos does;
          // the liquidity stage has always honored this mapping and discovery
          // has not, which is how every run spent its retry budget on a request
          // the endpoint answers with an error.
          `${CURVE_API_BASE}/${CURVE_API_CHAIN_PATHS[chain] ?? chain}`,
          {
            headers: { "User-Agent": USER_AGENT },
            signal: buildStageSignal(input.context.signal, input.context.deadlineMs, DISCOVERY_STAGE_TIMEOUT_MS.curve),
          },
          1,
          {
            timeoutMs: DISCOVERY_STAGE_TIMEOUT_MS.curve,
            maxResponseBytes: CURVE_DISCOVERY_MAX_RESPONSE_BYTES,
          },
        );
        const payload = result?.body ?? null;

        const poolData = payload?.data?.poolData;
        if (!Array.isArray(poolData)) {
          return targets.map(({ address }) => ({ chain, address, provider: "curve", status: "failure" }));
        }
        return targets.map(({ address }) => {
          const tokenAddress = canonicalExitRouteScopedId(chain, address);
          const observedPoolCount = poolData.filter(
            (pool) =>
              pool.isBroken !== true &&
              pool.usdTotal >= DEX_LIQUIDITY_POOL_MIN_TVL_USD &&
              pool.coins?.some((coin) => canonicalExitRouteScopedId(chain, coin.address) === tokenAddress),
          ).length;
          return { chain, address, provider: "curve", status: "success", observedPoolCount };
        });
      } catch (err) {
        if (input.context.signal?.aborted) throw err;
        return targets.map(({ address }) => ({ chain, address, provider: "curve", status: "failure" }));
      }
    },
    { signal: input.context.signal },
  );
  return { providerChecks: checks.flat() };
}
