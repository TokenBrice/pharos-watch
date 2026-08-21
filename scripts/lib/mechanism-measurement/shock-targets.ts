export const SHOCK_FRACTIONS_PPM = [400_000, 500_000, 600_000, 750_000] as const;
export const SCORE_SHOCK_FRACTION_PPM = 500_000 as const;
export const DEBT_RECONCILIATION_TOLERANCE_PPM = 1_000 as const;

interface ShockCoverageTargetBase {
  assetId: string;
  chain: { key: string; evmChainId: number };
  rpcs: readonly string[];
  maxPositionsPerBranch: number;
  sourcePin: {
    repository: string;
    commit: string;
    liquidationContractPath: string;
  };
  sources: readonly { label: string; url: string }[];
}

export interface LiquityV1ShockCoverageTarget extends ShockCoverageTargetBase {
  family: "liquity-v1-shock-v1";
  contracts: {
    token: string;
    troveManager: string;
    stabilityPool: string;
    priceFeed: string;
    borrowerOperations: string;
    gasPool: string;
    collSurplusPool: string;
  };
}

export interface LiquityV2ShockCoverageTarget extends ShockCoverageTargetBase {
  family: "liquity-v2-shock-v1";
  contracts: {
    token: string;
    collateralRegistry: string;
  };
  spDeposits: { signature: string; selector: string };
  branches: readonly {
    collateralSymbol: string;
    addressesRegistry: string;
    oracleGraph?: {
      /** Pin a direct AggregatorV3-compatible proxy implementation when the proxy has no aggregator() getter. */
      primaryImplementationAddress?: string;
      secondary?: {
        signature: string;
        selector: string;
        implementationAddress?: string;
      };
      rateProvider?: {
        signature: string;
        selector: string;
        expectedAddress: string;
      };
    };
  }[];
  maxBranches: number;
}

export type ShockCoverageTarget = LiquityV1ShockCoverageTarget | LiquityV2ShockCoverageTarget;

const ETHEREUM_ARCHIVE_RPCS = [
  "https://eth-mainnet.public.blastapi.io",
  "https://eth.drpc.org",
  "https://eth.blockscout.com/api/eth-rpc",
  "https://1rpc.io/eth",
] as const;

export const SHOCK_COVERAGE_TARGETS: readonly ShockCoverageTarget[] = [
  {
    assetId: "bd-basedollar",
    family: "liquity-v2-shock-v1",
    chain: { key: "base", evmChainId: 8453 },
    rpcs: ["https://base-rpc.publicnode.com", "https://base.llamarpc.com", "https://mainnet.base.org"],
    maxPositionsPerBranch: 5_000,
    maxBranches: 16,
    contracts: {
      token: "0x252d36f435582ecb01686448d21e8c9ea0b2ca65",
      collateralRegistry: "0x7551ebfc8340b7f91874942be9c653733d4fb04f",
    },
    spDeposits: { signature: "getTotalBoldDeposits()", selector: "0xf71c6940" },
    branches: [
      {
        collateralSymbol: "WETH",
        addressesRegistry: "0xdad2735973d29e3a8ce26667774a624e0ea97556",
        oracleGraph: { primaryImplementationAddress: "0x5ab26742abe7c904ddf35b4cae288eb4e4a36df2" },
      },
      {
        collateralSymbol: "wstETH",
        addressesRegistry: "0x3e35fcc70d2ed82adce6c1e8f111554a04b74f3f",
        oracleGraph: {
          primaryImplementationAddress: "0x5ab26742abe7c904ddf35b4cae288eb4e4a36df2",
          secondary: {
            signature: "stEthUsdOracle()",
            selector: "0xd69e820d",
            implementationAddress: "0xbaf71b9a60c5fe2a6a448c0f2e3d66e42f5b5db8",
          },
          rateProvider: {
            signature: "rateProviderAddress()",
            selector: "0xe5aa1c40",
            expectedAddress: "0x00caeda3cb375a17a084b1bdce7136bb01bbd13d",
          },
        },
      },
      {
        collateralSymbol: "rETH",
        addressesRegistry: "0xd4763ae6021927784a7a787c1a98b287f919d165",
        oracleGraph: {
          primaryImplementationAddress: "0x5ab26742abe7c904ddf35b4cae288eb4e4a36df2",
          secondary: {
            signature: "rEthEthOracle()",
            selector: "0x03f04756",
            implementationAddress: "0x73f526b1611f9cebbacd3110b4df3a0342864ae7",
          },
          rateProvider: {
            signature: "rateProviderAddress()",
            selector: "0xe5aa1c40",
            expectedAddress: "0x658843bb859b7b85ceab5cf77167e3f0a78dfe7f",
          },
        },
      },
      {
        collateralSymbol: "cbBTC",
        addressesRegistry: "0x1fdea10dc1f6ff27ed9881bdf464fe070dda6f76",
        oracleGraph: {
          primaryImplementationAddress: "0x4b9188dcb11c73b62e49e10791ebc276a2a66fc5",
          secondary: {
            signature: "btcUsdOracle()",
            selector: "0xca1ca21c",
            implementationAddress: "0xc1b881e528cf9b3ea4838a327fa0104f49da1489",
          },
        },
      },
      {
        collateralSymbol: "cbETH",
        addressesRegistry: "0x98f5ddda4c0250966a446d39167d0bfb8e4ca1b6",
        oracleGraph: {
          primaryImplementationAddress: "0x5ab26742abe7c904ddf35b4cae288eb4e4a36df2",
          secondary: {
            signature: "cbEthEthOracle()",
            selector: "0x4403b69b",
            implementationAddress: "0x9823fffe5ff8aaaa142dd6a398e501d49aaae9d9",
          },
        },
      },
    ],
    sourcePin: {
      repository: "https://github.com/basedollar/basedollar",
      commit: "fd325e5aeafa2e4881a4a2d32451dfc9dfa0d941",
      liquidationContractPath: "contracts/src/TroveManager.sol",
    },
    sources: [
      {
        label: "Pinned Base Dollar liquidation state machine",
        url: "https://github.com/basedollar/basedollar/blob/fd325e5aeafa2e4881a4a2d32451dfc9dfa0d941/contracts/src/TroveManager.sol",
      },
      {
        label: "Base Dollar Base mainnet CollateralRegistry",
        url: "https://base.blockscout.com/address/0x7551ebfc8340b7f91874942be9c653733d4fb04f",
      },
    ],
  },
  {
    assetId: "lusd-liquity",
    family: "liquity-v1-shock-v1",
    chain: { key: "ethereum", evmChainId: 1 },
    rpcs: ETHEREUM_ARCHIVE_RPCS,
    maxPositionsPerBranch: 5_000,
    contracts: {
      token: "0x5f98805a4e8be255a32880fdec7f6728c6568ba0",
      troveManager: "0xa39739ef8b0231dbfa0dcda07d7e29faabcf4bb2",
      stabilityPool: "0x66017d22b0f8556afdd19fc67041899eb65a21bb",
      priceFeed: "0x4c517d4e2c851ca76d7ec94b805269df0f2201de",
      borrowerOperations: "0x24179cd81c9e782a4096035f7ec97fb8b783e007",
      gasPool: "0x9555b042f969e561855e5f28cb1230819149a8d9",
      collSurplusPool: "0x3d32e8b97ed5881324241cf03b2da5e2ebce5521",
    },
    sourcePin: {
      repository: "https://github.com/liquity/dev",
      commit: "5174ecd0da4842157aba989499200d690b7e374f",
      liquidationContractPath: "packages/contracts/contracts/TroveManager.sol",
    },
    sources: [
      {
        label: "Liquity V1 deployed TroveManager and liquidation state machine",
        url: "https://github.com/liquity/dev/blob/5174ecd0da4842157aba989499200d690b7e374f/packages/contracts/contracts/TroveManager.sol",
      },
      {
        label: "Liquity V1 mainnet deployment",
        url: "https://etherscan.io/address/0xa39739ef8b0231dbfa0dcda07d7e29faabcf4bb2",
      },
    ],
  },
  {
    assetId: "bold-liquity",
    family: "liquity-v2-shock-v1",
    chain: { key: "ethereum", evmChainId: 1 },
    rpcs: ETHEREUM_ARCHIVE_RPCS,
    maxPositionsPerBranch: 5_000,
    maxBranches: 16,
    contracts: {
      token: "0x6440f144b7e50d6a8439336510312d2f54beb01d",
      collateralRegistry: "0xf949982b91c8c61e952b3ba942cbbfaef5386684",
    },
    spDeposits: { signature: "getTotalBoldDeposits()", selector: "0xf71c6940" },
    branches: [
      { collateralSymbol: "WETH", addressesRegistry: "0x20f7c9ad66983f6523a0881d0f82406541417526" },
      { collateralSymbol: "wstETH", addressesRegistry: "0x8d733f7ea7c23cbea7c613b6ebd845d46d3aac54" },
      { collateralSymbol: "rETH", addressesRegistry: "0x6106046f031a22713697e04c08b330ddaf3e8789" },
    ],
    sourcePin: {
      repository: "https://github.com/liquity/bold",
      commit: "c8a5a4ee2e9dc024905856b6698a77d849c68c7e",
      liquidationContractPath: "contracts/src/TroveManager.sol",
    },
    sources: [
      {
        label: "Liquity V2 pinned liquidation state machine",
        url: "https://github.com/liquity/bold/blob/c8a5a4ee2e9dc024905856b6698a77d849c68c7e/contracts/src/TroveManager.sol",
      },
      {
        label: "Liquity V2 mainnet CollateralRegistry",
        url: "https://etherscan.io/address/0xf949982b91c8c61e952b3ba942cbbfaef5386684",
      },
    ],
  },
] as const;

export interface ShockCoverageApplicability {
  assetId: string;
  applicable: boolean;
  completeSimulator: boolean;
  reconciledCommittedPool: boolean;
  selectedPath: "stress-measurement" | "legacyLCR";
  failureReason: string | null;
}

const EXPLICIT_INELIGIBLE: Readonly<Record<string, Omit<ShockCoverageApplicability, "assetId">>> = {
  "mim-abracadabra": {
    applicable: false,
    completeSimulator: false,
    reconciledCommittedPool: false,
    selectedPath: "legacyLCR",
    failureReason: "no-reconciled-committed-pool-and-no-complete-family-simulator",
  },
};

export function getShockCoverageTarget(assetId: string): ShockCoverageTarget | undefined {
  return SHOCK_COVERAGE_TARGETS.find((target) => target.assetId === assetId);
}

export function assessShockCoverageApplicability(assetId: string): ShockCoverageApplicability {
  const target = getShockCoverageTarget(assetId);
  if (target) {
    return {
      assetId,
      applicable: true,
      completeSimulator: true,
      reconciledCommittedPool: true,
      selectedPath: "stress-measurement",
      failureReason: null,
    };
  }

  const explicit = EXPLICIT_INELIGIBLE[assetId];
  if (explicit) return { assetId, ...explicit };

  return {
    assetId,
    applicable: false,
    completeSimulator: false,
    reconciledCommittedPool: false,
    selectedPath: "legacyLCR",
    failureReason: "unsupported-family-or-missing-complete-measurement",
  };
}
