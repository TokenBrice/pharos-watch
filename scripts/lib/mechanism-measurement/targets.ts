interface CdpMeasurementTargetBase {
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

export type CdpMeasurementTarget = LiquityV1MeasurementTarget | LiquityV2MeasurementTarget;

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
];
