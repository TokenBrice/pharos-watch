import {
  DAY_SECONDS,
} from "@shared/lib/time-constants";
import {
  type ChainRpcConfig,
  getChainRpc,
  hasRegistryRpc,
  registryRpcUrls,
} from "../../lib/chain-registry";
import {
  resolveRpcUrls,
  OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS,
  getFiniteNumber,
  runTimedOptionalSource,
  createOptionalSourceBudget,
  OPTIONAL_PROTOCOL_API_BUDGET_MS,
} from "./sources-rpc";
import {
  cgHeaders,
  cgSimplePricePath,
  cgUrl,
} from "../../lib/coingecko";
import {
  USER_AGENT,
} from "../../lib/constants";
import {
  fetchEvmRpcBatch,
  fetchEvmUint256AtBlock,
  fetchEvmCallHexAtBlock,
} from "../../lib/evm-rpc";
import {
  fetchJsonWithRetry,
  DEFAULT_FETCH_RETRY_MAX_RESPONSE_BYTES,
  fetchWithRetry,
} from "../../lib/fetch-retry";
import {
  throwIfAborted,
} from "../../lib/abort";
import {
  logWorkerEvent,
} from "../../lib/structured-log";
import {
  buildOnChainSourceKey,
} from "../../lib/yield-utils";
import type {
  ResolvedYield,
  ResolvedYieldCandidate,
} from "./types";
import {
  finiteDecimalNumberFromBigInt,
} from "../../lib/bigint";
import {
  isDeterministicApyWithinSanityBounds,
} from "../yield-helpers";
import {
  parseChainlinkLatestRoundData,
} from "../../lib/chainlink-round-data";
import {
  DECIMALS_SELECTOR,
  LATEST_ROUND_DATA_SELECTOR,
} from "../../lib/evm-selectors";
import {
  fetchZephyrZysSource,
} from "../../lib/yield-source-adapters/zephyr";
import {
  CHAIN_META,
  normalizeChainId,
} from "@shared/types/chain-identity";
import {
  parseRetryAfterSeconds,
} from "@shared/lib/retry-after";
import {
  ACTIVE_STABLECOINS,
} from "@shared/lib/stablecoins/registry";
import {
  isRecord,
  numberValue as finiteNumber,
} from "@shared/lib/type-guards";
import {
  cancelResponseBodyQuietly,
  readResponseJsonWithinLimitWithSignal,
} from "../../lib/response-body";
import {
  buildChainAddressKey,
  normalizeTokenAddress,
} from "../dex-liquidity/token-resolution";
import {
  PENDLE_SUPPLEMENTAL_FETCH_CADENCE_SEC,
  SUPPLEMENTAL_SOURCE_STALE_THRESHOLD_MS,
} from "../../lib/yield-ranking-helpers";
import {
  getCronJobMeta,
} from "@shared/lib/cron-jobs";
import type {
  StablecoinMeta,
} from "@shared/types/core";
import type {
  YieldMarketStatus,
  YieldSourceRisk,
  YieldTrancheSide,
} from "@shared/types/yield";
import {
  YIELD_VARIANT_MAP,
} from "../../lib/yield-config/yield-config-variants";

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
  startSec: number,
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
  if (!hasRegistryRpc(rpc)) {
    logWorkerEvent({
      scope: "lib",
      job: "sync-yield-data",
      level: "warn",
      event: "bprotocol-ethereum-rpc-missing",
      message: "No Ethereum RPC configured for B.Protocol LQTY-only source",
    });
    return null;
  }

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
    // B11 — without an observation timestamp the row classifies
    // `source-freshness-unknown`, is rejected, and the coin can never score.
    sourceObservedAt: startSec,
    comparisonAnchorObservedAt: null,
  };
}

export async function fetchLiquityV2StabilityPoolSource(
  startSec: number,
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
  if (!hasRegistryRpc(rpc)) {
    logWorkerEvent({
      scope: "lib",
      job: "sync-yield-data",
      level: "warn",
      event: `${config.eventPrefix}-${config.chain}-rpc-missing`,
      message: `No ${config.chain} RPC configured for ${config.sourceLabel}`,
    });
    return null;
  }

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
    // B11 — see fetchBprotocolLqtyOnlySource: the missing stamp made
    // lusd-liquity, bold-liquity and bd-basedollar permanently unscored.
    sourceObservedAt: startSec,
    comparisonAnchorObservedAt: null,
  };
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
  if (!hasRegistryRpc(rpc)) {
    logWorkerEvent({
      scope: "lib",
      job: "sync-yield-data",
      level: "warn",
      event: "scrvusd-ethereum-rpc-missing",
      message: "No Ethereum RPC configured for Curve scrvUSD current-rate source",
    });
    return null;
  }

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
}

interface HashnoteReport {
  roundId: string;
  price: string;
  timestamp: string;
}


interface RePriceObservation {
  apy?: number;
  date?: string;
  price?: number;
}

interface RePriceResponse {
  success?: boolean;
  data?: {
    reUSD?: RePriceObservation[];
  };
}

interface YdaemonVault {
  address?: string;
  /** ydaemon exposes the vault's underlying deposit token as `token`. */
  token?: { address?: string };
  tvl?: { tvl?: number };
  apr?: { netAPR?: number };
  info?: { isRetired?: boolean };
}

const HASHNOTE_USYC_SOURCE_KEY = "protocol-api:hashnote-usyc";
const HASHNOTE_USYC_SOURCE_LABEL = "Hashnote USYC";
const HASHNOTE_USYC_SOURCE_TYPE = "nav-appreciation";
const HASHNOTE_PRICE_REPORTS_URL = "https://usyc.hashnote.com/api/price-reports";
const HASHNOTE_TARGET_LOOKBACK_SEC = 7 * DAY_SECONDS;
const HASHNOTE_MIN_LOOKBACK_SEC = 5 * DAY_SECONDS;
const HASHNOTE_MAX_FRESHNESS_SEC = 3 * DAY_SECONDS;
const HASHNOTE_MAX_FUTURE_SKEW_SEC = 5 * 60;
const ONDO_USDY_SOURCE_KEY = "protocol-api:ondo-usdy-oracle";
const ONDO_USDY_SOURCE_LABEL = "Ondo USDY Oracle";
const ONDO_USDY_SOURCE_TYPE = "nav-appreciation";
const ONDO_USDY_ORACLE = "0xa0219aa5b31e65bc920b5b6dfb8edf0988121de0";
const ONDO_GET_PRICE_SELECTOR = "0x98d5fdca";
const RE_REUSD_SOURCE_KEY = "protocol-api:re-protocol-reusd";
const RE_REUSD_SOURCE_LABEL = "Re Protocol Basis-Plus (reUSD)";
const RE_REUSD_SOURCE_TYPE = "nav-appreciation";
const RE_REUSD_PRICE_URL = "https://api.re.xyz/price";
const RE_REUSD_CONTRACT = "0x5086bf358635B81D8C47C66d1C8b9E567Db70c72";
const RE_REUSD_MAX_FRESHNESS_SEC = 3 * DAY_SECONDS;
const RE_REUSD_MIN_APY_PERCENT = -100;
const RE_REUSD_MAX_APY_PERCENT = 500;
const YEARN_YBOLD_SOURCE_KEY = "protocol-api:yearn:ybold";
const YEARN_YBOLD_SOURCE_LABEL = "Yearn yBOLD Stability Pool vault";
const YEARN_YBOLD_SOURCE_TYPE = "lending-vault";
const YEARN_YBOLD_VAULT = "0x9f4330700a36b29952869fac9b33f45eedd8a3d8";
const YEARN_YSYBOLD_VAULT = "0x23346b04a7f55b8760e5860aa5a77383d63491cd";
const LIQUITY_BOLD_TOKEN = "0x6440f144b7e50d6a8439336510312d2f54beb01d";
const YDAEMON_ETHEREUM_VAULT_URL = "https://ydaemon.yearn.fi/1/vaults/";
const YEARN_YBOLD_MIN_TVL_USD = 100_000;
const YEARN_YBOLD_MAX_APY_PERCENT = 100;

/**
 * Yearn's first-party yBOLD numbers, read from ydaemon.
 *
 * yBOLD itself holds a flat 1.0 price-per-share: Yearn routes the Liquity V2
 * Stability Pool return to holders who stake yBOLD into `ysyBOLD`, so the
 * advertised yBOLD yield is the staked vault's net APR. TVL stays the yBOLD
 * vault's own TVL. The adapter fails closed unless yBOLD still wraps BOLD and
 * ysyBOLD still wraps the tracked yBOLD vault, so a Yearn restructure cannot
 * silently publish an unrelated vault's return under yBOLD.
 */
export async function fetchYearnYboldSource(signal?: AbortSignal): Promise<ResolvedYield | null> {
  const yboldResult = await fetchJsonWithRetry<YdaemonVault>(
    `${YDAEMON_ETHEREUM_VAULT_URL}${YEARN_YBOLD_VAULT}`,
    { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal },
    0,
    { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS },
  );
  if (!yboldResult?.response.ok) return null;
  if (yboldResult.body.info?.isRetired) return null;
  if (yboldResult.body.token?.address?.toLowerCase() !== LIQUITY_BOLD_TOKEN) return null;

  const sourceTvlUsd = getFiniteNumber(yboldResult.body.tvl?.tvl);
  if (sourceTvlUsd == null || sourceTvlUsd < YEARN_YBOLD_MIN_TVL_USD) return null;

  const stakedResult = await fetchJsonWithRetry<YdaemonVault>(
    `${YDAEMON_ETHEREUM_VAULT_URL}${YEARN_YSYBOLD_VAULT}`,
    { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal },
    0,
    { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS },
  );
  if (!stakedResult?.response.ok) return null;
  if (stakedResult.body.info?.isRetired) return null;
  if (stakedResult.body.token?.address?.toLowerCase() !== YEARN_YBOLD_VAULT) return null;

  const netApr = getFiniteNumber(stakedResult.body.apr?.netAPR);
  if (netApr == null) return null;

  const apy = netApr * 100;
  if (apy <= 0 || apy > YEARN_YBOLD_MAX_APY_PERCENT) return null;

  return {
    currentApy: apy,
    apyBase: apy,
    apyReward: null,
    sourcePool: YEARN_YBOLD_VAULT,
    sourceTvlUsd,
    dataSource: "protocol-api",
    exchangeRate: null,
    sourceKey: YEARN_YBOLD_SOURCE_KEY,
    yieldSource: YEARN_YBOLD_SOURCE_LABEL,
    yieldType: YEARN_YBOLD_SOURCE_TYPE,
    sourceObservedAt: Math.floor(Date.now() / 1000),
    comparisonAnchorObservedAt: null,
  };
}


export async function fetchHashnoteUsycSource(signal?: AbortSignal): Promise<ResolvedYield | null> {
  const result = await fetchJsonWithRetry<{ entity?: string; data?: HashnoteReport[] }>(
    HASHNOTE_PRICE_REPORTS_URL,
    {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal,
    },
    0,
    { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS },
  );
  if (!result?.response.ok) return null;

  const body = result.body;
  const reports = body.data;
  if (!Array.isArray(reports) || reports.length < 2) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  const sortedReports = [...reports]
    .map((report) => ({
      ...report,
      parsedTimestamp: Number(report.timestamp),
    }))
    .filter((report) => Number.isFinite(report.parsedTimestamp)
      && report.parsedTimestamp > 0
      && report.parsedTimestamp <= nowSec + HASHNOTE_MAX_FUTURE_SKEW_SEC)
    .sort((a, b) => b.parsedTimestamp - a.parsedTimestamp);
  if (sortedReports.length < 2) return null;

  const latest = sortedReports[0];
  const latestPrice = parseFloat(latest.price);
  const latestTimeSec = latest.parsedTimestamp;
  if (!Number.isFinite(latestPrice) || latestPrice <= 0) return null;
  if (!Number.isFinite(latestTimeSec)) return null;
  if (nowSec - latestTimeSec > HASHNOTE_MAX_FRESHNESS_SEC) return null;

  const targetAnchorSec = latestTimeSec - HASHNOTE_TARGET_LOOKBACK_SEC;
  let anchor = sortedReports[sortedReports.length - 1];
  for (const report of sortedReports) {
    if (report.parsedTimestamp <= targetAnchorSec) {
      anchor = report;
      break;
    }
  }
  const anchorPrice = parseFloat(anchor.price);
  const anchorTimeSec = anchor.parsedTimestamp;
  if (!Number.isFinite(anchorPrice) || anchorPrice <= 0) return null;

  const lookbackSec = latestTimeSec - anchorTimeSec;
  if (lookbackSec < HASHNOTE_MIN_LOOKBACK_SEC) return null;
  const daysDelta = lookbackSec / DAY_SECONDS;

  const apy = (Math.pow(latestPrice / anchorPrice, 365.25 / daysDelta) - 1) * 100;
  // B12 — the NAV-oracle annualization is unbounded on a short anchor window; the
  // shared deterministic envelope keeps an absurd print out of PYS.
  if (!isDeterministicApyWithinSanityBounds(apy)) return null;

  return {
    currentApy: apy, apyBase: apy, apyReward: null,
    sourcePool: null, sourceTvlUsd: null, dataSource: "protocol-api",
    exchangeRate: null, sourceKey: HASHNOTE_USYC_SOURCE_KEY,
    yieldSource: HASHNOTE_USYC_SOURCE_LABEL, yieldType: HASHNOTE_USYC_SOURCE_TYPE,
    sourceObservedAt: latestTimeSec,
    comparisonAnchorObservedAt: anchorTimeSec,
  };
}

export async function fetchOndoUsdyOracleSource(
  prevExchangeRate: number | null,
  daysDelta: number,
  comparisonAnchorObservedAt: number | null,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<ResolvedYield | null> {
  const rpc = chainRpcs ? getChainRpc(chainRpcs, "ethereum") : undefined;
  const fallbackRpcUrl = registryRpcUrls(rpc)[1];
  const extraRpcUrls = fallbackRpcUrl ? [fallbackRpcUrl] : [];
  const currentPrice = await fetchEvmUint256AtBlock(
    "ethereum", ONDO_USDY_ORACLE, ONDO_GET_PRICE_SELECTOR, "latest",
    { extraRpcUrls, signal },
  );
  if (!currentPrice || currentPrice === 0n) return null;

  const currentPriceFloat = finiteDecimalNumberFromBigInt(currentPrice, 18);
  if (currentPriceFloat == null || !Number.isFinite(currentPriceFloat) || currentPriceFloat <= 0) return null;

  if (prevExchangeRate == null || prevExchangeRate === 0 || daysDelta < 1) {
    return {
      observationKind: "anchor-only",
      currentApy: 0, apyBase: null, apyReward: null,
      sourcePool: null, sourceTvlUsd: null, dataSource: "protocol-api",
      exchangeRate: currentPriceFloat, sourceKey: ONDO_USDY_SOURCE_KEY,
      yieldSource: ONDO_USDY_SOURCE_LABEL, yieldType: ONDO_USDY_SOURCE_TYPE,
      sourceObservedAt: Math.floor(Date.now() / 1000), comparisonAnchorObservedAt: null,
    };
  }

  if (!Number.isFinite(prevExchangeRate) || prevExchangeRate <= 0) return null;
  const apy = (Math.pow(currentPriceFloat / prevExchangeRate, 365.25 / daysDelta) - 1) * 100;
  // B12 — same deterministic envelope as the other NAV oracles.
  if (!isDeterministicApyWithinSanityBounds(apy)) return null;

  return {
    currentApy: apy, apyBase: apy, apyReward: null,
    sourcePool: null, sourceTvlUsd: null, dataSource: "protocol-api",
    exchangeRate: currentPriceFloat, sourceKey: ONDO_USDY_SOURCE_KEY,
    yieldSource: ONDO_USDY_SOURCE_LABEL, yieldType: ONDO_USDY_SOURCE_TYPE,
    sourceObservedAt: Math.floor(Date.now() / 1000), comparisonAnchorObservedAt,
  };
}

export async function fetchReProtocolReusdSource(signal?: AbortSignal): Promise<ResolvedYield | null> {
  const result = await fetchJsonWithRetry<RePriceResponse>(
    RE_REUSD_PRICE_URL,
    {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal,
    },
    0,
    { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS },
  );
  if (!result?.response.ok || result.body.success !== true) return null;

  const observations = result.body.data?.reUSD;
  if (!Array.isArray(observations) || observations.length === 0) return null;

  const parsed = observations
    .map((observation) => {
      const observedAt = typeof observation.date === "string"
        ? Date.parse(`${observation.date}T00:00:00Z`) / 1000
        : Number.NaN;
      return {
        apy: getFiniteNumber(observation.apy),
        observedAt,
        price: getFiniteNumber(observation.price),
      };
    })
    .filter((observation) =>
      observation.apy != null &&
      observation.apy >= RE_REUSD_MIN_APY_PERCENT &&
      observation.apy <= RE_REUSD_MAX_APY_PERCENT &&
      Number.isFinite(observation.observedAt) &&
      observation.price != null &&
      observation.price > 0,
    )
    .sort((a, b) => b.observedAt - a.observedAt);
  const latest = parsed[0];
  if (!latest || latest.apy == null || latest.price == null) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  if (latest.observedAt > nowSec || nowSec - latest.observedAt > RE_REUSD_MAX_FRESHNESS_SEC) {
    return null;
  }

  return {
    currentApy: latest.apy,
    apyBase: latest.apy,
    apyReward: null,
    sourcePool: RE_REUSD_CONTRACT,
    sourceTvlUsd: null,
    dataSource: "protocol-api",
    exchangeRate: latest.price,
    sourceKey: RE_REUSD_SOURCE_KEY,
    yieldSource: RE_REUSD_SOURCE_LABEL,
    yieldType: RE_REUSD_SOURCE_TYPE,
    sourceObservedAt: latest.observedAt,
    comparisonAnchorObservedAt: null,
  };
}

const MIDAS_MMEV_ID = "mmev-midas";
const MIDAS_MMEV_SYMBOL = "mMEV";
const MIDAS_MMEV_CHAIN = "ethereum";
const MIDAS_MMEV_TOKEN = "0x030b69280892c888670edcdcd8b69fd8026a0bf3";
const MIDAS_MMEV_NAV_ORACLE = "0x5f09Aff8B9b1f488B7d1bbaD4D89648579e55d61";
const MIDAS_MMEV_NAV_ORACLE_SOURCE_KEY = "protocol-api:midas-mmev-nav-oracle";
const MIDAS_MMEV_NAV_ORACLE_LABEL = "Midas mMEV/USD Oracle";
const MIDAS_MMEV_NAV_ORACLE_MAX_AGE_SEC = 3 * DAY_SECONDS;
const MIDAS_NAV_ORACLE_MAX_DECIMALS = 36;
const MIDAS_NAV_ORACLE_MAX_FUTURE_SKEW_SEC = 5 * 60;

interface MidasMmevNavOracleOptions {
  prevExchangeRate?: number | null;
  comparisonAnchorObservedAt?: number | null;
  loadAnchor?: (observedAt: number) => Promise<{ exchangeRate: number; observedAt: number } | null>;
  signal?: AbortSignal;
  chainRpcs?: Map<string, ChainRpcConfig>;
  nowSec?: number;
}

function decodeMidasNavOracleDecimals(rawDecimals: bigint | null): number | null {
  if (rawDecimals == null || rawDecimals < 0n || rawDecimals > BigInt(MIDAS_NAV_ORACLE_MAX_DECIMALS)) {
    return null;
  }
  return Number(rawDecimals);
}

function isFreshMidasNavOracleUpdate(updatedAt: number, nowSec: number): boolean {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return false;
  if (updatedAt > nowSec + MIDAS_NAV_ORACLE_MAX_FUTURE_SKEW_SEC) return false;
  return nowSec - updatedAt <= MIDAS_MMEV_NAV_ORACLE_MAX_AGE_SEC;
}

function buildMidasMmevNavCandidate(params: {
  observationKind?: "anchor-only";
  apy: number;
  apyBase: number | null;
  exchangeRate: number;
  sourceObservedAt: number;
  comparisonAnchorObservedAt: number | null;
}): ResolvedYieldCandidate {
  return {
    stablecoinId: MIDAS_MMEV_ID,
    symbol: MIDAS_MMEV_SYMBOL,
    chain: MIDAS_MMEV_CHAIN,
    address: MIDAS_MMEV_TOKEN,
    yield: {
      observationKind: params.observationKind,
      currentApy: params.apy,
      apyBase: params.apyBase,
      apyReward: null,
      sourcePool: MIDAS_MMEV_NAV_ORACLE,
      sourceTvlUsd: null,
      dataSource: "protocol-api",
      exchangeRate: params.exchangeRate,
      sourceKey: MIDAS_MMEV_NAV_ORACLE_SOURCE_KEY,
      yieldSource: MIDAS_MMEV_NAV_ORACLE_LABEL,
      yieldType: "nav-appreciation",
      sourceObservedAt: params.sourceObservedAt,
      comparisonAnchorObservedAt: params.comparisonAnchorObservedAt,
    },
  };
}

export async function fetchMidasMmevNavOracleSource(
  options: MidasMmevNavOracleOptions = {},
): Promise<ResolvedYieldCandidate | null> {
  const {
    prevExchangeRate = null,
    comparisonAnchorObservedAt = null,
    loadAnchor,
    signal,
    chainRpcs,
    nowSec = Math.floor(Date.now() / 1000),
  } = options;

  const callOptions = {
    chainRpcs,
    signal,
    timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS,
    maxRetries: 0,
  };
  const [rawDecimals, rawRoundData] = await Promise.all([
    fetchEvmUint256AtBlock(
      MIDAS_MMEV_CHAIN,
      MIDAS_MMEV_NAV_ORACLE,
      DECIMALS_SELECTOR,
      "latest",
      callOptions,
    ),
    fetchEvmCallHexAtBlock(
      MIDAS_MMEV_CHAIN,
      MIDAS_MMEV_NAV_ORACLE,
      LATEST_ROUND_DATA_SELECTOR,
      "latest",
      callOptions,
    ),
  ]);

  const decimals = decodeMidasNavOracleDecimals(rawDecimals);
  if (decimals == null || rawRoundData == null) return null;

  const round = parseChainlinkLatestRoundData(rawRoundData, "midas-mmev-nav-oracle");
  if (round.invalidReason) return null;
  if (!isFreshMidasNavOracleUpdate(round.updatedAt, nowSec)) return null;

  const currentPriceFloat = finiteDecimalNumberFromBigInt(round.answer, decimals);
  if (currentPriceFloat == null || currentPriceFloat <= 0) return null;

  const anchor = loadAnchor ? await loadAnchor(round.updatedAt) : {
    exchangeRate: prevExchangeRate, observedAt: comparisonAnchorObservedAt,
  };
  const prevPriceFloat = typeof anchor?.exchangeRate === "number" && Number.isFinite(anchor.exchangeRate) && anchor.exchangeRate > 0
    ? anchor.exchangeRate : null;
  const anchorObservedAt = anchor?.observedAt;
  const daysDelta = typeof anchorObservedAt === "number" && Number.isFinite(anchorObservedAt)
    ? (round.updatedAt - anchorObservedAt) / DAY_SECONDS : 0;

  if (prevPriceFloat == null || anchorObservedAt == null) {
    return buildMidasMmevNavCandidate({
      observationKind: "anchor-only",
      apy: 0,
      apyBase: null,
      exchangeRate: currentPriceFloat,
      sourceObservedAt: round.updatedAt,
      comparisonAnchorObservedAt: null,
    });
  }
  if (!Number.isFinite(daysDelta) || daysDelta < 1 || daysDelta > 45) return null;

  const apy = (Math.pow(currentPriceFloat / prevPriceFloat, 365.25 / daysDelta) - 1) * 100;
  // B12 — a short or mis-anchored window annualizes without bound; the shared
  // deterministic envelope keeps an absurd NAV move out of PYS (and out of the
  // published board) instead of clamping it to a perfect score.
  if (!isDeterministicApyWithinSanityBounds(apy)) return null;

  return buildMidasMmevNavCandidate({
    apy,
    apyBase: apy,
    exchangeRate: currentPriceFloat,
    sourceObservedAt: round.updatedAt,
    comparisonAnchorObservedAt: anchorObservedAt ?? null,
  });
}

const SCRVUSD_CURVE_ID = "scrvusd-curve";
const HASHNOTE_USYC_ID = "usyc-hashnote";
const ONDO_USDY_ID = "usdy-ondo-finance";
const RE_REUSD_ID = "reusd-re-protocol";
const ZEPHYR_ZYS_ID = "zys-zephyr-protocol";
const YEARN_YBOLD_ID = "ybold-yearn";
const ONDO_USDY_ORACLE_SOURCE_KEY = "protocol-api:ondo-usdy-oracle";

export interface TrackedOptionalSourceContext {
  db: D1Database;
  startSec: number;
  signal?: AbortSignal;
  chainRpcs?: Map<string, ChainRpcConfig>;
  coingeckoApiKey?: string | null;
  /** B15 — forwarded to `runTimedOptionalSource` so a swallowed failure reaches run metadata. */
  onOutcome?: (outcome: { label: string; outcome: "failed" | "timeout" }) => void;
}

interface TrackedOptionalSourceEntry {
  stablecoinId: string;
  sourceKey: string;
  /**
   * B15 — set only when the entry's coin is deliberately not in
   * `ACTIVE_YIELD_BEARING_STABLECOINS`, so the registry cannot silently strand a
   * source behind a coin that will never be iterated. Absent means "must be active".
   */
  intendedDormant?: string;
  run: (context: TrackedOptionalSourceContext) => Promise<ResolvedYield | null>;
}

type OracleAnchorRow = { exchange_rate: number; recorded_at: number; source_observed_at?: number | null };

async function loadNavOracleAnchorRow(
  db: D1Database,
  stablecoinId: string,
  sourceKey: string,
  startSec: number,
  minAgeDays: number,
  maxAgeDays: number,
  useObservationClock = false,
): Promise<OracleAnchorRow | null> {
  const newestAllowed = startSec - minAgeDays * DAY_SECONDS;
  const oldestAllowed = startSec - maxAgeDays * DAY_SECONDS;
  const anchorClock = useObservationClock ? "source_observed_at" : "recorded_at";
  const rawRow = await db
    .prepare(
      `SELECT /* pharos:yield-sync:nav-oracle-prior-anchor */
         exchange_rate, recorded_at, source_observed_at FROM yield_history
       WHERE stablecoin_id = ? AND source_key = ?
         AND exchange_rate IS NOT NULL
         AND ${anchorClock} <= ?
         AND ${anchorClock} >= ?
         AND (publication_generation_id IS NULL OR publication_state = 'published')
       ORDER BY ${anchorClock} DESC LIMIT 1`,
    )
    .bind(stablecoinId, sourceKey, newestAllowed, oldestAllowed)
    .first<OracleAnchorRow>();
  if (rawRow) return rawRow;

  // Raw history keeps `YIELD_HISTORY_RAW_DAYS` (30) while these NAV-oracle
  // anchors allow a lookback of up to 45 days. `maxAgeDays` is a floor, not a
  // requirement — the query takes the newest row past the min-age bound, which
  // for Midas is normally ~7 days old and comfortably inside raw retention — so
  // this fallback only matters when the newest qualifying observation sits
  // outside the raw window (a publication gap longer than the raw policy). It
  // exists because Midas has no shorter-window retry (Ondo retries at 3/14
  // days), so without it such a gap would stop the source resolving silently
  // rather than degrading. `yield_history_daily` keeps a year and carries the
  // same `exchange_rate`/`publication_state` columns.
  return db
    .prepare(
      `SELECT /* pharos:yield-sync:nav-oracle-prior-anchor-daily */
         exchange_rate, recorded_at, source_observed_at FROM yield_history_daily
       WHERE stablecoin_id = ? AND source_key = ?
         AND exchange_rate IS NOT NULL
         AND ${anchorClock} <= ?
         AND ${anchorClock} >= ?
         AND (publication_generation_id IS NULL OR publication_state = 'published')
       ORDER BY ${anchorClock} DESC LIMIT 1`,
    )
    .bind(stablecoinId, sourceKey, newestAllowed, oldestAllowed)
    .first<OracleAnchorRow>();
}

export async function loadOndoOracleAnchorRow(
  db: D1Database,
  startSec: number,
): Promise<OracleAnchorRow | null> {
  const preferredPriorRow = await loadNavOracleAnchorRow(
    db,
    ONDO_USDY_ID,
    ONDO_USDY_ORACLE_SOURCE_KEY,
    startSec,
    7,
    45,
  );
  if (preferredPriorRow) return preferredPriorRow;

  return loadNavOracleAnchorRow(db, ONDO_USDY_ID, ONDO_USDY_ORACLE_SOURCE_KEY, startSec, 3, 14);
}

async function loadMidasMmevOracleAnchorRow(
  db: D1Database,
  startSec: number,
): Promise<OracleAnchorRow | null> {
  return loadNavOracleAnchorRow(db, MIDAS_MMEV_ID, MIDAS_MMEV_NAV_ORACLE_SOURCE_KEY, startSec, 7, 45, true);
}

/**
 * Ordinary entry shape: the registry applies the shared per-source timeout
 * policy once here instead of repeating it in every descriptor. Entries that
 * must prepare D1 anchors before the timed region (Ondo, Midas) keep a
 * bespoke `run` that opens the timer only after that preparation.
 */
function timedOptionalSourceEntry(
  stablecoinId: string,
  sourceKey: string,
  label: string,
  fetchSource: (
    budgetSignal: AbortSignal,
    context: TrackedOptionalSourceContext,
  ) => Promise<ResolvedYield | null>,
  intendedDormant?: string,
): TrackedOptionalSourceEntry {
  return {
    stablecoinId,
    sourceKey,
    intendedDormant,
    run: (context) =>
      runTimedOptionalSource(
        label,
        context.signal,
        (budgetSignal) => fetchSource(budgetSignal, context),
        null,
        context.onOutcome,
      ),
  };
}

export const TRACKED_OPTIONAL_SOURCE_REGISTRY: TrackedOptionalSourceEntry[] = [
  timedOptionalSourceEntry(
    SCRVUSD_CURVE_ID,
    SCRVUSD_CURRENT_RATE_SOURCE_KEY,
    "Curve scrvUSD current-rate source",
    (budgetSignal, context) =>
      fetchCurveScrvusdCurrentRateSource(context.startSec, budgetSignal, context.chainRpcs),
  ),
  timedOptionalSourceEntry(
    HASHNOTE_USYC_ID,
    "protocol-api:hashnote-usyc",
    "Hashnote USYC source",
    (budgetSignal) => fetchHashnoteUsycSource(budgetSignal),
  ),
  {
    stablecoinId: ONDO_USDY_ID,
    sourceKey: ONDO_USDY_ORACLE_SOURCE_KEY,
    run: async (context) => {
      const anchorRow = await loadOndoOracleAnchorRow(context.db, context.startSec);
      const daysDelta = anchorRow ? (context.startSec - anchorRow.recorded_at) / DAY_SECONDS : 0;

      return runTimedOptionalSource(
        "Ondo USDY oracle source",
        context.signal,
        (budgetSignal) => fetchOndoUsdyOracleSource(
          anchorRow?.exchange_rate ?? null,
          daysDelta,
          anchorRow?.recorded_at ?? null,
          budgetSignal,
          context.chainRpcs,
        ),
        null,
        context.onOutcome,
      );
    },
  },
  {
    stablecoinId: MIDAS_MMEV_ID,
    sourceKey: MIDAS_MMEV_NAV_ORACLE_SOURCE_KEY,
    run: async (context) => {
      const candidate = await runTimedOptionalSource(
        "Midas mMEV NAV oracle source",
        context.signal,
        (budgetSignal) => fetchMidasMmevNavOracleSource({
          loadAnchor: async (observedAt) => {
            const anchor = await loadMidasMmevOracleAnchorRow(context.db, observedAt);
            return anchor?.source_observed_at != null
              ? { exchangeRate: anchor.exchange_rate, observedAt: anchor.source_observed_at } : null;
          },
          nowSec: context.startSec,
          signal: budgetSignal,
          chainRpcs: context.chainRpcs,
        }),
        null,
        context.onOutcome,
      );
      return candidate?.yield ?? null;
    },
  },
  timedOptionalSourceEntry(
    RE_REUSD_ID,
    "protocol-api:re-protocol-reusd",
    "Re Protocol reUSD source",
    (budgetSignal) => fetchReProtocolReusdSource(budgetSignal),
  ),
  timedOptionalSourceEntry(
    ZEPHYR_ZYS_ID,
    "protocol-api:zys-zephyr-protocol",
    "Zephyr ZYS source",
    (budgetSignal) => fetchZephyrZysSource(budgetSignal),
  ),
  timedOptionalSourceEntry(
    YEARN_YBOLD_ID,
    YEARN_YBOLD_SOURCE_KEY,
    "Yearn yBOLD source",
    (budgetSignal) => fetchYearnYboldSource(budgetSignal),
  ),
];

export const TRACKED_OPTIONAL_SOURCE_REGISTRY_BY_ID = new Map<string, TrackedOptionalSourceEntry[]>();
for (const entry of TRACKED_OPTIONAL_SOURCE_REGISTRY) {
  const list = TRACKED_OPTIONAL_SOURCE_REGISTRY_BY_ID.get(entry.stablecoinId) ?? [];
  list.push(entry);
  TRACKED_OPTIONAL_SOURCE_REGISTRY_BY_ID.set(entry.stablecoinId, list);
}

export const STANDALONE_TRACKED_OPTIONAL_SOURCE_REGISTRY: readonly TrackedOptionalSourceEntry[] = [
  timedOptionalSourceEntry(
    LIQUITY_V1_LUSD_ID,
    buildOnChainSourceKey(LIQUITY_V1_LUSD_ID),
    "B.Protocol LQTY-only source",
    (budgetSignal, context) =>
      fetchBprotocolLqtyOnlySource(context.startSec, budgetSignal, context.chainRpcs, context.coingeckoApiKey),
  ),
  timedOptionalSourceEntry(
    BASEDOLLAR_BD_ID,
    buildOnChainSourceKey(BASEDOLLAR_BD_ID),
    "Base Dollar SP interest-only source",
    (budgetSignal, context) =>
      fetchLiquityV2StabilityPoolSource(context.startSec, BASEDOLLAR_SP_CONFIG, budgetSignal, context.chainRpcs),
  ),
  timedOptionalSourceEntry(
    LIQUITY_V2_BOLD_ID,
    buildOnChainSourceKey(LIQUITY_V2_BOLD_ID),
    "Liquity V2 SP interest-only source",
    (budgetSignal, context) =>
      fetchLiquityV2StabilityPoolSource(context.startSec, LIQUITY_V2_SP_CONFIG, budgetSignal, context.chainRpcs),
  ),
];

interface MorphoVaultItem {
  address: string;
  name: string;
  asset: { symbol: string; address?: string | null };
  chain: { id: number };
  state: { netApy: number; totalAssetsUsd: number | null; fee: number } | null;
}

interface PendleMarket {
  id: string;
  address: string;
  chainId: number;
  isActive: boolean;
  expiry: string;
  impliedApy: number;
  underlyingApy: number;
  aggregatedApy: number;
  underlyingAsset: { symbol: string; address: string };
  assetRepresentation: string;
  protocol: string;
  liquidity: { usd: number };
  categoryIds: string[];
}

interface KongVault {
  address: string;
  name: string;
  yearn: boolean;
  asset: { symbol: string; address?: string | null };
  tvl: { close: number } | null;
  apy: { net: number | null; monthlyNet: number | null } | null;
  meta: { category: string | null; isRetired: boolean | null } | null;
}

interface BeefyVault {
  id: string;
  name: string;
  token: string;
  assets: string[];
  status: string;
  chain: string;
  platformId: string;
  tokenAddress: string;
}

type BeefyTvlPayload = Record<string, number | null | Record<string, number | null>>;

const BEEFY_CHAIN_ALIASES: Record<string, string> = {
  avax: "avalanche",
  one: "harmony",
  zkevm: "polygon-zkevm",
};

interface TrackedMorphoAsset {
  stablecoinId: string;
  symbol: string;
}

interface TrackedMorphoFilters {
  symbols: string[];
  assetsByChainAddress: Map<string, TrackedMorphoAsset>;
}

/**
 * B1: supplemental fetchers report whether an HTTP/parse failure or a partial
 * pagination ended the run early, so the writer can retain the previous family
 * snapshot instead of publishing a fresh, incomplete one.
 */
export interface SupplementalFamilyFetchResult {
  candidates: ResolvedYieldCandidate[];
  degraded: boolean;
  /** A 429's retry window, persisted by the supplemental producer. */
  rateLimited?: PendleRateLimitBackoff;
}

interface PendleRateLimitBackoff {
  backoffSec: number;
  source: "retry-after" | "x-ratelimit-weekly-reset" | "x-ratelimit-reset" | "default";
}

/** Respect the exhausted quota window, not the weekly reset on an ordinary minute-limit response. */
function resolvePendleRateLimitBackoff(response: Response, nowMs: number): PendleRateLimitBackoff {
  const retryAfterSec = parseRetryAfterSeconds(response.headers.get("Retry-After"), { nowMs });
  const weeklyRemaining = response.headers.get("x-ratelimit-weekly-remaining");
  const weeklyExhausted = weeklyRemaining != null && Number(weeklyRemaining) === 0;
  const resetHeaders = weeklyExhausted || (weeklyRemaining == null && !retryAfterSec)
    ? ["x-ratelimit-weekly-reset", "x-ratelimit-reset"] as const
    : ["x-ratelimit-reset"] as const;
  let backoffSec = retryAfterSec && retryAfterSec > 0 ? retryAfterSec : 0;
  let source: PendleRateLimitBackoff["source"] = backoffSec ? "retry-after" : "default";
  for (const header of resetHeaders) {
    const resetSec = Number(response.headers.get(header));
    const delaySec = resetSec - Math.floor(nowMs / 1000);
    if (Number.isSafeInteger(resetSec) && delaySec > backoffSec) {
      backoffSec = delaySec;
      source = header;
    }
  }
  return {
    backoffSec: backoffSec > 0 ? Math.min(backoffSec, 7 * 86400) : PENDLE_SUPPLEMENTAL_FETCH_CADENCE_SEC,
    source,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function resolveBeefyCanonicalChain(chain: string | null | undefined): string | null {
  if (!isNonEmptyString(chain)) return null;
  const alias = BEEFY_CHAIN_ALIASES[chain.toLowerCase()];
  return normalizeChainId(alias ?? chain);
}

function resolveBeefyTvl(tvlMap: BeefyTvlPayload, chain: string, vaultId: string): number | null {
  const evmChainId = CHAIN_META[chain]?.evmChainId;
  if (evmChainId != null) {
    const chainTvlMap = tvlMap[String(evmChainId)];
    if (chainTvlMap && typeof chainTvlMap === "object" && !Array.isArray(chainTvlMap)) {
      return chainTvlMap[vaultId] ?? null;
    }
  }

  const flatTvl = tvlMap[vaultId];
  return typeof flatTvl === "number" ? flatTvl : null;
}

const MORPHO_PAGE_SIZE = 100;
const MORPHO_MIN_TVL_USD = 100_000;
const PENDLE_MIN_EXPIRY_DAYS = 3;
const PENDLE_MAX_EXPIRY_YEARS = 5;
const PENDLE_MAX_IMPLIED_APY = 1;
const PENDLE_MIN_TVL_USD = 100_000;
const KONG_MIN_TVL_USD = 100_000;
const BEEFY_MAX_APY = 0.5;
const BEEFY_MIN_TVL_USD = 100_000;

function buildMorphoFilters(): TrackedMorphoFilters {
  const symbols = new Set<string>();
  const assetsByChainAddress = new Map<string, TrackedMorphoAsset>();

  for (const meta of ACTIVE_STABLECOINS) {
    if (meta.flags.pegCurrency === "GOLD" || meta.flags.pegCurrency === "SILVER") continue;
    symbols.add(meta.symbol);

    for (const contract of [...(meta.contracts ?? []), ...(meta.tradedContracts ?? [])]) {
      const chain = normalizeChainId(contract.chain);
      const address = contract.address?.trim() ?? "";
      if (!chain || !address) continue;
      assetsByChainAddress.set(buildChainAddressKey(chain, address), {
        stablecoinId: meta.id,
        symbol: meta.symbol,
      });
    }
  }

  return {
    symbols: [...symbols].sort((a, b) => a.localeCompare(b)),
    assetsByChainAddress,
  };
}

function resolveMorphoTrackedAsset(
  filters: TrackedMorphoFilters,
  chain: string,
  asset: MorphoVaultItem["asset"],
): TrackedMorphoAsset | null {
  const address = asset.address?.trim() ?? "";
  if (address) {
    const byAddress = filters.assetsByChainAddress.get(buildChainAddressKey(chain, address));
    if (byAddress) return byAddress;
  }

  return null;
}

function isSanePendleExpiry(expiry: string, nowMs: number): boolean {
  const expiryMs = Date.parse(expiry);
  if (!Number.isFinite(expiryMs)) return false;

  const minExpiryMs = nowMs + PENDLE_MIN_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  const maxExpiryMs = nowMs + PENDLE_MAX_EXPIRY_YEARS * 365.25 * 24 * 60 * 60 * 1000;
  return expiryMs >= minExpiryMs && expiryMs <= maxExpiryMs;
}

function buildSupplementalCandidate(
  identity: Omit<ResolvedYieldCandidate, "yield">,
  currentApy: number,
  sourcePool: string,
  sourceTvlUsd: number,
  sourceKey: string,
  yieldSource: string,
  yieldType: NonNullable<ResolvedYield["yieldType"]>,
  sourceObservedAt: number,
): ResolvedYieldCandidate {
  return {
    ...identity,
    yield: {
      currentApy,
      apyBase: currentApy,
      apyReward: null,
      sourcePool,
      sourceTvlUsd,
      dataSource: "protocol-api",
      exchangeRate: null,
      sourceKey,
      yieldSource,
      yieldType,
      sourceObservedAt,
      comparisonAnchorObservedAt: null,
    },
  };
}

export async function fetchMorphoVaultSources(signal?: AbortSignal): Promise<SupplementalFamilyFetchResult> {
  const budget = createOptionalSourceBudget("Morpho vault sources", OPTIONAL_PROTOCOL_API_BUDGET_MS, signal);
  const filters = buildMorphoFilters();
  if (filters.symbols.length === 0) return { candidates: [], degraded: false };

  try {
    const results: ResolvedYieldCandidate[] = [];
    let degraded = false;
    // Morpho caps assetSymbol_in at 100; keep each filter batch independently paginated.
    for (let symbolOffset = 0; symbolOffset < filters.symbols.length; symbolOffset += 100) {
      const symbols = filters.symbols.slice(symbolOffset, symbolOffset + 100);
      let skip = 0;
      while (!budget.budgetController.signal.aborted) {
        throwIfAborted(budget.budgetController.signal);
        const result = await fetchJsonWithRetry<{ data?: { vaults?: { items?: MorphoVaultItem[] } } }>(
          "https://api.morpho.org/graphql",
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
            body: JSON.stringify({
              query: `query($symbols: [String!]!, $first: Int!, $skip: Int!, $minTvl: Float!) {
    vaults(first: $first, skip: $skip, where: { listed: true, assetSymbol_in: $symbols, totalAssetsUsd_gte: $minTvl }) {
      items {
        address name
        asset { symbol address }
        chain { id }
        state { netApy totalAssetsUsd fee }
      }
    }
  }`,
              variables: { symbols, first: MORPHO_PAGE_SIZE, skip, minTvl: MORPHO_MIN_TVL_USD },
            }),
            signal: budget.signal,
          },
          0,
          { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS },
        );
        if (!result?.response.ok) return { candidates: results, degraded: true };

        const body = result.body;
        const items = body.data?.vaults?.items;
        if (!Array.isArray(items)) {
          degraded = true;
          break;
        }
        if (items.length === 0) break;

        for (const vault of items) {
          if (!symbols.includes(vault.asset?.symbol)) continue;
          const apy = vault.state?.netApy;
          if (typeof apy !== "number" || !Number.isFinite(apy) || apy <= 0) continue;

          const tvl = vault.state?.totalAssetsUsd;
          if (typeof tvl !== "number" || tvl < MORPHO_MIN_TVL_USD) continue;
          if (!isNonEmptyString(vault.address) || !isNonEmptyString(vault.asset?.symbol)) continue;
          const chain = normalizeChainId(vault.chain?.id);
          if (!chain) continue;
          const trackedAsset = resolveMorphoTrackedAsset(filters, chain, vault.asset);
          if (!trackedAsset) continue;

          results.push(buildSupplementalCandidate(
            { stablecoinId: trackedAsset.stablecoinId, symbol: trackedAsset.symbol, chain, address: vault.asset.address ?? null },
            apy * 100, vault.address, tvl,
            `protocol-api:morpho-vault:${chain}:${vault.address.toLowerCase()}`,
            `Morpho: ${vault.name}`, "lending-opportunity", Math.floor(Date.now() / 1000),
          ));
        }
        skip += items.length;
        if (items.length < MORPHO_PAGE_SIZE) break;
      }
    }
    // A budget abort exits pagination mid-run, so the snapshot is partial.
    return { candidates: results, degraded: degraded || budget.budgetController.signal.aborted };
  } catch (error) {
    if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
    if (budget.budgetController.signal.aborted) {
      logWorkerEvent({
        scope: "lib",
        job: "sync-yield-data",
        level: "warn",
        event: "morpho-sources-budget-exhausted",
        message: "Morpho vault sources budget exhausted; continuing without this source family",
      });
      return { candidates: [], degraded: true };
    }
    logWorkerEvent({
      scope: "lib",
      job: "sync-yield-data",
      level: "warn",
      event: "morpho-sources-failed",
      message: "Morpho vault sources failed",
      error,
    });
    return { candidates: [], degraded: true };
  } finally {
    budget.cleanup();
  }
}

export async function fetchPendleMarketSources(signal?: AbortSignal): Promise<SupplementalFamilyFetchResult> {
  const results: ResolvedYieldCandidate[] = [];
  const budget = createOptionalSourceBudget("Pendle market sources", OPTIONAL_PROTOCOL_API_BUDGET_MS, signal);
  const nowMs = Date.now();
  let degraded = false;

  try {
    for (const chainId of [1, 42161, 8453]) {
      if (budget.budgetController.signal.aborted) break;
      try {
        let skip = 0;
        const limit = 100;
        while (!budget.budgetController.signal.aborted) {
          throwIfAborted(budget.budgetController.signal);
          const url = `https://api-v2.pendle.finance/core/v1/${chainId}/markets?limit=${limit}&skip=${skip}&is_active=true`;
          const response = await fetchWithRetry(
            url,
            {
              headers: {
                Accept: "application/json",
                "User-Agent": USER_AGENT,
              },
              signal: budget.signal,
            },
            0,
            { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS, passthroughStatuses: [429], waitOnPassthrough429: false },
          );
          if (!response?.ok) {
            degraded = true;
            if (response?.status === 429) {
              const rateLimited = resolvePendleRateLimitBackoff(response, Date.now());
              await cancelResponseBodyQuietly(response);
              // The quota is shared across chains: stop immediately, not after
              // two more doomed requests. Error bodies need not be JSON.
              return { candidates: results, degraded, rateLimited };
            }
            await cancelResponseBodyQuietly(response);
            break;
          }

          const body = await readResponseJsonWithinLimitWithSignal<{ total?: number; results?: PendleMarket[] }>(
            response, DEFAULT_FETCH_RETRY_MAX_RESPONSE_BYTES, budget.signal,
          );
          if (!Array.isArray(body.results)) {
            degraded = true;
            break;
          }
          if (body.results.length === 0) break;

          for (const market of body.results) {
            if (!market.categoryIds?.includes("stables")) continue;
            if (!market.isActive) continue;
            if (!isSanePendleExpiry(market.expiry, nowMs)) continue;

            const apy = market.impliedApy;
            if (typeof apy !== "number" || !Number.isFinite(apy) || apy <= 0 || apy > PENDLE_MAX_IMPLIED_APY) {
              continue;
            }

            const tvl = market.liquidity?.usd;
            if (typeof tvl !== "number" || tvl < PENDLE_MIN_TVL_USD) continue;
            if (
              !isNonEmptyString(market.address) ||
              !isNonEmptyString(market.underlyingAsset?.symbol) ||
              !isNonEmptyString(market.underlyingAsset?.address)
            ) {
              continue;
            }
            const chain = normalizeChainId(market.chainId);
            if (!chain) continue;

            results.push(buildSupplementalCandidate(
              { symbol: market.underlyingAsset.symbol, chain, address: market.underlyingAsset.address },
              apy * 100, market.address, tvl,
              `protocol-api:pendle:${chain}:${market.address.toLowerCase()}`,
              `Pendle fixed yield: ${market.protocol} ${market.assetRepresentation}`,
              "fixed-yield", Math.floor(Date.now() / 1000),
            ));
          }

          skip += body.results.length;
          if (body.results.length < limit || (typeof body.total === "number" && skip >= body.total)) {
            break;
          }
        }
      } catch (error) {
        if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
        if (budget.budgetController.signal.aborted) {
          logWorkerEvent({
            scope: "lib",
            job: "sync-yield-data",
            level: "warn",
            event: "pendle-sources-budget-exhausted",
            message: "Pendle sources budget exhausted; keeping partial results",
            metadata: { resultCount: results.length },
          });
          degraded = true;
          break;
        }
        logWorkerEvent({
          scope: "lib",
          job: "sync-yield-data",
          level: "warn",
          event: "pendle-chain-failed",
          message: "Pendle chain source failed",
          metadata: { chainId },
          error,
        });
        degraded = true;
      }
    }
    return { candidates: results, degraded };
  } finally {
    budget.cleanup();
  }
}

export async function fetchYearnKongSources(signal?: AbortSignal): Promise<SupplementalFamilyFetchResult> {
  const results: ResolvedYieldCandidate[] = [];
  const budget = createOptionalSourceBudget("Yearn Kong sources", OPTIONAL_PROTOCOL_API_BUDGET_MS, signal);
  let degraded = false;

  try {
    for (const chainId of [1, 10, 137, 8453, 42161]) {
      const seenAddresses = new Set<string>();
      if (budget.budgetController.signal.aborted) break;
      try {
        const result = await fetchJsonWithRetry<{ data?: { vaults?: KongVault[] } }>(
          "https://kong.yearn.fi/api/gql",
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
            body: JSON.stringify({
              query: `query($chainId: Int!) {
  vaults(chainId: $chainId) {
    address name yearn
    asset { symbol address }
    tvl { close }
    apy { net monthlyNet }
    meta { category isRetired }
  }
}`,
              variables: { chainId },
            }),
            signal: budget.signal,
          },
          0,
          { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS },
        );
        if (!result?.response.ok) {
          degraded = true;
          continue;
        }

        const body = result.body;
        const vaults = body.data?.vaults;
        if (!Array.isArray(vaults)) {
          degraded = true;
          continue;
        }

        for (const vault of vaults) {
          if (
            !isNonEmptyString(vault.address) ||
            !isNonEmptyString(vault.name) ||
            !isNonEmptyString(vault.asset?.symbol)
          ) {
            continue;
          }
          if (seenAddresses.has(vault.address.toLowerCase())) continue;
          if (vault.meta?.isRetired) continue;
          if (vault.meta?.category !== "Stablecoin") continue;

          const netApy = vault.apy?.net;
          if (typeof netApy !== "number" || !Number.isFinite(netApy) || netApy <= 0) continue;

          const tvl = vault.tvl?.close;
          if (typeof tvl !== "number" || tvl < KONG_MIN_TVL_USD) continue;

          seenAddresses.add(vault.address.toLowerCase());
          const chain = normalizeChainId(chainId);
          if (!chain) continue;
          const normalizedAssetAddress = vault.asset.address?.toLowerCase() ?? null;
          const isK3Sbold =
            chain === "ethereum" &&
            normalizedAssetAddress === "0x9f4330700a36b29952869fac9b33f45eedd8a3d8" &&
            vault.name.trim().toLowerCase() === "staked ybold";
          const sourcePrefix = vault.yearn ? "Yearn" : "Kong";
          const sourceNamespace = isK3Sbold ? "k3" : vault.yearn ? "yearn" : "kong";

          results.push(buildSupplementalCandidate(
            {
              stablecoinId: isK3Sbold ? "sbold-k3-capital" : undefined,
              symbol: vault.asset.symbol, chain, address: vault.asset.address ?? null,
            },
            netApy * 100, vault.address, tvl,
            `protocol-api:${sourceNamespace}:${chain}:${vault.address.toLowerCase()}`,
            isK3Sbold ? "K3: sBOLD" : `${sourcePrefix}: ${vault.name}`,
            isK3Sbold ? "lending-vault" : "lending-opportunity", Math.floor(Date.now() / 1000),
          ));
        }
      } catch (error) {
        if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
        if (budget.budgetController.signal.aborted) {
          logWorkerEvent({
            scope: "lib",
            job: "sync-yield-data",
            level: "warn",
            event: "yearn-kong-sources-budget-exhausted",
            message: "Yearn Kong sources budget exhausted; keeping partial results",
            metadata: { resultCount: results.length },
          });
          degraded = true;
          break;
        }
        logWorkerEvent({
          scope: "lib",
          job: "sync-yield-data",
          level: "warn",
          event: "yearn-kong-chain-failed",
          message: "Yearn Kong chain source failed",
          metadata: { chainId },
          error,
        });
        degraded = true;
      }
    }
    return { candidates: results, degraded };
  } finally {
    budget.cleanup();
  }
}

export async function fetchBeefySources(signal?: AbortSignal): Promise<SupplementalFamilyFetchResult> {
  const budget = createOptionalSourceBudget("Beefy sources", OPTIONAL_PROTOCOL_API_BUDGET_MS, signal);
  try {
    const [apyRes, vaultsRes, tvlRes] = await Promise.all([
      fetchJsonWithRetry<Record<string, number | null>>(
        "https://api.beefy.finance/apy",
        { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: budget.signal },
        0,
        { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS },
      ),
      fetchJsonWithRetry<BeefyVault[]>(
        "https://api.beefy.finance/vaults",
        { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: budget.signal },
        0,
        { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS },
      ),
      fetchJsonWithRetry<BeefyTvlPayload>(
        "https://api.beefy.finance/tvl",
        { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: budget.signal },
        0,
        { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS },
      ),
    ]);
    if (!apyRes?.response.ok || !vaultsRes?.response.ok || !tvlRes?.response.ok) {
      return { candidates: [], degraded: true };
    }

    const apyMap = apyRes.body;
    const vaults = vaultsRes.body;
    const tvlMap = tvlRes.body;
    if (!Array.isArray(vaults)) return { candidates: [], degraded: true };
    // A different document shape here silently matches nothing, so treat it as
    // a parse failure rather than as "the provider has no eligible vaults".
    if (!isRecord(apyMap) || !isRecord(tvlMap)) return { candidates: [], degraded: true };

    const results: ResolvedYieldCandidate[] = [];
    for (const vault of vaults) {
      if (!vault || !isNonEmptyString(vault.id)) continue;
      if (vault.status !== "active") continue;
      if (!vault.assets || vault.assets.length !== 1 || !isNonEmptyString(vault.assets[0])) continue;
      const chain = resolveBeefyCanonicalChain(vault.chain);
      if (!chain) continue;
      if (!isNonEmptyString(vault.tokenAddress)) continue;

      const apy = apyMap[vault.id];
      if (typeof apy !== "number" || !Number.isFinite(apy) || apy <= 0 || apy > BEEFY_MAX_APY) continue;
      const tvl = resolveBeefyTvl(tvlMap, chain, vault.id);
      if (typeof tvl !== "number" || !Number.isFinite(tvl) || tvl < BEEFY_MIN_TVL_USD) continue;

      results.push(buildSupplementalCandidate(
        { symbol: vault.assets[0], chain, address: vault.tokenAddress },
        apy * 100, vault.id, tvl,
        `protocol-api:beefy:${chain}:${vault.id}`,
        `Beefy: ${vault.name || vault.id}`, "lending-opportunity", Math.floor(Date.now() / 1000),
      ));
    }
    return { candidates: results, degraded: false };
  } catch (error) {
    if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
    if (budget.budgetController.signal.aborted) {
      logWorkerEvent({
        scope: "lib",
        job: "sync-yield-data",
        level: "warn",
        event: "beefy-sources-budget-exhausted",
        message: "Beefy sources budget exhausted; continuing without this source family",
      });
      return { candidates: [], degraded: true };
    }
    logWorkerEvent({
      scope: "lib",
      job: "sync-yield-data",
      level: "warn",
      event: "beefy-sources-failed",
      message: "Beefy sources failed",
      error,
    });
    return { candidates: [], degraded: true };
  } finally {
    budget.cleanup();
  }
}

const ROYCO_DAWN_EXPLORE_URL = "https://dawn.royco.org/api/v1/ecosystem/explore";
const ROYCO_DAWN_PAGE_SIZE = 100;
const ROYCO_DAWN_MIN_MARKET_TVL_USD = 100_000;
const ROYCO_DAWN_MIN_TRANCHE_TVL_USD = 100_000;
const ROYCO_DAWN_MAX_APY_RATIO = 2;
const ROYCO_DAWN_DETAIL_CONCURRENCY = getCronJobMeta("sync-yield-supplemental")!.maxConnections!;

interface RoycoToken {
  symbol?: string | null;
  chainId?: number | null;
  contractAddress?: string | null;
}

interface RoycoVault {
  address?: string | null;
  name?: string | null;
  apy?: number | null;
  apy7d?: number | null;
  apyInfo?: { duration?: { end?: { blockTimestamp?: number | null } } } | null;
  tvl?: {
    tokenAmountUsd?: number | null;
  } | null;
  depositToken?: RoycoToken | null;
  shareToken?: RoycoToken | null;
}

interface RoycoMarket {
  majorType?: string | null;
  chainId?: number | null;
  marketId?: string | null;
  name?: string | null;
  listingType?: string | null;
  status?: string | null;
  tvlUsd?: number | null;
  coverage?: {
    currentRatio?: number | null;
    requiredRatio?: number | null;
  } | null;
  utilization?: {
    currentRatio?: number | null;
    requiredRatio?: number | null;
  } | null;
  drawdown?: {
    ratio?: number | null;
  } | null;
  totalDrawdowns?: number | null;
  juniorRedemptionDelay?: number | null;
  seniorVault?: RoycoVault | null;
  juniorVault?: RoycoVault | null;
}

interface RoycoExploreResponse {
  data?: RoycoMarket[];
  count?: number;
}

interface RoycoTrackedAsset {
  stablecoinId: string;
  symbol: string;
}

function stablecoinContracts(meta: Pick<StablecoinMeta, "contracts" | "tradedContracts">) {
  return [...(meta.contracts ?? []), ...(meta.tradedContracts ?? [])];
}

function buildTrackedAssetByChainAddress(): Map<string, RoycoTrackedAsset> {
  const byChainAddress = new Map<string, RoycoTrackedAsset>();

  for (const meta of ACTIVE_STABLECOINS) {
    for (const contract of stablecoinContracts(meta)) {
      const chain = normalizeChainId(contract.chain);
      const address = contract.address.trim();
      if (!chain || !address) continue;
      byChainAddress.set(buildChainAddressKey(chain, address), {
        stablecoinId: meta.id,
        symbol: meta.symbol,
      });
    }
  }

  for (const [stablecoinId, variant] of Object.entries(YIELD_VARIANT_MAP)) {
    if (!variant.variantAddress || !variant.variantChain) continue;
    const chain = normalizeChainId(variant.variantChain);
    const address = variant.variantAddress.trim();
    const meta = ACTIVE_STABLECOINS.find((entry) => entry.id === stablecoinId);
    if (!chain || !address || !meta) continue;
    byChainAddress.set(buildChainAddressKey(chain, address), {
      stablecoinId: meta.id,
      symbol: meta.symbol,
    });
  }

  return byChainAddress;
}

function resolveVaultDepositToken(
  vault: RoycoVault,
  chain: string,
  lookup: Map<string, RoycoTrackedAsset>,
): RoycoTrackedAsset | null {
  const address = vault.depositToken?.contractAddress?.trim() ?? "";
  return address ? (lookup.get(buildChainAddressKey(chain, address)) ?? null) : null;
}

function readMarketStatus(value: string | null | undefined): YieldMarketStatus | null {
  return value === "normal" || value === "protected" || value === "unhealthy" || value === "critical" ? value : null;
}

function sourceRiskForTranche(params: {
  side: YieldTrancheSide;
  market: RoycoMarket;
  vault: RoycoVault;
  chain: string;
}): YieldSourceRisk {
  const shareTokenAddress = normalizeTokenAddress(
    params.vault.shareToken?.contractAddress ?? params.vault.address ?? "",
  );
  const depositTokenAddress = normalizeTokenAddress(params.vault.depositToken?.contractAddress ?? "");
  const status = readMarketStatus(params.market.status);
  const investabilityFlags = [
    "withdrawals-underlying-dependent",
    "listing-verified",
    "royco-security-reviewed",
    params.side === "junior" ? "first-loss-junior-tranche" : "senior-protected-by-junior-coverage",
    ...(status ? [`market-status:${status}`] : []),
  ];

  return {
    deploymentPlace: "structured-tranche",
    venueProtocol: "royco-dawn",
    venueChain: params.chain,
    venueRiskTier: "unknown",
    trancheSide: params.side,
    marketCoverageRatio: finiteNumber(params.market.coverage?.currentRatio),
    marketMinCoverageRatio: finiteNumber(params.market.coverage?.requiredRatio),
    marketUtilizationRatio: finiteNumber(params.market.utilization?.currentRatio),
    marketUtilizationLimitRatio: finiteNumber(params.market.utilization?.requiredRatio),
    marketDrawdownRatio: finiteNumber(params.market.drawdown?.ratio),
    marketTotalDrawdowns:
      Number.isInteger(params.market.totalDrawdowns) && params.market.totalDrawdowns != null
        ? params.market.totalDrawdowns
        : null,
    marketStatus: status,
    marketTvlUsd: finiteNumber(params.market.tvlUsd),
    trancheTvlUsd: finiteNumber(params.vault.tvl?.tokenAmountUsd),
    trancheShareTokenAddress: shareTokenAddress || null,
    trancheDepositTokenAddress: depositTokenAddress || null,
    withdrawalDelaySeconds:
      params.side === "junior" && Number.isInteger(params.market.juniorRedemptionDelay)
        ? (params.market.juniorRedemptionDelay ?? null)
        : null,
    kycRequired: null,
    accessRestricted: null,
    investabilityFlags,
  };
}

function buildTrancheCandidate(params: {
  side: YieldTrancheSide;
  market: RoycoMarket;
  vault: RoycoVault;
  chain: string;
  trackedAsset: RoycoTrackedAsset;
  observedAt: number;
}): ResolvedYieldCandidate | null {
  const marketId = params.market.marketId?.trim();
  if (!marketId) return null;

  const apyRatio = finiteNumber(params.vault.apy);
  if (apyRatio == null || apyRatio <= 0 || apyRatio > ROYCO_DAWN_MAX_APY_RATIO) return null;

  const sourceTvlUsd = finiteNumber(params.vault.tvl?.tokenAmountUsd);
  if (sourceTvlUsd == null || sourceTvlUsd < ROYCO_DAWN_MIN_TRANCHE_TVL_USD) return null;
  const sourceObservedAt = finiteNumber(params.vault.apyInfo?.duration?.end?.blockTimestamp);
  if (
    sourceObservedAt == null ||
    sourceObservedAt > params.observedAt + 60 ||
    params.observedAt - sourceObservedAt > SUPPLEMENTAL_SOURCE_STALE_THRESHOLD_MS / 1000
  ) {
    return null;
  }
  const sourcePool = normalizeTokenAddress(params.vault.address ?? params.vault.shareToken?.contractAddress ?? "");
  const marketName = params.market.name?.trim() || "Royco Dawn market";
  const sourceKey = `royco-dawn:${params.market.chainId}:${marketId}:${params.side}`;
  const sideLabel = params.side === "senior" ? "Senior" : "Junior";

  return {
    stablecoinId: params.trackedAsset.stablecoinId,
    symbol: params.trackedAsset.symbol,
    chain: params.chain,
    address: params.vault.depositToken?.contractAddress ?? null,
    yield: {
      currentApy: apyRatio * 100,
      apyBase: apyRatio * 100,
      apyReward: null,
      sourcePool: sourcePool || marketId,
      sourceTvlUsd,
      dataSource: "protocol-api",
      exchangeRate: null,
      sourceKey,
      yieldSource: `Royco Dawn ${sideLabel}: ${marketName}`,
      yieldType: "structured-tranche",
      project: "royco-dawn",
      chain: params.chain,
      sourceObservedAt: Math.floor(sourceObservedAt),
      comparisonAnchorObservedAt: null,
      sourceRisk: sourceRiskForTranche({
        side: params.side,
        market: params.market,
        vault: params.vault,
        chain: params.chain,
      }),
    },
  };
}

function buildExploreBody(pageIndex: number): string {
  return JSON.stringify({
    page: {
      index: pageIndex,
      size: ROYCO_DAWN_PAGE_SIZE,
    },
    filters: [
      {
        id: "listingType",
        value: "verified",
        condition: "eq",
      },
    ],
    sorting: [
      {
        id: "totalTvl",
        desc: true,
      },
    ],
  });
}

export interface RoycoDawnSourceResult {
  candidates: ResolvedYieldCandidate[];
  /**
   * SRC-SUPP-2: true when the paginated walk ended early — a non-ok page
   * response or a thrown fetch. The caller must retain the previous snapshot
   * instead of replacing it with this partial list.
   */
  degraded: boolean;
}

export async function fetchRoycoDawnSources(signal?: AbortSignal): Promise<RoycoDawnSourceResult> {
  const budget = createOptionalSourceBudget("Royco Dawn sources", OPTIONAL_PROTOCOL_API_BUDGET_MS, signal);
  const trackedByAddress = buildTrackedAssetByChainAddress();
  const observedAt = Math.floor(Date.now() / 1000);
  const results: ResolvedYieldCandidate[] = [];

  try {
    let pageIndex = 1;
    while (!budget.budgetController.signal.aborted) {
      throwIfAborted(budget.budgetController.signal);
      const result = await fetchJsonWithRetry<RoycoExploreResponse>(
        ROYCO_DAWN_EXPLORE_URL,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
          },
          body: buildExploreBody(pageIndex),
          signal: budget.signal,
        },
        0,
        { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS },
      );
      if (!result?.response.ok) return { candidates: results, degraded: true };

      const body = result.body;
      if (!Array.isArray(body.data)) return { candidates: results, degraded: true };
      const markets = body.data;
      if (markets.length === 0) break;

      const detailTargets: Array<{ discovery: RoycoMarket; chain: string; marketId: string }> = [];
      for (const discovery of markets) {
        const chain = normalizeChainId(discovery.chainId);
        if (!chain || discovery.majorType !== "marketv2" || discovery.listingType !== "verified") continue;
        const marketId = discovery.marketId;
        if (!marketId?.trim()) return { candidates: results, degraded: true };
        detailTargets.push({ discovery, chain, marketId });
      }

      for (let offset = 0; offset < detailTargets.length; offset += ROYCO_DAWN_DETAIL_CONCURRENCY) {
        throwIfAborted(budget.budgetController.signal);
        const details = await Promise.all(
          detailTargets.slice(offset, offset + ROYCO_DAWN_DETAIL_CONCURRENCY).map(async ({ discovery, chain, marketId }) => {
            // The ecosystem snapshot mixes Day and Dawn and reports TVL in native NAV units.
            // Use it only for discovery; the detail endpoint preserves Dawn's USD/risk schema.
            const detail = await fetchJsonWithRetry<RoycoMarket>(
              `https://dawn.royco.org/api/v1/market/info/${discovery.chainId}/${encodeURIComponent(marketId)}`,
              { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: budget.signal },
              0,
              { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS },
            );
            return { discovery, chain, marketId, detail };
          }),
        );

        for (const { discovery, chain, marketId, detail } of details) {
          if (!detail?.response.ok) return { candidates: results, degraded: true };
          const market = detail.body;
          if (
            market.chainId !== discovery.chainId ||
            market.marketId?.toLowerCase() !== marketId.toLowerCase() ||
            market.majorType !== "marketv2"
          ) {
            return { candidates: results, degraded: true };
          }
          const marketTvlUsd = finiteNumber(market.tvlUsd);
          if (marketTvlUsd == null || marketTvlUsd < ROYCO_DAWN_MIN_MARKET_TVL_USD) continue;
          if (market.listingType !== "verified") continue;

          const seniorVault = market.seniorVault ?? null;
          if (seniorVault) {
            const trackedAsset = resolveVaultDepositToken(seniorVault, chain, trackedByAddress);
            if (trackedAsset) {
              const candidate = buildTrancheCandidate({
                side: "senior",
                market,
                vault: seniorVault,
                chain,
                trackedAsset,
                observedAt,
              });
              if (candidate) results.push(candidate);
            }
          }

          const juniorVault = market.juniorVault ?? null;
          if (juniorVault) {
            const trackedAsset = resolveVaultDepositToken(juniorVault, chain, trackedByAddress);
            if (trackedAsset) {
              const candidate = buildTrancheCandidate({
                side: "junior",
                market,
                vault: juniorVault,
                chain,
                trackedAsset,
                observedAt,
              });
              if (candidate) results.push(candidate);
            }
          }
        }
      }

      pageIndex += 1;
      if (
        markets.length < ROYCO_DAWN_PAGE_SIZE ||
        (typeof body.count === "number" && (pageIndex - 1) * ROYCO_DAWN_PAGE_SIZE >= body.count)
      ) {
        break;
      }
    }

    throwIfAborted(budget.budgetController.signal);
    return { candidates: results, degraded: false };
  } catch (error) {
    if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
    if (budget.budgetController.signal.aborted) {
      logWorkerEvent({
        scope: "lib",
        level: "warn",
        event: "royco-dawn-sources-budget-exhausted",
        job: "sync-yield-supplemental",
        provider: "royco-dawn",
        source: "yield-supplemental",
        message: "Royco Dawn sources budget exhausted; keeping partial results",
        metadata: { resultCount: results.length },
      });
    } else {
      logWorkerEvent({
        scope: "lib",
        level: "warn",
        event: "royco_dawn_sources_failed",
        job: "sync-yield-supplemental",
        provider: "royco-dawn",
        source: "yield-supplemental",
        message: "Royco Dawn supplemental yield sources failed",
        error,
      });
    }
    return { candidates: results, degraded: true };
  } finally {
    budget.cleanup();
  }
}
