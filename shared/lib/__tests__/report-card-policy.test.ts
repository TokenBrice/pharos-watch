import { describe, it, expect } from "vitest";
import { inferResilienceDefaults } from "../report-card-policy";
import { BACKING_TYPE_VALUES, GOVERNANCE_TYPE_VALUES } from "@shared/types/core";
import {
  type BackingType,
  type CollateralQuality,
  type CustodyModel,
  type GovernanceType,
} from "@shared/types";

type ResilienceDefaults = {
  collateralQuality: CollateralQuality;
  custodyModel: CustodyModel;
};

// Expected defaults for every BackingType × GovernanceType combination,
// transcribed from DEFAULT_RESILIENCE_FACTORS so a silent table change fails
// here rather than only transitively through resilience-score consumers.
const EXPECTED: Record<`${BackingType}:${GovernanceType}`, ResilienceDefaults> = {
  "rwa-backed:centralized": {
    collateralQuality: "rwa",
    custodyModel: "institutional-regulated",
  },
  "rwa-backed:centralized-dependent": {
    collateralQuality: "rwa",
    custodyModel: "institutional-regulated",
  },
  "rwa-backed:decentralized": {
    collateralQuality: "native",
    custodyModel: "onchain",
  },
  "crypto-backed:centralized": {
    collateralQuality: "native",
    custodyModel: "onchain",
  },
  "crypto-backed:centralized-dependent": {
    collateralQuality: "eth-lst",
    custodyModel: "onchain",
  },
  "crypto-backed:decentralized": {
    collateralQuality: "native",
    custodyModel: "onchain",
  },
  "algorithmic:centralized": {
    collateralQuality: "native",
    custodyModel: "onchain",
  },
  "algorithmic:centralized-dependent": {
    collateralQuality: "native",
    custodyModel: "onchain",
  },
  "algorithmic:decentralized": {
    collateralQuality: "native",
    custodyModel: "onchain",
  },
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
