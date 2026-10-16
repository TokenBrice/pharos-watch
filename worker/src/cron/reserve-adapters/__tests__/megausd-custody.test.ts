import { describe, expect, it } from "vitest";
import { adaptCustodyInventory, type BackingAndSupplyPayload } from "../custody-inventory";
import { expectValidAdapterOutput } from "./reserve-adapter.test-support";
import { MEGAUSD_BACKING } from "./megausd-custody.test-support";

const USDC_TOTAL = 1618402.389424 + 15319532.925638 + 440 + 1000.109;
const USDTB_TOTAL = 1607.822777 + 19187.0188631 + 121;
const TOTAL_RESERVE_USD = USDC_TOTAL + USDTB_TOTAL;


describe("custody inventory MegaUSD profile", () => {
  it("maps USDC and USDtb into tracked-coin slices and persists only totalReserveUsd", () => {
    const result = adaptCustodyInventory("megausd-custody", MEGAUSD_BACKING);

    expect(result.slices).toEqual([
      { sourceKey: "megausd-custody:usdc", name: "USDC cash-equivalent reserves", pct: 99.9, risk: "low", coinId: "usdc-circle", depType: "collateral" },
      { sourceKey: "megausd-custody:usdtb", name: "USDtb cash-equivalent reserves", pct: 0.1, risk: "low", coinId: "usdtb-ethena", depType: "collateral" },
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

  it("ignores local supply and settlement float rather than applying USDtb liability policy", () => {
    const result = adaptCustodyInventory("megausd-custody", {
      ...MEGAUSD_BACKING, supply: "not-a-global-liability", assetsInMotion: -1,
    });
    expect(result).toEqual(adaptCustodyInventory("megausd-custody", MEGAUSD_BACKING));
  });

  it("emits an info warning when USDm reports nonzero self-holdings and excludes them from backing", () => {
    const withSelfHolding: BackingAndSupplyPayload = {
      ...MEGAUSD_BACKING,
      backingAssets: {
        ...MEGAUSD_BACKING.backingAssets,
        USDm: [{ amount: 5_000_000, custodian: "0x343c18B0f1710B65cE33A7CE720b5D540215d343" }],
      },
    };

    const result = adaptCustodyInventory("megausd-custody", withSelfHolding);

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
    const withUnknownAsset: BackingAndSupplyPayload = {
      ...MEGAUSD_BACKING,
      backingAssets: {
        ...MEGAUSD_BACKING.backingAssets,
        DAI: [{ amount: 1_000_000, custodian: "0x343c18B0f1710B65cE33A7CE720b5D540215d343" }],
      },
    };

    const result = adaptCustodyInventory("megausd-custody", withUnknownAsset);

    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "unknown-asset", severity: "warning", effect: "degraded" }),
    ]);
    expect(result.slices).toContainEqual(
      expect.objectContaining({ name: "DAI (unmapped)", risk: "high" }),
    );
  });

  it("throws when backingAssets is missing", () => {
    expect(() => adaptCustodyInventory("megausd-custody", { ...MEGAUSD_BACKING, backingAssets: undefined }))
      .toThrow("missing backingAssets");
  });

  it("throws when lastUpdatedAt is unreadable", () => {
    expect(() => adaptCustodyInventory("megausd-custody", { ...MEGAUSD_BACKING, lastUpdatedAt: "" }))
      .toThrow("unreadable lastUpdatedAt");
  });

  it("parses numeric-string amounts instead of silently reading them as zero", () => {
    const withStringAmounts: BackingAndSupplyPayload = {
      ...MEGAUSD_BACKING,
      backingAssets: {
        USDC: [{ amount: "16939375.424062", custodian: "0x343c18B0f1710B65cE33A7CE720b5D540215d343" }],
        USDtb: [{ amount: "20915.8416401", custodian: "0x343c18B0f1710B65cE33A7CE720b5D540215d343" }],
        USDm: [{ amount: 0, custodian: "0x343c18B0f1710B65cE33A7CE720b5D540215d343" }],
      },
    };

    const result = adaptCustodyInventory("megausd-custody", withStringAmounts);

    expect(result.slices).toEqual([
      { sourceKey: "megausd-custody:usdc", name: "USDC cash-equivalent reserves", pct: 99.9, risk: "low", coinId: "usdc-circle", depType: "collateral" },
      { sourceKey: "megausd-custody:usdtb", name: "USDtb cash-equivalent reserves", pct: 0.1, risk: "low", coinId: "usdtb-ethena", depType: "collateral" },
    ]);
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(TOTAL_RESERVE_USD, 3);
  });

  it("throws on negative amounts instead of silently zeroing them", () => {
    expect(() => adaptCustodyInventory("megausd-custody", {
      ...MEGAUSD_BACKING,
      backingAssets: {
        ...MEGAUSD_BACKING.backingAssets,
        USDC: [{ amount: -5, custodian: "0x343c18B0f1710B65cE33A7CE720b5D540215d343" }],
      },
    })).toThrow("backing asset USDC entry 0 has a negative amount");
  });

  it("throws when every backing asset amount is zero", () => {
    expect(() =>
      adaptCustodyInventory("megausd-custody", {
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
    const stale: BackingAndSupplyPayload = {
      ...MEGAUSD_BACKING,
      lastUpdatedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const result = adaptCustodyInventory("megausd-custody", stale);
    const report = expectValidAdapterOutput("megausd-custody", result);
    expect(report.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "stale-source-data", effect: "degraded" })]),
    );
  });
});
