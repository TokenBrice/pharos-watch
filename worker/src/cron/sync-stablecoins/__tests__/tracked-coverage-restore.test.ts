import { describe, expect, it } from "vitest";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
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

/** Full active-tracked intake minus the ids under test, so droppedIds assertions stay exact. */
function fullActiveIntake(omitIds: string[] = []): PeggedAsset[] {
  const omitted = new Set(omitIds);
  return ACTIVE_STABLECOINS.filter((meta) => !omitted.has(meta.id)).map((meta) =>
    asset({ id: meta.id, symbol: meta.symbol, circulating: { peggedUSD: 1 } }),
  );
}

describe("restoreMissingTrackedAssets", () => {
  it("restores a tracked coin the intake list omitted", () => {
    const current = fullActiveIntake(["usdc-circle"]);
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
    const result = restoreMissingTrackedAssets(fullActiveIntake(), new Map([["usdc-circle", row]]), NOW_SEC);

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

    const result = restoreMissingTrackedAssets(fullActiveIntake(), previous, NOW_SEC);

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

    const result = restoreMissingTrackedAssets(fullActiveIntake(["usdc-circle"]), previous, NOW_SEC);

    expect(result.restoredIds).toEqual([]);
    expect(result.droppedIds).toEqual(["usdc-circle"]);
    expect(result.assets).toEqual([]);
  });

  it("degrades when the previous row has no usable supply", () => {
    const previous = new Map([
      ["usdc-circle", asset({ id: "usdc-circle", symbol: "USDC", circulating: {} })],
    ]);

    const result = restoreMissingTrackedAssets(fullActiveIntake(["usdc-circle"]), previous, NOW_SEC);

    expect(result.restoredIds).toEqual([]);
    expect(result.droppedIds).toEqual(["usdc-circle"]);
    expect(result.assets).toEqual([]);
  });

  it("keeps reporting a coin absent from both the intake and the previous payload as dropped", () => {
    const result = restoreMissingTrackedAssets(fullActiveIntake(["usdc-circle"]), new Map(), NOW_SEC);

    expect(result.restoredIds).toEqual([]);
    expect(result.droppedIds).toEqual(["usdc-circle"]);
    expect(result.assets).toEqual([]);
  });
});
