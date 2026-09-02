import {
  getHorizonDiscoveryAsset,
  isHorizonDiscoveryDeployment,
} from "@shared/lib/dex-deployment-coverage";
import { canonicalExitRouteScopedKey } from "@shared/lib/exit-route-identity";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { ContractDeployment } from "@shared/types/core";
import { sleepWithSignal } from "../../lib/abort";
import { CIRCUIT_SOURCE, STELLAR_HORIZON_API, USER_AGENT } from "../../lib/constants";
import { fetchJsonWithRetry } from "../../lib/fetch-retry";
import { IsolateLocalState } from "../../lib/isolate-local-state";
import {
  buildPriceValidationContext,
  getReferencePriceForContext,
} from "../../lib/price-validation";
import { RATE_LIMITS } from "../../lib/rate-limit";
import { isPlausibleDexObservationPrice } from "../dex-liquidity/price-sanity";
import {
  DISCOVERY_STAGE_TIMEOUT_MS,
  buildStageSignal,
  toStagedPool,
  type CrawlStageContext,
} from "./staged-pool";
import { makeDexDeploymentProviderCheck, type DexDeploymentProviderCheck } from "./types";

const HORIZON_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const HORIZON_PAGE_LIMIT = 200;

interface HorizonReserve {
  asset: string;
  amount: number;
}

interface HorizonLiquidityPool {
  id: string;
  feeBp: number;
  type: string;
  reserves: [HorizonReserve, HorizonReserve];
}

interface PricedHorizonPool {
  priceUsd: number | null;
  tvlUsd: number | null;
}

export interface HorizonPoolsStageResult {
  providerChecks: DexDeploymentProviderCheck[];
  stoppedEarly?: boolean;
}

const horizonRequestState = new IsolateLocalState(() => ({ lastStartedAtMs: 0 }));

const trackedClassicAssets = new Map<string, { stablecoinId: string; address: string }>();
for (const coin of ACTIVE_STABLECOINS) {
  for (const deployment of [...(coin.contracts ?? []), ...(coin.tradedContracts ?? [])]) {
    if (deployment.chain !== "stellar") continue;
    const horizonAsset = getHorizonDiscoveryAsset(deployment.address, coin.symbol);
    if (horizonAsset) {
      trackedClassicAssets.set(horizonAsset, { stablecoinId: coin.id, address: deployment.address });
    }
  }
}

/** Test-only reset for the isolate-local request pacing clock. */
export function resetHorizonDiscoveryStateForTests(): void {
  horizonRequestState.reset();
}

function toRepoStellarAsset(asset: string): string | null {
  if (asset === "native") return "native";
  const tracked = trackedClassicAssets.get(asset);
  if (tracked) return tracked.address;
  const separator = asset.indexOf(":");
  if (separator <= 0) return null;
  const code = asset.slice(0, separator);
  const issuer = asset.slice(separator + 1);
  if (!/^[A-Za-z0-9]{1,12}$/.test(code) || !/^G[A-Z2-7]{55}$/.test(issuer)) return null;
  return `${code}-${issuer}`;
}

function parseFiniteAmount(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function parseHorizonPool(value: unknown, trackedAsset: string): HorizonLiquidityPool | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !/^[A-Fa-f0-9]{64}$/.test(row.id)) return null;
  if (row.type !== "constant_product" || !Array.isArray(row.reserves) || row.reserves.length !== 2) return null;
  const feeBp = typeof row.fee_bp === "number" ? row.fee_bp : Number(row.fee_bp);
  if (!Number.isInteger(feeBp) || feeBp < 0) return null;

  const reserves = row.reserves.map((reserve): HorizonReserve | null => {
    if (typeof reserve !== "object" || reserve === null) return null;
    const candidate = reserve as Record<string, unknown>;
    const amount = parseFiniteAmount(candidate.amount);
    return typeof candidate.asset === "string" && amount != null
      ? { asset: candidate.asset, amount }
      : null;
  });
  if (reserves.some((reserve) => reserve == null)) return null;
  const parsedReserves = reserves as [HorizonReserve, HorizonReserve];
  if (parsedReserves.filter((reserve) => reserve.asset === trackedAsset).length !== 1) return null;
  return { id: row.id, feeBp, type: row.type, reserves: parsedReserves };
}

function priceHorizonPool(
  pool: HorizonLiquidityPool,
  trackedAsset: string,
  context: CrawlStageContext,
): PricedHorizonPool {
  const trackedReserve = pool.reserves.find((reserve) => reserve.asset === trackedAsset)!;
  const pairedReserve = pool.reserves.find((reserve) => reserve.asset !== trackedAsset)!;
  const pairedAsset = trackedClassicAssets.get(pairedReserve.asset);
  if (!pairedAsset || trackedReserve.amount <= 0 || pairedReserve.amount <= 0) {
    return { priceUsd: null, tvlUsd: null };
  }
  const pairedPriceUsd = getReferencePriceForContext(
    buildPriceValidationContext({ stablecoinId: pairedAsset.stablecoinId }),
    context.references,
  );
  if (pairedPriceUsd == null) return { priceUsd: null, tvlUsd: null };

  const priceUsd = (pairedReserve.amount * pairedPriceUsd) / trackedReserve.amount;
  if (!isPlausibleDexObservationPrice(context.stablecoinId, priceUsd, context.references)) {
    return { priceUsd: null, tvlUsd: null };
  }
  const tvlUsd = pairedReserve.amount * pairedPriceUsd * 2;
  return Number.isFinite(tvlUsd) && tvlUsd >= 0
    ? { priceUsd, tvlUsd }
    : { priceUsd: null, tvlUsd: null };
}

async function paceHorizonRequest(signal?: AbortSignal): Promise<void> {
  const elapsedMs = Date.now() - horizonRequestState.state.lastStartedAtMs;
  if (horizonRequestState.state.lastStartedAtMs > 0 && elapsedMs < RATE_LIMITS.HORIZON_MS) {
    await sleepWithSignal(RATE_LIMITS.HORIZON_MS - elapsedMs, signal);
  }
  horizonRequestState.state.lastStartedAtMs = Date.now();
}

export async function crawlHorizonPoolsStage(input: {
  coinTargets: ContractDeployment[];
  context: CrawlStageContext;
}): Promise<HorizonPoolsStageResult> {
  const providerChecks: DexDeploymentProviderCheck[] = [];
  const targets = input.coinTargets.filter((target) =>
    isHorizonDiscoveryDeployment(target.chain, target.address),
  );
  if (targets.length === 0 || input.context.timeExceeded()) return { providerChecks };

  for (const target of targets) {
    if (input.context.timeExceeded()) return { providerChecks, stoppedEarly: true };
    const stablecoinSymbol = ACTIVE_STABLECOINS.find((coin) => coin.id === input.context.stablecoinId)?.symbol;
    const horizonAsset = getHorizonDiscoveryAsset(target.address, stablecoinSymbol);
    if (!horizonAsset) {
      // A bare issuer needs the tracked asset code to form Horizon's filter.
      providerChecks.push(makeDexDeploymentProviderCheck(target, "horizon", "failure"));
      continue;
    }

    await paceHorizonRequest(input.context.signal);
    if (input.context.timeExceeded()) return { providerChecks, stoppedEarly: true };
    const url = new URL("/liquidity_pools", STELLAR_HORIZON_API);
    url.searchParams.set("reserves", horizonAsset);
    url.searchParams.set("limit", String(HORIZON_PAGE_LIMIT));

    try {
      const result = await fetchJsonWithRetry<unknown>(
        url.toString(),
        {
          headers: { "User-Agent": USER_AGENT },
          signal: buildStageSignal(
            input.context.signal,
            input.context.deadlineMs,
            DISCOVERY_STAGE_TIMEOUT_MS.horizon,
          ),
        },
        1,
        {
          logUrl: CIRCUIT_SOURCE.HORIZON_DISCOVERY,
          maxResponseBytes: HORIZON_MAX_RESPONSE_BYTES,
          timeoutMs: DISCOVERY_STAGE_TIMEOUT_MS.horizon,
        },
      );
      const body = result?.body;
      const records =
        typeof body === "object" && body !== null &&
        typeof (body as Record<string, unknown>)._embedded === "object" &&
        (body as Record<string, unknown>)._embedded !== null
          ? ((body as { _embedded: Record<string, unknown> })._embedded.records)
          : null;
      if (!Array.isArray(records)) {
        providerChecks.push(makeDexDeploymentProviderCheck(target, "horizon", "failure"));
        continue;
      }
      const pools = records.map((record) => parseHorizonPool(record, horizonAsset));
      if (pools.some((pool) => pool == null)) {
        providerChecks.push(makeDexDeploymentProviderCheck(target, "horizon", "failure"));
        continue;
      }

      for (const pool of pools as HorizonLiquidityPool[]) {
        const poolId = canonicalExitRouteScopedKey(target.chain, pool.id);
        if (input.context.hasKnownPool(poolId)) continue;
        const trackedIndex = pool.reserves.findIndex((reserve) => reserve.asset === horizonAsset);
        const tokenIds = pool.reserves.map((reserve) =>
          reserve.asset === horizonAsset ? target.address : toRepoStellarAsset(reserve.asset),
        );
        if (tokenIds.some((tokenId) => tokenId == null)) continue;
        const priced = priceHorizonPool(pool, horizonAsset, input.context);
        const pairedReserve = pool.reserves[trackedIndex === 0 ? 1 : 0];
        const pairedSymbol = pairedReserve.asset === "native" ? "XLM" : pairedReserve.asset.split(":", 1)[0]!;
        input.context.addPool(
          toStagedPool(input.context, {
            poolId,
            source: "horizon",
            chain: target.chain,
            protocol: "stellar-sdex",
            dexId: "stellar-sdex",
            symbol: `${horizonAsset.split(":", 1)[0]} / ${pairedSymbol}`,
            tvlUsd: priced.tvlUsd,
            volume24h: null,
            qualityMultiplier: null,
            poolType: "stellar-constant-product",
            feeTier: pool.feeBp,
            balanceRatio: null,
            isStable: null,
            baseToken: tokenIds[0]!,
            quoteToken: tokenIds[1]!,
            quoteSymbol: pairedSymbol,
            priceUsd: priced.priceUsd,
            lockedLiqPct: null,
            rawJson: JSON.stringify(pool),
          }),
        );
      }
      providerChecks.push(makeDexDeploymentProviderCheck(target, "horizon", "success", {
        observedPoolCount: pools.length,
      }));
    } catch (err) {
      if (input.context.signal?.aborted) throw err;
      providerChecks.push(makeDexDeploymentProviderCheck(target, "horizon", "failure"));
    }
  }

  return { providerChecks };
}
