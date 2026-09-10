import { describe, expect, it } from "vitest";
import { adaptFalconTransparency, type FalconTransparencyResponse } from "../falcon";
import { runAdapter } from "./reserve-adapter.test-support";

function falconPayload(
  assets: Array<{ label: string; [venue: string]: string | number }>,
  { timestamp = 1773316982, supply = "100", insurance = "5" } = {},
): FalconTransparencyResponse {
  return { snapshot_date: timestamp, usdf: { supply, insurance_fund: insurance, breakdown: { assets } } };
}
const FALCON_URL = "https://api.falcon.finance/api/v1/transparency";

describe("adaptFalconTransparency", () => {
  it("rejects drift removing usdf.supply", () => {
    const payload = falconPayload([{ label: "USDC", ceffu: "100" }]);
    Reflect.deleteProperty(payload.usdf!, "supply");
    expect(() => adaptFalconTransparency(payload)).toThrow(/usdf.supply/);
  });

  it("groups Falcon asset-level reserves into reserve buckets", () => {
    const payload = falconPayload([
      { label: "USDC", ceffu: "20", fireblocks: "10" },
      { label: "BTC", multisig: "25" },
      { label: "ETH", multisig: "10" },
      { label: "USTB", fireblocks: "15" },
      { label: "AVAX", fireblocks: "15" },
    ]);

    const result = adaptFalconTransparency(payload);

    expect(result.slices).toEqual([
      { name: "USDC cash-equivalent assets", pct: 30, risk: "low", coinId: "usdc-circle", depType: "collateral" },
      { name: "BTC collateral", pct: 25, risk: "medium" },
      { name: "USTB tokenized Treasury assets", pct: 15, risk: "low", coinId: "ustb-superstate" },
      { name: "Other crypto / tokenized assets", pct: 15, risk: "high" },
      { name: "ETH / liquid staking collateral", pct: 10, risk: "medium" },
      { name: "Insurance fund", pct: 5, risk: "medium" },
    ]);
    expect(result.metadata).toMatchObject({
      snapshotDate: 1773316982,
      supply: "100",
      supplyUsd: 100,
      insuranceFund: "5",
      assetCount: 5,
      sourceTimestamp: 1773316982,
      freshnessMode: "verified",
      redemption: {
        capacityUsd: 30,
        capacityRatioOfSupply: 0.3,
        routeStatus: "open",
        routeStatusSource: "protocol-api",
        settlementDelaySec: 604800,
      },
    });
    // AVAX is unmapped; at ~16% of this fixture it exceeds the share threshold
    // and warns rather than being silently suppressed.
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "unknown-asset", message: expect.stringContaining("AVAX") }),
    ]);
    expect(() => adaptFalconTransparency(falconPayload([
      { label: "USDC", ceffu: "malformed", fireblocks: "100" },
    ]))).toThrow(/Falcon USDC venue values row 1 has invalid value: NaN/);
  });

  it.each([
    ["UNKNOWN_TOKEN_XYZ", "50000", true],
    ["UNKNOWN_TOKEN_XYZ", "0.01", false],
    ["SOL", "500000", true],
  ] as const)("classifies warning exposure for %s worth %s", (label, value, warns) => {
    const result = adaptFalconTransparency(falconPayload([
      { label: "USDC", ceffu: "50" }, { label, ceffu: value },
    ]));
    if (warns) {
      expect(result.warnings).toEqual([
        expect.objectContaining({ code: "unknown-asset", message: expect.stringContaining(label) }),
      ]);
    } else {
      expect(result.warnings).toBeUndefined();
    }
  });

  it("normalizes a millisecond snapshot_date to unix seconds", () => {
    const payload = falconPayload(
      [{ label: "USDC", ceffu: "100" }],
      { timestamp: 1776067200000, insurance: "0" },
    );
    const result = adaptFalconTransparency(payload);
    expect(result.metadata).toMatchObject({
      sourceTimestamp: 1776067200,
      freshnessMode: "verified",
    });
  });
});

describe("falcon fetch boundary", () => {
  it("fetches the configured transparency endpoint through the shared network harness", async () => {
    const { result, network } = await runAdapter("falcon", "usdf-falcon", {
      network: {
        json: {
          [FALCON_URL]: falconPayload([
            { label: "USDC", ceffu: "20", fireblocks: "10" },
            { label: "BTC", multisig: "25" },
            { label: "ETH", multisig: "10" },
            { label: "USTB", fireblocks: "15" },
            { label: "AVAX", fireblocks: "15" },
          ]),
        },
      },
      nowSec: 1_773_318_200,
    });

    expect(network.requests.map((request) => request.url)).toEqual([FALCON_URL]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: 1_773_316_982,
      supplyUsd: 100,
    });
    expect(result.slices).toContainEqual(expect.objectContaining({
      name: "USDC cash-equivalent assets",
      coinId: "usdc-circle",
    }));
  });
});
