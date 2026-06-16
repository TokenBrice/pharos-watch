import { describe, it, expect } from "vitest";
import { inferResilienceDefaults, inferGovernanceQuality } from "../report-card-policy";
import { BACKING_TYPE_VALUES, GOVERNANCE_TYPE_VALUES } from "@shared/types/core";
import {
  type BackingType,
  type ChainTier,
  type CollateralQuality,
  type CustodyModel,
  type DeploymentModel,
  type GovernanceQuality,
  type GovernanceType,
} from "@shared/types";

type ResilienceDefaults = {
  chainTier: ChainTier;
  deploymentModel: DeploymentModel;
  collateralQuality: CollateralQuality;
  custodyModel: CustodyModel;
};

// Expected defaults for every BackingType × GovernanceType combination,
// transcribed from DEFAULT_RESILIENCE_FACTORS so a silent table change fails
// here rather than only transitively through resilience-score consumers.
const EXPECTED: Record<`${BackingType}:${GovernanceType}`, ResilienceDefaults> = {
  "rwa-backed:centralized": {
    chainTier: "ethereum",
    deploymentModel: "single-chain",
    collateralQuality: "rwa",
    custodyModel: "institutional-regulated",
  },
  "rwa-backed:centralized-dependent": {
    chainTier: "ethereum",
    deploymentModel: "single-chain",
    collateralQuality: "rwa",
    custodyModel: "institutional-regulated",
  },
  "rwa-backed:decentralized": {
    chainTier: "ethereum",
    deploymentModel: "single-chain",
    collateralQuality: "native",
    custodyModel: "onchain",
  },
  "crypto-backed:centralized": {
    chainTier: "ethereum",
    deploymentModel: "single-chain",
    collateralQuality: "native",
    custodyModel: "onchain",
  },
  "crypto-backed:centralized-dependent": {
    chainTier: "ethereum",
    deploymentModel: "single-chain",
    collateralQuality: "eth-lst",
    custodyModel: "onchain",
  },
  "crypto-backed:decentralized": {
    chainTier: "ethereum",
    deploymentModel: "single-chain",
    collateralQuality: "native",
    custodyModel: "onchain",
  },
  "algorithmic:centralized": {
    chainTier: "ethereum",
    deploymentModel: "single-chain",
    collateralQuality: "native",
    custodyModel: "onchain",
  },
  "algorithmic:centralized-dependent": {
    chainTier: "ethereum",
    deploymentModel: "single-chain",
    collateralQuality: "native",
    custodyModel: "onchain",
  },
  "algorithmic:decentralized": {
    chainTier: "ethereum",
    deploymentModel: "single-chain",
    collateralQuality: "native",
    custodyModel: "onchain",
  },
};

const EXPECTED_GOVERNANCE_QUALITY: Record<GovernanceType, GovernanceQuality> = {
  centralized: "single-entity",
  "centralized-dependent": "multisig",
  decentralized: "dao-governance",
};

describe("inferResilienceDefaults", () => {
  for (const backing of BACKING_TYPE_VALUES) {
    for (const governance of GOVERNANCE_TYPE_VALUES) {
      const key = `${backing}:${governance}` as const;
      it(`returns the expected defaults for ${key}`, () => {
        expect(inferResilienceDefaults(backing, governance)).toEqual(EXPECTED[key]);
      });
    }
  }

  it("resolves every backing × governance combination to a defined record", () => {
    for (const backing of BACKING_TYPE_VALUES) {
      for (const governance of GOVERNANCE_TYPE_VALUES) {
        expect(inferResilienceDefaults(backing, governance)).toBeDefined();
      }
    }
  });
});

describe("inferGovernanceQuality", () => {
  for (const governance of GOVERNANCE_TYPE_VALUES) {
    it(`maps ${governance} to ${EXPECTED_GOVERNANCE_QUALITY[governance]}`, () => {
      expect(inferGovernanceQuality(governance)).toBe(EXPECTED_GOVERNANCE_QUALITY[governance]);
    });
  }
});
