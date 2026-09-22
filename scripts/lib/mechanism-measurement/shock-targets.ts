import shockCoverageTargetRoster from "../../../shared/data/safety-score-v9/shock-coverage-targets.json";

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

const rawShockCoverageTargets: unknown = shockCoverageTargetRoster.targets;
if (!Array.isArray(rawShockCoverageTargets) || rawShockCoverageTargets.length === 0) {
  throw new Error("Canonical shock-coverage target roster must contain at least one target");
}
if (
  rawShockCoverageTargets.some(
    (target) =>
      typeof target !== "object" ||
      target === null ||
      !("assetId" in target) ||
      typeof target.assetId !== "string",
  )
) {
  throw new Error("Canonical shock-coverage targets must have string assetIds");
}

export const SHOCK_COVERAGE_TARGET_DETAILS = Object.freeze([
  ...rawShockCoverageTargets,
]) as readonly ShockCoverageTarget[];
export const SHOCK_COVERAGE_TARGETS = SHOCK_COVERAGE_TARGET_DETAILS;
export const SHOCK_COVERAGE_TARGET_IDS: readonly string[] = Object.freeze(
  SHOCK_COVERAGE_TARGET_DETAILS.map((target) => target.assetId),
);
if (
  SHOCK_COVERAGE_TARGET_IDS.some((assetId) => !/^[a-z0-9][a-z0-9-]*$/.test(assetId))
) {
  throw new Error("Configured shock-coverage target assetIds must be non-empty slugs");
}
if (new Set(SHOCK_COVERAGE_TARGET_IDS).size !== SHOCK_COVERAGE_TARGET_IDS.length) {
  throw new Error("Duplicate configured shock-coverage target assetId");
}

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
