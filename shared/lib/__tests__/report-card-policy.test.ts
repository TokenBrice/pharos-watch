import { describe, it, expect } from "vitest";
import { inferDefaultCustodyModel } from "../report-card-policy";
import { BACKING_TYPE_VALUES, GOVERNANCE_TYPE_VALUES } from "@shared/types/core";
import {
  type BackingType,
  type CustodyModel,
  type GovernanceType,
} from "@shared/types";

const EXPECTED: Record<`${BackingType}:${GovernanceType}`, CustodyModel> = {
  "rwa-backed:centralized": "institutional-regulated",
  "rwa-backed:centralized-dependent": "institutional-regulated",
  "rwa-backed:decentralized": "onchain",
  "crypto-backed:centralized": "onchain",
  "crypto-backed:centralized-dependent": "onchain",
  "crypto-backed:decentralized": "onchain",
  "algorithmic:centralized": "onchain",
  "algorithmic:centralized-dependent": "onchain",
  "algorithmic:decentralized": "onchain",
};

describe("inferDefaultCustodyModel", () => {
  for (const backing of BACKING_TYPE_VALUES) {
    for (const governance of GOVERNANCE_TYPE_VALUES) {
      const key = `${backing}:${governance}` as const;
      it(`returns the expected default for ${key}`, () => {
        expect(inferDefaultCustodyModel(backing, governance)).toBe(EXPECTED[key]);
      });
    }
  }
});
