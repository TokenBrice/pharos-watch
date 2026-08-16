import {
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  parseAbi,
} from "viem/utils";

import { canonicalExitRouteAssetKey } from "@shared/lib/exit-route-identity";
import {
  DEX_CURVE_STABLESWAP_MEASURED_FRESHNESS_MAX_SEC,
  DEX_MEASURED_TARGET_SCHEMA_VERSION,
  buildDexMeasuredExecutionTargetId,
  type DexMeasuredExecutionCurveCompositeProof,
  type DexMeasuredExecutionProfile,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import { throwIfAborted } from "../../lib/abort";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import {
  fetchEvmBlockHeader,
  fetchEvmCallHexAtBlock,
  fetchEvmCodeStatusAtBlock,
  fetchEvmMulticall3Aggregate3AtBlock,
  type EvmBlockHeader,
  type EvmCodeAtBlockResult,
  type EvmMulticall3Call,
  type EvmMulticall3Result,
} from "../../lib/evm-rpc";
import {
  DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS,
  type DexMeasuredExecutionBudgetStopReason,
  type DexMeasuredExecutionRpcBudget,
  type DexMeasuredRawQuotePoint,
} from "./profiles";
import { usdToRawAmount } from "./fixed-point";
import { executeEvmQuotePlan, materializeEvmQuotePoint } from "./evm-quote-plan";
import {
  CURVE_ALUSD_3CRV_METAPOOL_ADDRESS,
  CURVE_DOLA_FRAXBP_METAPOOL_ADDRESS,
  CURVE_DOLA_SUSDE_COMPOSITE_POOL_ADDRESS,
  CURVE_EUSD_FRAXBP_METAPOOL_ADDRESS,
  CURVE_GUSD_3CRV_METAPOOL_ADDRESS,
  CURVE_MAI_AM3CRV_METAPOOL_ADDRESS,
  CURVE_MEUSD_CRV2POOL_METAPOOL_ADDRESS,
  CURVE_MSUSD_FRAXBP_METAPOOL_ADDRESS,
  CURVE_NXUSD_COMPOSITE_POOL_ADDRESS,
  CURVE_OUSD_3CRV_METAPOOL_ADDRESS,
  CURVE_TUSD_AM3CRV_METAPOOL_ADDRESS,
  CURVE_USD1_COMPOSITE_POOL_ADDRESS,
} from "./curve-composite-identities";

const POOL_ABI = parseAbi([
  "function coins(uint256) view returns (address)",
  "function get_dy(int128 i,int128 j,uint256 dx) view returns (uint256)",
  "function get_dy_underlying(int128 i,int128 j,uint256 dx) view returns (uint256)",
  "function stored_rates() view returns (uint256[])",
]);
const FACTORY_ABI = parseAbi([
  "function pool_list(uint256) view returns (address)",
  "function get_coins(address pool) view returns (address[])",
  "function get_implementation_address(address pool) view returns (address)",
  "function get_pool_asset_types(address pool) view returns (uint8[])",
  "function get_base_pool(address pool) view returns (address)",
  "function get_underlying_coins(address pool) view returns (address[])",
  "function get_underlying_decimals(address pool) view returns (uint256[])",
  "function is_meta(address pool) view returns (bool)",
]);
const LEGACY_FACTORY_ARRAY_ABI = parseAbi([
  "function get_coins(address pool) view returns (address[4])",
  "function get_underlying_coins(address pool) view returns (address[8])",
  "function get_underlying_decimals(address pool) view returns (uint256[8])",
]);
const MAIN_REGISTRY_ARRAY_ABI = parseAbi([
  "function get_coins(address pool) view returns (address[8])",
  "function get_underlying_coins(address pool) view returns (address[8])",
  "function get_underlying_decimals(address pool) view returns (uint256[8])",
]);
const MAIN_REGISTRY_ABI = parseAbi([
  "function get_pool_from_lp_token(address lpToken) view returns (address)",
]);
const ERC20_ABI = parseAbi(["function decimals() view returns (uint8)"]);
const ERC4626_ABI = parseAbi([
  "function asset() view returns (address)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
]);
const EVM_ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const BATCH_SIZE = 8;
const MULTICALL_GAS = "0x1c9c380";

export const CURVE_RATE_BEARING_ADAPTER_PROFILE_ID =
  "curve-stableswap-ng-rate-bearing-get-dy-v1" as const;
export const CURVE_METAPOOL_ADAPTER_PROFILE_ID =
  "curve-stableswap-ng-metapool-underlying-v1" as const;

export interface CurveCompositeToken {
  address: `0x${string}`;
  symbol: string;
  decimals: number;
  trackedAssetId?: string;
  referenceAssetId?: string;
}

interface CurveCompositePolicyBase {
  chain: "ethereum" | "avalanche" | "polygon";
  stablecoinId: string;
  adapterProfileId:
    | typeof CURVE_RATE_BEARING_ADAPTER_PROFILE_ID
    | typeof CURVE_METAPOOL_ADAPTER_PROFILE_ID;
  poolAddress: `0x${string}`;
  expectedPoolCodeHash: `0x${string}`;
  factoryAddress: `0x${string}`;
  expectedFactoryCodeHash: `0x${string}`;
  factoryPoolIndex: number;
  expectedRegistryId: "factory-stable-ng" | "factory" | "main";
  factoryArrayEncoding: "dynamic" | "legacy-fixed" | "registry-fixed";
  implementationBinding: "factory-lookup" | "standalone-runtime";
  implementationAddress: `0x${string}`;
  expectedImplementationCodeHash: `0x${string}`;
  poolTokens: readonly [CurveCompositeToken, CurveCompositeToken];
  executionTokens: readonly CurveCompositeToken[];
  inputIndex: number;
  outputIndex: number;
  quoteFunction: "get_dy" | "get_dy_underlying";
  mode: "shadow" | "active";
  scoreEligible: boolean;
}

export interface CurveRateBearingPoolPolicy extends CurveCompositePolicyBase {
  adapterProfileId: typeof CURVE_RATE_BEARING_ADAPTER_PROFILE_ID;
  quoteFunction: "get_dy";
  expectedAssetTypes: readonly [0, 3];
  rateProvider: {
    kind: "erc4626";
    tokenIndex: 1;
    providerAddress: `0x${string}`;
    expectedProviderCodeHash: `0x${string}`;
    underlyingAddress: `0x${string}`;
  };
}

export interface CurveMetapoolPolicy extends CurveCompositePolicyBase {
  adapterProfileId: typeof CURVE_METAPOOL_ADAPTER_PROFILE_ID;
  quoteFunction: "get_dy_underlying";
  metapool: {
    basePoolBinding: "factory-get-base-pool" | "registry-lp-token";
    basePoolAddress: `0x${string}`;
    expectedBasePoolCodeHash: `0x${string}`;
    basePoolTokens: readonly CurveCompositeToken[];
  };
}

export type CurveCompositePoolPolicy = CurveRateBearingPoolPolicy | CurveMetapoolPolicy;

/**
 * Exact reviewed DOLA/sUSDe StableSwap-NG deployment. The pool applies the
 * sUSDe ERC-4626 rate internally; this policy never simulates that rate.
 */
export const CURVE_DOLA_SUSDE_RATE_BEARING_POLICY: CurveRateBearingPoolPolicy = {
  chain: "ethereum",
  stablecoinId: "susde-ethena",
  adapterProfileId: CURVE_RATE_BEARING_ADAPTER_PROFILE_ID,
  poolAddress: CURVE_DOLA_SUSDE_COMPOSITE_POOL_ADDRESS,
  expectedPoolCodeHash: "0x94804f252de72c79ef819798e3149d5d461d4fbc8417aa0f5e314070c3cb599f",
  factoryAddress: "0x6a8cbed756804b16e05e741edabd5cb544ae21bf",
  expectedFactoryCodeHash: "0xb78c1b32cd364260f3fa497ccc7e98c73cdc26bdae2d3635e763ee8b59a1d6fd",
  factoryPoolIndex: 298,
  expectedRegistryId: "factory-stable-ng",
  factoryArrayEncoding: "dynamic",
  implementationBinding: "factory-lookup",
  implementationAddress: "0xdcc91f930b42619377c200ba05b7513f2958b202",
  expectedImplementationCodeHash: "0xe2a3dd8d583b86eb7f562b4307aab6e5a373ddb5c6b348e4cf63d41914f35a9f",
  poolTokens: [
    {
      address: "0x865377367054516e17014ccded1e7d814edc9ce4",
      symbol: "DOLA",
      decimals: 18,
      trackedAssetId: "dola-inverse-finance",
    },
    {
      address: "0x9d39a5de30e57443bff2a8307a4256c8797a3497",
      symbol: "sUSDe",
      decimals: 18,
      trackedAssetId: "susde-ethena",
    },
  ],
  executionTokens: [
    {
      address: "0x865377367054516e17014ccded1e7d814edc9ce4",
      symbol: "DOLA",
      decimals: 18,
      trackedAssetId: "dola-inverse-finance",
    },
    {
      address: "0x9d39a5de30e57443bff2a8307a4256c8797a3497",
      symbol: "sUSDe",
      decimals: 18,
      trackedAssetId: "susde-ethena",
    },
  ],
  inputIndex: 1,
  outputIndex: 0,
  quoteFunction: "get_dy",
  expectedAssetTypes: [0, 3],
  rateProvider: {
    kind: "erc4626",
    tokenIndex: 1,
    providerAddress: "0x9d39a5de30e57443bff2a8307a4256c8797a3497",
    expectedProviderCodeHash: "0xadc4989c92fab525a1a22b3f60f5b61b77f9eb11b693e8afeba5736ea4b502e3",
    underlyingAddress: "0x4c9edd5852cd905f086c759e8383e09bff1e68b3",
  },
  mode: "shadow",
  scoreEligible: false,
};

/**
 * Exact reviewed USD1 metapool path. The executable path is USD1 -> USDC via
 * the factory-proved USDC/USDT base pool and get_dy_underlying.
 */
export const CURVE_USD1_METAPOOL_POLICY: CurveMetapoolPolicy = {
  chain: "ethereum",
  stablecoinId: "usd1-world-liberty-financial",
  adapterProfileId: CURVE_METAPOOL_ADAPTER_PROFILE_ID,
  poolAddress: CURVE_USD1_COMPOSITE_POOL_ADDRESS,
  expectedPoolCodeHash: "0x25478b25c12a81937ddb75e0c5ed8ca8ab248a102316873d092f49ca870b8cca",
  factoryAddress: "0x6a8cbed756804b16e05e741edabd5cb544ae21bf",
  expectedFactoryCodeHash: "0xb78c1b32cd364260f3fa497ccc7e98c73cdc26bdae2d3635e763ee8b59a1d6fd",
  factoryPoolIndex: 553,
  expectedRegistryId: "factory-stable-ng",
  factoryArrayEncoding: "dynamic",
  implementationBinding: "factory-lookup",
  implementationAddress: "0xede71f77d7c900dca5892720e76316c6e575f0f7",
  expectedImplementationCodeHash: "0x9d37af7ff5467ed7db9fe783986e9d7dabbb9dbb5a74e1da50cea67478a584bc",
  poolTokens: [
    {
      address: "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d",
      symbol: "USD1",
      decimals: 18,
      trackedAssetId: "usd1-world-liberty-financial",
    },
    {
      address: "0x4f493b7de8aac7d55f71853688b1f7c8f0243c85",
      symbol: "crv2pool",
      decimals: 18,
    },
  ],
  executionTokens: [
    {
      address: "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d",
      symbol: "USD1",
      decimals: 18,
      trackedAssetId: "usd1-world-liberty-financial",
    },
    {
      address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      symbol: "USDC",
      decimals: 6,
      trackedAssetId: "usdc-circle",
    },
    {
      address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
      symbol: "USDT",
      decimals: 6,
      trackedAssetId: "usdt-tether",
    },
  ],
  inputIndex: 0,
  outputIndex: 1,
  quoteFunction: "get_dy_underlying",
  metapool: {
    basePoolBinding: "factory-get-base-pool",
    basePoolAddress: "0x4f493b7de8aac7d55f71853688b1f7c8f0243c85",
    expectedBasePoolCodeHash: "0x5f0f1709fa823592ad75b27e32af00a8715d620dcb269be7c26fd5c873c1ce0e",
    basePoolTokens: [
      {
        address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        symbol: "USDC",
        decimals: 6,
        trackedAssetId: "usdc-circle",
      },
      {
        address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
        symbol: "USDT",
        decimals: 6,
        trackedAssetId: "usdt-tether",
      },
    ],
  },
  mode: "shadow",
  scoreEligible: false,
};

/**
 * Exact reviewed Avalanche NXUSD metapool path. The legacy factory exposes
 * fixed-width identity arrays; execution is NXUSD -> avUSDC through the
 * factory-proved av3CRV base pool and get_dy_underlying.
 */
export const CURVE_NXUSD_METAPOOL_POLICY: CurveMetapoolPolicy = {
  chain: "avalanche",
  stablecoinId: "nxusd-nereus",
  adapterProfileId: CURVE_METAPOOL_ADAPTER_PROFILE_ID,
  poolAddress: CURVE_NXUSD_COMPOSITE_POOL_ADDRESS,
  expectedPoolCodeHash: "0x189567179f11c501b47c595502e59f75c31e36e0a8cf95ba5f73ef6fff5d74a3",
  factoryAddress: "0xb17b674d9c5cb2e441f8e196a2f048a81355d031",
  expectedFactoryCodeHash: "0x7b76a635c41c7b2a6bbdd9e3a5d2df9f9c662c9292f97dd9a2a847652f5f4359",
  factoryPoolIndex: 66,
  expectedRegistryId: "factory",
  factoryArrayEncoding: "legacy-fixed",
  implementationBinding: "factory-lookup",
  implementationAddress: "0xa237034249290de2b07988ac64b96f22c0e76fe0",
  expectedImplementationCodeHash:
    "0xa14fbe91ed30d41ab822e2d3ef28a1ae375f3e60da77348fca77b7dd0a0b8641",
  poolTokens: [
    {
      address: "0xf14f4ce569cb3679e99d5059909e23b07bd2f387",
      symbol: "NXUSD",
      decimals: 18,
      trackedAssetId: "nxusd-nereus",
    },
    {
      address: "0x1337bedc9d22ecbe766df105c9623922a27963ec",
      symbol: "av3CRV",
      decimals: 18,
    },
  ],
  executionTokens: [
    {
      address: "0xf14f4ce569cb3679e99d5059909e23b07bd2f387",
      symbol: "NXUSD",
      decimals: 18,
      trackedAssetId: "nxusd-nereus",
    },
    {
      address: "0x47afa96cdc9fab46904a55a6ad4bf6660b53c38a",
      symbol: "avDAI",
      decimals: 18,
    },
    {
      address: "0x46a51127c3ce23fb7ab1de06226147f446e4a857",
      symbol: "avUSDC",
      decimals: 6,
      referenceAssetId: "usdc-circle",
    },
    {
      address: "0x532e6537fea298397212f09a61e03311686f548e",
      symbol: "avUSDT",
      decimals: 6,
    },
  ],
  inputIndex: 0,
  outputIndex: 2,
  quoteFunction: "get_dy_underlying",
  metapool: {
    basePoolBinding: "factory-get-base-pool",
    basePoolAddress: "0x7f90122bf0700f9e7e1f688fe926940e8839f353",
    expectedBasePoolCodeHash:
      "0xa3fc544c3d02269e8a5d1fef9bda368f32ed62e6da938e202549aa1b5fc520c8",
    basePoolTokens: [
      {
        address: "0x47afa96cdc9fab46904a55a6ad4bf6660b53c38a",
        symbol: "avDAI",
        decimals: 18,
      },
      {
        address: "0x46a51127c3ce23fb7ab1de06226147f446e4a857",
        symbol: "avUSDC",
        decimals: 6,
      },
      {
        address: "0x532e6537fea298397212f09a61e03311686f548e",
        symbol: "avUSDT",
        decimals: 6,
      },
    ],
  },
  mode: "shadow",
  scoreEligible: false,
};

const ETHEREUM_DAI: CurveCompositeToken = {
  address: "0x6b175474e89094c44da98b954eedeac495271d0f",
  symbol: "DAI",
  decimals: 18,
};
const ETHEREUM_USDC: CurveCompositeToken = {
  address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  symbol: "USDC",
  decimals: 6,
  trackedAssetId: "usdc-circle",
};
const ETHEREUM_USDT: CurveCompositeToken = {
  address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
  symbol: "USDT",
  decimals: 6,
  trackedAssetId: "usdt-tether",
};
const ETHEREUM_3CRV: CurveCompositeToken = {
  address: "0x6c3f90f043a72fa612cbac8115ee7e52bde6e490",
  symbol: "3Crv",
  decimals: 18,
};
const ETHEREUM_FRAX: CurveCompositeToken = {
  address: "0x853d955acef822db058eb8505911ed77f175b99e",
  symbol: "FRAX",
  decimals: 18,
};
const ETHEREUM_FRAXBP: CurveCompositeToken = {
  address: "0x3175df0976dfa876431c2e9ee6bc45b65d3473cc",
  symbol: "FRAXBP",
  decimals: 18,
};
const ETHEREUM_CRV2POOL: CurveCompositeToken = {
  address: "0x4f493b7de8aac7d55f71853688b1f7c8f0243c85",
  symbol: "crv2pool",
  decimals: 18,
};
const POLYGON_AMDAI: CurveCompositeToken = {
  address: "0x27f8d03b3a2196956ed754badc28d73be8830a6e",
  symbol: "amDAI",
  decimals: 18,
};
const POLYGON_AMUSDC: CurveCompositeToken = {
  address: "0x1a13f4ca1d028320a707d99520abfefca3998b7f",
  symbol: "amUSDC",
  decimals: 6,
  referenceAssetId: "usdc-circle",
};
const POLYGON_AMUSDT: CurveCompositeToken = {
  address: "0x60d55f02a771d515e077c9c2403a1ef324885cec",
  symbol: "amUSDT",
  decimals: 6,
};
const POLYGON_AM3CRV: CurveCompositeToken = {
  address: "0xe7a24ef0c5e95ffb0f6684b813a78f2a3ad7d171",
  symbol: "am3CRV",
  decimals: 18,
};

function activeMetapoolPolicy(
  policy: Omit<
    CurveMetapoolPolicy,
    "adapterProfileId" | "quoteFunction" | "mode" | "scoreEligible"
  >,
): CurveMetapoolPolicy {
  return {
    ...policy,
    adapterProfileId: CURVE_METAPOOL_ADAPTER_PROFILE_ID,
    quoteFunction: "get_dy_underlying",
    mode: "active",
    scoreEligible: true,
  };
}

/**
 * Owner-ratified metapool routes. Each entry is an exact physical deployment
 * with pinned registry, implementation, base-pool, token-order, and runtime
 * code identities. No other metapool is admitted by this adapter.
 */
export const CURVE_ALUSD_3CRV_METAPOOL_POLICY = activeMetapoolPolicy({
  chain: "ethereum",
  stablecoinId: "alusd-alchemix",
  poolAddress: CURVE_ALUSD_3CRV_METAPOOL_ADDRESS,
  expectedPoolCodeHash: "0x156700a4060f3d62786914b50cc60b2b840e6440401bea9a99c0acce0b58beda",
  factoryAddress: "0xb9fc157394af804a3578134a6585c0dc9cc990d4",
  expectedFactoryCodeHash: "0xd1b02d8c066dc343522d6aa5f6427b5245dc1f3276841ea48180cb0d0387e2ca",
  factoryPoolIndex: 12,
  expectedRegistryId: "factory",
  factoryArrayEncoding: "legacy-fixed",
  implementationBinding: "factory-lookup",
  implementationAddress: "0x5f890841f657d90e081babdb532a05996af79fe6",
  expectedImplementationCodeHash:
    "0x260a286cc14e91f4a2d4a966e2e5f5030543a7d2f090a623f5fa15ba174a50f3",
  poolTokens: [
    {
      address: "0xbc6da0fe9ad5f3b0d58160288917aa56653660e9",
      symbol: "alUSD",
      decimals: 18,
      trackedAssetId: "alusd-alchemix",
    },
    ETHEREUM_3CRV,
  ],
  executionTokens: [
    {
      address: "0xbc6da0fe9ad5f3b0d58160288917aa56653660e9",
      symbol: "alUSD",
      decimals: 18,
      trackedAssetId: "alusd-alchemix",
    },
    ETHEREUM_DAI,
    ETHEREUM_USDC,
    ETHEREUM_USDT,
  ],
  inputIndex: 0,
  outputIndex: 2,
  metapool: {
    basePoolBinding: "factory-get-base-pool",
    basePoolAddress: "0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7",
    expectedBasePoolCodeHash:
      "0x954a1e212c557c85043985931498ffa3e2fcbe7dfe9cd61513f36eb47d6f4dfc",
    basePoolTokens: [ETHEREUM_DAI, ETHEREUM_USDC, ETHEREUM_USDT],
  },
});

function ethereumFraxBpMetapool(input: {
  stablecoinId: string;
  poolAddress: `0x${string}`;
  factoryPoolIndex: number;
  token: CurveCompositeToken;
}): CurveMetapoolPolicy {
  return activeMetapoolPolicy({
    chain: "ethereum",
    stablecoinId: input.stablecoinId,
    poolAddress: input.poolAddress,
    expectedPoolCodeHash:
      "0xd1ea5822210a78c174b99e58a8d3803d68a3694868c6d796fee2b5cebe383f62",
    factoryAddress: "0xb9fc157394af804a3578134a6585c0dc9cc990d4",
    expectedFactoryCodeHash:
      "0xd1b02d8c066dc343522d6aa5f6427b5245dc1f3276841ea48180cb0d0387e2ca",
    factoryPoolIndex: input.factoryPoolIndex,
    expectedRegistryId: "factory",
    factoryArrayEncoding: "legacy-fixed",
    implementationBinding: "factory-lookup",
    implementationAddress: "0x33bb0e62d5e8c688e645dd46dfb48cd613250067",
    expectedImplementationCodeHash:
      "0x2c67f0058c5bebafdab722f691a698a56d1480b5dbaf9bca64bb036e9f24cf4a",
    poolTokens: [input.token, ETHEREUM_FRAXBP],
    executionTokens: [input.token, ETHEREUM_FRAX, ETHEREUM_USDC],
    inputIndex: 0,
    outputIndex: 2,
    metapool: {
      basePoolBinding: "factory-get-base-pool",
      basePoolAddress: "0xdcef968d416a41cdac0ed8702fac8128a64241a2",
      expectedBasePoolCodeHash:
        "0x304e2199bfe57413d95a53efb2f3df8ed69be12f7df5770b874c9b3a30d9cafd",
      basePoolTokens: [ETHEREUM_FRAX, ETHEREUM_USDC],
    },
  });
}

export const CURVE_DOLA_FRAXBP_METAPOOL_POLICY = ethereumFraxBpMetapool({
  stablecoinId: "dola-inverse-finance",
  poolAddress: CURVE_DOLA_FRAXBP_METAPOOL_ADDRESS,
  factoryPoolIndex: 176,
  token: {
    address: "0x865377367054516e17014ccded1e7d814edc9ce4",
    symbol: "DOLA",
    decimals: 18,
    trackedAssetId: "dola-inverse-finance",
  },
});

export const CURVE_EUSD_FRAXBP_METAPOOL_POLICY = ethereumFraxBpMetapool({
  stablecoinId: "eusd-electronic-usd",
  poolAddress: CURVE_EUSD_FRAXBP_METAPOOL_ADDRESS,
  factoryPoolIndex: 277,
  token: {
    address: "0xa0d69e286b938e21cbf7e51d71f6a4c8918f482f",
    symbol: "eUSD",
    decimals: 18,
    trackedAssetId: "eusd-electronic-usd",
  },
});

export const CURVE_MSUSD_FRAXBP_METAPOOL_POLICY = ethereumFraxBpMetapool({
  stablecoinId: "msusd-metronome",
  poolAddress: CURVE_MSUSD_FRAXBP_METAPOOL_ADDRESS,
  factoryPoolIndex: 251,
  token: {
    address: "0xab5eb14c09d416f0ac63661e57edb7aecdb9befa",
    symbol: "msUSD",
    decimals: 18,
    trackedAssetId: "msusd-metronome",
  },
});

export const CURVE_GUSD_3CRV_METAPOOL_POLICY = activeMetapoolPolicy({
  chain: "ethereum",
  stablecoinId: "gusd-gemini",
  poolAddress: CURVE_GUSD_3CRV_METAPOOL_ADDRESS,
  expectedPoolCodeHash: "0xce79330162abf07fc163331f9d9d1553b93dbf509eeafa1215fafa6113c5088e",
  factoryAddress: "0x90e00ace148ca3b23ac1bc8c240c2a7dd9c2d7f5",
  expectedFactoryCodeHash: "0x13d7cfcf1cef4bf310fa544567a427771c9be2c16bbf2c6be845d3d5f4cc5f22",
  factoryPoolIndex: 19,
  expectedRegistryId: "main",
  factoryArrayEncoding: "registry-fixed",
  implementationBinding: "standalone-runtime",
  implementationAddress: CURVE_GUSD_3CRV_METAPOOL_ADDRESS,
  expectedImplementationCodeHash:
    "0xce79330162abf07fc163331f9d9d1553b93dbf509eeafa1215fafa6113c5088e",
  poolTokens: [
    {
      address: "0x056fd409e1d7a124bd7017459dfea2f387b6d5cd",
      symbol: "GUSD",
      decimals: 2,
      trackedAssetId: "gusd-gemini",
    },
    ETHEREUM_3CRV,
  ],
  executionTokens: [
    {
      address: "0x056fd409e1d7a124bd7017459dfea2f387b6d5cd",
      symbol: "GUSD",
      decimals: 2,
      trackedAssetId: "gusd-gemini",
    },
    ETHEREUM_DAI,
    ETHEREUM_USDC,
    ETHEREUM_USDT,
  ],
  inputIndex: 0,
  outputIndex: 2,
  metapool: {
    basePoolBinding: "registry-lp-token",
    basePoolAddress: "0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7",
    expectedBasePoolCodeHash:
      "0x954a1e212c557c85043985931498ffa3e2fcbe7dfe9cd61513f36eb47d6f4dfc",
    basePoolTokens: [ETHEREUM_DAI, ETHEREUM_USDC, ETHEREUM_USDT],
  },
});

export const CURVE_MEUSD_CRV2POOL_METAPOOL_POLICY = activeMetapoolPolicy({
  chain: "ethereum",
  stablecoinId: "meusd-mezo",
  poolAddress: CURVE_MEUSD_CRV2POOL_METAPOOL_ADDRESS,
  expectedPoolCodeHash: "0xfeb82e1a7ec3cc0f6773f0ea2d12acaadfa4f8b979a94a23c02626fefd5f9eb0",
  factoryAddress: "0x6a8cbed756804b16e05e741edabd5cb544ae21bf",
  expectedFactoryCodeHash: "0xb78c1b32cd364260f3fa497ccc7e98c73cdc26bdae2d3635e763ee8b59a1d6fd",
  factoryPoolIndex: 518,
  expectedRegistryId: "factory-stable-ng",
  factoryArrayEncoding: "dynamic",
  implementationBinding: "factory-lookup",
  implementationAddress: "0xede71f77d7c900dca5892720e76316c6e575f0f7",
  expectedImplementationCodeHash:
    "0x9d37af7ff5467ed7db9fe783986e9d7dabbb9dbb5a74e1da50cea67478a584bc",
  poolTokens: [
    {
      address: "0xdd468a1ddc392dcdbef6db6e34e89aa338f9f186",
      symbol: "MUSD",
      decimals: 18,
      trackedAssetId: "meusd-mezo",
    },
    ETHEREUM_CRV2POOL,
  ],
  executionTokens: [
    {
      address: "0xdd468a1ddc392dcdbef6db6e34e89aa338f9f186",
      symbol: "MUSD",
      decimals: 18,
      trackedAssetId: "meusd-mezo",
    },
    ETHEREUM_USDC,
    ETHEREUM_USDT,
  ],
  inputIndex: 0,
  outputIndex: 1,
  metapool: {
    basePoolBinding: "factory-get-base-pool",
    basePoolAddress: ETHEREUM_CRV2POOL.address,
    expectedBasePoolCodeHash:
      "0x5f0f1709fa823592ad75b27e32af00a8715d620dcb269be7c26fd5c873c1ce0e",
    basePoolTokens: [ETHEREUM_USDC, ETHEREUM_USDT],
  },
});

export const CURVE_OUSD_3CRV_METAPOOL_POLICY = activeMetapoolPolicy({
  chain: "ethereum",
  stablecoinId: "ousd-origin-protocol",
  poolAddress: CURVE_OUSD_3CRV_METAPOOL_ADDRESS,
  expectedPoolCodeHash: "0x156700a4060f3d62786914b50cc60b2b840e6440401bea9a99c0acce0b58beda",
  factoryAddress: "0xb9fc157394af804a3578134a6585c0dc9cc990d4",
  expectedFactoryCodeHash: "0xd1b02d8c066dc343522d6aa5f6427b5245dc1f3276841ea48180cb0d0387e2ca",
  factoryPoolIndex: 9,
  expectedRegistryId: "factory",
  factoryArrayEncoding: "legacy-fixed",
  implementationBinding: "factory-lookup",
  implementationAddress: "0x5f890841f657d90e081babdb532a05996af79fe6",
  expectedImplementationCodeHash:
    "0x260a286cc14e91f4a2d4a966e2e5f5030543a7d2f090a623f5fa15ba174a50f3",
  poolTokens: [
    {
      address: "0x2a8e1e676ec238d8a992307b495b45b3feaa5e86",
      symbol: "OUSD",
      decimals: 18,
      trackedAssetId: "ousd-origin-protocol",
    },
    ETHEREUM_3CRV,
  ],
  executionTokens: [
    {
      address: "0x2a8e1e676ec238d8a992307b495b45b3feaa5e86",
      symbol: "OUSD",
      decimals: 18,
      trackedAssetId: "ousd-origin-protocol",
    },
    ETHEREUM_DAI,
    ETHEREUM_USDC,
    ETHEREUM_USDT,
  ],
  inputIndex: 0,
  outputIndex: 2,
  metapool: {
    basePoolBinding: "factory-get-base-pool",
    basePoolAddress: "0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7",
    expectedBasePoolCodeHash:
      "0x954a1e212c557c85043985931498ffa3e2fcbe7dfe9cd61513f36eb47d6f4dfc",
    basePoolTokens: [ETHEREUM_DAI, ETHEREUM_USDC, ETHEREUM_USDT],
  },
});

function polygonAm3CrvMetapool(input: {
  stablecoinId: string;
  poolAddress: `0x${string}`;
  factoryPoolIndex: number;
  token: CurveCompositeToken;
}): CurveMetapoolPolicy {
  return activeMetapoolPolicy({
    chain: "polygon",
    stablecoinId: input.stablecoinId,
    poolAddress: input.poolAddress,
    expectedPoolCodeHash:
      "0x3e54554b2fcc52bfb0487a66d242ad697094e4f9a0a6565c5ff61827e6467c79",
    factoryAddress: "0x722272d36ef0da72ff51c5a65db7b870e2e8d4ee",
    expectedFactoryCodeHash:
      "0x7b76a635c41c7b2a6bbdd9e3a5d2df9f9c662c9292f97dd9a2a847652f5f4359",
    factoryPoolIndex: input.factoryPoolIndex,
    expectedRegistryId: "factory",
    factoryArrayEncoding: "legacy-fixed",
    implementationBinding: "factory-lookup",
    implementationAddress: "0x4fb93d7d320e8a263f22f62c2059dfc2a8bcbc4c",
    expectedImplementationCodeHash:
      "0x9afd1238323750dbcd66006d7a82c835f15924a16f635377422b05ce8f28406a",
    poolTokens: [input.token, POLYGON_AM3CRV],
    executionTokens: [input.token, POLYGON_AMDAI, POLYGON_AMUSDC, POLYGON_AMUSDT],
    inputIndex: 0,
    outputIndex: 2,
    metapool: {
      basePoolBinding: "factory-get-base-pool",
      basePoolAddress: "0x445fe580ef8d70ff569ab36e80c647af338db351",
      expectedBasePoolCodeHash:
        "0xd6eed64965cb4079ed779ee585297302ae36ec12626b69ae318c836df371165b",
      basePoolTokens: [POLYGON_AMDAI, POLYGON_AMUSDC, POLYGON_AMUSDT],
    },
  });
}

export const CURVE_MAI_AM3CRV_METAPOOL_POLICY = polygonAm3CrvMetapool({
  stablecoinId: "mai-qidao",
  poolAddress: CURVE_MAI_AM3CRV_METAPOOL_ADDRESS,
  factoryPoolIndex: 107,
  token: {
    address: "0xa3fa99a148fa48d14ed51d610c367c61876997f1",
    symbol: "miMATIC",
    decimals: 18,
    trackedAssetId: "mai-qidao",
  },
});

export const CURVE_TUSD_AM3CRV_METAPOOL_POLICY = polygonAm3CrvMetapool({
  stablecoinId: "tusd-trueusd",
  poolAddress: CURVE_TUSD_AM3CRV_METAPOOL_ADDRESS,
  factoryPoolIndex: 152,
  token: {
    address: "0x2e1ad108ff1d8c782fcbbb89aad783ac49586756",
    symbol: "TUSD",
    decimals: 18,
    trackedAssetId: "tusd-trueusd",
  },
});

export const CURVE_R3_METAPOOL_POLICIES = [
  CURVE_ALUSD_3CRV_METAPOOL_POLICY,
  CURVE_DOLA_FRAXBP_METAPOOL_POLICY,
  CURVE_EUSD_FRAXBP_METAPOOL_POLICY,
  CURVE_GUSD_3CRV_METAPOOL_POLICY,
  CURVE_MAI_AM3CRV_METAPOOL_POLICY,
  CURVE_MEUSD_CRV2POOL_METAPOOL_POLICY,
  CURVE_MSUSD_FRAXBP_METAPOOL_POLICY,
  CURVE_OUSD_3CRV_METAPOOL_POLICY,
  CURVE_TUSD_AM3CRV_METAPOOL_POLICY,
] as const satisfies readonly CurveMetapoolPolicy[];

const POLICIES: readonly CurveCompositePoolPolicy[] = [
  CURVE_DOLA_SUSDE_RATE_BEARING_POLICY,
  CURVE_USD1_METAPOOL_POLICY,
  CURVE_NXUSD_METAPOOL_POLICY,
  ...CURVE_R3_METAPOOL_POLICIES,
];

function canonicalAddress(value: unknown): `0x${string}` | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return EVM_ADDRESS_PATTERN.test(normalized) ? (normalized as `0x${string}`) : null;
}

function decodeFactoryAddressArray(
  policy: CurveCompositePoolPolicy,
  functionName: "get_coins" | "get_underlying_coins",
  data: `0x${string}`,
  expectedLength: number,
): readonly string[] | null {
  try {
    const decoded = decodeFunctionResult({
      abi: policy.factoryArrayEncoding === "legacy-fixed"
        ? LEGACY_FACTORY_ARRAY_ABI
        : policy.factoryArrayEncoding === "registry-fixed"
          ? MAIN_REGISTRY_ARRAY_ABI
          : FACTORY_ABI,
      functionName,
      data,
    } as never) as readonly string[];
    if (policy.factoryArrayEncoding === "dynamic") return decoded;
    if (
      decoded.length < expectedLength ||
      decoded.slice(expectedLength).some(
        (address) => canonicalAddress(address) !== "0x0000000000000000000000000000000000000000",
      )
    ) return null;
    return decoded.slice(0, expectedLength);
  } catch {
    return null;
  }
}

function decodeFactoryDecimalsArray(
  policy: CurveCompositePoolPolicy,
  data: `0x${string}`,
  expectedLength: number,
): readonly bigint[] | null {
  try {
    const decoded = decodeFunctionResult({
      abi: policy.factoryArrayEncoding === "legacy-fixed"
        ? LEGACY_FACTORY_ARRAY_ABI
        : policy.factoryArrayEncoding === "registry-fixed"
          ? MAIN_REGISTRY_ARRAY_ABI
          : FACTORY_ABI,
      functionName: "get_underlying_decimals",
      data,
    } as never) as readonly bigint[];
    if (policy.factoryArrayEncoding === "dynamic") return decoded;
    if (
      decoded.length < expectedLength ||
      decoded.slice(expectedLength).some((decimals) => decimals !== 0n)
    ) return null;
    return decoded.slice(0, expectedLength);
  } catch {
    return null;
  }
}

export function getCurveCompositePolicy(
  chain: string,
  poolAddress: string,
): CurveCompositePoolPolicy | null {
  const normalizedChain = chain.trim().toLowerCase();
  const normalizedAddress = canonicalAddress(poolAddress);
  return POLICIES.find(
    (policy) => policy.chain === normalizedChain && policy.poolAddress === normalizedAddress,
  ) ?? null;
}

export function isCurveCompositeAdapterProfileId(profileId: string): boolean {
  return profileId === CURVE_RATE_BEARING_ADAPTER_PROFILE_ID ||
    profileId === CURVE_METAPOOL_ADAPTER_PROFILE_ID;
}

interface CurveCompositePoolSource {
  poolAddress?: string;
  apiIsBroken?: boolean;
  registryId: string;
  isMetaPool: boolean;
  basePoolAddress?: string;
  poolCoins?: readonly {
    address: string;
    symbol: string;
    decimals: number;
    usdPrice: number;
    isBasePoolLpToken: boolean;
  }[];
  underlyingCoins?: readonly {
    address: string;
    symbol: string;
    decimals: number;
    usdPrice: number;
  }[];
}

/** Build one exact reviewed target from the current Curve source row. */
export function buildCurveCompositeMeasuredExecutionTarget(input: {
  curveData: CurveCompositePoolSource | undefined;
  chain: string;
  stablecoinId: string;
  chainAddressToId: Map<string, string>;
  stablecoinPriceById?: Map<string, number>;
  retainedTvlUsd: number;
  capturedAt: number;
}): DexMeasuredExecutionTarget | null {
  const curveData = input.curveData;
  const policy = curveData?.poolAddress
    ? getCurveCompositePolicy(input.chain, curveData.poolAddress)
    : null;
  if (
    !curveData ||
    !policy ||
    curveData.apiIsBroken ||
    input.stablecoinId !== policy.stablecoinId ||
    curveData.registryId.trim().toLowerCase() !== policy.expectedRegistryId ||
    curveData.isMetaPool !== (policy.quoteFunction === "get_dy_underlying") ||
    curveData.poolCoins?.length !== policy.poolTokens.length ||
    !Number.isFinite(input.retainedTvlUsd) ||
    input.retainedTvlUsd <= 0
  ) return null;
  if (
    policy.quoteFunction === "get_dy_underlying" &&
    canonicalAddress(curveData.basePoolAddress) !== policy.metapool.basePoolAddress
  ) return null;
  for (let index = 0; index < policy.poolTokens.length; index += 1) {
    const expected = policy.poolTokens[index]!;
    const actual = curveData.poolCoins[index]!;
    if (
      canonicalAddress(actual.address) !== expected.address ||
      actual.symbol.trim().toLowerCase() !== expected.symbol.toLowerCase() ||
      actual.decimals !== expected.decimals ||
      actual.isBasePoolLpToken !==
        (policy.quoteFunction === "get_dy_underlying" && index === 1)
    ) return null;
  }
  for (const token of policy.executionTokens) {
    if (
      token.trackedAssetId &&
      input.chainAddressToId.get(canonicalExitRouteAssetKey(policy.chain, token.address)) !==
        token.trackedAssetId
    ) return null;
  }
  if (curveData.underlyingCoins != null) {
    if (
      curveData.underlyingCoins.length !== policy.executionTokens.length ||
      curveData.underlyingCoins.some((actual, index) => {
        const expected = policy.executionTokens[index]!;
        return canonicalAddress(actual.address) !== expected.address ||
          actual.symbol.trim().toLowerCase() !== expected.symbol.toLowerCase() ||
          actual.decimals !== expected.decimals ||
          !Number.isFinite(actual.usdPrice) ||
          actual.usdPrice <= 0;
      })
    ) return null;
  }
  const tokenIn = policy.executionTokens[policy.inputIndex];
  const tokenOut = policy.executionTokens[policy.outputIndex];
  if (!tokenIn || !tokenOut || tokenIn.trackedAssetId !== policy.stablecoinId) return null;
  const inputPrice = input.stablecoinPriceById?.get(policy.stablecoinId);
  const outputReferenceAssetId = tokenOut.trackedAssetId ?? tokenOut.referenceAssetId;
  const outputPrice = outputReferenceAssetId
    ? input.stablecoinPriceById?.get(outputReferenceAssetId)
    : undefined;
  if (
    inputPrice == null ||
    outputPrice == null ||
    !Number.isFinite(inputPrice) ||
    inputPrice <= 0 ||
    !Number.isFinite(outputPrice) ||
    outputPrice <= 0
  ) return null;
  const poolId = canonicalExitRouteAssetKey(policy.chain, policy.poolAddress);
  const poolTokenAddresses = policy.executionTokens.map((token) => token.address);
  const targetId = buildDexMeasuredExecutionTargetId({
    adapterProfileId: policy.adapterProfileId,
    stablecoinId: policy.stablecoinId,
    chain: policy.chain,
    protocol: "curve",
    poolId,
    tokenInAddress: tokenIn.address,
    tokenOutAddress: tokenOut.address,
    poolTokenAddresses,
  });
  return {
    schemaVersion: DEX_MEASURED_TARGET_SCHEMA_VERSION,
    targetId,
    stablecoinId: policy.stablecoinId,
    adapterProfileId: policy.adapterProfileId,
    protocol: "curve",
    chain: policy.chain,
    poolId,
    poolTokenAddresses,
    tokenIn: {
      address: tokenIn.address,
      symbol: tokenIn.symbol,
      decimals: tokenIn.decimals,
      referencePriceUsd: inputPrice,
      trackedAssetId: policy.stablecoinId,
    },
    tokenOut: {
      address: tokenOut.address,
      symbol: tokenOut.symbol,
      decimals: tokenOut.decimals,
      referencePriceUsd: outputPrice,
      ...(tokenOut.trackedAssetId ? { trackedAssetId: tokenOut.trackedAssetId } : {}),
    },
    retainedTvlUsd: input.retainedTvlUsd,
    retainedPoolPriceUsd: inputPrice,
    capturedAt: input.capturedAt,
  };
}

type EligibilityFailure =
  | "pool-not-reviewed"
  | "execution-endpoint-mismatch"
  | "invalid-pinned-block"
  | "block-header-unavailable"
  | "stale-pinned-block"
  | "future-pinned-block"
  | "runtime-code-unavailable"
  | "runtime-code-absent"
  | "runtime-code-hash-mismatch"
  | "factory-code-mismatch"
  | "implementation-code-mismatch"
  | "factory-membership-mismatch"
  | "pool-token-order-mismatch"
  | "token-decimals-mismatch"
  | "rate-provider-mismatch"
  | "base-pool-mismatch"
  | "rpc-failure";

export type CurveCompositeEligibility =
  | { ok: true }
  | { ok: false; reason: EligibilityFailure };

export interface CurveCompositeRuntimeEvidence {
  blockTimestamp: number;
  proof: DexMeasuredExecutionCurveCompositeProof;
}

export function evaluateCurveCompositeEligibility(input: {
  chain: string;
  endpointAddress: string;
  blockNumber: number;
  nowSec: number;
  evidence?: CurveCompositeRuntimeEvidence;
}): CurveCompositeEligibility {
  const policy = getCurveCompositePolicy(input.chain, input.endpointAddress);
  if (!policy) return { ok: false, reason: "pool-not-reviewed" };
  if (canonicalAddress(input.endpointAddress) !== policy.poolAddress) {
    return { ok: false, reason: "execution-endpoint-mismatch" };
  }
  if (!Number.isSafeInteger(input.blockNumber) || input.blockNumber < 0) {
    return { ok: false, reason: "invalid-pinned-block" };
  }
  const evidence = input.evidence;
  if (!evidence || evidence.proof.blockNumber !== input.blockNumber) {
    return { ok: false, reason: "block-header-unavailable" };
  }
  if (evidence.blockTimestamp > input.nowSec + 60) {
    return { ok: false, reason: "future-pinned-block" };
  }
  if (input.nowSec - evidence.blockTimestamp > DEX_CURVE_STABLESWAP_MEASURED_FRESHNESS_MAX_SEC) {
    return { ok: false, reason: "stale-pinned-block" };
  }
  const proof = evidence.proof;
  if (
    proof.poolCodeHash !== policy.expectedPoolCodeHash ||
    proof.registeredPoolAddress !== policy.poolAddress
  ) return { ok: false, reason: "runtime-code-hash-mismatch" };
  if (
    proof.factoryAddress !== policy.factoryAddress ||
    proof.factoryCodeHash !== policy.expectedFactoryCodeHash ||
    proof.poolIndex !== policy.factoryPoolIndex
  ) return { ok: false, reason: "factory-code-mismatch" };
  if (
    proof.implementationAddress !== policy.implementationAddress ||
    proof.implementationCodeHash !== policy.expectedImplementationCodeHash
  ) return { ok: false, reason: "implementation-code-mismatch" };
  if (
    proof.quoteFunction !== policy.quoteFunction ||
    proof.poolTokenAddresses.length !== policy.poolTokens.length ||
    proof.poolTokenAddresses.some((address, index) => address !== policy.poolTokens[index]!.address) ||
    proof.executionTokenAddresses.length !== policy.executionTokens.length ||
    proof.executionTokenAddresses.some(
      (address, index) => address !== policy.executionTokens[index]!.address,
    )
  ) return { ok: false, reason: "pool-token-order-mismatch" };
  if (policy.adapterProfileId === CURVE_RATE_BEARING_ADAPTER_PROFILE_ID) {
    if (
      !proof.rateProvider ||
      proof.rateProvider.kind !== "erc4626" ||
      proof.rateProvider.tokenAddress !== policy.poolTokens[policy.rateProvider.tokenIndex].address ||
      proof.rateProvider.providerAddress !== policy.rateProvider.providerAddress ||
      proof.rateProvider.providerCodeHash !== policy.rateProvider.expectedProviderCodeHash ||
      proof.rateProvider.underlyingAddress !== policy.rateProvider.underlyingAddress
    ) return { ok: false, reason: "rate-provider-mismatch" };
  } else if (
    !proof.metapool ||
    proof.metapool.basePoolAddress !== policy.metapool.basePoolAddress ||
    proof.metapool.basePoolCodeHash !== policy.metapool.expectedBasePoolCodeHash ||
    proof.metapool.basePoolTokenAddresses.length !== policy.metapool.basePoolTokens.length ||
    proof.metapool.basePoolTokenAddresses.some(
      (address, index) => address !== policy.metapool.basePoolTokens[index]!.address,
    )
  ) return { ok: false, reason: "base-pool-mismatch" };
  return { ok: true };
}

interface VerificationDependencies {
  fetchCodeStatus(
    chain: string,
    address: string,
    blockNumber: number,
    options: Parameters<typeof fetchEvmCodeStatusAtBlock>[3],
  ): Promise<EvmCodeAtBlockResult>;
  fetchCall(
    chain: string,
    address: string,
    callData: string,
    blockNumber: number,
    options: Parameters<typeof fetchEvmCallHexAtBlock>[4],
  ): Promise<`0x${string}` | null>;
  fetchBlockHeader(
    chain: string,
    blockNumber: number | "finalized",
    options: Parameters<typeof fetchEvmBlockHeader>[2],
  ): Promise<EvmBlockHeader | null>;
  hashCode?(code: `0x${string}`): `0x${string}`;
}

export type CurveCompositeDeploymentVerification =
  | {
      ok: true;
      codeHash: `0x${string}`;
      blockNumber: number;
      blockTimestamp: number;
      runtimeEvidence: CurveCompositeRuntimeEvidence;
      proof: DexMeasuredExecutionCurveCompositeProof;
    }
  | { ok: false; reason: EligibilityFailure };

function decodeAddress(
  abi:
    | typeof POOL_ABI
    | typeof FACTORY_ABI
    | typeof MAIN_REGISTRY_ABI
    | typeof ERC4626_ABI,
  functionName: string,
  data: `0x${string}`,
): `0x${string}` | null {
  try {
    return canonicalAddress(decodeFunctionResult({ abi, functionName, data } as never));
  } catch {
    return null;
  }
}

function createCurveCompositeDeploymentVerifier(dependencies: VerificationDependencies) {
  return async function verifyCurveCompositeDeployment(input: {
    policy: CurveCompositePoolPolicy;
    nowSec: number;
    chainRpcs: Map<string, ChainRpcConfig>;
    signal?: AbortSignal;
    rpcBudget?: DexMeasuredExecutionRpcBudget;
  }): Promise<CurveCompositeDeploymentVerification> {
    const policy = input.policy;
    const requestOptions = {
      chainRpcs: input.chainRpcs,
      signal: input.signal,
      timeoutMs: DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS,
      maxRetries: 0,
      ...(input.rpcBudget ? { deadlineMs: input.rpcBudget.deadlineMs } : {}),
      ...(input.rpcBudget ? { beforeRequest: () => input.rpcBudget!.tryConsume() } : {}),
    };
    const header = await dependencies.fetchBlockHeader(policy.chain, "finalized", requestOptions);
    input.rpcBudget?.recordChainResult(policy.chain, header != null);
    if (!header) return { ok: false, reason: "block-header-unavailable" };
    if (header.timestamp > input.nowSec + 60) return { ok: false, reason: "future-pinned-block" };
    if (input.nowSec - header.timestamp > DEX_CURVE_STABLESWAP_MEASURED_FRESHNESS_MAX_SEC) {
      return { ok: false, reason: "stale-pinned-block" };
    }

    const hashCode = dependencies.hashCode ?? ((code: `0x${string}`) => keccak256(code));
    const readCode = async (
      address: `0x${string}`,
    ): Promise<{ ok: true; hash: `0x${string}` } | { ok: false; absent: boolean }> => {
      throwIfAborted(input.signal);
      if (input.rpcBudget && !input.rpcBudget.canRequestChain(policy.chain)) {
        return { ok: false, absent: false };
      }
      const result = await dependencies.fetchCodeStatus(
        policy.chain,
        address,
        header.number,
        requestOptions,
      );
      input.rpcBudget?.recordChainResult(policy.chain, result.status !== "unavailable");
      return result.status === "available"
        ? { ok: true, hash: hashCode(result.code).toLowerCase() as `0x${string}` }
        : { ok: false, absent: result.status === "absent" };
    };
    const calls: DexMeasuredExecutionCurveCompositeProof["calls"] = [];
    const readCall = async (
      role: string,
      target: `0x${string}`,
      callData: `0x${string}`,
    ): Promise<`0x${string}` | null> => {
      throwIfAborted(input.signal);
      if (input.rpcBudget && !input.rpcBudget.canRequestChain(policy.chain)) return null;
      const result = await dependencies.fetchCall(
        policy.chain,
        target,
        callData,
        header.number,
        requestOptions,
      );
      input.rpcBudget?.recordChainResult(policy.chain, result != null);
      if (result != null) {
        calls.push({
          role,
          target,
          callData,
          returnData: result.toLowerCase() as `0x${string}`,
        });
      }
      return result;
    };

    const poolCode = await readCode(policy.poolAddress);
    if (!poolCode.ok) {
      return { ok: false, reason: poolCode.absent ? "runtime-code-absent" : "runtime-code-unavailable" };
    }
    if (poolCode.hash !== policy.expectedPoolCodeHash) {
      return { ok: false, reason: "runtime-code-hash-mismatch" };
    }
    const factoryCode = await readCode(policy.factoryAddress);
    if (!factoryCode.ok || factoryCode.hash !== policy.expectedFactoryCodeHash) {
      return { ok: false, reason: "factory-code-mismatch" };
    }
    const implementationCode = policy.implementationBinding === "standalone-runtime"
      ? poolCode
      : await readCode(policy.implementationAddress);
    if (
      !implementationCode.ok ||
      implementationCode.hash !== policy.expectedImplementationCodeHash ||
      (
        policy.implementationBinding === "standalone-runtime" &&
        policy.implementationAddress !== policy.poolAddress
      )
    ) {
      return { ok: false, reason: "implementation-code-mismatch" };
    }

    const poolListData = encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: "pool_list",
      args: [BigInt(policy.factoryPoolIndex)],
    }).toLowerCase() as `0x${string}`;
    const factoryCoinsData = encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: "get_coins",
      args: [policy.poolAddress],
    }).toLowerCase() as `0x${string}`;
    const implementationResult = policy.implementationBinding === "factory-lookup"
      ? await readCall(
          "factory-implementation",
          policy.factoryAddress,
          encodeFunctionData({
            abi: FACTORY_ABI,
            functionName: "get_implementation_address",
            args: [policy.poolAddress],
          }).toLowerCase() as `0x${string}`,
        )
      : null;
    const [poolListResult, factoryCoinsResult] = [
      await readCall("factory-pool-list", policy.factoryAddress, poolListData),
      await readCall("factory-coins", policy.factoryAddress, factoryCoinsData),
    ];
    if (
      !poolListResult ||
      !factoryCoinsResult ||
      (policy.implementationBinding === "factory-lookup" && !implementationResult)
    ) {
      return { ok: false, reason: "rpc-failure" };
    }
    const factoryCoins = decodeFactoryAddressArray(
      policy,
      "get_coins",
      factoryCoinsResult,
      policy.poolTokens.length,
    );
    if (
      !factoryCoins ||
      decodeAddress(FACTORY_ABI, "pool_list", poolListResult) !== policy.poolAddress ||
      (
        policy.implementationBinding === "factory-lookup" &&
        decodeAddress(
          FACTORY_ABI,
          "get_implementation_address",
          implementationResult!,
        ) !== policy.implementationAddress
      ) ||
      factoryCoins.length !== policy.poolTokens.length ||
      factoryCoins.some(
        (address, index) => canonicalAddress(address) !== policy.poolTokens[index]!.address,
      )
    ) return { ok: false, reason: "factory-membership-mismatch" };

    for (let index = 0; index < policy.poolTokens.length; index += 1) {
      throwIfAborted(input.signal);
      const callData = encodeFunctionData({
        abi: POOL_ABI,
        functionName: "coins",
        args: [BigInt(index)],
      }).toLowerCase() as `0x${string}`;
      const result = await readCall(`pool-coin-${index}`, policy.poolAddress, callData);
      if (!result || decodeAddress(POOL_ABI, "coins", result) !== policy.poolTokens[index]!.address) {
        return { ok: false, reason: "pool-token-order-mismatch" };
      }
    }
    for (let index = 0; index < policy.executionTokens.length; index += 1) {
      throwIfAborted(input.signal);
      const token = policy.executionTokens[index]!;
      const callData = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "decimals",
      }).toLowerCase() as `0x${string}`;
      const result = await readCall(`token-decimals-${index}`, token.address, callData);
      if (!result) return { ok: false, reason: "token-decimals-mismatch" };
      try {
        if (
          Number(decodeFunctionResult({
            abi: ERC20_ABI,
            functionName: "decimals",
            data: result,
          })) !== token.decimals
        ) return { ok: false, reason: "token-decimals-mismatch" };
      } catch {
        return { ok: false, reason: "token-decimals-mismatch" };
      }
    }

    let rateProvider: DexMeasuredExecutionCurveCompositeProof["rateProvider"];
    let metapool: DexMeasuredExecutionCurveCompositeProof["metapool"];
    if (policy.adapterProfileId === CURVE_RATE_BEARING_ADAPTER_PROFILE_ID) {
      const providerCode = await readCode(policy.rateProvider.providerAddress);
      if (!providerCode.ok || providerCode.hash !== policy.rateProvider.expectedProviderCodeHash) {
        return { ok: false, reason: "rate-provider-mismatch" };
      }
      const assetTypesData = encodeFunctionData({
        abi: FACTORY_ABI,
        functionName: "get_pool_asset_types",
        args: [policy.poolAddress],
      }).toLowerCase() as `0x${string}`;
      const assetData = encodeFunctionData({
        abi: ERC4626_ABI,
        functionName: "asset",
      }).toLowerCase() as `0x${string}`;
      const shares = 10n ** BigInt(policy.poolTokens[policy.rateProvider.tokenIndex].decimals);
      const convertData = encodeFunctionData({
        abi: ERC4626_ABI,
        functionName: "convertToAssets",
        args: [shares],
      }).toLowerCase() as `0x${string}`;
      const storedRatesData = encodeFunctionData({
        abi: POOL_ABI,
        functionName: "stored_rates",
      }).toLowerCase() as `0x${string}`;
      const [assetTypesResult, assetResult, convertResult, storedRatesResult] = [
        await readCall("factory-asset-types", policy.factoryAddress, assetTypesData),
        await readCall("rate-provider-asset", policy.rateProvider.providerAddress, assetData),
        await readCall("rate-provider-convert", policy.rateProvider.providerAddress, convertData),
        await readCall("pool-stored-rates", policy.poolAddress, storedRatesData),
      ];
      if (!assetTypesResult || !assetResult || !convertResult || !storedRatesResult) {
        return { ok: false, reason: "rate-provider-mismatch" };
      }
      try {
        const assetTypes = decodeFunctionResult({
          abi: FACTORY_ABI,
          functionName: "get_pool_asset_types",
          data: assetTypesResult,
        }) as readonly number[];
        const observedRate = decodeFunctionResult({
          abi: ERC4626_ABI,
          functionName: "convertToAssets",
          data: convertResult,
        }) as bigint;
        const storedRates = decodeFunctionResult({
          abi: POOL_ABI,
          functionName: "stored_rates",
          data: storedRatesResult,
        }) as readonly bigint[];
        if (
          assetTypes.length !== policy.expectedAssetTypes.length ||
          assetTypes.some((value, index) => Number(value) !== policy.expectedAssetTypes[index]) ||
          decodeAddress(ERC4626_ABI, "asset", assetResult) !== policy.rateProvider.underlyingAddress ||
          observedRate <= 0n ||
          storedRates.length !== policy.poolTokens.length ||
          storedRates[policy.rateProvider.tokenIndex] !== observedRate
        ) return { ok: false, reason: "rate-provider-mismatch" };
        rateProvider = {
          kind: "erc4626",
          tokenAddress: policy.poolTokens[policy.rateProvider.tokenIndex].address,
          providerAddress: policy.rateProvider.providerAddress,
          providerCodeHash: providerCode.hash,
          underlyingAddress: policy.rateProvider.underlyingAddress,
          observedRate: observedRate.toString(),
        };
      } catch {
        return { ok: false, reason: "rate-provider-mismatch" };
      }
    } else {
      const baseCode = await readCode(policy.metapool.basePoolAddress);
      if (!baseCode.ok || baseCode.hash !== policy.metapool.expectedBasePoolCodeHash) {
        return { ok: false, reason: "base-pool-mismatch" };
      }
      const basePoolData = policy.metapool.basePoolBinding === "registry-lp-token"
        ? encodeFunctionData({
            abi: MAIN_REGISTRY_ABI,
            functionName: "get_pool_from_lp_token",
            args: [policy.poolTokens[1].address],
          }).toLowerCase() as `0x${string}`
        : encodeFunctionData({
            abi: FACTORY_ABI,
            functionName: "get_base_pool",
            args: [policy.poolAddress],
          }).toLowerCase() as `0x${string}`;
      const basePoolRole = policy.metapool.basePoolBinding === "registry-lp-token"
        ? "registry-base-pool-from-lp-token"
        : "factory-base-pool";
      const underlyingCoinsData = encodeFunctionData({
        abi: FACTORY_ABI,
        functionName: "get_underlying_coins",
        args: [policy.poolAddress],
      }).toLowerCase() as `0x${string}`;
      const underlyingDecimalsData = encodeFunctionData({
        abi: FACTORY_ABI,
        functionName: "get_underlying_decimals",
        args: [policy.poolAddress],
      }).toLowerCase() as `0x${string}`;
      const isMetaData = encodeFunctionData({
        abi: FACTORY_ABI,
        functionName: "is_meta",
        args: [policy.poolAddress],
      }).toLowerCase() as `0x${string}`;
      const [basePoolResult, underlyingCoinsResult, underlyingDecimalsResult, isMetaResult] = [
        await readCall(basePoolRole, policy.factoryAddress, basePoolData),
        await readCall("factory-underlying-coins", policy.factoryAddress, underlyingCoinsData),
        await readCall("factory-underlying-decimals", policy.factoryAddress, underlyingDecimalsData),
        await readCall("factory-is-meta", policy.factoryAddress, isMetaData),
      ];
      if (!basePoolResult || !underlyingCoinsResult || !underlyingDecimalsResult || !isMetaResult) {
        return { ok: false, reason: "base-pool-mismatch" };
      }
      try {
        const underlyingCoins = decodeFactoryAddressArray(
          policy,
          "get_underlying_coins",
          underlyingCoinsResult,
          policy.executionTokens.length,
        );
        const underlyingDecimals = decodeFactoryDecimalsArray(
          policy,
          underlyingDecimalsResult,
          policy.executionTokens.length,
        );
        const isMeta = decodeFunctionResult({
          abi: FACTORY_ABI,
          functionName: "is_meta",
          data: isMetaResult,
        }) as boolean;
        const decodedBasePool = policy.metapool.basePoolBinding === "registry-lp-token"
          ? decodeAddress(MAIN_REGISTRY_ABI, "get_pool_from_lp_token", basePoolResult)
          : decodeAddress(FACTORY_ABI, "get_base_pool", basePoolResult);
        if (
          decodedBasePool !== policy.metapool.basePoolAddress ||
          !isMeta ||
          !underlyingCoins ||
          underlyingCoins.length !== policy.executionTokens.length ||
          underlyingCoins.some(
            (address, index) => canonicalAddress(address) !== policy.executionTokens[index]!.address,
          ) ||
          !underlyingDecimals ||
          underlyingDecimals.length !== policy.executionTokens.length ||
          underlyingDecimals.some(
            (decimals, index) => Number(decimals) !== policy.executionTokens[index]!.decimals,
          )
        ) return { ok: false, reason: "base-pool-mismatch" };
        metapool = {
          basePoolAddress: policy.metapool.basePoolAddress,
          basePoolCodeHash: baseCode.hash,
          basePoolTokenAddresses: policy.metapool.basePoolTokens.map((token) => token.address),
        };
      } catch {
        return { ok: false, reason: "base-pool-mismatch" };
      }
    }

    const revalidated = await dependencies.fetchBlockHeader(policy.chain, header.number, requestOptions);
    input.rpcBudget?.recordChainResult(policy.chain, revalidated != null);
    if (
      !revalidated ||
      revalidated.hash !== header.hash ||
      revalidated.timestamp !== header.timestamp
    ) return { ok: false, reason: "block-header-unavailable" };

    const proof: DexMeasuredExecutionCurveCompositeProof = {
      blockNumber: header.number,
      blockHash: header.hash,
      blockCommitment: "finalized",
      factoryAddress: policy.factoryAddress,
      factoryCodeHash: factoryCode.hash,
      poolIndex: policy.factoryPoolIndex,
      registeredPoolAddress: policy.poolAddress,
      poolCodeHash: poolCode.hash,
      implementationAddress: policy.implementationAddress,
      implementationCodeHash: implementationCode.hash,
      quoteFunction: policy.quoteFunction,
      poolTokenAddresses: policy.poolTokens.map((token) => token.address),
      executionTokenAddresses: policy.executionTokens.map((token) => token.address),
      calls,
      ...(rateProvider ? { rateProvider } : {}),
      ...(metapool ? { metapool } : {}),
    };
    const runtimeEvidence = { blockTimestamp: header.timestamp, proof };
    const eligibility = evaluateCurveCompositeEligibility({
      chain: policy.chain,
      endpointAddress: policy.poolAddress,
      blockNumber: header.number,
      nowSec: input.nowSec,
      evidence: runtimeEvidence,
    });
    return eligibility.ok
      ? {
          ok: true,
          codeHash: poolCode.hash,
          blockNumber: header.number,
          blockTimestamp: header.timestamp,
          runtimeEvidence,
          proof,
        }
      : eligibility;
  };
}

export const verifyCurveCompositeDeployment = createCurveCompositeDeploymentVerifier({
  fetchCodeStatus: fetchEvmCodeStatusAtBlock,
  fetchCall: fetchEvmCallHexAtBlock,
  fetchBlockHeader: fetchEvmBlockHeader,
});

type QuoteFailure =
  | DexMeasuredExecutionBudgetStopReason
  | "unsupported-chain-or-pool"
  | "invalid-pinned-block"
  | "invalid-quote-input"
  | "invalid-curve-composite-target"
  | "runtime-evidence-missing"
  | "rpc-failure"
  | "pool-revert"
  | "malformed-pool-return";

export interface CurveCompositeRequest {
  target: DexMeasuredExecutionTarget;
  inputUsd: number;
  blockNumber: number;
  blockObservedAt: number;
  endpointAddress: `0x${string}`;
  runtimeEvidence?: CurveCompositeRuntimeEvidence;
}

interface EncodedRequest extends CurveCompositeRequest {
  index: number;
  label: string;
  amountInRaw: bigint;
  inputIndex: number;
  outputIndex: number;
  callData: `0x${string}`;
  policy: CurveCompositePoolPolicy;
  eligibility: CurveCompositeEligibility;
}

export interface CurveCompositeBatchOutcome {
  targetId: string;
  inputUsd: number;
  blockNumber: number;
  eligibility: CurveCompositeEligibility;
  point?: DexMeasuredRawQuotePoint;
  failureReason?: QuoteFailure;
}

function resolveCurveCompositeTokenIndices(
  target: DexMeasuredExecutionTarget | DexMeasuredExecutionProfile,
): { ok: true; inputIndex: number; outputIndex: number } | { ok: false; reason: QuoteFailure } {
  const endpointAddress =
    "executionEndpoint" in target
      ? target.executionEndpoint.address
      : target.poolId.slice(target.poolId.lastIndexOf(":") + 1);
  const policy = getCurveCompositePolicy(target.chain, endpointAddress);
  if (
    !policy ||
    target.adapterProfileId !== policy.adapterProfileId ||
    target.protocol.trim().toLowerCase() !== "curve" ||
    target.tokenIn.trackedAssetId !== policy.stablecoinId ||
    target.poolTokenAddresses?.length !== policy.executionTokens.length ||
    target.poolTokenAddresses.some(
      (address, index) => address !== policy.executionTokens[index]!.address,
    ) ||
    target.tokenIn.address !== policy.executionTokens[policy.inputIndex]?.address ||
    target.tokenOut.address !== policy.executionTokens[policy.outputIndex]?.address ||
    target.tokenIn.decimals !== policy.executionTokens[policy.inputIndex]?.decimals ||
    target.tokenOut.decimals !== policy.executionTokens[policy.outputIndex]?.decimals
  ) return { ok: false, reason: "invalid-curve-composite-target" };
  return { ok: true, inputIndex: policy.inputIndex, outputIndex: policy.outputIndex };
}

export function encodeCurveCompositeQuote(input: {
  policy: CurveCompositePoolPolicy;
  inputIndex: number;
  outputIndex: number;
  amountInRaw: bigint;
}): `0x${string}` {
  if (
    input.inputIndex !== input.policy.inputIndex ||
    input.outputIndex !== input.policy.outputIndex ||
    input.amountInRaw <= 0n
  ) throw new Error("Curve composite quote indices or amount are invalid");
  return encodeFunctionData({
    abi: POOL_ABI,
    functionName: input.policy.quoteFunction,
    args: [BigInt(input.inputIndex), BigInt(input.outputIndex), input.amountInRaw],
  }).toLowerCase() as `0x${string}`;
}

function decodeCurveCompositeQuote(
  policy: CurveCompositePoolPolicy,
  returnData: `0x${string}`,
): bigint | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(returnData)) return null;
  try {
    return decodeFunctionResult({
      abi: POOL_ABI,
      functionName: policy.quoteFunction,
      data: returnData,
    }) as bigint;
  } catch {
    return null;
  }
}

function prepareRequest(
  request: CurveCompositeRequest,
  index: number,
): {
  encoded?: EncodedRequest;
  failureReason?: QuoteFailure;
  eligibility: CurveCompositeEligibility;
} {
  const policy = getCurveCompositePolicy(request.target.chain, request.endpointAddress);
  const eligibility = evaluateCurveCompositeEligibility({
    chain: request.target.chain,
    endpointAddress: request.endpointAddress,
    blockNumber: request.blockNumber,
    nowSec: request.blockObservedAt,
    evidence: request.runtimeEvidence,
  });
  if (!policy) return { failureReason: "unsupported-chain-or-pool", eligibility };
  if (!Number.isSafeInteger(request.blockNumber) || request.blockNumber < 0) {
    return { failureReason: "invalid-pinned-block", eligibility };
  }
  if (!eligibility.ok) return { failureReason: "runtime-evidence-missing", eligibility };
  const indices = resolveCurveCompositeTokenIndices(request.target);
  if (!indices.ok) return { failureReason: indices.reason, eligibility };
  const expectedTargetId = buildDexMeasuredExecutionTargetId({
    adapterProfileId: request.target.adapterProfileId,
    stablecoinId: request.target.stablecoinId,
    chain: request.target.chain,
    protocol: request.target.protocol,
    poolId: request.target.poolId,
    tokenInAddress: request.target.tokenIn.address,
    tokenOutAddress: request.target.tokenOut.address,
    poolTokenAddresses: request.target.poolTokenAddresses,
  });
  if (request.target.targetId !== expectedTargetId) {
    return { failureReason: "invalid-curve-composite-target", eligibility };
  }
  const amountInRaw = usdToRawAmount(
    request.inputUsd,
    request.target.tokenIn.decimals,
    request.target.tokenIn.referencePriceUsd,
  );
  if (!amountInRaw) return { failureReason: "invalid-quote-input", eligibility };
  return {
    eligibility,
    encoded: {
      ...request,
      index,
      label: `${index}:${request.target.targetId}`,
      amountInRaw,
      inputIndex: indices.inputIndex,
      outputIndex: indices.outputIndex,
      callData: encodeCurveCompositeQuote({
        policy,
        inputIndex: indices.inputIndex,
        outputIndex: indices.outputIndex,
        amountInRaw,
      }),
      policy,
      eligibility,
    },
  };
}

function decodeQuotePoint(
  request: EncodedRequest,
  result: EvmMulticall3Result,
): { point?: DexMeasuredRawQuotePoint; failureReason?: QuoteFailure } {
  if (!result.success) return { failureReason: "pool-revert" };
  const amountOutRaw = decodeCurveCompositeQuote(request.policy, result.returnData);
  if (amountOutRaw == null) return { failureReason: "malformed-pool-return" };
  const point = materializeEvmQuotePoint({
    amountInRaw: request.amountInRaw,
    amountOutRaw,
    callData: request.callData,
    returnData: result.returnData,
    tokenIn: request.target.tokenIn,
    tokenOut: request.target.tokenOut,
    adapterMetadata: {
        executionPool: request.endpointAddress,
        blockNumber: request.blockNumber,
        inputIndex: request.inputIndex,
        outputIndex: request.outputIndex,
        quoteFunction: request.policy.quoteFunction,
    },
  });
  return point ? { point } : { failureReason: "malformed-pool-return" };
}

interface QuoteDependencies {
  executeMulticall(input: {
    chain: string;
    calls: readonly EvmMulticall3Call[];
    blockNumber: number;
    chainRpcs: Map<string, ChainRpcConfig>;
    signal?: AbortSignal;
    rpcBudget?: DexMeasuredExecutionRpcBudget;
  }): Promise<EvmMulticall3Result[] | null>;
}

export function createCurveCompositeQuoteExecutor(dependencies: QuoteDependencies) {
  return async function quoteCurveCompositeRequests(input: {
    requests: readonly CurveCompositeRequest[];
    chainRpcs: Map<string, ChainRpcConfig>;
    signal?: AbortSignal;
    rpcBudget?: DexMeasuredExecutionRpcBudget;
  }): Promise<CurveCompositeBatchOutcome[]> {
    const prepared = input.requests.map(prepareRequest);
    const outcomes = input.requests.map((request, index): CurveCompositeBatchOutcome => ({
      targetId: request.target.targetId,
      inputUsd: request.inputUsd,
      blockNumber: request.blockNumber,
      eligibility: prepared[index]!.eligibility,
      ...(prepared[index]!.failureReason ? { failureReason: prepared[index]!.failureReason } : {}),
    }));
    const plans = prepared.flatMap((entry) => entry.encoded ? [{
      ...entry.encoded,
      chain: entry.encoded.policy.chain,
      call: {
            label: entry.encoded.label,
            target: entry.encoded.endpointAddress,
            callData: entry.encoded.callData,
            allowFailure: true,
      },
    }] : []);
    return executeEvmQuotePlan({
      plans,
      outcomes,
      chainRpcs: input.chainRpcs,
      signal: input.signal,
      rpcBudget: input.rpcBudget,
      spec: {
        batchSize: BATCH_SIZE,
        executeMulticall: dependencies.executeMulticall,
        resolveResult: (request, result) => ({
            targetId: request.target.targetId,
            inputUsd: request.inputUsd,
            blockNumber: request.blockNumber,
            eligibility: request.eligibility,
            ...decodeQuotePoint(request, result),
        }),
        materializeTransportFailure: (request, reason) => ({
          targetId: request.target.targetId,
          inputUsd: request.inputUsd,
          blockNumber: request.blockNumber,
          eligibility: request.eligibility,
          failureReason: reason ?? "rpc-failure",
        }),
      },
    });
  };
}

export const quoteCurveCompositeRequests = createCurveCompositeQuoteExecutor({
  executeMulticall: async (input) =>
    fetchEvmMulticall3Aggregate3AtBlock(input.chain, input.calls, input.blockNumber, {
      chainRpcs: input.chainRpcs,
      signal: input.signal,
      timeoutMs: DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS,
      maxRetries: 1,
      ...(input.rpcBudget ? { deadlineMs: input.rpcBudget.deadlineMs } : {}),
      ...(input.rpcBudget ? { beforeRequest: () => input.rpcBudget!.tryConsume() } : {}),
      gas: MULTICALL_GAS,
      multicallBatchSize: Math.min(BATCH_SIZE, input.calls.length),
    }),
});

function callByRole(
  proof: DexMeasuredExecutionCurveCompositeProof,
  role: string,
): DexMeasuredExecutionCurveCompositeProof["calls"][number] | null {
  const matches = proof.calls.filter((call) => call.role === role);
  return matches.length === 1 ? matches[0]! : null;
}

function bindingCallMatches(
  call: DexMeasuredExecutionCurveCompositeProof["calls"][number] | null,
  target: `0x${string}`,
  callData: `0x${string}`,
): call is DexMeasuredExecutionCurveCompositeProof["calls"][number] {
  return call?.target === target && call.callData === callData;
}

/** Consumer-side raw-call and decoded-identity validation. */
export function validateCurveCompositeProfileProof(profile: DexMeasuredExecutionProfile): string[] {
  const issues = new Set<string>();
  const policy = getCurveCompositePolicy(profile.chain, profile.executionEndpoint.address);
  if (!policy || profile.adapterProfileId !== policy.adapterProfileId) {
    return ["execution-pool-not-reviewed"];
  }
  const indices = resolveCurveCompositeTokenIndices(profile);
  if (!indices.ok) issues.add(indices.reason);
  const proof = profile.curveCompositeProof;
  if (!proof) return ["curve-composite-proof-missing", ...issues];
  const eligibility = evaluateCurveCompositeEligibility({
    chain: profile.chain,
    endpointAddress: profile.executionEndpoint.address,
    blockNumber: profile.blockNumber,
    nowSec: profile.quotedAt,
    evidence: { blockTimestamp: profile.quotedAt, proof },
  });
  if (!eligibility.ok) issues.add(eligibility.reason);
  if (
    profile.executionEndpoint.codeHash !== policy.expectedPoolCodeHash ||
    proof.blockNumber !== profile.blockNumber
  ) issues.add("endpoint-binding-mismatch");

  const commonRoles = [
    "factory-pool-list",
    "factory-coins",
    ...(policy.implementationBinding === "factory-lookup" ? ["factory-implementation"] : []),
    ...policy.poolTokens.map((_, index) => `pool-coin-${index}`),
    ...policy.executionTokens.map((_, index) => `token-decimals-${index}`),
  ];
  const policyRoles = policy.adapterProfileId === CURVE_RATE_BEARING_ADAPTER_PROFILE_ID
    ? [
        "factory-asset-types",
        "rate-provider-asset",
        "rate-provider-convert",
        "pool-stored-rates",
      ]
    : [
        policy.metapool.basePoolBinding === "registry-lp-token"
          ? "registry-base-pool-from-lp-token"
          : "factory-base-pool",
        "factory-underlying-coins",
        "factory-underlying-decimals",
        "factory-is-meta",
      ];
  const expectedRoles = [...commonRoles, ...policyRoles];
  if (
    proof.calls.length !== expectedRoles.length ||
    proof.calls.some((call) => !expectedRoles.includes(call.role)) ||
    expectedRoles.some(
      (role) => proof.calls.filter((call) => call.role === role).length !== 1,
    )
  ) issues.add("binding-call-set-mismatch");

  const poolList = callByRole(proof, "factory-pool-list");
  const factoryCoins = callByRole(proof, "factory-coins");
  const implementation = callByRole(proof, "factory-implementation");
  const poolListCallData = encodeFunctionData({
    abi: FACTORY_ABI,
    functionName: "pool_list",
    args: [BigInt(policy.factoryPoolIndex)],
  }).toLowerCase() as `0x${string}`;
  const factoryCoinsCallData = encodeFunctionData({
    abi: FACTORY_ABI,
    functionName: "get_coins",
    args: [policy.poolAddress],
  }).toLowerCase() as `0x${string}`;
  const implementationCallData = encodeFunctionData({
    abi: FACTORY_ABI,
    functionName: "get_implementation_address",
    args: [policy.poolAddress],
  }).toLowerCase() as `0x${string}`;
  try {
    if (
      !bindingCallMatches(poolList, policy.factoryAddress, poolListCallData) ||
      decodeAddress(FACTORY_ABI, "pool_list", poolList.returnData as `0x${string}`) !==
        policy.poolAddress
    ) issues.add("factory-pool-list-proof-mismatch");
  } catch {
    issues.add("factory-pool-list-proof-mismatch");
  }
  try {
    const decoded = factoryCoins
      ? decodeFactoryAddressArray(
          policy,
          "get_coins",
          factoryCoins.returnData as `0x${string}`,
          policy.poolTokens.length,
        )
      : null;
    if (
      !bindingCallMatches(factoryCoins, policy.factoryAddress, factoryCoinsCallData) ||
      !decoded ||
      decoded.length !== policy.poolTokens.length ||
      decoded.some(
        (address, index) => canonicalAddress(address) !== policy.poolTokens[index]!.address,
      )
    ) issues.add("factory-coins-proof-mismatch");
  } catch {
    issues.add("factory-coins-proof-mismatch");
  }
  if (policy.implementationBinding === "factory-lookup") {
    if (
      !bindingCallMatches(implementation, policy.factoryAddress, implementationCallData) ||
      decodeAddress(
        FACTORY_ABI,
        "get_implementation_address",
        implementation.returnData as `0x${string}`,
      ) !== policy.implementationAddress
    ) issues.add("implementation-proof-mismatch");
  } else if (
    implementation != null ||
    policy.implementationAddress !== policy.poolAddress ||
    proof.implementationAddress !== policy.poolAddress ||
    proof.implementationCodeHash !== proof.poolCodeHash
  ) {
    issues.add("implementation-proof-mismatch");
  }

  for (let index = 0; index < policy.poolTokens.length; index += 1) {
    const call = callByRole(proof, `pool-coin-${index}`);
    const callData = encodeFunctionData({
      abi: POOL_ABI,
      functionName: "coins",
      args: [BigInt(index)],
    }).toLowerCase() as `0x${string}`;
    if (
      !bindingCallMatches(call, policy.poolAddress, callData) ||
      decodeAddress(POOL_ABI, "coins", call.returnData as `0x${string}`) !==
        policy.poolTokens[index]!.address
    ) issues.add("pool-coins-proof-mismatch");
  }
  for (let index = 0; index < policy.executionTokens.length; index += 1) {
    const call = callByRole(proof, `token-decimals-${index}`);
    const callData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "decimals",
    }).toLowerCase() as `0x${string}`;
    try {
      if (
        !bindingCallMatches(call, policy.executionTokens[index]!.address, callData) ||
        Number(decodeFunctionResult({
          abi: ERC20_ABI,
          functionName: "decimals",
          data: call.returnData as `0x${string}`,
        })) !== policy.executionTokens[index]!.decimals
      ) issues.add("token-decimals-proof-mismatch");
    } catch {
      issues.add("token-decimals-proof-mismatch");
    }
  }
  if (policy.adapterProfileId === CURVE_RATE_BEARING_ADAPTER_PROFILE_ID) {
    const assetTypes = callByRole(proof, "factory-asset-types");
    const asset = callByRole(proof, "rate-provider-asset");
    const convert = callByRole(proof, "rate-provider-convert");
    const storedRates = callByRole(proof, "pool-stored-rates");
    const assetTypesCallData = encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: "get_pool_asset_types",
      args: [policy.poolAddress],
    }).toLowerCase() as `0x${string}`;
    const assetCallData = encodeFunctionData({
      abi: ERC4626_ABI,
      functionName: "asset",
    }).toLowerCase() as `0x${string}`;
    const shares = 10n ** BigInt(policy.poolTokens[policy.rateProvider.tokenIndex].decimals);
    const convertCallData = encodeFunctionData({
      abi: ERC4626_ABI,
      functionName: "convertToAssets",
      args: [shares],
    }).toLowerCase() as `0x${string}`;
    const storedRatesCallData = encodeFunctionData({
      abi: POOL_ABI,
      functionName: "stored_rates",
    }).toLowerCase() as `0x${string}`;
    try {
      const observedAssetTypes = assetTypes
        ? decodeFunctionResult({
            abi: FACTORY_ABI,
            functionName: "get_pool_asset_types",
            data: assetTypes.returnData as `0x${string}`,
          }) as readonly number[]
        : [];
      const observedRate = convert
        ? decodeFunctionResult({
            abi: ERC4626_ABI,
            functionName: "convertToAssets",
            data: convert.returnData as `0x${string}`,
          }) as bigint
        : 0n;
      const rates = storedRates
        ? decodeFunctionResult({
            abi: POOL_ABI,
            functionName: "stored_rates",
            data: storedRates.returnData as `0x${string}`,
          }) as readonly bigint[]
        : [];
      if (
        !bindingCallMatches(assetTypes, policy.factoryAddress, assetTypesCallData) ||
        !bindingCallMatches(asset, policy.rateProvider.providerAddress, assetCallData) ||
        !bindingCallMatches(convert, policy.rateProvider.providerAddress, convertCallData) ||
        !bindingCallMatches(storedRates, policy.poolAddress, storedRatesCallData) ||
        observedAssetTypes.length !== policy.expectedAssetTypes.length ||
        observedAssetTypes.some(
          (value, index) => Number(value) !== policy.expectedAssetTypes[index],
        ) ||
        decodeAddress(ERC4626_ABI, "asset", asset.returnData as `0x${string}`) !==
          policy.rateProvider.underlyingAddress ||
        observedRate <= 0n ||
        observedRate.toString() !== proof.rateProvider?.observedRate ||
        rates.length !== policy.poolTokens.length ||
        rates[policy.rateProvider.tokenIndex] !== observedRate
      ) issues.add("rate-provider-proof-mismatch");
    } catch {
      issues.add("rate-provider-proof-mismatch");
    }
  } else {
    const basePoolRole = policy.metapool.basePoolBinding === "registry-lp-token"
      ? "registry-base-pool-from-lp-token"
      : "factory-base-pool";
    const basePool = callByRole(proof, basePoolRole);
    const underlyingCoins = callByRole(proof, "factory-underlying-coins");
    const underlyingDecimals = callByRole(proof, "factory-underlying-decimals");
    const isMeta = callByRole(proof, "factory-is-meta");
    const basePoolCallData = policy.metapool.basePoolBinding === "registry-lp-token"
      ? encodeFunctionData({
          abi: MAIN_REGISTRY_ABI,
          functionName: "get_pool_from_lp_token",
          args: [policy.poolTokens[1].address],
        }).toLowerCase() as `0x${string}`
      : encodeFunctionData({
          abi: FACTORY_ABI,
          functionName: "get_base_pool",
          args: [policy.poolAddress],
        }).toLowerCase() as `0x${string}`;
    const underlyingCoinsCallData = encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: "get_underlying_coins",
      args: [policy.poolAddress],
    }).toLowerCase() as `0x${string}`;
    const underlyingDecimalsCallData = encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: "get_underlying_decimals",
      args: [policy.poolAddress],
    }).toLowerCase() as `0x${string}`;
    const isMetaCallData = encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: "is_meta",
      args: [policy.poolAddress],
    }).toLowerCase() as `0x${string}`;
    try {
      const coins = underlyingCoins
        ? decodeFactoryAddressArray(
            policy,
            "get_underlying_coins",
            underlyingCoins.returnData as `0x${string}`,
            policy.executionTokens.length,
          )
        : null;
      const decimals = underlyingDecimals
        ? decodeFactoryDecimalsArray(
            policy,
            underlyingDecimals.returnData as `0x${string}`,
            policy.executionTokens.length,
          )
        : null;
      if (
        !bindingCallMatches(basePool, policy.factoryAddress, basePoolCallData) ||
        !bindingCallMatches(
          underlyingCoins,
          policy.factoryAddress,
          underlyingCoinsCallData,
        ) ||
        !bindingCallMatches(
          underlyingDecimals,
          policy.factoryAddress,
          underlyingDecimalsCallData,
        ) ||
        !bindingCallMatches(isMeta, policy.factoryAddress, isMetaCallData) ||
        (
          policy.metapool.basePoolBinding === "registry-lp-token"
            ? decodeAddress(
                MAIN_REGISTRY_ABI,
                "get_pool_from_lp_token",
                basePool.returnData as `0x${string}`,
              )
            : decodeAddress(
                FACTORY_ABI,
                "get_base_pool",
                basePool.returnData as `0x${string}`,
              )
        ) !== policy.metapool.basePoolAddress ||
        decodeFunctionResult({
          abi: FACTORY_ABI,
          functionName: "is_meta",
          data: isMeta.returnData as `0x${string}`,
        }) !== true ||
        !coins ||
        coins.length !== policy.executionTokens.length ||
        coins.some(
          (address, index) => canonicalAddress(address) !== policy.executionTokens[index]!.address,
        ) ||
        !decimals ||
        decimals.length !== policy.executionTokens.length ||
        decimals.some(
          (value, index) => Number(value) !== policy.executionTokens[index]!.decimals,
        )
      ) issues.add("metapool-path-proof-mismatch");
    } catch {
      issues.add("metapool-path-proof-mismatch");
    }
  }

  for (const point of profile.quoteProof) {
    try {
      const decoded = decodeFunctionData({
        abi: POOL_ABI,
        data: point.callData as `0x${string}`,
      });
      if (
        !indices.ok ||
        decoded.functionName !== policy.quoteFunction ||
        decoded.args[0] !== BigInt(indices.inputIndex) ||
        decoded.args[1] !== BigInt(indices.outputIndex) ||
        decoded.args[2].toString() !== point.amountInRaw ||
        decodeCurveCompositeQuote(policy, point.returnData as `0x${string}`)?.toString() !==
          point.amountOutRaw
      ) issues.add("quote-proof-mismatch");
    } catch {
      issues.add("quote-proof-mismatch");
    }
  }
  return [...issues];
}
