import { canonicalExitRouteScopedId } from "@shared/lib/exit-route-identity";
import type { ContractDeployment } from "@shared/types/core";
import { USER_AGENT } from "../../lib/constants";
import { fetchJsonWithRetry } from "../../lib/fetch-retry";
import { CURVE_API_BASE, CURVE_CHAINS, DEX_LIQUIDITY_POOL_MIN_TVL_USD } from "../dex-liquidity/constants";
import type { CurveApiPayload } from "../dex-liquidity/types";
import { DISCOVERY_STAGE_TIMEOUT_MS, buildStageSignal, type CrawlStageContext } from "./staged-pool";
import type { DexDeploymentProviderCheck } from "./types";

const CURVE_NATIVE_CHAINS = new Set<string>(CURVE_CHAINS);

export interface CurvePoolsStageResult {
  providerChecks: DexDeploymentProviderCheck[];
}

export async function crawlCurvePoolsStage(input: {
  coinTargets: ContractDeployment[];
  context: CrawlStageContext;
}): Promise<CurvePoolsStageResult> {
  const targetsByChain = new Map<string, ContractDeployment[]>();
  for (const target of input.coinTargets) {
    if (!CURVE_NATIVE_CHAINS.has(target.chain)) continue;
    const targets = targetsByChain.get(target.chain) ?? [];
    targets.push(target);
    targetsByChain.set(target.chain, targets);
  }
  if (targetsByChain.size === 0 || input.context.timeExceeded()) return { providerChecks: [] };

  const checks = await Promise.all(
    [...targetsByChain].map(async ([chain, targets]): Promise<DexDeploymentProviderCheck[]> => {
      const result = await fetchJsonWithRetry<CurveApiPayload>(
        `${CURVE_API_BASE}/${chain}`,
        {
          headers: { "User-Agent": USER_AGENT },
          signal: buildStageSignal(input.context.signal, input.context.deadlineMs, DISCOVERY_STAGE_TIMEOUT_MS.curve),
        },
        1,
        { timeoutMs: DISCOVERY_STAGE_TIMEOUT_MS.curve },
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
    }),
  );
  return { providerChecks: checks.flat() };
}
