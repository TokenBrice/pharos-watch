import { describe, expect, it } from "vitest";
import base from "@shared/data/stablecoins/coins/usdc-circle.json";
import type { StablecoinMeta } from "@shared/types/core";
import { computeDexDeploymentSupplyCoverage } from "../report-cards-snapshot-inputs";

const native = "0xb6ceceab302e2e4948951ee7843fc24e92933061";
const bridged = "0x74b7f16337b8972027f6196a17a631ac6de26d22";

describe("USDC X Layer deployment supply", () => {
  it("does not allocate or double-count aggregate X Layer supply between the deployments", () => {
    const amount = 10_000_000;
    const coverage = computeDexDeploymentSupplyCoverage({
      contracts: base.contracts as StablecoinMeta["contracts"],
      chainCirculating: { "X Layer": {
        current: amount, circulatingPrevDay: amount,
        circulatingPrevWeek: amount, circulatingPrevMonth: amount,
      } },
    }, [
      { chain: "xlayer", contractAddress: native, outcome: "observed_pools" },
      { chain: "xlayer", contractAddress: bridged, outcome: "verified_no_pools" },
    ], new Map([["xlayer", 1_000_000]]));
    expect(coverage).toMatchObject({
      totalSupplyUsd: amount,
      unknownSupplyUsd: amount,
      unknownSupplyRatio: 1,
      unknownChains: ["xlayer"],
      observedSupplyUsd: 0,
    });
  });
});
