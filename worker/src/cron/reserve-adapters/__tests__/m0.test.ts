import { describe, expect, it } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { StablecoinMeta } from "@shared/types/core";
import { adaptM0Collateral, fetchM0Reserves } from "../m0";
import { getReserveAdapter } from "../index";
import { validateAdapterOutput } from "../validate";

// Live payload shape observed against protocol-api.m0.org on 2026-08-20, after
// M0 retired the off-chain CollateralCurrent composition feed and moved the
// endpoint to keyed access. Values are 6-decimal token units.
const SAMPLE_PAYLOAD = {
  data: {
    minterGateway_totalCollateralSnapshots: [
      { timestamp: "1787171387", value: "277097642539488" },
    ],
    minterGateway_minters: [
      { id: "minter-0x1d5b695d13f231a605d231631c688fb33477b249", collateral: "162911451780" },
      { id: "minter-0x5d238f4eac94da0a635ee39fa389a4754395d5d9", collateral: "9799887431160" },
      { id: "minter-0x7f7489582b64abe46c074a45d758d701c2ca5446", collateral: "238711590186548" },
      { id: "minter-0xcd1394d24e1e404f9eb3609f872b0736becb9d74", collateral: "28422026810000" },
    ],
    collateralUpdateds: [
      { timestamp: "1787176804", blockTimestamp: "1787176847" },
    ],
    minterGateway_latestUpdateTimestampSnapshots: [
      { timestamp: "1787176847", value: "1787176847" },
    ],
  },
};

describe("adaptM0Collateral", () => {
  it("keeps M0-backed curated aggregate collateral on the conservative classification", () => {
    for (const coinId of ["musd-metamask"]) {
      const aggregateCollateral = TRACKED_META_BY_ID.get(coinId)?.reserves?.find(
        ({ name }) => name === "U.S. Treasury bills & cash (M0 eligible collateral)",
      );
      expect(aggregateCollateral, coinId).toMatchObject({
        sourceKey: "m0:eligible-collateral",
        pct: 100,
        risk: "very-low",
        assetClass: "other",
        issuerOrObligor: "M0 permissioned minters and eligible collateral SPVs",
      });
    }
  });

  it("keeps exact extension claims out of the generic M0 collateral cohort", () => {
    const ctusd = TRACKED_META_BY_ID.get("ctusd-citrea");
    const usdat = TRACKED_META_BY_ID.get("usdat-saturn");

    expect(ctusd?.reserves).toEqual([
      expect.objectContaining({
        name: "M token held by Citrea USD",
        pct: 100,
        coinId: "m-m0",
        depType: "wrapper",
      }),
    ]);
    expect(ctusd?.liveReservesConfig).toMatchObject({
      adapter: "m0-wrapper-underlying",
      breakerScope: "ctusd-citrea",
      params: {
        mode: "m-extension",
        expectedMTokenAddress: "0x866A2BF4E572CbcF37D5071A7a58503Bfb36be1b",
        expectedSwapFacilityAddress: "0xB6807116b3B1B321a390594e31ECD6e0076f6278",
      },
    });

    expect(usdat?.reserves).toEqual([
      expect.objectContaining({
        name: "PYUSDx held by Saturn USDat",
        pct: 100,
        coinId: "pyusd-paypal",
        depType: "wrapper",
      }),
    ]);
    expect(usdat?.liveReservesConfig).toBeUndefined();
  });

  it("converts the total collateral snapshot into the single protocol-constrained slice", () => {
    const result = adaptM0Collateral(SAMPLE_PAYLOAD);

    expect(result.slices).toEqual([
      {
        sourceKey: "m0:eligible-collateral",
        name: "U.S. Treasury bills & cash (M0 eligible collateral)",
        pct: 100,
        risk: "very-low",
      },
    ]);
    expect(result.warnings).toBeUndefined();
    expect(validateAdapterOutput(result, { adapter: getReserveAdapter("m0") ?? undefined }).valid).toBe(true);
  });

  it("normalizes 6-decimal units and reconciles the per-minter sum in metadata", () => {
    const result = adaptM0Collateral(SAMPLE_PAYLOAD);

    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: 1787171387,
      collateralValueDivisor: 1_000_000,
      normalizedReserveTotal: 277_097_642.539488,
      minterCount: 4,
      minterCollateralTotalUsd: 277_096_415.879488,
      earliestCollateralUpdateTimestamp: 1787176804,
      latestCollateralUpdateTimestamp: 1787176847,
      snapshotLagSec: 5460,
    });
    expect(result.metadata?.redemption).toBeUndefined();
  });

  it("tolerates the routine indexing skew between the snapshot and the update stream", () => {
    // Observed live 2026-08-20: the collateral-update events run ~1.5h ahead of
    // the latest total snapshot. That must not degrade every run.
    const result = adaptM0Collateral(SAMPLE_PAYLOAD);
    expect(result.warnings).toBeUndefined();
  });

  it("degrades when the total snapshot lags known collateral updates materially", () => {
    const result = adaptM0Collateral({
      data: {
        ...SAMPLE_PAYLOAD.data,
        collateralUpdateds: [
          // 7h after the total snapshot at 1787171387.
          { timestamp: "1787196587", blockTimestamp: "1787196587" },
        ],
        minterGateway_latestUpdateTimestampSnapshots: [
          { timestamp: "1787196587", value: "1787196587" },
        ],
      },
    });

    expect(result.warnings?.some((warning) => warning.code === "total-collateral-snapshot-lag")).toBe(true);
    expect(result.metadata).toMatchObject({ snapshotLagSec: 25_200 });
  });

  it("degrades when the per-minter sum diverges from the total snapshot", () => {
    const result = adaptM0Collateral({
      data: {
        ...SAMPLE_PAYLOAD.data,
        minterGateway_minters: [
          { id: "minter-0x1d5b695d13f231a605d231631c688fb33477b249", collateral: "200000000000000" },
        ],
      },
    });

    expect(result.warnings?.some((warning) => warning.code === "minter-collateral-reconciliation")).toBe(true);
  });

  it("falls back to unverified freshness when the snapshot timestamp is unparseable", () => {
    const result = adaptM0Collateral({
      data: {
        ...SAMPLE_PAYLOAD.data,
        minterGateway_totalCollateralSnapshots: [
          { timestamp: "not-a-timestamp", value: "277097642539488" },
        ],
      },
    });

    expect(result.metadata).toMatchObject({
      freshnessMode: "unverified",
      details: { freshnessSource: "protocol-api-graphql" },
    });
    expect(result.slices).toHaveLength(1);
  });

  // Observed 2026-08-08 (and still true for retired Collateral* resolvers on
  // 2026-08-20): protocol-api.m0.org answers dead resolvers with its gateway
  // error envelope (`{"status":false,"statusCode":500,"message":"fetch failed"}`).
  // HTTP 500 already throws in the transport, but the envelope must never be
  // adapted into a snapshot if the gateway ever returns it with a 200.
  it("refuses the M0 gateway error envelope instead of publishing an empty snapshot", () => {
    expect(() => adaptM0Collateral(
      { status: false, statusCode: 500, message: "fetch failed", result: {} } as never,
    )).toThrow(/missing minterGateway_totalCollateralSnapshots/);
  });

  it("refuses an empty snapshot list", () => {
    expect(() => adaptM0Collateral({ data: { minterGateway_totalCollateralSnapshots: [] } }))
      .toThrow(/missing minterGateway_totalCollateralSnapshots/);
  });

  it("refuses a non-numeric total collateral value", () => {
    expect(() => adaptM0Collateral({
      data: {
        minterGateway_totalCollateralSnapshots: [
          { timestamp: "1787171387", value: "fetch failed" },
        ],
      },
    })).toThrow(/not a usable number/);
  });

  it("emits no publishable slices when the total collateral reports zero", () => {
    const result = adaptM0Collateral({
      data: {
        minterGateway_totalCollateralSnapshots: [
          { timestamp: "1787171387", value: "0" },
        ],
      },
    });

    expect(result.slices).toEqual([]);
    const adapter = getReserveAdapter("m0") ?? undefined;
    const report = validateAdapterOutput(result, { adapter });
    expect(report.valid).toBe(false);
    expect(report.warnings.map((warning) => warning.code)).toContain("empty-slices");
  });
});

describe("fetchM0Reserves", () => {
  it("fails closed before fetching when M0_API_KEY is not configured", async () => {
    const config = {
      adapter: "m0",
      version: 1,
      semantics: "protocol-reserve",
      inputs: { primary: { kind: "http-json", url: "https://protocol-api.m0.org/graphql" } },
    } as unknown as LiveReservesConfig;

    await expect(
      fetchM0Reserves({} as StablecoinMeta, config, new AbortController().signal, {}),
    ).rejects.toThrow(/M0_API_KEY not configured/);
    await expect(
      fetchM0Reserves({} as StablecoinMeta, config, new AbortController().signal, { m0ApiKey: "   " }),
    ).rejects.toThrow(/M0_API_KEY not configured/);
  });
});
