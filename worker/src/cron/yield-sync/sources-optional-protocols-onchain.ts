import { DAY_SECONDS } from "@shared/lib/time-constants";
import { type ChainRpcConfig, getChainRpc } from "../../lib/chain-registry";
import { resolveRpcUrls } from "./sources-helpers";
import { cgHeaders, cgSimplePricePath, cgUrl } from "../../lib/coingecko";
import { USER_AGENT } from "../../lib/constants";
import { fetchEvmRpcBatch, fetchEvmUint256AtBlock } from "../../lib/evm-rpc";
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
const BASEDOLLAR_BD_ID = "bd-basedollar";
const LIQUITY_V2_BOLD_ID = "bold-liquity";
const LIQUITY_V2_SP_SOURCE_TYPE = "lending-vault";
const LIQUITY_V2_TOTAL_COLLATERALS_SELECTOR = "0x30504b6f";
const LIQUITY_V2_AGG_WEIGHTED_DEBT_SUM_SELECTOR = "0x42635a95";
const LIQUITY_V2_SHUTDOWN_TIME_SELECTOR = "0x58569081";
const LIQUITY_V2_TOTAL_BOLD_DEPOSITS_SELECTOR = "0xf71c6940";
const LIQUITY_V2_SP_YIELD_SPLIT_PERCENT = 75n;

export interface LiquityV2SpSourceConfig {
  stablecoinId: string;
  chain: string;
  /** Log-event prefix so each deployment keeps its own operator-visible events. */
  eventPrefix: string;
  sourceLabel: string;
  collateralRegistry: string;
  branches: readonly { activePool: string; stabilityPool: string }[];
}

export const BASEDOLLAR_SP_CONFIG: LiquityV2SpSourceConfig = {
  stablecoinId: BASEDOLLAR_BD_ID,
  chain: "base",
  eventPrefix: "basedollar",
  sourceLabel: "Base Dollar Stability Pools (interest-only)",
  collateralRegistry: "0x7551ebfc8340b7f91874942be9c653733d4fb04f",
  branches: [
    {
      activePool: "0x254a8267d4e12a8c0f283274632a18a33e49f7c0",
      stabilityPool: "0x7d837bf114785642d225d1101145ddb8af4ba438",
    },
    {
      activePool: "0x1021fefc406c9573ab3579fc55be13e3300ef6b1",
      stabilityPool: "0xc65a05737d31e0f42c0806c739f3c88dd009c05f",
    },
    {
      activePool: "0x1b9a62798e8bae0cea4eb21b4b3775359beb819f",
      stabilityPool: "0x4eb3b6970fd358d34195b5d40e4eb64e0e3c0b6a",
    },
    {
      activePool: "0xcaa72df531554087318eaf24646958500668b230",
      stabilityPool: "0x6bd55dd953507641c84a03956760f83d29d65726",
    },
    {
      activePool: "0xddac84ab417677f553cced8ababf497226112218",
      stabilityPool: "0x25afbb09d9804482ed8e24295be4a12704fe93ea",
    },
  ],
};

// Liquity V2 mainnet: the three immutable collateral branches (wstETH, WETH,
// rETH). ActivePool/StabilityPool addresses mirror the reviewed branch table in
// shared/data/stablecoins/coins/bold-liquity.json.
export const LIQUITY_V2_SP_CONFIG: LiquityV2SpSourceConfig = {
  stablecoinId: LIQUITY_V2_BOLD_ID,
  chain: "ethereum",
  eventPrefix: "liquity-v2",
  sourceLabel: "Liquity V2 Stability Pools (interest-only)",
  collateralRegistry: "0xf949982b91c8c61e952b3ba942cbbfaef5386684",
  branches: [
    {
      activePool: "0x531a8f99c70d6a56a7cee02d6b4281650d7919a0",
      stabilityPool: "0x9502b7c397e9aa22fe9db7ef7daf21cd2aebe56b",
    },
    {
      activePool: "0xeb5a8c825582965f1d84606e078620a84ab16afe",
      stabilityPool: "0x5721cbbd64fc7ae3ef44a0a3f9a790a9264cf9bf",
    },
    {
      activePool: "0x9074d72cc82dad1e13e454755aa8f144c479532f",
      stabilityPool: "0xd442e41019b7f5c4dd78f50dc03726c446148695",
    },
  ],
};

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

export async function fetchLiquityV2StabilityPoolSource(
  config: LiquityV2SpSourceConfig,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<ResolvedYield | null> {
  if (!chainRpcs) {
    logWorkerEvent({
      scope: "lib",
      job: "sync-yield-data",
      level: "warn",
      event: `${config.eventPrefix}-rpcs-missing`,
      message: `No chain RPCs provided for ${config.sourceLabel}`,
    });
    return null;
  }
  const rpc = getChainRpc(chainRpcs, config.chain);
  if (!rpc) {
    logWorkerEvent({
      scope: "lib",
      job: "sync-yield-data",
      level: "warn",
      event: `${config.eventPrefix}-${config.chain}-rpc-missing`,
      message: `No ${config.chain} RPC configured for ${config.sourceLabel}`,
    });
    return null;
  }

  try {
    // One JSON-RPC batch keeps every read on a single provider snapshot: the
    // registry branch count plus the three per-branch reads. The count guard
    // fails closed if the collateral governor registers a branch this adapter
    // does not yet aggregate, so a partial sum can never publish as a
    // "complete" APR.
    const calls = [
      {
        method: "eth_call",
        params: [{ to: config.collateralRegistry, data: LIQUITY_V2_TOTAL_COLLATERALS_SELECTOR }, "latest"],
      },
      ...config.branches.flatMap((branch) => [
        { method: "eth_call", params: [{ to: branch.activePool, data: LIQUITY_V2_AGG_WEIGHTED_DEBT_SUM_SELECTOR }, "latest"] },
        { method: "eth_call", params: [{ to: branch.activePool, data: LIQUITY_V2_SHUTDOWN_TIME_SELECTOR }, "latest"] },
        { method: "eth_call", params: [{ to: branch.stabilityPool, data: LIQUITY_V2_TOTAL_BOLD_DEPOSITS_SELECTOR }, "latest"] },
      ]),
    ];

    throwIfAborted(signal);
    const results = await fetchEvmRpcBatch(config.chain, calls, { chainRpcs, signal });
    if (results === null) return null;

    const values: bigint[] = [];
    for (const result of results) {
      if (typeof result !== "string" || !/^0x[0-9a-fA-F]+$/.test(result)) return null;
      values.push(BigInt(result));
    }

    const totalCollaterals = values[0]!;
    if (totalCollaterals !== BigInt(config.branches.length)) {
      logWorkerEvent({
        scope: "lib",
        job: "sync-yield-data",
        level: "warn",
        event: `${config.eventPrefix}-branch-count-mismatch`,
        message:
          `${config.sourceLabel}: CollateralRegistry reports ${totalCollaterals} branches but the adapter `
          + `aggregates ${config.branches.length}; failing closed until the branch table is re-reviewed`,
      });
      return null;
    }

    let totalAggWeightedDebtSumRaw = 0n;
    let totalDepositsRaw = 0n;
    for (let index = 0; index < config.branches.length; index += 1) {
      const aggWeightedDebtSumRaw = values[1 + index * 3]!;
      const shutdownTimeRaw = values[2 + index * 3]!;
      const depositsRaw = values[3 + index * 3]!;
      // A shut-down branch accrues no interest; its deposits stay in the denominator.
      if (shutdownTimeRaw === 0n) {
        totalAggWeightedDebtSumRaw += aggWeightedDebtSumRaw;
      }
      totalDepositsRaw += depositsRaw;
    }

    if (totalDepositsRaw <= 0n) return null;

    // APR% = 75 * sum(aggWeightedDebtSum) / (sum(SP deposits) * 1e18).
    // This is interest-only: upfront borrowing fees and liquidation collateral gains are excluded.
    const apr =
      Number(LIQUITY_V2_SP_YIELD_SPLIT_PERCENT * totalAggWeightedDebtSumRaw)
      / Number(totalDepositsRaw * 10n ** 18n);
    const totalDeposits = Number(totalDepositsRaw) / 1e18;
    if (!Number.isFinite(totalDeposits) || totalDeposits <= 0) return null;
    if (!Number.isFinite(apr) || apr <= 0) return null;

    return {
      currentApy: apr,
      apyBase: apr,
      apyReward: null,
      sourcePool: null,
      sourceTvlUsd: totalDeposits,
      dataSource: "onchain",
      exchangeRate: null,
      sourceKey: buildOnChainSourceKey(config.stablecoinId),
      yieldSource: config.sourceLabel,
      yieldType: LIQUITY_V2_SP_SOURCE_TYPE,
    };
  } catch (error) {
    if (signal?.aborted) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    logWorkerEvent({
      scope: "lib",
      job: "sync-yield-data",
      level: "warn",
      event: `${config.eventPrefix}-source-failed`,
      message: `${config.sourceLabel} source failed`,
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
