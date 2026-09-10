import { describe, expect, it } from "vitest";
import { runAdapter, expectWarnings } from "./reserve-adapter.test-support";

const YIELD_MANAGER = "0xa230285d5683c74935ad14c446e137c8c8828438";
const USDB = "0x4300000000000000000000000000000000000003";
const TOTAL_VALUE_SELECTOR = "0xd4c3eea0";
const TOTAL_SUPPLY_SELECTOR = "0x18160ddd";
const NOW_SEC = 1_788_912_032;

describe("fetchBlastUsdbYieldManagerReserves", () => {
  it("uses USDYieldManager totalValue as USDB backing", async () => {
    const { result } = await runAdapter("blast-usdb-yield-manager", "usdb-blast", {
      network: {
        rpc: {
          [`ethereum:${YIELD_MANAGER}:${TOTAL_VALUE_SELECTOR}`]: 120n * 10n ** 18n,
          [`${USDB}:${TOTAL_SUPPLY_SELECTOR}`]: 100n * 10n ** 18n,
        },
      },
      nowSec: NOW_SEC,
    });

    expect(result.slices).toEqual([
      {
        sourceKey: "blast-usdb-yield-manager:dai",
        name: "MakerDAO DSR / DAI yield manager",
        pct: 100,
        risk: "low",
        coinId: "dai-makerdao",
      },
    ]);
    expectWarnings(result, []);
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      totalReserveUsd: 120,
      supplyUsd: 100,
      details: {
        proofKind: "blast-usdb-yield-manager-total-value",
        supplyChain: "blast",
        sharePrice: 1.2,
      },
    });
    expect(result.metadata).not.toHaveProperty("collateralizationRatio");
  });

  it("publishes the share price without a coverage claim when manager value falls below supply", async () => {
    const { result } = await runAdapter("blast-usdb-yield-manager", "usdb-blast", {
      network: {
        rpc: {
          [`ethereum:${YIELD_MANAGER}:${TOTAL_VALUE_SELECTOR}`]: 98n * 10n ** 18n,
          [`${USDB}:${TOTAL_SUPPLY_SELECTOR}`]: 100n * 10n ** 18n,
        },
      },
      nowSec: NOW_SEC,
    });

    expectWarnings(result, []);
    expect(result.metadata).not.toHaveProperty("collateralizationRatio");
    expect(result.metadata?.details?.sharePrice).toBeCloseTo(0.98, 6);
  });

  it("fails when the manager totalValue read is unavailable", async () => {
    await expect(runAdapter("blast-usdb-yield-manager", "usdb-blast", {
      network: {
        rpc: {
          [`ethereum:${YIELD_MANAGER}:${TOTAL_VALUE_SELECTOR}`]: null,
          [`${USDB}:${TOTAL_SUPPLY_SELECTOR}`]: 100n * 10n ** 18n,
        },
      },
      nowSec: NOW_SEC,
    })).rejects.toThrow(/totalValue/);
  });
});
