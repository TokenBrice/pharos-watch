import {
  getHorizonDiscoveryAsset,
  isHorizonDiscoveryDeployment,
} from "@shared/lib/dex-deployment-coverage";
import { canonicalExitRouteScopedKey } from "@shared/lib/exit-route-identity";
import { WORKER_ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/worker-runtime-registry";
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
/** Bounded cursor budget per deployment; requests stay sequential. */
const HORIZON_MAX_PAGES = 3;

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
for (const coin of WORKER_ACTIVE_STABLECOINS) {
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

function horizonNextPageUrl(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("_links" in body)) return null;
  const links = body._links;
  if (typeof links !== "object" || links === null || !("next" in links)) return null;
  const next = links.next;
  if (typeof next !== "object" || next === null || !("href" in next)) return null;
  const href = next.href;
  if (typeof href !== "string" || href === "") return null;
  try {
    const resolved = new URL(href, STELLAR_HORIZON_API);
    return resolved.origin === new URL(STELLAR_HORIZON_API).origin ? resolved.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Follows `_links.next.href` until a page shorter than the requested limit is
 * read — the only positive end-of-inventory evidence Horizon gives. A cursor
 * loop stopped by the page or time budget reports `degraded` with
 * `paginationComplete: false`, never a completed query. One request is in
 * flight at a time.
 */
async function crawlHorizonAssetPages(
  target: ContractDeployment,
  horizonAsset: string,
  context: CrawlStageContext,
): Promise<DexDeploymentProviderCheck> {
  const url = new URL("/liquidity_pools", STELLAR_HORIZON_API);
  url.searchParams.set("reserves", horizonAsset);
  url.searchParams.set("limit", String(HORIZON_PAGE_LIMIT));

  let nextUrl: string | null = url.toString();
  let observedPoolCount = 0;
  let pagesRead = 0;
  let paginationComplete = false;

  try {
    while (nextUrl) {
      const requestUrl: string = nextUrl;
      const result = await fetchJsonWithRetry<unknown>(
        requestUrl,
        {
          headers: { "User-Agent": USER_AGENT },
          signal: buildStageSignal(
            context.signal,
            context.deadlineMs,
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
        return makeDexDeploymentProviderCheck(target, "horizon", "failure", { retryable: true });
      }
      const pools = records.map((record) => parseHorizonPool(record, horizonAsset));
      if (pools.some((pool) => pool == null)) {
        return makeDexDeploymentProviderCheck(target, "horizon", "failure", { retryable: true });
      }

      for (const pool of pools as HorizonLiquidityPool[]) {
        const poolId = canonicalExitRouteScopedKey(target.chain, pool.id);
        if (context.hasKnownPool(poolId)) continue;
        const trackedIndex = pool.reserves.findIndex((reserve) => reserve.asset === horizonAsset);
        const tokenIds = pool.reserves.map((reserve) =>
          reserve.asset === horizonAsset ? target.address : toRepoStellarAsset(reserve.asset),
        );
        if (tokenIds.some((tokenId) => tokenId == null)) continue;
        const priced = priceHorizonPool(pool, horizonAsset, context);
        const pairedReserve = pool.reserves[trackedIndex === 0 ? 1 : 0];
        const pairedSymbol = pairedReserve.asset === "native" ? "XLM" : pairedReserve.asset.split(":", 1)[0]!;
        context.addPool(
          toStagedPool(context, {
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
      observedPoolCount += records.length;
      pagesRead++;

      if (records.length < HORIZON_PAGE_LIMIT) {
        paginationComplete = true;
        break;
      }
      nextUrl = pagesRead < HORIZON_MAX_PAGES ? horizonNextPageUrl(body) : null;
      if (nextUrl) {
        await paceHorizonRequest(context.signal);
        if (context.timeExceeded()) nextUrl = null;
      }
    }
  } catch (err) {
    if (context.signal?.aborted) throw err;
    return makeDexDeploymentProviderCheck(target, "horizon", "failure", { retryable: true });
  }

  return makeDexDeploymentProviderCheck(
    target,
    "horizon",
    paginationComplete ? "success" : "degraded",
    { observedPoolCount, paginationComplete },
  );
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
    const stablecoinSymbol = WORKER_ACTIVE_STABLECOINS.find((coin) => coin.id === input.context.stablecoinId)?.symbol;
    const horizonAsset = getHorizonDiscoveryAsset(target.address, stablecoinSymbol);
    if (!horizonAsset) {
      // A bare issuer needs the tracked asset code to form Horizon's filter;
      // an identity this run could not build is a deferral, not an outage.
      providerChecks.push(makeDexDeploymentProviderCheck(target, "horizon", "failure", { retryable: true }));
      continue;
    }

    await paceHorizonRequest(input.context.signal);
    if (input.context.timeExceeded()) return { providerChecks, stoppedEarly: true };
    providerChecks.push(await crawlHorizonAssetPages(target, horizonAsset, input.context));
  }

  return { providerChecks };
}
