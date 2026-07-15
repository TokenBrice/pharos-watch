export interface CdpMeasurementTargetBase {
  assetId: string;
  chain: { key: string; evmChainId: number };
  /** Tried in order; a failure restarts the whole measurement on the next endpoint, never mixing sources in one file. */
  rpcs: readonly string[];
  overlaySources: readonly { label: string; url: string }[];
}

export interface LiquityV1MeasurementTarget extends CdpMeasurementTargetBase {
  family: "liquity-v1";
  contracts: {
    token: string;
    troveManager: string;
    stabilityPool: string;
    priceFeed: string;
  };
  chainlink: {
    feed: string;
    heartbeatSeconds: number;
    /** Max relative difference between the protocol price and the Chainlink answer. */
    tolerancePct: number;
  };
  sanity: {
    minCollateralizationRatio: number;
    maxCollateralizationRatio: number;
    minPriceUsd: number;
    maxPriceUsd: number;
    /** Max relative divergence between token totalSupply and entire system debt. */
    maxSupplyDebtDivergencePct: number;
  };
}

export interface LiquityV2MeasurementTarget extends CdpMeasurementTargetBase {
  family: "liquity-v2";
  contracts: {
    token: string;
    collateralRegistry: string;
  };
  /** Stability Pool deposits getter — forks rename it (BOLD getTotalBoldDeposits, Felix getTotalfeUSDDeposits). */
  spDeposits: { signature: string; selector: string };
  /**
   * Optional Chainlink cross-check for the branch-0 collateral price (mainnet
   * WETH branch). Chains without Chainlink record protocol-feed-only evidence.
   */
  chainlinkBranch0?: {
    feed: string;
    heartbeatSeconds: number;
    tolerancePct: number;
  };
  sanity: {
    minCollateralizationRatio: number;
    maxCollateralizationRatio: number;
    /** V2 forks accrue unminted interest; divergence tolerance is wider than V1. */
    maxSupplyDebtDivergencePct: number;
    maxBranches: number;
  };
}

export interface EnumeratedLiquityV2MeasurementTarget extends CdpMeasurementTargetBase {
  family: "liquity-v2-enumerated-v1";
  contracts: {
    token: string;
    collateralRegistry: string;
    deriveRegistryFromToken: boolean;
  };
  controllerEnumerator: { signature: string; selector: string };
  spDeposits: { signature: string; selector: string };
  branches: readonly {
    collateralToken: string;
    controller: string;
    collateralDecimals: number;
    debtDecimals: number;
    priceDecimals: number;
    activePool?: string;
  }[];
  sanity: {
    maxSupplyDebtDivergencePct: number;
    maxBranches: number;
  };
}

interface MentoConversionTargetBase extends CdpMeasurementTargetBase {
  family: "mento-conversion-evidence-v1";
  contracts: { token: string; counterToken: string };
}

export interface MentoBrokerMeasurementTarget extends MentoConversionTargetBase {
  mode: "broker-pool";
  contracts: MentoConversionTargetBase["contracts"] & { biPoolManager: string };
  maxExchangeIds: number;
}

export interface MentoFpmmMeasurementTarget extends MentoConversionTargetBase {
  mode: "fpmm-pool";
  contracts: MentoConversionTargetBase["contracts"] & { pool: string };
}

export type MentoConversionMeasurementTarget = MentoBrokerMeasurementTarget | MentoFpmmMeasurementTarget;

export interface YamatoMeasurementTarget extends CdpMeasurementTargetBase {
  family: "yamato-system-v1";
  contracts: { token: string; yamato: string; expectedPool: string };
}

export interface GhoMeasurementTarget extends CdpMeasurementTargetBase {
  family: "gho-facilitator-evidence-v1";
  contracts: { token: string };
  trackedGsms: readonly string[];
  maxFacilitators: number;
}

export interface FxProtocolMeasurementTarget extends CdpMeasurementTargetBase {
  family: "fx-protocol-v1";
  contracts: {
    token: string;
    poolManager: string;
    fxBase: string;
  };
  pools: readonly {
    address: string;
    collateralToken: string;
    priceOracle: string;
  }[];
  registrationFromBlock: number;
  registrationTopic: string;
  maxSupplyDebtDivergencePct: number;
}

export interface WrapperMechanismMeasurementTarget extends CdpMeasurementTargetBase {
  family: "wrapper-mechanism-v1";
  contracts: { wrapper: string; expectedAsset: string };
  parentAssetId: string;
  maxAccountingDeltaPct: number;
  complete: boolean;
  blocker?: string;
}

export interface ResupplyMeasurementTarget extends CdpMeasurementTargetBase {
  family: "resupply-pairs-v1";
  contracts: {
    token: string;
    registry: string;
    expectedInsurancePool: string;
    expectedLiquidationHandler: string;
  };
  allowedUnderlyings: readonly string[];
  maxPairs: number;
  maxSupplyDebtDivergencePct: number;
}

export type CdpMeasurementTarget =
  | LiquityV1MeasurementTarget
  | LiquityV2MeasurementTarget
  | EnumeratedLiquityV2MeasurementTarget
  | MentoConversionMeasurementTarget
  | YamatoMeasurementTarget
  | GhoMeasurementTarget
  | FxProtocolMeasurementTarget
  | WrapperMechanismMeasurementTarget
  | ResupplyMeasurementTarget;

const ETHEREUM_RPCS = [
  "https://ethereum-rpc.publicnode.com",
  "https://eth.llamarpc.com",
  "https://1rpc.io/eth",
] as const;
const CELO_RPCS = ["https://forno.celo.org"] as const;
const MENTO_COUNTER_TOKEN = "0x765de816845861e75a25fca122bb6898b8b1282a";
const MENTO_BIPOOL_MANAGER = "0x22d9db95e6ae61c104a7b6f6c78d7993b94ec901";
const MENTO_SOURCES = [
  {
    label: "Mento BiPoolManager/FPMM conversion state on Celo at the pinned block",
    url: "https://celoscan.io/address/0x22d9db95e6ae61c104a7b6f6c78d7993b94ec901",
  },
  {
    label: "Mento V3 documentation (permissionless reserve conversion design)",
    url: "https://docs.mento.org/mento-v3",
  },
] as const;

const MENTO_BROKER_TARGETS: readonly MentoBrokerMeasurementTarget[] = [
  ["audm-mento", "0x7175504c455076f15c04a2f90a8e352281f492f9"],
  ["cadm-mento", "0xff4ab19391af240c311c54200a492233052b6325"],
  ["copm-mento", "0x8a567e2ae79ca692bd748ab832081c45de4041ea"],
  ["ghsm-mento", "0xfaea5f3404bba20d3cc2f8c4b0a888f55a3c7313"],
  ["kesm-mento", "0x456a3d042c0dbd3db53d5489e98dfb038553b0d0"],
  ["phpm-mento", "0x105d4a9306d2e55a71d2eb95b81553ae1dc20d7b"],
  ["zarm-mento", "0x4c35853a3b4e647fd266f4de678dcc8fec410bf6"],
].map(([assetId, token]) => ({
  assetId,
  family: "mento-conversion-evidence-v1",
  mode: "broker-pool",
  chain: { key: "celo", evmChainId: 42220 },
  rpcs: CELO_RPCS,
  contracts: { token, counterToken: MENTO_COUNTER_TOKEN, biPoolManager: MENTO_BIPOOL_MANAGER },
  maxExchangeIds: 64,
  overlaySources: MENTO_SOURCES,
}));

const ADDITIONAL_MEASUREMENT_TARGETS: readonly CdpMeasurementTarget[] = [
  {
    assetId: "cdp-enosys",
    family: "liquity-v2-enumerated-v1",
    chain: { key: "flare", evmChainId: 14 },
    rpcs: ["https://flare-api.flare.network/ext/C/rpc"],
    contracts: {
      token: "0x6cd3a5ba46fa254d4d2e3c2b37350ae337e94a0f",
      collateralRegistry: "0x9474206bc035d03d142264fd9913d1d51246d3ac",
      deriveRegistryFromToken: true,
    },
    controllerEnumerator: { signature: "getTroveManager(uint256)", selector: "0x0bc17feb" },
    spDeposits: { signature: "getTotalBoldDeposits()", selector: "0xf71c6940" },
    branches: [
      {
        collateralToken: "0xad552a648c74d49e10027ab8a618a3ad4901c5be",
        controller: "0xc46e7d0538494feb82b460b9723daba0508c8fb1",
        collateralDecimals: 6,
        debtDecimals: 18,
        priceDecimals: 18,
      },
      {
        collateralToken: "0x1d80c49bbbcd1c0911346656b529df9e5c2f783d",
        controller: "0xb6cb0c5301d4e6e227ba490cee7b92eb954ac06d",
        collateralDecimals: 18,
        debtDecimals: 18,
        priceDecimals: 18,
      },
      {
        collateralToken: "0x4c18ff3c89632c3dd62e796c0afa5c07c4c1b2b3",
        controller: "0x3866d5ea3c04a1371d8c6f75529064455eb43220",
        collateralDecimals: 6,
        debtDecimals: 18,
        priceDecimals: 18,
      },
      {
        collateralToken: "0x12e605bc104e93b45e1ad99f9e555f659051c2bb",
        controller: "0xb7997ecdce5db9036c54e128d9efbcdcdc7c9303",
        collateralDecimals: 18,
        debtDecimals: 18,
        priceDecimals: 18,
      },
    ],
    sanity: { maxSupplyDebtDivergencePct: 0.1, maxBranches: 16 },
    overlaySources: [
      {
        label: "Enosys Loans registry and branch state on Flare",
        url: "https://flare-explorer.flare.network/address/0x9474206bc035D03d142264fd9913d1D51246d3AC",
      },
      { label: "Enosys Loans documentation", url: "https://help.enosys.global/enosys/enosys-ecosystem/enosys-loans" },
    ],
  },
  {
    assetId: "usdq-quill",
    family: "liquity-v2-enumerated-v1",
    chain: { key: "scroll", evmChainId: 534352 },
    rpcs: ["https://rpc.scroll.io"],
    contracts: {
      token: "0xdb9e8f82d6d45fff803161f2a5f75543972b229a",
      collateralRegistry: "0x358d90036e70542ae24b3813c0efecc1f8811442",
      deriveRegistryFromToken: true,
    },
    controllerEnumerator: { signature: "getTroveManager(uint256)", selector: "0x0bc17feb" },
    spDeposits: { signature: "getTotalBoldDeposits()", selector: "0xf71c6940" },
    branches: [
      {
        collateralToken: "0x5300000000000000000000000000000000000004",
        controller: "0x9d2ad9712f3905f3e7803c92d027a197b4c8da90",
        collateralDecimals: 18,
        debtDecimals: 18,
        priceDecimals: 18,
      },
      {
        collateralToken: "0xf610a9dfb7c89644979b4a0f27063e9e7d7cda32",
        controller: "0xa57aae77fbb22f9c1fb55d516e44b856614e143e",
        collateralDecimals: 18,
        debtDecimals: 18,
        priceDecimals: 18,
      },
      {
        collateralToken: "0x01f0a31698c4d065659b9bdc21b3610292a1c506",
        controller: "0xf645d67733b76e9d69908108d2eef6bec53dd7c8",
        collateralDecimals: 18,
        debtDecimals: 18,
        priceDecimals: 18,
      },
      {
        collateralToken: "0xd29687c813d741e2f938f4ac377128810e217b1b",
        controller: "0x862ec870184a66fd3ed6bd7e122bc18355002076",
        collateralDecimals: 18,
        debtDecimals: 18,
        priceDecimals: 18,
      },
    ],
    sanity: { maxSupplyDebtDivergencePct: 0.5, maxBranches: 16 },
    overlaySources: [
      {
        label: "Quill CollateralRegistry and branch state on Scroll",
        url: "https://scrollscan.com/address/0x358d90036e70542ae24b3813c0efecc1f8811442",
      },
      { label: "Quill deployment documentation", url: "https://docs.quill.finance/documentation/contract-addresses" },
    ],
  },
  {
    assetId: "gbpm-mento",
    family: "liquity-v2-enumerated-v1",
    chain: { key: "celo", evmChainId: 42220 },
    rpcs: CELO_RPCS,
    contracts: {
      token: "0xccf663b1ff11028f0b19058d0f7b674004a40746",
      collateralRegistry: "0x1bedd4334335522b0a0e8e610d326b16b0a605fb",
      deriveRegistryFromToken: false,
    },
    controllerEnumerator: { signature: "getTroveManager(uint256)", selector: "0x0bc17feb" },
    spDeposits: { signature: "getTotalBoldDeposits()", selector: "0xf71c6940" },
    branches: [
      {
        collateralToken: MENTO_COUNTER_TOKEN,
        controller: "0xb38aef2bf4e34b997330d626ebcd7629de3885c9",
        collateralDecimals: 18,
        debtDecimals: 18,
        priceDecimals: 18,
        activePool: "0xa7873f4bf2a1ea2eb20b1e8a992c4748e78473b2",
      },
    ],
    sanity: { maxSupplyDebtDivergencePct: 0.1, maxBranches: 4 },
    overlaySources: [
      {
        label: "Mento GBPm CollateralRegistry, TroveManager, ActivePool, and StabilityPool state on Celo",
        url: "https://celoscan.io/address/0x1bEDD4334335522B0a0e8e610d326B16B0a605Fb",
      },
      { label: "Mento V3 CDP documentation", url: "https://docs.mento.org/mento-v3/dive-deeper/cdp" },
    ],
  },
  ...MENTO_BROKER_TARGETS,
  {
    assetId: "jpym-mento",
    family: "mento-conversion-evidence-v1",
    mode: "fpmm-pool",
    chain: { key: "celo", evmChainId: 42220 },
    rpcs: CELO_RPCS,
    contracts: {
      token: "0xc45ecf20f3cd864b32d9794d6f76814ae8892e20",
      counterToken: MENTO_COUNTER_TOKEN,
      pool: "0x9861f6d2fe392b934c86ec89d2886ceb772b2b41",
    },
    overlaySources: MENTO_SOURCES,
  },
  {
    assetId: "chfm-mento",
    family: "mento-conversion-evidence-v1",
    mode: "fpmm-pool",
    chain: { key: "celo", evmChainId: 42220 },
    rpcs: CELO_RPCS,
    contracts: {
      token: "0xb55a79f398e759e43c95b979163f30ec87ee131d",
      counterToken: MENTO_COUNTER_TOKEN,
      pool: "0xdc81135fd82f02cae736e261fb676b716663e8b8",
    },
    overlaySources: MENTO_SOURCES,
  },
  {
    assetId: "cjpy-yamato",
    family: "yamato-system-v1",
    chain: { key: "ethereum", evmChainId: 1 },
    rpcs: ETHEREUM_RPCS,
    contracts: {
      token: "0x1cfa5641c01406ab8ac350ded7d735ec41298372",
      yamato: "0x02fe72b2e9ff717ebf3049333b184e9cd984f257",
      expectedPool: "0x9c1f0e3d4bd4a513721c028e1d4610cd17745f0b",
    },
    overlaySources: [
      {
        label: "Yamato getStates, priceFeed, pool, and CJPY accounting on Ethereum",
        url: "https://etherscan.io/address/0x02Fe72b2E9fF717EbF3049333B184E9Cd984f257#readProxyContract",
      },
      {
        label: "Yamato protocol documentation (no-liquidation design and redemptions)",
        url: "https://docs.yamato.fi/readme/english-overview",
      },
    ],
  },
  {
    assetId: "gho-aave",
    family: "gho-facilitator-evidence-v1",
    chain: { key: "ethereum", evmChainId: 1 },
    rpcs: ETHEREUM_RPCS,
    contracts: { token: "0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f" },
    trackedGsms: ["0x3a3868898305f04bec7fea77becff04c13444112", "0x882285e62656b9623af136ce3078c6bdcc33f5e3"],
    maxFacilitators: 32,
    overlaySources: [
      {
        label: "GHO facilitator registry and tracked GSM state on Ethereum",
        url: "https://etherscan.io/address/0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f#readContract",
      },
      { label: "Aave GHO facilitator documentation", url: "https://aave.com/help/gho-stablecoin/facilitators" },
    ],
  },
  {
    assetId: "fxusd-f-x-protocol",
    family: "fx-protocol-v1",
    chain: { key: "ethereum", evmChainId: 1 },
    rpcs: ["https://eth.blockscout.com/api/eth-rpc", ...ETHEREUM_RPCS],
    contracts: {
      token: "0x085780639cc2cacd35e474e71f4d000e2405d8f6",
      poolManager: "0x250893ca4ba5d05626c785e8da758026928fcd24",
      fxBase: "0x65c9a641afceb9c0e6034e558a319488fa0fa3be",
    },
    pools: [
      {
        address: "0x6ecfa38fee8a5277b91efda204c235814f0122e8",
        collateralToken: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
        priceOracle: "0x0c5c61025f047cb7e3e85852dc8eafd7b9a4abfb",
      },
      {
        address: "0xab709e26fa6b0a30c119d8c55b887ded24952473",
        collateralToken: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",
        priceOracle: "0xb3c90e64eb6f456a5f5c17aa99b6aeca6f4a6390",
      },
    ],
    registrationFromBlock: 21529341,
    registrationTopic: "0xdfc596fabc6581c887262c97695176a79e3c8fc6ab7aaf14700820f3436b8fb9",
    maxSupplyDebtDivergencePct: 0.1,
    overlaySources: [
      {
        label: "f(x) fxUSD, PoolManager, long-pool, oracle, and fxBASE state on Ethereum",
        url: "https://etherscan.io/address/0x085780639CC2cACd35E474e71f4d000e2405d8f6#readProxyContract",
      },
      { label: "f(x) Protocol documentation", url: "https://fxprotocol.gitbook.io/fx-docs" },
    ],
  },
  {
    assetId: "fxsave-f-x-protocol",
    family: "wrapper-mechanism-v1",
    chain: { key: "ethereum", evmChainId: 1 },
    rpcs: ETHEREUM_RPCS,
    contracts: {
      wrapper: "0x7743e50f534a7f9f1791dde7dcd89f7783eefc39",
      expectedAsset: "0x65c9a641afceb9c0e6034e558a319488fa0fa3be",
    },
    parentAssetId: "fxusd-f-x-protocol",
    maxAccountingDeltaPct: 1,
    complete: false,
    blocker:
      "Local wrapper accounting is reproducible, but the parent fxUSD mechanism evidence must be attached before an asset-wide review can clear.",
    overlaySources: [
      {
        label: "fxSAVE ERC-4626 wrapper accounting on Ethereum",
        url: "https://etherscan.io/address/0x7743e50f534a7f9f1791dde7dcd89f7783eefc39#readProxyContract",
      },
      { label: "f(x) Protocol documentation", url: "https://fxprotocol.gitbook.io/fx-docs" },
    ],
  },
  {
    assetId: "reusd-resupply",
    family: "resupply-pairs-v1",
    chain: { key: "ethereum", evmChainId: 1 },
    rpcs: ETHEREUM_RPCS,
    contracts: {
      token: "0x57ab1e0003f623289cd798b1824be09a793e4bec",
      registry: "0x10101010e0c3171d894b71b3400668af311e7d94",
      expectedInsurancePool: "0x00000000efe883b3304aff71eacf72dbc3e1b577",
      expectedLiquidationHandler: "0x88888888c227c36401493ed9f3e3dcc3800b2634",
    },
    allowedUnderlyings: ["0xf939e0a03fb07f59a73314e73794be0e57ac1b4e", "0xcacd6fd266af91b8aed52accc382b4e165586e29"],
    maxPairs: 64,
    maxSupplyDebtDivergencePct: 0.5,
    overlaySources: [
      {
        label: "Resupply Registry, pair accounting, collateral-vault conversion, and InsurancePool state on Ethereum",
        url: "https://etherscan.io/address/0x10101010E0C3171D894B71B3400668aF311e7D94#readContract",
      },
      {
        label: "Resupply protocol stability-mechanics documentation",
        url: "https://docs.resupply.fi/resupply-protocol/stability-mechanics",
      },
    ],
  },
];

export const CDP_MEASUREMENT_TARGETS: readonly CdpMeasurementTarget[] = [
  {
    assetId: "bold-liquity",
    family: "liquity-v2",
    chain: { key: "ethereum", evmChainId: 1 },
    rpcs: ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com", "https://1rpc.io/eth"],
    contracts: {
      token: "0x6440f144b7e50d6a8439336510312d2f54beb01d",
      collateralRegistry: "0xf949982b91c8c61e952b3ba942cbbfaef5386684",
    },
    spDeposits: { signature: "getTotalBoldDeposits()", selector: "0xf71c6940" },
    chainlinkBranch0: {
      feed: "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419",
      heartbeatSeconds: 3600,
      tolerancePct: 1,
    },
    sanity: {
      minCollateralizationRatio: 1,
      maxCollateralizationRatio: 100,
      maxSupplyDebtDivergencePct: 0.5,
      maxBranches: 16,
    },
    overlaySources: [
      {
        label:
          "Liquity V2 on-chain system state (CollateralRegistry branch enumeration, per-branch TroveManager coll/debt/price, StabilityPool getTotalBoldDeposits)",
        url: "https://etherscan.io/address/0xf949982b91c8c61e952b3ba942cbbfaef5386684",
      },
      {
        label: "Liquity V2 documentation (per-branch MCR, Stability Pool liquidation mechanics, branch isolation)",
        url: "https://docs.liquity.org/",
      },
    ],
  },
  {
    assetId: "feusd-felix",
    family: "liquity-v2",
    chain: { key: "hyperevm", evmChainId: 999 },
    rpcs: ["https://rpc.hyperliquid.xyz/evm"],
    contracts: {
      token: "0x02c6a2fa58cc01a18b8d9e00ea48d65e4df26c70",
      collateralRegistry: "0x9de1e57049c475736289cb006212f3e1dce4711b",
    },
    spDeposits: { signature: "getTotalfeUSDDeposits()", selector: "0x2d02cf6a" },
    sanity: {
      minCollateralizationRatio: 1,
      maxCollateralizationRatio: 100,
      maxSupplyDebtDivergencePct: 0.5,
      maxBranches: 16,
    },
    overlaySources: [
      {
        label:
          "Felix (Liquity V2 fork) on-chain system state on HyperEVM (CollateralRegistry branch enumeration, per-branch TroveManager coll/debt/price, StabilityPool getTotalfeUSDDeposits)",
        url: "https://hyperevmscan.io/address/0x9de1e57049c475736289cb006212f3e1dce4711b",
      },
      {
        label: "Felix documentation (Liquity V2 fork mechanics)",
        url: "https://usefelix.gitbook.io/felix-docs",
      },
    ],
  },
  {
    assetId: "lusd-liquity",
    family: "liquity-v1",
    chain: { key: "ethereum", evmChainId: 1 },
    rpcs: ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com", "https://1rpc.io/eth"],
    contracts: {
      token: "0x5f98805a4e8be255a32880fdec7f6728c6568ba0",
      troveManager: "0xa39739ef8b0231dbfa0dcda07d7e29faabcf4bb2",
      stabilityPool: "0x66017d22b0f8556afdd19fc67041899eb65a21bb",
      priceFeed: "0x4c517d4e2c851ca76d7ec94b805269df0f2201de",
    },
    chainlink: {
      feed: "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419",
      heartbeatSeconds: 3600,
      tolerancePct: 0.5,
    },
    sanity: {
      minCollateralizationRatio: 1,
      maxCollateralizationRatio: 100,
      minPriceUsd: 100,
      maxPriceUsd: 100_000,
      maxSupplyDebtDivergencePct: 0.1,
    },
    overlaySources: [
      {
        label:
          "Liquity V1 on-chain system state (TroveManager getEntireSystemColl/getEntireSystemDebt/getTCR, StabilityPool getTotalLUSDDeposits, PriceFeed fetchPrice simulation)",
        url: "https://etherscan.io/address/0xa39739ef8b0231dbfa0dcda07d7e29faabcf4bb2",
      },
      {
        label: "Liquity V1 documentation (Stability Pool liquidation mechanics, Recovery Mode, redemptions)",
        url: "https://docs.liquity.org/",
      },
    ],
  },
  ...ADDITIONAL_MEASUREMENT_TARGETS,
];
