import { describe, it, expect } from "vitest";
import { resolveCustodyModel } from "../report-card-policy";
import { BACKING_TYPE_VALUES, CUSTODY_MODEL_VALUES, GOVERNANCE_TYPE_VALUES } from "@shared/types/core";
import { makeStablecoinMeta } from "@shared/test-utils/stablecoin";
import { applyInputDrivenExclusions } from "../selector/exclusions";
import { makeInput, makeMergedRow as makeRow } from "../selector/__tests__/fixture";

describe("whole-book custody eligibility", () => {
  it.each([
    ["rwa-backed", "centralized", "unknown"],
    ["rwa-backed", "centralized-dependent", "unknown"],
    ["rwa-backed", "decentralized", "onchain"],
    ["crypto-backed", "centralized", "onchain"],
    ["crypto-backed", "centralized-dependent", "onchain"],
    ["crypto-backed", "decentralized", "onchain"],
    ["algorithmic", "centralized", "onchain"],
    ["algorithmic", "centralized-dependent", "onchain"],
    ["algorithmic", "decentralized", "onchain"],
  ] as const)("defaults %s:%s to %s without inventing institutional coverage", (backing, governance, expected) => {
    const custodyModel = resolveCustodyModel({
      ...makeStablecoinMeta(),
      listingClass: "core-stablecoin",
      hasAuthoredDependencyEvidence: false,
      flags: { ...makeStablecoinMeta().flags, backing, governance },
    });
    expect(custodyModel).toBe(expected);
    expect(applyInputDrivenExclusions(makeRow({ custodyModel }), makeInput({ custodyOk: "regulated-only" })))
      .toMatchObject({ reason: "custody-regulated-only-violation" });
    const onchainExclusion = applyInputDrivenExclusions(makeRow({ custodyModel }), makeInput({ custodyOk: "onchain-only" }));
    if (expected === "onchain") {
      expect(onchainExclusion).toBeNull();
    } else {
      expect(onchainExclusion).toMatchObject({ reason: "custody-onchain-only-violation" });
    }
  });

  it.each(CUSTODY_MODEL_VALUES)("preserves the authored value %s over every class default", (custodyModel) => {
    for (const backing of BACKING_TYPE_VALUES) {
      for (const governance of GOVERNANCE_TYPE_VALUES) {
        expect(resolveCustodyModel({
          ...makeStablecoinMeta(),
          listingClass: "core-stablecoin",
          hasAuthoredDependencyEvidence: false,
          custodyModel,
          flags: { ...makeStablecoinMeta().flags, backing, governance },
        })).toBe(custodyModel);
      }
    }
  });

  it.each(["mixed", "unknown"] as const)("does not credit %s as regulated or all-onchain", (custodyModel) => {
    for (const custodyOk of ["regulated-only", "onchain-only"] as const) {
      expect(applyInputDrivenExclusions(makeRow({ custodyModel }), makeInput({ custodyOk })))
        .toMatchObject({ reason: `custody-${custodyOk}-violation` });
    }
    expect(applyInputDrivenExclusions(makeRow({ custodyModel }), makeInput({ custodyOk: "any" }))).toBeNull();
  });
});
