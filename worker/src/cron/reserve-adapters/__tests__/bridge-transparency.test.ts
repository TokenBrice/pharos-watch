import { describe, expect, it } from "vitest";
import { LiveReservesConfigSchema } from "@shared/lib/live-reserve-adapters";
import { ReserveSliceSchema } from "@shared/types/reserves";
import { buildReviewedReserveClassifications } from "../../../lib/safety-score-v9/extension-reserves";

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
const OUSD_ENDPOINT = "https://transparency.bridge.xyz/v0/stablecoins/ousd";
const CASH_ENDPOINT = "https://transparency.bridge.xyz/v0/stablecoins/cash";
const CASH_NOW_SEC = Math.floor(Date.parse("2026-10-07T22:00:15Z") / 1000);
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

/** Captured production pathUSD totals; synthetic component allocation retains
 *  its exact disclosed aggregate ($0.32 asset drift, $161.954963 liability drift). */
const PATHUSD_PAYLOAD: BridgeTransparencyPayload = {
  last_updated: "2026-10-07T20:10:31Z",
  total_onchain_amount: "70562222.545037",
  total_reserve_amount: "70562384.18",
  reserves: [
    { type: "cash", amount: "7056238.45" },
    { type: "treasury", amount: "63506146.05" },
  ],
  collateralization_ratio: "1.0",
};

/** Bridge OUSD capture on 2026-10-07: the disclosed components omit
 *  $2,000,114.99 of the published assets even though they match liabilities. */
const OUSD_PAYLOAD: BridgeTransparencyPayload = {
  last_updated: "2026-10-07T20:40:34Z",
  total_onchain_amount: "729642146.82",
  total_reserve_amount: "731642261.81",
  reserves: [
    { type: "cash", amount: "88087150.59" },
    { type: "treasury", amount: "641554996.23" },
  ],
  collateralization_ratio: "1.0027",
};

/** Bridge CASH API capture on 2026-10-07T21:06:44Z. */
const CASH_PAYLOAD: BridgeTransparencyPayload = {
  last_updated: "2026-10-07T21:00:15Z",
  total_onchain_amount: "127929774.363047",
  total_reserve_amount: "127930977.54",
  reserves: [
    { type: "cash", amount: "8974120.28" },
    { type: "treasury", amount: "118956857.26" },
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
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(70_562_384.18, 4);
    expect(result.metadata?.supplyUsd).toBeCloseTo(70_562_222.545037, 4);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(70_562_384.18 / 70_562_222.545037, 9);
    expect(result.metadata?.details).toMatchObject({
      driftVsReservesUsd: expect.closeTo(0.32, 3),
      driftVsLiabilitiesUsd: expect.closeTo(161.954963, 3),
    });
  });

  it("accepts materially overcollateralized assets when every asset is disclosed", () => {
    const result = adaptBridgeTransparency({
      ...USDSUI_PAYLOAD,
      total_onchain_amount: "37055580.785",
    }, "usd_sui");

    expectWarnings(result, []);
    expect(result.metadata?.collateralizationRatio).toBe(2);
  });

  it.each([
    { drift: 1, degraded: false },
    { drift: -1, degraded: false },
    { drift: 1.01, degraded: true },
    { drift: -1.01, degraded: true },
  ])("preserves the exact $1 asset tolerance for drift $drift", ({ drift, degraded }) => {
    const result = adaptBridgeTransparency({
      ...USDSUI_PAYLOAD,
      total_reserve_amount: 100,
      total_onchain_amount: 50,
      reserves: [{ type: "cash", amount: 100 + drift }],
    }, "usd_sui");

    expectWarnings(result, degraded ? ["bridge-component-sum-drift"] : []);
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

    expectWarnings(result, ["reserve-undercollateralized"]);
    expect(result.warnings?.[0]).toMatchObject({ severity: "warning", effect: "degraded" });
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

  it.each(["0x10", "0b10", "0o10", "", " ", "1,00", "1e309"])(
    "rejects malformed decimal amount %j in every issuer amount field",
    (amount) => {
      expect(() => adaptBridgeTransparency({ ...CASH_PAYLOAD, total_reserve_amount: amount }, "cash")).toThrow();
      expect(() => adaptBridgeTransparency({ ...CASH_PAYLOAD, total_onchain_amount: amount }, "cash")).toThrow();
      expect(() => adaptBridgeTransparency({
        ...CASH_PAYLOAD,
        reserves: [{ type: "cash", amount }],
      }, "cash")).toThrow();
      expect(() => adaptBridgeTransparency({ ...CASH_PAYLOAD, collateralization_ratio: amount }, "cash")).toThrow();
    },
  );

  it("preserves genuine zero components and accepted scientific decimal amounts", () => {
    const result = adaptBridgeTransparency({
      ...CASH_PAYLOAD,
      total_reserve_amount: "1e3",
      total_onchain_amount: "+1000.",
      reserves: [{ type: "cash", amount: "-0" }, { type: "treasury", amount: "1e3" }],
    }, "cash");

    expectWarnings(result, []);
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0]).toMatchObject({ sourceKey: "bridge-transparency:treasury", pct: 100, assetClass: "other" });
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
      nowSec: CASH_NOW_SEC,
    });

    expect(result.metadata?.totalReserveUsd).toBeCloseTo(70_562_384.18, 4);
    expect(result.metadata?.details).toMatchObject({
      driftVsReservesUsd: expect.closeTo(0.32, 3),
      driftVsLiabilitiesUsd: expect.closeTo(161.954963, 3),
    });
    expectWarnings(result, []);
  });

  it("keeps Open USD's genuine undisclosed asset gap degraded despite reconciled liabilities", async () => {
    const { result, network } = await runAdapter("bridge-transparency", "ousd-open-standard", {
      network: { json: { [OUSD_ENDPOINT]: OUSD_PAYLOAD } },
      nowSec: CASH_NOW_SEC,
    });

    expect(network.requests.map((request) => request.url)).toEqual([OUSD_ENDPOINT]);
    expect(result.slices).toHaveLength(2);
    expect(result.slices).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceKey: "bridge-transparency:cash",
        name: "Cash",
        pct: 12.1,
        risk: "very-low",
        assetClass: "cash",
      }),
      expect.objectContaining({
        sourceKey: "bridge-transparency:treasury",
        name: "Treasury",
        pct: 87.9,
        risk: "very-low",
        assetClass: "treasury-bill",
      }),
    ]));
    expect(result.metadata).toMatchObject({
      totalReserveUsd: 731_642_261.81,
      supplyUsd: 729_642_146.82,
      collateralizationRatio: expect.closeTo(731_642_261.81 / 729_642_146.82, 9),
      sourceTimestamp: Math.floor(Date.parse("2026-10-07T20:40:34Z") / 1000),
      details: {
        slug: "ousd",
        componentSumUsd: expect.closeTo(729_642_146.82, 4),
        driftVsReservesUsd: expect.closeTo(-2_000_114.99, 4),
        driftVsLiabilitiesUsd: expect.closeTo(0, 4),
      },
    });
    expectWarnings(result, ["bridge-component-sum-drift"]);
  });

  it("measures CASH's single combined Treasury/MMF bucket without inventing instrument weights", async () => {
    const { result, report, coin, config } = await runAdapter("bridge-transparency", "cash-phantom", {
      network: { json: { [CASH_ENDPOINT]: CASH_PAYLOAD } },
      nowSec: CASH_NOW_SEC,
    });

    expectWarnings(result, []);
    expectWarnings(report, []);
    expect(LiveReservesConfigSchema.safeParse(config).success).toBe(true);
    for (const slice of result.slices) expect(ReserveSliceSchema.safeParse(slice).success).toBe(true);
    expect(result.slices).toHaveLength(2);
    expect(result.slices.find((slice) => slice.sourceKey === "bridge-transparency:treasury")).toMatchObject({
      pct: 93,
      assetClass: "other",
    });
    expect(result.slices.find((slice) => slice.sourceKey === "bridge-transparency:cash")).toMatchObject({
      pct: 7,
      assetClass: "bank-deposit",
    });
    expect(result.metadata).toMatchObject({
      sourceTimestamp: Math.floor(Date.parse(CASH_PAYLOAD.last_updated!) / 1000),
      freshnessMode: "verified",
      totalReserveUsd: 127_930_977.54,
      supplyUsd: 127_929_774.363047,
      collateralizationRatio: expect.closeTo(127_930_977.54 / 127_929_774.363047, 12),
      details: {
        componentSumUsd: expect.closeTo(127_930_977.54, 4),
        driftVsReservesUsd: expect.closeTo(0, 4),
        driftVsLiabilitiesUsd: expect.closeTo(1_203.176953, 4),
        reportedCollateralizationRatio: 1,
      },
    });
    // A display rename must not sever reviewed uncertainty from measured keys.
    const classifications = buildReviewedReserveClassifications(
      result.slices.map((slice) => ({ ...slice, name: `Measured ${slice.sourceKey}` })),
      coin,
      CASH_NOW_SEC,
    );
    const treasury = classifications.find((classification) => classification.assetClass === "other");
    expect(treasury).toMatchObject({
      classificationKey: expect.stringMatching(/^registry-reviewed:/),
      riskFactors: expect.arrayContaining(["custody", "counterparty", "liquidity", "concentration"]),
      liquidityHorizon: "one-day",
      maturityDaysMax: null,
    });
    expect(classifications.find((classification) => classification.assetClass === "bank-deposit")).toMatchObject({
      riskFactors: expect.arrayContaining(["custody", "counterparty"]),
      liquidityHorizon: "immediate",
    });
  });

  it.each([
    { label: "asset gap", overrides: { total_reserve_amount: "127932977.54" }, warnings: ["bridge-component-sum-drift"] },
    { label: "liability shortfall", overrides: { total_onchain_amount: "127932977.54" }, warnings: ["reserve-undercollateralized"] },
    { label: "unmapped future type", overrides: { reserves: [
      { type: "cash", amount: "8974120.28" },
      { type: "future-treasury", amount: "118956857.26" },
    ] }, warnings: ["unknown-component"] },
    { label: "prototype-named type", overrides: { reserves: [
      { type: "cash", amount: "8974120.28" },
      { type: "constructor", amount: "118956857.26" },
    ] }, warnings: ["unknown-component"] },
  ])("keeps CASH $label degraded", async ({ overrides, warnings }) => {
    const { result, report } = await runAdapter("bridge-transparency", "cash-phantom", {
      network: { json: { [CASH_ENDPOINT]: { ...CASH_PAYLOAD, ...overrides } } },
      nowSec: CASH_NOW_SEC,
    });

    expectWarnings(result, warnings);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ effect: "degraded" }),
    ]));
    expect(report.valid).toBe(true);
  });

  it("rejects a CASH binding whose URL identifies a different product", async () => {
    await expect(runAdapter("bridge-transparency", "cash-phantom", {
      network: { json: { [CASH_ENDPOINT]: CASH_PAYLOAD } },
      params: { slug: "ousd" },
      nowSec: CASH_NOW_SEC,
    })).rejects.toThrow();
  });

  it("keeps stale CASH source clocks degraded and future source clocks fatal", async () => {
    const stale = await runAdapter("bridge-transparency", "cash-phantom", {
      network: { json: { [CASH_ENDPOINT]: { ...CASH_PAYLOAD, last_updated: "2026-10-01T21:00:15Z" } } },
      nowSec: CASH_NOW_SEC,
    });
    expect(stale.report.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "stale-source-data", effect: "degraded" }),
    ]));

    const future = await runAdapter("bridge-transparency", "cash-phantom", {
      network: { json: { [CASH_ENDPOINT]: { ...CASH_PAYLOAD, last_updated: "2026-10-08T21:00:15Z" } } },
      nowSec: CASH_NOW_SEC,
      validate: false,
    });
    expect(future.report.valid).toBe(false);
    expect(future.report.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "future-source-timestamp", effect: "fatal" }),
    ]));
  });

  it.each([undefined, "", "not-a-date", "2026-02-30T21:00:15Z"])(
    "withholds CASH composition when last_updated is %j",
    async (last_updated) => {
      await expect(runAdapter("bridge-transparency", "cash-phantom", {
        network: { json: { [CASH_ENDPOINT]: { ...CASH_PAYLOAD, last_updated } } },
        nowSec: CASH_NOW_SEC,
      })).rejects.toThrow();
    },
  );

  it("fails the attempt when the endpoint errors instead of publishing a partial mix", async () => {
    await expect(runAdapter("bridge-transparency", "usdsui-sui", {
      network: { json: { [USDSUI_ENDPOINT]: { status: 500, json: {} } } },
      nowSec: NOW_SEC,
    })).rejects.toThrow(/500/);
  });
});
