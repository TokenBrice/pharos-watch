import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import {
  adaptMegausdCustody,
  type MegausdBackingAndSupplyPayload,
} from "../megausd-custody";
import { expectValidAdapterOutput, runAdapter } from "./reserve-adapter.test-support";

const MEGAUSD_URL = "https://app.megausd.money/api/transparency/backing-and-supply/current";

function makeConfig(): LiveReservesConfig {
  return {
    adapter: "megausd-custody",
    version: 1,
    semantics: "collateral-mix",
    inputs: {
      primary: { kind: "http-json", url: MEGAUSD_URL },
    },
  } as unknown as LiveReservesConfig;
}

function makeCoin(): StablecoinMeta {
  return { id: "usdm-mega", name: "MegaUSD", ticker: "USDM", liveReservesConfig: makeConfig() } as unknown as StablecoinMeta;
}

const MEGAUSD_BACKING: MegausdBackingAndSupplyPayload = {
  backingAssets: {
    USDC: [
      { amount: 1618402.389424, custodian: "0xE0406beE6D58bCd7C1cA78191b6fde9CA060F6f2" },
      { amount: 15319532.925638, custodian: "0x343c18B0f1710B65cE33A7CE720b5D540215d343" },
      { amount: 440, custodian: "0x01b3AfeBdA3ED0E55feDb10DAdA5eF8Dbe8f8d0C" },
      { amount: 1000.109, custodian: "0x99F97f2822478f71e6ea8BD872e61DF10aE19ccd" },
      { amount: 0, custodian: "0xF6a4347Fe4F2c8D7228d3d53ab8e0d0cFC507DDC" },
    ],
    USDm: [{ amount: 0, custodian: "0x343c18B0f1710B65cE33A7CE720b5D540215d343" }],
    USDtb: [
      { amount: 1607.822777, custodian: "0xE0406beE6D58bCd7C1cA78191b6fde9CA060F6f2" },
      { amount: 19187.0188631, custodian: "0x343c18B0f1710B65cE33A7CE720b5D540215d343" },
      { amount: 121, custodian: "0x01b3AfeBdA3ED0E55feDb10DAdA5eF8Dbe8f8d0C" },
    ],
  },
  lastUpdatedAt: "2026-09-09T15:55:59.000Z",
  supply: 31379.8289956866,
};

const USDC_TOTAL = 1618402.389424 + 15319532.925638 + 440 + 1000.109;
const USDTB_TOTAL = 1607.822777 + 19187.0188631 + 121;
const TOTAL_RESERVE_USD = USDC_TOTAL + USDTB_TOTAL;


describe("adaptMegausdCustody", () => {
  it("maps USDC and USDtb into tracked-coin slices and persists only totalReserveUsd", () => {
    const result = adaptMegausdCustody(MEGAUSD_BACKING);

    expect(result.slices).toEqual([
      { sourceKey: "megausd-custody:usdc", name: "USDC cash-equivalent reserves", pct: 99.9, risk: "low", coinId: "usdc-circle" },
      { sourceKey: "megausd-custody:usdtb", name: "USDtb cash-equivalent reserves", pct: 0.1, risk: "low", coinId: "usdtb-ethena" },
    ]);
    expect(result.warnings).toBeUndefined();

    expect(result.metadata).toMatchObject({
      sourceTimestamp: Math.floor(Date.parse("2026-09-09T15:55:59.000Z") / 1000),
      freshnessMode: "verified",
      details: { lastUpdatedAt: "2026-09-09T15:55:59.000Z" },
    });
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(TOTAL_RESERVE_USD, 3);
    // The API's local single-chain `supply` is not a tracked global liability,
    // so the adapter never publishes a collateralization ratio.
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.metadata?.supplyUsd).toBeUndefined();
  });

  it("emits an info warning when USDm reports nonzero self-holdings and excludes them from backing", () => {
    const withSelfHolding: MegausdBackingAndSupplyPayload = {
      ...MEGAUSD_BACKING,
      backingAssets: {
        ...MEGAUSD_BACKING.backingAssets,
        USDm: [{ amount: 5_000_000, custodian: "0x343c18B0f1710B65cE33A7CE720b5D540215d343" }],
      },
    };

    const result = adaptMegausdCustody(withSelfHolding);

    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "megausd-self-holding-excluded",
        severity: "info",
        effect: "info",
      }),
    ]);
    expect(result.slices.some((slice) => slice.name.includes("USDm"))).toBe(false);
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(TOTAL_RESERVE_USD, 3);
  });

  it("degrades-warns and buckets an unmapped backing asset instead of failing closed", () => {
    const withUnknownAsset: MegausdBackingAndSupplyPayload = {
      ...MEGAUSD_BACKING,
      backingAssets: {
        ...MEGAUSD_BACKING.backingAssets,
        DAI: [{ amount: 1_000_000, custodian: "0x343c18B0f1710B65cE33A7CE720b5D540215d343" }],
      },
    };

    const result = adaptMegausdCustody(withUnknownAsset);

    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "unknown-asset", severity: "warning", effect: "degraded" }),
    ]);
    expect(result.slices).toContainEqual(
      expect.objectContaining({ name: "DAI (unmapped)", risk: "high" }),
    );
  });

  it("throws when backingAssets is missing", () => {
    expect(() => adaptMegausdCustody({ ...MEGAUSD_BACKING, backingAssets: undefined }))
      .toThrow("missing backingAssets");
  });

  it("throws when lastUpdatedAt is unreadable", () => {
    expect(() => adaptMegausdCustody({ ...MEGAUSD_BACKING, lastUpdatedAt: "" }))
      .toThrow("unreadable lastUpdatedAt");
  });

  it("parses numeric-string amounts instead of silently reading them as zero", () => {
    const withStringAmounts: MegausdBackingAndSupplyPayload = {
      ...MEGAUSD_BACKING,
      backingAssets: {
        USDC: [{ amount: "16939375.424062", custodian: "0x343c18B0f1710B65cE33A7CE720b5D540215d343" }],
        USDtb: [{ amount: "20915.8416401", custodian: "0x343c18B0f1710B65cE33A7CE720b5D540215d343" }],
        USDm: [{ amount: 0, custodian: "0x343c18B0f1710B65cE33A7CE720b5D540215d343" }],
      },
    };

    const result = adaptMegausdCustody(withStringAmounts);

    expect(result.slices).toEqual([
      { sourceKey: "megausd-custody:usdc", name: "USDC cash-equivalent reserves", pct: 99.9, risk: "low", coinId: "usdc-circle" },
      { sourceKey: "megausd-custody:usdtb", name: "USDtb cash-equivalent reserves", pct: 0.1, risk: "low", coinId: "usdtb-ethena" },
    ]);
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(TOTAL_RESERVE_USD, 3);
  });

  it("throws on negative amounts instead of silently zeroing them", () => {
    expect(() => adaptMegausdCustody({
      ...MEGAUSD_BACKING,
      backingAssets: {
        ...MEGAUSD_BACKING.backingAssets,
        USDC: [{ amount: -5, custodian: "0x343c18B0f1710B65cE33A7CE720b5D540215d343" }],
      },
    })).toThrow("backing asset USDC entry 0 has a negative amount");
  });

  it("throws when every backing asset amount is zero", () => {
    expect(() =>
      adaptMegausdCustody({
        ...MEGAUSD_BACKING,
        backingAssets: {
          USDC: [{ amount: 0, custodian: "0x343c18B0f1710B65cE33A7CE720b5D540215d343" }],
          USDm: [{ amount: 0, custodian: "0x343c18B0f1710B65cE33A7CE720b5D540215d343" }],
          USDtb: [{ amount: 0, custodian: "0x343c18B0f1710B65cE33A7CE720b5D540215d343" }],
        },
      }),
    ).toThrow("no positive backing asset amounts");
  });

  it("is degraded-but-valid under validateAdapterOutput when the source timestamp is stale", () => {
    const stale: MegausdBackingAndSupplyPayload = {
      ...MEGAUSD_BACKING,
      lastUpdatedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const result = adaptMegausdCustody(stale);
    const report = expectValidAdapterOutput("megausd-custody", result);
    expect(report.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "stale-source-data", effect: "degraded" })]),
    );
  });
});

describe("fetchMegausdCustodyReserves", () => {
  it("fetches the configured backing-and-supply endpoint through the shared network harness", async () => {
    const { result, network } = await runAdapter("megausd-custody", makeCoin(), {
      network: { json: { [MEGAUSD_URL]: MEGAUSD_BACKING } },
      nowSec: Math.floor(Date.parse("2026-09-09T16:00:00Z") / 1000),
    });

    expect(network.requests.map((request) => request.url)).toEqual([MEGAUSD_URL]);
    expect(result.slices[0]).toMatchObject({ name: "USDC cash-equivalent reserves" });
  });

  it("propagates an endpoint failure", async () => {
    await expect(runAdapter("megausd-custody", makeCoin(), {
      network: { json: { [MEGAUSD_URL]: { status: 500, body: "upstream unavailable" } } },
      nowSec: Math.floor(Date.parse("2026-09-09T16:00:00Z") / 1000),
    })).rejects.toThrow(/500/);
  });
});
