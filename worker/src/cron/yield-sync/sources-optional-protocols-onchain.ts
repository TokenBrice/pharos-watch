import { DAY_SECONDS } from "@shared/lib/time-constants";
import { type ChainRpcConfig, getChainRpc } from "../../lib/chain-registry";
import { resolveRpcUrls } from "./sources-helpers";
import { cgHeaders, cgSimplePricePath, cgUrl } from "../../lib/coingecko";
import { USER_AGENT } from "../../lib/constants";
import { fetchEvmUint256AtBlock } from "../../lib/evm-rpc";
import { fetchJsonWithRetry } from "../../lib/fetch-retry";
import { throwIfAborted } from "../../lib/abort";
import { logWorkerEvent } from "../../lib/structured-log";
import { buildOnChainSourceKey } from "../yield-helpers";
import type { ResolvedYield } from "./types";

const LIQUITY_V1_LUSD_ID = "lusd-liquity";
const BPROTOCOL_LQTY_ONLY_SOURCE_LABEL = "B.Protocol Stability Pool (LQTY only)";
const BPROTOCOL_LQTY_ONLY_SOURCE_TYPE = "lending-vault";
const LIQUITY_STABILITY_POOL_TOTAL_LQTY_REWARD = 32_000_000;
const LIQUITY_DAILY_LQTY_ISSUANCE_FACTOR = 1 - Math.pow(0.5, 1 / 365);
const LIQUITY_COMMUNITY_ISSUANCE = "0xD8c9D9071123a059C6E0A945cF0e0c82b508d816";
const LIQUITY_STABILITY_POOL = "0x66017D22b0f8556afDd19FC67041899Eb65a21bb";
const LIQUITY_TOTAL_LQTY_ISSUED_SELECTOR = "0xb140384b";
const LIQUITY_TOTAL_LUSD_DEPOSITS_SELECTOR = "0x9bf2f1ac";
const LIQUITY_LQTY_GECKO_ID = "liquity";
const SCRVUSD_VAULT = "0x0655977FEb2f289A4aB78af67BAB0d17aAb84367";
const SCRVUSD_CURRENT_RATE_SOURCE_KEY = "onchain:scrvusd-curve:scrvusd-current-rate";
const SCRVUSD_SOURCE_POOL = "5fd328af-4203-471b-bd16-1705c726d926";
const SCRVUSD_SOURCE_LABEL = "Curve Savings (scrvUSD)";
const SCRVUSD_SOURCE_TYPE = "governance-set";
const SCRVUSD_TOTAL_ASSETS_SELECTOR = "0x01e1d114";
const SCRVUSD_TOTAL_SUPPLY_SELECTOR = "0x18160ddd";
const SCRVUSD_PROFIT_UNLOCKING_RATE_SELECTOR = "0x5141eebb";
const SCRVUSD_FULL_PROFIT_UNLOCK_DATE_SELECTOR = "0x2d632692";
const YEARN_V3_MAX_BPS_EXTENDED = 1_000_000_000_000;
const SCRVUSD_DAYS_PER_YEAR = 365;
const SCRVUSD_SECONDS_PER_YEAR = SCRVUSD_DAYS_PER_YEAR * DAY_SECONDS;

async function fetchEthCallUint256(
  rpcUrl: string,
  chain: string,
  to: string,
  data: string,
  signal?: AbortSignal,
): Promise<bigint | null> {
  try {
    return await fetchEvmUint256AtBlock(chain, to, data, "latest", {
      extraRpcUrls: [rpcUrl],
      signal,
      timeoutMs: 10_000,
    });
  } catch (error) {
    logWorkerEvent({
      scope: "lib",
      job: "sync-yield-data",
      level: "warn",
      event: "eth-call-failed",
      message: "eth_call failed",
      metadata: { chain, to, data },
      error,
    });
    return null;
  }
}

async function fetchCoinGeckoUsdPrice(
  geckoId: string,
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
): Promise<number | null> {
  try {
    const result = await fetchJsonWithRetry<Record<string, { usd?: number }>>(
      cgUrl(cgSimplePricePath(`ids=${encodeURIComponent(geckoId)}&vs_currencies=usd`), coingeckoApiKey ?? null),
      {
        headers: cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT }, coingeckoApiKey ?? null),
        signal,
      },
      1,
    );
    if (!result?.response.ok) return null;

    const body = result.body;
    const price = body[geckoId]?.usd;
    return typeof price === "number" && price > 0 ? price : null;
  } catch (error) {
    logWorkerEvent({
      scope: "lib",
      job: "sync-yield-data",
      level: "warn",
      event: "coingecko-price-fetch-failed",
      message: "CoinGecko price fetch failed",
      provider: "coingecko",
      metadata: { geckoId },
      error,
    });
    return null;
  }
}

function compoundDailyAprToApy(aprPercent: number): number {
  const aprFraction = aprPercent / 100;
  return (Math.pow(1 + aprFraction / SCRVUSD_DAYS_PER_YEAR, SCRVUSD_DAYS_PER_YEAR) - 1) * 100;
}

export async function fetchBprotocolLqtyOnlySource(
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
  coingeckoApiKey?: string | null,
): Promise<ResolvedYield | null> {
  if (!chainRpcs) {
    logWorkerEvent({
      scope: "lib",
      job: "sync-yield-data",
      level: "warn",
      event: "bprotocol-rpcs-missing",
      message: "No chain RPCs provided for B.Protocol LQTY-only source",
    });
    return null;
  }
  const rpc = getChainRpc(chainRpcs, "ethereum");
  if (!rpc) {
    logWorkerEvent({
      scope: "lib",
      job: "sync-yield-data",
      level: "warn",
      event: "bprotocol-ethereum-rpc-missing",
      message: "No Ethereum RPC configured for B.Protocol LQTY-only source",
    });
    return null;
  }

  try {
    const lqtyPriceUsd = await fetchCoinGeckoUsdPrice(LIQUITY_LQTY_GECKO_ID, signal, coingeckoApiKey);
    if (lqtyPriceUsd == null) return null;

    let totalLusdDepositsRaw: bigint | null = null;
    let totalLqtyIssuedRaw: bigint | null = null;
    const rpcUrls = resolveRpcUrls(rpc, { order: "primary-first" });

    for (const rpcUrl of rpcUrls) {
      throwIfAborted(signal);
      const lusdDeposits = await fetchEthCallUint256(
        rpcUrl,
        "ethereum",
        LIQUITY_STABILITY_POOL,
        LIQUITY_TOTAL_LUSD_DEPOSITS_SELECTOR,
        signal,
      );
      const lqtyIssued = await fetchEthCallUint256(
        rpcUrl,
        "ethereum",
        LIQUITY_COMMUNITY_ISSUANCE,
        LIQUITY_TOTAL_LQTY_ISSUED_SELECTOR,
        signal,
      );
      if (lusdDeposits != null && lqtyIssued != null) {
        totalLusdDepositsRaw = lusdDeposits;
        totalLqtyIssuedRaw = lqtyIssued;
        break;
      }
    }

    if (totalLusdDepositsRaw == null || totalLqtyIssuedRaw == null) return null;

    const totalLusdDeposits = Number(totalLusdDepositsRaw) / 1e18;
    const totalLqtyIssued = Number(totalLqtyIssuedRaw) / 1e18;
    if (!Number.isFinite(totalLusdDeposits) || totalLusdDeposits <= 0) return null;
    if (!Number.isFinite(totalLqtyIssued) || totalLqtyIssued < 0) return null;

    const remainingLqtyRewards = Math.max(
      0,
      LIQUITY_STABILITY_POOL_TOTAL_LQTY_REWARD - totalLqtyIssued,
    );
    if (remainingLqtyRewards <= 0) return null;

    const apr =
      (remainingLqtyRewards * LIQUITY_DAILY_LQTY_ISSUANCE_FACTOR * lqtyPriceUsd * 365 * 100)
      / totalLusdDeposits;
    if (!Number.isFinite(apr) || apr <= 0) return null;

    return {
      currentApy: apr,
      apyBase: null,
      apyReward: apr,
      sourcePool: null,
      sourceTvlUsd: totalLusdDeposits,
      dataSource: "onchain",
      exchangeRate: null,
      sourceKey: buildOnChainSourceKey(LIQUITY_V1_LUSD_ID),
      yieldSource: BPROTOCOL_LQTY_ONLY_SOURCE_LABEL,
      yieldType: BPROTOCOL_LQTY_ONLY_SOURCE_TYPE,
    };
  } catch (error) {
    if (signal?.aborted) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    logWorkerEvent({
      scope: "lib",
      job: "sync-yield-data",
      level: "warn",
      event: "bprotocol-source-failed",
      message: "B.Protocol LQTY-only source failed",
      error,
    });
    return null;
  }
}

export async function fetchCurveScrvusdCurrentRateSource(
  startSec: number,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<ResolvedYield | null> {
  if (!chainRpcs) {
    logWorkerEvent({
      scope: "lib",
      job: "sync-yield-data",
      level: "warn",
      event: "scrvusd-rpcs-missing",
      message: "No chain RPCs provided for Curve scrvUSD current-rate source",
    });
    return null;
  }
  const rpc = getChainRpc(chainRpcs, "ethereum");
  if (!rpc) {
    logWorkerEvent({
      scope: "lib",
      job: "sync-yield-data",
      level: "warn",
      event: "scrvusd-ethereum-rpc-missing",
      message: "No Ethereum RPC configured for Curve scrvUSD current-rate source",
    });
    return null;
  }

  try {
    const rpcUrls = resolveRpcUrls(rpc, { order: "primary-first" });

    for (const rpcUrl of rpcUrls) {
      throwIfAborted(signal);
      const totalAssetsRaw = await fetchEthCallUint256(
        rpcUrl,
        "ethereum",
        SCRVUSD_VAULT,
        SCRVUSD_TOTAL_ASSETS_SELECTOR,
        signal,
      );
      const totalSupplyRaw = await fetchEthCallUint256(
        rpcUrl,
        "ethereum",
        SCRVUSD_VAULT,
        SCRVUSD_TOTAL_SUPPLY_SELECTOR,
        signal,
      );
      const profitUnlockingRateRaw = await fetchEthCallUint256(
        rpcUrl,
        "ethereum",
        SCRVUSD_VAULT,
        SCRVUSD_PROFIT_UNLOCKING_RATE_SELECTOR,
        signal,
      );
      const fullProfitUnlockDateRaw = await fetchEthCallUint256(
        rpcUrl,
        "ethereum",
        SCRVUSD_VAULT,
        SCRVUSD_FULL_PROFIT_UNLOCK_DATE_SELECTOR,
        signal,
      );

      if (
        totalAssetsRaw == null ||
        totalSupplyRaw == null ||
        profitUnlockingRateRaw == null ||
        fullProfitUnlockDateRaw == null
      ) {
        continue;
      }

      const sourceTvlUsd = Number(totalAssetsRaw) / 1e18;
      const totalSupply = Number(totalSupplyRaw) / 1e18;
      if (!Number.isFinite(sourceTvlUsd) || sourceTvlUsd <= 0) return null;
      if (!Number.isFinite(totalSupply) || totalSupply <= 0) return null;

      const fullProfitUnlockDate = Number(fullProfitUnlockDateRaw);
      const profitUnlockingSharesPerSecond =
        Number(profitUnlockingRateRaw) / YEARN_V3_MAX_BPS_EXTENDED / 1e18;
      const currentApy =
        fullProfitUnlockDate > startSec && profitUnlockingSharesPerSecond > 0
          ? compoundDailyAprToApy(
            (profitUnlockingSharesPerSecond * SCRVUSD_SECONDS_PER_YEAR * 100) / totalSupply,
          )
          : 0;
      if (!Number.isFinite(currentApy) || currentApy < 0) return null;

      return {
        currentApy,
        apyBase: currentApy,
        apyReward: null,
        sourcePool: SCRVUSD_SOURCE_POOL,
        sourceTvlUsd,
        dataSource: "onchain",
        exchangeRate: null,
        sourceKey: SCRVUSD_CURRENT_RATE_SOURCE_KEY,
        sourceObservedAt: startSec,
        comparisonAnchorObservedAt: null,
        yieldSource: SCRVUSD_SOURCE_LABEL,
        yieldType: SCRVUSD_SOURCE_TYPE,
      };
    }

    return null;
  } catch (error) {
    if (signal?.aborted) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    logWorkerEvent({
      scope: "lib",
      job: "sync-yield-data",
      level: "warn",
      event: "scrvusd-source-failed",
      message: "Curve scrvUSD current-rate source failed",
      error,
    });
    return null;
  }
}
