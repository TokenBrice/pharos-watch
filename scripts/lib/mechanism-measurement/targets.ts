export interface CdpMeasurementTarget {
  assetId: string;
  family: "liquity-v1";
  chain: { key: string; evmChainId: number };
  /** Tried in order; a failure restarts the whole measurement on the next endpoint, never mixing sources in one file. */
  rpcs: readonly string[];
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
  overlaySources: readonly { label: string; url: string }[];
}

export const CDP_MEASUREMENT_TARGETS: readonly CdpMeasurementTarget[] = [
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
