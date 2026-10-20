import { describe, expect, it } from "vitest";
import { resolveRequiredTrackedContractConfig } from "../tracked-contract-resolution";

describe("lightweight tracked contract resolution", () => {
  it("preserves primary, traded, and any-source selection", () => {
    expect(resolveRequiredTrackedContractConfig("usdt-tether", "optimism")).toMatchObject({
      contractAddress: "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58",
      decimals: 6,
    });
    expect(
      resolveRequiredTrackedContractConfig("usdt-tether", "optimism", { source: "traded" }),
    ).toMatchObject({
      contractAddress: "0x01bFF41798a0BcF287b996046Ca68b395DbC1071",
      decimals: 6,
    });
    expect(
      resolveRequiredTrackedContractConfig("usdt-tether", "optimism", { source: "any" }),
    ).toMatchObject({
      contractAddress: "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58",
      decimals: 6,
    });
  });

  it("rejects unreviewed foreign-address and missing-chain decimal inference", () => {
    for (const chainId of ["bsc", "missing-chain"]) {
      expect(() => resolveRequiredTrackedContractConfig("usdt-tether", chainId, {
        addressOverride: "0x0000000000000000000000000000000000000001",
      })).toThrow(`Missing tracked contract for usdt-tether on ${chainId}`);
    }
  });

  it("accepts explicit override scales and exact deployment identities", () => {
    expect(resolveRequiredTrackedContractConfig("usdt-tether", "optimism", {
      source: "traded", addressOverride: "0x01bff41798a0bcf287b996046ca68b395dbc1071",
    })).toMatchObject({ decimals: 6 });
    expect(
      resolveRequiredTrackedContractConfig("usdt-tether", "bsc", {
        addressOverride: "0x0000000000000000000000000000000000000003",
        decimalsOverride: 9,
      }),
    ).toMatchObject({
      contractAddress: "0x0000000000000000000000000000000000000003",
      decimals: 9,
    });
  });

  it("preserves unknown-ID and missing-deployment errors", () => {
    expect(() => resolveRequiredTrackedContractConfig("unknown-stablecoin", "ethereum"))
      .toThrow("Unknown tracked stablecoin: unknown-stablecoin");
    expect(() => resolveRequiredTrackedContractConfig("usdc-circle", "missing-chain"))
      .toThrow("Missing tracked contract for usdc-circle on missing-chain");
  });
});
