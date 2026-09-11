import { describe, expect, it } from "vitest";

import {
  adaptBridgeTransparency,
  type BridgeTransparencyPayload,
} from "../bridge-transparency";
import {
  expectValidAdapterOutput,
  expectWarnings,
  runAdapter,
} from "./reserve-adapter.test-support";

const USDSUI_ENDPOINT = "https://transparency.bridge.xyz/v0/stablecoins/usd_sui";
const PATHUSD_ENDPOINT = "https://transparency.bridge.xyz/v0/stablecoins/path_usd";
const NOW_SEC = Math.floor(Date.parse("2026-09-09T16:50:36Z") / 1000);

/** Live capture of https://transparency.bridge.xyz/v0/stablecoins/usd_sui on
 *  2026-09-09 (components reconcile to the cent against both totals). */
const USDSUI_PAYLOAD: BridgeTransparencyPayload = {
  last_updated: "2026-09-09T15:50:36Z",
  total_onchain_amount: "74111161.57",
  total_reserve_amount: "74111161.57",
  reserves: [
    { type: "cash", amount: "7580669.7" },
    { type: "treasury", amount: "66530491.87" },
  ],
  collateralization_ratio: "1.0",
};

/** Live capture of https://transparency.bridge.xyz/v0/stablecoins/path_usd on
 *  2026-09-09 (components sum $0.32 above the rounded reserve total). */
const PATHUSD_PAYLOAD: BridgeTransparencyPayload = {
  last_updated: "2026-09-09T15:50:30Z",
  total_onchain_amount: "36658731.375041",
  total_reserve_amount: "36658731.37",
  reserves: [
    { type: "cash", amount: "3609603.05" },
    { type: "treasury", amount: "33049128.64" },
  ],
  collateralization_ratio: "1.0",
};


describe("adaptBridgeTransparency", () => {
  it("maps cash and treasury components into slices and publishes the issuer liability ratio", () => {
    const result = adaptBridgeTransparency(USDSUI_PAYLOAD, "usd_sui");

    expect(result.slices).toEqual([
      { sourceKey: "bridge-transparency:treasury", name: "Treasury", pct: 89.8, risk: "very-low", assetClass: "treasury-bill", issuerOrObligor: "United States Treasury" },
      { sourceKey: "bridge-transparency:cash", name: "Cash", pct: 10.2, risk: "very-low", assetClass: "cash", issuerOrObligor: "Bridge-approved bank counterparties" },
    ]);
    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      sourceTimestamp: Math.floor(Date.parse("2026-09-09T15:50:36Z") / 1000),
      freshnessMode: "verified",
      totalReserveUsd: 74_111_161.57,
      supplyUsd: 74_111_161.57,
      collateralizationRatio: 1,
      details: {
        lastUpdated: "2026-09-09T15:50:36Z",
        slug: "usd_sui",
        reportedCollateralizationRatio: 1,
      },
    });
    expect(result.metadata?.details?.componentSumUsd).toBeCloseTo(74_111_161.57, 6);
    expect(result.metadata?.details?.driftVsReservesUsd).toBeCloseTo(0, 6);
    expect(result.metadata?.details?.driftVsLiabilitiesUsd).toBeCloseTo(0, 6);
  });

  it("accepts pathUSD's $0.32 component rounding drift without degrading", () => {
    const result = adaptBridgeTransparency(PATHUSD_PAYLOAD, "path_usd");

    expect(result.warnings).toBeUndefined();
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(36_658_731.37, 4);
    expect(result.metadata?.supplyUsd).toBeCloseTo(36_658_731.375041, 4);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(36_658_731.37 / 36_658_731.375041, 9);
    expect(result.metadata?.details).toMatchObject({
      driftVsReservesUsd: expect.closeTo(0.32, 3),
      driftVsLiabilitiesUsd: expect.closeTo(0.314959, 3),
    });
  });

  it("degrades-warns but still publishes when components drift beyond the $1 rounding tolerance", () => {
    const drifted: BridgeTransparencyPayload = {
      ...USDSUI_PAYLOAD,
      total_reserve_amount: "73111161.57",
    };

    const result = adaptBridgeTransparency(drifted, "usd_sui");

    // Reserves below the $1 tolerance both drift from the components and leave
    // the liability undercollateralized by $1M.
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "bridge-component-sum-drift",
        severity: "warning",
        effect: "degraded",
      }),
      expect.objectContaining({ code: "reserve-undercollateralized" }),
    ]));
    expect(result.slices).toHaveLength(2);
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(73_111_161.57, 4);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(73_111_161.57 / 74_111_161.57, 9);
  });

  it("degrades-warns when reserves fall below the on-chain liability beyond rounding", () => {
    const undercollateralized: BridgeTransparencyPayload = {
      last_updated: "2026-09-09T15:50:36Z",
      total_onchain_amount: "74111161.57",
      total_reserve_amount: "72111161.57",
      reserves: [
        { type: "cash", amount: "7000000" },
        { type: "treasury", amount: "65111161.57" },
      ],
    };

    const result = adaptBridgeTransparency(undercollateralized, "usd_sui");

    // The shortfall shows up both as an undercollateralized ratio and as a
    // component-vs-liability drift beyond the $1 rounding tolerance.
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "reserve-undercollateralized",
        severity: "warning",
        effect: "degraded",
      }),
      expect.objectContaining({ code: "bridge-component-sum-drift" }),
    ]));
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(72_111_161.57 / 74_111_161.57, 9);
  });

  it("degrades-warns and buckets an unmapped reserve component instead of failing closed", () => {
    const withUnknown: BridgeTransparencyPayload = {
      ...USDSUI_PAYLOAD,
      reserves: [...USDSUI_PAYLOAD.reserves!, { type: "repo", amount: "1000000" }],
    };

    const result = adaptBridgeTransparency(withUnknown, "usd_sui");

    // A material unmapped component is published as a high-risk slice and also
    // drifts the component sum beyond the $1 tolerance.
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unknown-component", severity: "warning", effect: "degraded" }),
      expect.objectContaining({ code: "bridge-component-sum-drift" }),
    ]));
    expect(result.slices).toContainEqual(
      expect.objectContaining({ name: "repo (unmapped)", risk: "high" }),
    );
  });

  it("throws when last_updated is missing or unreadable", () => {
    expect(() => adaptBridgeTransparency({ ...USDSUI_PAYLOAD, last_updated: undefined }, "usd_sui"))
      .toThrow("unreadable last_updated");
    expect(() => adaptBridgeTransparency({ ...USDSUI_PAYLOAD, last_updated: "" }, "usd_sui"))
      .toThrow("unreadable last_updated");
  });

  it("throws when reserves is missing or empty", () => {
    expect(() => adaptBridgeTransparency({ ...USDSUI_PAYLOAD, reserves: undefined }, "usd_sui"))
      .toThrow("missing reserves");
    expect(() => adaptBridgeTransparency({ ...USDSUI_PAYLOAD, reserves: [] }, "usd_sui"))
      .toThrow("missing reserves");
  });

  it("throws on malformed or negative amounts instead of silently reading them as zero", () => {
    const garbage = { ...USDSUI_PAYLOAD, reserves: [{ type: "cash", amount: "not-a-number" }] };
    expect(() => adaptBridgeTransparency(garbage, "usd_sui"))
      .toThrow("reserves entry 0 amount is not a finite number");
    const negative = { ...USDSUI_PAYLOAD, reserves: [{ type: "cash", amount: -5 }] };
    expect(() => adaptBridgeTransparency(negative, "usd_sui"))
      .toThrow("reserves entry 0 has a negative amount");
    expect(() => adaptBridgeTransparency({ ...USDSUI_PAYLOAD, total_reserve_amount: "NaN" }, "usd_sui"))
      .toThrow("total_reserve_amount is not a finite number");
    expect(() => adaptBridgeTransparency({ ...USDSUI_PAYLOAD, total_onchain_amount: 0 }, "usd_sui"))
      .toThrow("invalid total_onchain_amount");
  });

  it("is degraded-but-valid under validateAdapterOutput when the source timestamp is stale", () => {
    const stale: BridgeTransparencyPayload = {
      ...USDSUI_PAYLOAD,
      last_updated: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const result = adaptBridgeTransparency(stale, "usd_sui");
    const report = expectValidAdapterOutput("bridge-transparency", result);
    expect(report.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "stale-source-data", effect: "degraded" })]),
    );
  });
});

describe("fetchBridgeTransparencyReserves", () => {
  it("fetches the configured stablecoin endpoint and adapts the payload", async () => {
    const { result, network } = await runAdapter("bridge-transparency", "usdsui-sui", {
      network: { json: { [USDSUI_ENDPOINT]: USDSUI_PAYLOAD } },
      nowSec: NOW_SEC,
    });

    expect(network.requests.map((request) => request.url)).toEqual([USDSUI_ENDPOINT]);
    expect(result.slices.find((slice) => slice.name === "Cash")).toMatchObject({ risk: "very-low" });
    expect(result.metadata?.details).toMatchObject({ slug: "usd_sui" });
    expectWarnings(result, []);
  });

  it("accepts pathUSD's rounded component totals through the registered binding", async () => {
    const { result } = await runAdapter("bridge-transparency", "pathusd-bridge", {
      network: { json: { [PATHUSD_ENDPOINT]: PATHUSD_PAYLOAD } },
      nowSec: NOW_SEC,
    });

    expect(result.metadata?.totalReserveUsd).toBeCloseTo(36_658_731.37, 4);
    expect(result.metadata?.details).toMatchObject({
      driftVsReservesUsd: expect.closeTo(0.32, 3),
      driftVsLiabilitiesUsd: expect.closeTo(0.314959, 3),
    });
    expectWarnings(result, []);
  });

  it("fails the attempt when the endpoint errors instead of publishing a partial mix", async () => {
    await expect(runAdapter("bridge-transparency", "usdsui-sui", {
      network: { json: { [USDSUI_ENDPOINT]: { status: 500, json: {} } } },
      nowSec: NOW_SEC,
    })).rejects.toThrow(/500/);
  });
});
