import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adaptFalconTransparency, type FalconTransparencyResponse } from "../falcon";
import { expectValidAdapterOutput, runAdapter } from "./reserve-adapter.test-support";

function falconPayload(
  assets: Array<{ label: string; [venue: string]: string | number }>,
  { timestamp = 1773316982, supply = "100", insurance = "5" } = {},
): FalconTransparencyResponse {
  return { snapshot_date: timestamp, usdf: { supply, insurance_fund: insurance, breakdown: { assets } } };
}
const FALCON_URL = "https://api.falcon.finance/api/v1/transparency";
/** Publication instant of the compact fixture payloads, used as their replay clock. */
const FIXTURE_TIMESTAMP = 1773316982;

/** Wire capture of the transparency API: 140 assets, 96 of them unmapped
 *  altcoin dust worth 0.90% of reserves at the 2026-09-10 snapshot. */
const LIVE_CAPTURE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "falcon-transparency.json"), "utf8"),
) as FalconTransparencyResponse;

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
    // AVAX stays in the high-risk "other" bucket and the unknown-exposure
    // total; discovery is one info warning, and the shared cap decides whether
    // the snapshot degrades.
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "unknown-asset", effect: "info", message: expect.stringContaining("AVAX") }),
    ]);
    expect(() => adaptFalconTransparency(falconPayload([
      { label: "USDC", ceffu: "malformed", fireblocks: "100" },
    ]))).toThrow(/Falcon USDC venue values row 1 has invalid value: NaN/);
  });

  it("aggregates the unmapped tail into one info warning instead of degrading per asset", () => {
    const result = adaptFalconTransparency(falconPayload([
      { label: "BTC", multisig: "990" },
      { label: "FLOKI", ceffu: "5" },
      { label: "NEAR", ceffu: "3" },
      { label: "SOL", ceffu: "2" },
    ], { insurance: "0" }));

    expect(result.metadata?.unknownExposurePct).toBeCloseTo(1);
    expect(result.slices).toContainEqual({ name: "Other crypto / tokenized assets", pct: 1, risk: "high" });
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "unknown-asset",
        effect: "info",
        message: expect.stringContaining("FLOKI, NEAR, SOL"),
      }),
    ]);
    const report = expectValidAdapterOutput("falcon", result, { now: FIXTURE_TIMESTAMP });
    expect(report.warnings.filter((warning) => warning.effect === "degraded")).toEqual([]);
  });

  it("degrades through the shared 5% unknown-exposure cap", () => {
    const result = adaptFalconTransparency(falconPayload([
      { label: "BTC", multisig: "94" },
      { label: "FLOKI", ceffu: "6" },
    ], { insurance: "0" }));

    expect(result.metadata?.unknownExposurePct).toBeCloseTo(6);
    expect(result.warnings).toEqual([expect.objectContaining({ code: "unknown-asset", effect: "info" })]);
    const report = expectValidAdapterOutput("falcon", result, { now: FIXTURE_TIMESTAMP });
    expect(report.warnings).toEqual([
      expect.objectContaining({ code: "material-unknown-exposure", effect: "degraded" }),
    ]);
  });

  it("keeps the live capture's unmapped long tail informational", () => {
    const result = adaptFalconTransparency(LIVE_CAPTURE);

    expect(result.metadata).toMatchObject({ assetCount: 140, freshnessMode: "verified" });
    expect(result.metadata?.unknownExposurePct).toBeCloseTo(0.897, 3);
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "unknown-asset", effect: "info", message: expect.stringContaining("FLOKI") }),
    ]);

    const report = expectValidAdapterOutput("falcon", result, { now: LIVE_CAPTURE.snapshot_date });
    // Sync status is derived from adapter and validation warnings together, so
    // the capture must carry no degraded effect on either side.
    expect([...(result.warnings ?? []), ...report.warnings].filter((warning) => warning.effect === "degraded"))
      .toEqual([]);
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
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "unknown-asset", effect: "info" }),
    ]);
  });
});
