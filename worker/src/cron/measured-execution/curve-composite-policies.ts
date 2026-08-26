import { canonicalEvmAddress } from "./evm-codecs";
import { DEX_MEASURED_ADAPTER_PROFILE_IDS } from "@shared/types/measured-execution";
import {
  CURVE_ALUSD_3CRV_METAPOOL_ADDRESS, CURVE_DOLA_FRAXBP_METAPOOL_ADDRESS,
  CURVE_DOLA_SUSDE_COMPOSITE_POOL_ADDRESS, CURVE_EUSD_FRAXBP_METAPOOL_ADDRESS,
  CURVE_GUSD_3CRV_METAPOOL_ADDRESS, CURVE_MAI_AM3CRV_METAPOOL_ADDRESS,
  CURVE_MEUSD_CRV2POOL_METAPOOL_ADDRESS, CURVE_MSUSD_FRAXBP_METAPOOL_ADDRESS,
  CURVE_NXUSD_COMPOSITE_POOL_ADDRESS, CURVE_OUSD_3CRV_METAPOOL_ADDRESS,
  CURVE_TUSD_AM3CRV_METAPOOL_ADDRESS, CURVE_USD1_COMPOSITE_POOL_ADDRESS,
} from "./curve-composite-identities";

export const CURVE_RATE_BEARING_ADAPTER_PROFILE_ID =
  DEX_MEASURED_ADAPTER_PROFILE_IDS.curveRateBearing;
export const CURVE_METAPOOL_ADAPTER_PROFILE_ID =
  DEX_MEASURED_ADAPTER_PROFILE_IDS.curveMetapool;

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
const CURVE_ALUSD_3CRV_METAPOOL_POLICY = activeMetapoolPolicy({
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

const CURVE_DOLA_FRAXBP_METAPOOL_POLICY = ethereumFraxBpMetapool({
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

const CURVE_EUSD_FRAXBP_METAPOOL_POLICY = ethereumFraxBpMetapool({
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

const CURVE_MSUSD_FRAXBP_METAPOOL_POLICY = ethereumFraxBpMetapool({
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

const CURVE_MEUSD_CRV2POOL_METAPOOL_POLICY = activeMetapoolPolicy({
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

const CURVE_OUSD_3CRV_METAPOOL_POLICY = activeMetapoolPolicy({
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

const CURVE_MAI_AM3CRV_METAPOOL_POLICY = polygonAm3CrvMetapool({
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

const CURVE_TUSD_AM3CRV_METAPOOL_POLICY = polygonAm3CrvMetapool({
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

export function getCurveCompositePolicy(
  chain: string,
  poolAddress: string,
): CurveCompositePoolPolicy | null {
  const normalizedChain = chain.trim().toLowerCase();
  const normalizedAddress = canonicalEvmAddress(poolAddress);
  return POLICIES.find(
    (policy) => policy.chain === normalizedChain && policy.poolAddress === normalizedAddress,
  ) ?? null;
}

export function isCurveCompositeAdapterProfileId(profileId: string): boolean {
  return profileId === CURVE_RATE_BEARING_ADAPTER_PROFILE_ID ||
    profileId === CURVE_METAPOOL_ADAPTER_PROFILE_ID;
}
