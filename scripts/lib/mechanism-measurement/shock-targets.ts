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
  branches: readonly { collateralSymbol: string; addressesRegistry: string }[];
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
