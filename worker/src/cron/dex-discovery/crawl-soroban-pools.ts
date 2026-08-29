import { canonicalExitRouteScopedKey } from "@shared/lib/exit-route-identity";
import { isAquariusSorobanDeployment } from "@shared/lib/dex-deployment-coverage";
import type { ContractDeployment } from "@shared/types/core";
import { USER_AGENT } from "../../lib/constants";
import { fetchJsonWithRetry } from "../../lib/fetch-retry";
import {
  buildStageSignal,
  toStagedPool,
  type CrawlStageContext,
} from "./staged-pool";
import {
  STAGED_POOL_MAX_TVL_USD,
  type DexDeploymentProviderCheck,
} from "./types";

/** Public, unauthenticated Aquarius ticker index documented at
 * https://docs.aqua.network/developers/reference/backend-api. */
export const AQUARIUS_TICKERS_URL = "https://amm-api.aqua.network/api/tickers/";
const AQUARIUS_REQUEST_TIMEOUT_MS = 8_000;
const AQUARIUS_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const SOROBAN_CONTRACT_ID_RE = /^C[A-Z2-7]{55}$/;
// eslint-disable-next-line security/detect-unsafe-regex -- anchored bounded optional code prefix plus fixed-width base32 contract id; linear, no backtracking ambiguity.
const SOROBAN_IDENTITY_RE = /^(?:[A-Z0-9]{1,12}-)?(C[A-Z2-7]{55})$/;

/** A census row is not an exact-execution authorization for any AMM invariant. */
const SOROBAN_UNREVIEWED_POOL_TYPE = "soroban-amm-unclassified";

// Aquarius is the only currently usable public Soroban pool index here.
// Soroswap/Phoenix indexes remain unregistered (the public Soroswap
// https://api.soroswap.finance/pools endpoint returns 403 without a bearer
// key), so an Aquarius empty census is scoped to Aquarius.
const AQUARIUS_PROVIDER = "aquarius";
const AQUARIUS_SOURCE = "aquarius";

interface AquariusTicker {
  poolId: string;
  baseCurrency: string;
  targetCurrency: string;
  lastPrice: number | null;
  baseVolume: number | null;
  targetVolume: number | null;
  liquidityInUsd: number;
  raw: Record<string, unknown>;
}

export interface SorobanPoolsStageResult {
  providerChecks: DexDeploymentProviderCheck[];
  stoppedEarly?: boolean;
}

/**
 * Return the raw Soroban contract id used by Soroban-aware indexes.
 *
 * Registry deployments may be represented as either `C...` or
 * `CODE-C...`. The code prefix is a Pharos display/deployment identity, not
 * part of the on-chain contract address and must never be sent to a classic
 * Stellar/Horizon asset query.
 */
export function canonicalSorobanTokenId(address: string): string | null {
  const normalized = address.trim().toUpperCase();
  const match = SOROBAN_IDENTITY_RE.exec(normalized);
  return match?.[1] ?? null;
}

/** The shared registry owns the eight-token Aquarius scope; keep the re-export for stage callers. */
export { isAquariusSorobanDeployment };

function parseFiniteNonNegative(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}
function parseSorobanAsset(value: unknown): string | null {
  if (value === "native") return value;
  if (typeof value !== "string") return null;
  return canonicalSorobanTokenId(value);
}

function parseAquariusTicker(value: unknown): AquariusTicker | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const poolId = typeof row.pool_id === "string" ? row.pool_id.trim().toUpperCase() : null;
  const baseCurrency = parseSorobanAsset(row.base_currency);
  const targetCurrency = parseSorobanAsset(row.target_currency);
  const liquidityInUsd = parseFiniteNonNegative(row.liquidity_in_usd);
  if (
    !poolId ||
    !SOROBAN_CONTRACT_ID_RE.test(poolId) ||
    !baseCurrency ||
    !targetCurrency ||
    baseCurrency === targetCurrency ||
    liquidityInUsd == null ||
    liquidityInUsd > STAGED_POOL_MAX_TVL_USD
  ) {
    return null;
  }

  const lastPrice = row.last_price == null ? null : parseFiniteNonNegative(row.last_price);
  const baseVolume = row.base_volume == null ? null : parseFiniteNonNegative(row.base_volume);
  const targetVolume = row.target_volume == null ? null : parseFiniteNonNegative(row.target_volume);
  if ((row.last_price != null && lastPrice == null) || (row.base_volume != null && baseVolume == null) || (row.target_volume != null && targetVolume == null)) {
    return null;
  }

  return {
    poolId,
    baseCurrency,
    targetCurrency,
    lastPrice,
    baseVolume,
    targetVolume,
    liquidityInUsd,
    raw: row,
  };
}

function parseAquariusTickers(value: unknown): AquariusTicker[] | null {
  if (!Array.isArray(value)) return null;
  const seenPoolIds = new Set<string>();
  const tickers: AquariusTicker[] = [];
  for (const row of value) {
    const ticker = parseAquariusTicker(row);
    if (!ticker || seenPoolIds.has(ticker.poolId)) return null;
    seenPoolIds.add(ticker.poolId);
    tickers.push(ticker);
  }
  return tickers;
}

function checkForTarget(
  target: ContractDeployment,
  status: DexDeploymentProviderCheck["status"],
  extras?: Pick<DexDeploymentProviderCheck, "observedPoolCount" | "retryable">,
): DexDeploymentProviderCheck {
  return {
    chain: target.chain,
    address: target.address,
    provider: AQUARIUS_PROVIDER,
    status,
    ...extras,
  };
}

function isTickerForToken(ticker: AquariusTicker, tokenId: string): boolean {
  return (
    canonicalSorobanTokenId(ticker.baseCurrency) === tokenId ||
    canonicalSorobanTokenId(ticker.targetCurrency) === tokenId
  );
}

function addTickerPool(
  context: CrawlStageContext,
  target: ContractDeployment,
  tokenId: string,
  ticker: AquariusTicker,
): void {
  const poolId = canonicalExitRouteScopedKey(target.chain, ticker.poolId);
  if (context.hasKnownPool(poolId)) return;

  const baseToken = canonicalSorobanTokenId(ticker.baseCurrency) === tokenId ? target.address : ticker.baseCurrency;
  const quoteToken = canonicalSorobanTokenId(ticker.targetCurrency) === tokenId ? target.address : ticker.targetCurrency;
  context.addPool(
    toStagedPool(context, {
      poolId,
      source: AQUARIUS_SOURCE,
      chain: target.chain,
      protocol: "aquarius",
      dexId: "aquarius",
      symbol: `${ticker.baseCurrency} / ${ticker.targetCurrency}`,
      tvlUsd: ticker.liquidityInUsd,
      // Aquarius exposes token-unit ticker volumes, not USD volume. Do not
      // relabel those values as a 24-hour USD observation.
      volume24h: null,
      // The ticker's last_price is base/target, not a USD price. Keep it out
      // of the price-observation lane until a reviewed valuation is available.
      priceUsd: null,
      qualityMultiplier: null,
      poolType: SOROBAN_UNREVIEWED_POOL_TYPE,
      feeTier: null,
      balanceRatio: null,
      isStable: null,
      baseToken,
      quoteToken,
      quoteSymbol: null,
      lockedLiqPct: null,
      rawJson: JSON.stringify(ticker.raw),
    }),
  );
}

export async function crawlSorobanPoolsStage(input: {
  coinTargets: ContractDeployment[];
  context: CrawlStageContext;
}): Promise<SorobanPoolsStageResult> {
  const targets = input.coinTargets.filter((target) => isAquariusSorobanDeployment(target.chain, target.address));
  if (targets.length === 0) return { providerChecks: [] };
  if (input.context.timeExceeded()) return { providerChecks: [], stoppedEarly: true };

  try {
    // The Aquarius ticker endpoint is one bounded, unpaginated fetch. It is
    // shared across this coin's Soroban deployments and filtered locally by
    // canonical contract id, so no per-pool follow-up requests are needed.
    const result = await fetchJsonWithRetry<unknown>(
      AQUARIUS_TICKERS_URL,
      {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal: buildStageSignal(input.context.signal, input.context.deadlineMs, AQUARIUS_REQUEST_TIMEOUT_MS),
      },
      0,
      {
        timeoutMs: AQUARIUS_REQUEST_TIMEOUT_MS,
        maxResponseBytes: AQUARIUS_MAX_RESPONSE_BYTES,
      },
    );

    if (!result) {
      return {
        providerChecks: targets.map((target) => checkForTarget(target, "failure", { retryable: true })),
      };
    }

    const tickers = parseAquariusTickers(result.body);
    if (!tickers) {
      return {
        providerChecks: targets.map((target) => checkForTarget(target, "degraded")),
      };
    }

    const providerChecks: DexDeploymentProviderCheck[] = [];
    for (const target of targets) {
      const tokenId = canonicalSorobanTokenId(target.address)!;
      const matchingTickers = tickers.filter((ticker) => isTickerForToken(ticker, tokenId));
      for (const ticker of matchingTickers) addTickerPool(input.context, target, tokenId, ticker);
      providerChecks.push(
        checkForTarget(target, "success", { observedPoolCount: matchingTickers.length }),
      );
    }
    return { providerChecks };
  } catch (error) {
    if (input.context.signal?.aborted) throw error;
    return {
      providerChecks: targets.map((target) => checkForTarget(target, "failure", { retryable: true })),
    };
  }
}
