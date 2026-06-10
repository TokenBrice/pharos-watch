import { describe, expect, it } from "vitest";
import type { PeggedAsset } from "../enrich-prices-shared";
import {
  restoreMissingTrackedAssets,
  SUPPLEMENTAL_RESTORE_MAX_AGE_SEC,
} from "../shared";

const NOW_SEC = 1_780_000_000;

function asset(input: Partial<PeggedAsset> & Pick<PeggedAsset, "id" | "symbol">): PeggedAsset {
  return {
    name: input.symbol,
    circulating: {},
    ...input,
  } as PeggedAsset;
}

describe("restoreMissingTrackedAssets", () => {
  it("restores a tracked coin the intake list omitted", () => {
    const current = [asset({ id: "usdt-tether", symbol: "USDT", circulating: { peggedUSD: 1 } })];
    const previous = new Map([
      [
        "usdc-circle",
        asset({
          id: "usdc-circle",
          symbol: "USDC",
          circulating: { peggedUSD: 70_000_000_000 },
          supplyObservedAt: NOW_SEC - 900,
        }),
      ],
    ]);

    const result = restoreMissingTrackedAssets(current, previous, NOW_SEC);

    expect(result.restoredIds).toEqual(["usdc-circle"]);
    expect(result.droppedIds).toEqual([]);
    expect(result.assets[0]).toMatchObject({
      id: "usdc-circle",
      circulating: { peggedUSD: 70_000_000_000 },
      supplyRestored: true,
    });
  });

  it("does not restore coins already present in the intake list", () => {
    const row = asset({
      id: "usdc-circle",
      symbol: "USDC",
      circulating: { peggedUSD: 70_000_000_000 },
      supplyObservedAt: NOW_SEC - 900,
    });
    const result = restoreMissingTrackedAssets([row], new Map([["usdc-circle", row]]), NOW_SEC);

    expect(result.restoredIds).toEqual([]);
    expect(result.droppedIds).toEqual([]);
    expect(result.assets).toEqual([]);
  });

  it("ignores previous rows that are not active tracked coins", () => {
    const previous = new Map([
      [
        "not-a-tracked-coin",
        asset({
          id: "not-a-tracked-coin",
          symbol: "XXX",
          circulating: { peggedUSD: 1_000_000 },
          supplyObservedAt: NOW_SEC - 900,
        }),
      ],
    ]);

    const result = restoreMissingTrackedAssets([], previous, NOW_SEC);

    expect(result.restoredIds).toEqual([]);
    expect(result.droppedIds).toEqual([]);
    expect(result.assets).toEqual([]);
  });

  it("degrades (reports as dropped) past the carry-forward ceiling", () => {
    const previous = new Map([
      [
        "usdc-circle",
        asset({
          id: "usdc-circle",
          symbol: "USDC",
          circulating: { peggedUSD: 70_000_000_000 },
          supplyObservedAt: NOW_SEC - SUPPLEMENTAL_RESTORE_MAX_AGE_SEC - 1,
        }),
      ],
    ]);

    const result = restoreMissingTrackedAssets([], previous, NOW_SEC);

    expect(result.restoredIds).toEqual([]);
    expect(result.droppedIds).toEqual(["usdc-circle"]);
    expect(result.assets).toEqual([]);
  });

  it("degrades when the previous row has no usable supply", () => {
    const previous = new Map([
      ["usdc-circle", asset({ id: "usdc-circle", symbol: "USDC", circulating: {} })],
    ]);

    const result = restoreMissingTrackedAssets([], previous, NOW_SEC);

    expect(result.restoredIds).toEqual([]);
    expect(result.droppedIds).toEqual(["usdc-circle"]);
    expect(result.assets).toEqual([]);
  });
});
