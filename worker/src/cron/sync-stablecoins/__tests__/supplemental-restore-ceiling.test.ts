import { describe, expect, it } from "vitest";
import type { PeggedAsset } from "../enrich-prices-shared";
import {
  mergeSupplementalLastKnownGood,
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

describe("mergeSupplementalLastKnownGood carry-forward ceiling", () => {
  it("restores last-known-good supply observed inside the ceiling", () => {
    const current = asset({ id: "xaut-tether", symbol: "XAUT", circulating: {} });
    const previous = asset({
      id: "xaut-tether",
      symbol: "XAUT",
      circulating: { peggedUSD: 500_000_000 },
      supplyObservedAt: NOW_SEC - 86_400,
    });

    const result = mergeSupplementalLastKnownGood(
      [current],
      new Map([["xaut-tether", previous]]),
      new Set(),
      NOW_SEC,
    );

    expect(result.restoredCount).toBe(1);
    expect(result.expiredRestoreIds).toEqual([]);
    expect(result.assets[0]).toMatchObject({
      circulating: { peggedUSD: 500_000_000 },
      supplyRestored: true,
      supplyObservedAt: NOW_SEC - 86_400,
    });
  });

  it("refuses to restore supply older than the 7-day ceiling", () => {
    const current = asset({ id: "xaut-tether", symbol: "XAUT", circulating: {} });
    const previous = asset({
      id: "xaut-tether",
      symbol: "XAUT",
      circulating: { peggedUSD: 500_000_000 },
      supplyObservedAt: NOW_SEC - SUPPLEMENTAL_RESTORE_MAX_AGE_SEC - 1,
    });

    const result = mergeSupplementalLastKnownGood(
      [current],
      new Map([["xaut-tether", previous]]),
      new Set(),
      NOW_SEC,
    );

    expect(result.restoredCount).toBe(0);
    expect(result.expiredRestoreIds).toEqual(["xaut-tether"]);
    expect(result.assets[0]).toMatchObject({ id: "xaut-tether", circulating: {} });
    expect(result.assets[0].supplyRestored).toBeUndefined();
  });

  it("restores rows without provenance exactly as before", () => {
    const current = asset({ id: "paxg-paxos", symbol: "PAXG", circulating: {} });
    const previous = asset({
      id: "paxg-paxos",
      symbol: "PAXG",
      circulating: { peggedUSD: 900_000_000 },
    });

    const result = mergeSupplementalLastKnownGood(
      [current],
      new Map([["paxg-paxos", previous]]),
      new Set(),
      NOW_SEC,
    );

    expect(result.restoredCount).toBe(1);
    expect(result.expiredRestoreIds).toEqual([]);
    expect(result.assets[0]).toMatchObject({ supplyRestored: true });
  });
});
