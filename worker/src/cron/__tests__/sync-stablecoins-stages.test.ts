import { describe, it, expect, vi } from "vitest";

vi.mock("@shared/lib/stablecoins", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shared/lib/stablecoins")>();
  const TRACKED_META_BY_ID = new Map(actual.TRACKED_META_BY_ID);
  TRACKED_META_BY_ID.set("usdt-tether", {
    ...TRACKED_META_BY_ID.get("usdt-tether"),
    geckoId: "canonical-usdt",
    cmcSlug: "tether",
    flags: { navToken: false },
  } as never);
  TRACKED_META_BY_ID.set("nav-token-test", {
    geckoId: "nav-token",
    cmcSlug: "nav-token",
    flags: { navToken: true },
  } as never);

  return {
    ...actual,
    TRACKED_META_BY_ID,
  };
});

import {
  applyTrackedAssetOverrides,
  computePriceStalenessSummary,
  dedupeCanonicalAssets,
  filterStructurallyValidAssets,
  normalizeChainCirculating,
} from "../sync-stablecoins/stages";

describe("sync-stablecoins stage helpers", () => {
  it("filters malformed assets while preserving structurally valid rows", () => {
    const assets = [
      { id: "usdt-tether", name: "USDT", symbol: "USDT", circulating: { peggedUSD: 1 } },
      { id: "usdc-circle", name: "Broken", circulating: { peggedUSD: 1 } },
      { id: null, name: "Broken", symbol: "BRK", circulating: { peggedUSD: 1 } },
    ] as unknown as Array<{
      id: string | null;
      name: string;
      symbol?: string;
      circulating: Record<string, number>;
    }>;

    const { validAssets, droppedMalformedAssets } = filterStructurallyValidAssets(assets as never[]);

    expect(validAssets).toHaveLength(1);
    expect(validAssets[0].id).toBe("usdt-tether");
    expect(droppedMalformedAssets).toBe(2);
  });

  it("normalizes chainCirculating peg buckets into numeric totals", () => {
    const assets = [
      {
        id: "usdt-tether",
        chainCirculating: {
          ethereum: {
            current: { peggedUSD: 10, peggedEUR: 15 },
            circulatingPrevDay: { peggedUSD: 8, peggedEUR: 7 },
            circulatingPrevWeek: 9,
          },
        },
      },
    ] as unknown as never[];

    normalizeChainCirculating(assets);

    const entry = (assets[0] as unknown as { chainCirculating: Record<string, Record<string, unknown>> }).chainCirculating.ethereum;
    expect(entry.current).toBe(25);
    expect(entry.circulatingPrevDay).toBe(15);
    expect(entry.circulatingPrevWeek).toBe(9);
  });

  it("applies curated metadata overrides and address patches", () => {
    const assets = [
      { id: "usdt-tether", geckoId: "wrong-id", cmcSlug: undefined, navToken: false },
      { id: "nav-token-test", geckoId: undefined, cmcSlug: undefined, navToken: false },
      { id: "m-m0", geckoId: undefined, cmcSlug: undefined, navToken: false, address: "" },
    ] as unknown as never[];

    applyTrackedAssetOverrides(assets);

    const [usdt, nav, patchedAddress] = assets as unknown as Array<{
      geckoId?: string;
      cmcSlug?: string;
      navToken?: boolean;
      address?: string;
    }>;

    expect(usdt.geckoId).toBe("canonical-usdt");
    expect(usdt.cmcSlug).toBe("tether");
    expect(nav.navToken).toBe(true);
    expect(patchedAddress.address).toBe("0x866A2BF4E572CbcF37D5071A7a58503Bfb36be1b");
  });

  it("dedupes canonical ID collisions by keeping the richer asset row", () => {
    const assets = [
      {
        id: "usdt-tether",
        symbol: "USDT",
        circulating: { peggedUSD: 100 },
        chainCirculating: { Ethereum: { current: 100, circulatingPrevDay: 100, circulatingPrevWeek: 100, circulatingPrevMonth: 100 } },
        chains: ["Ethereum"],
        price: 1,
      },
      {
        id: "usdt-tether",
        symbol: "USDT",
        circulating: { peggedUSD: 125 },
        chainCirculating: {
          Ethereum: { current: 80, circulatingPrevDay: 80, circulatingPrevWeek: 80, circulatingPrevMonth: 80 },
          Tron: { current: 45, circulatingPrevDay: 45, circulatingPrevWeek: 45, circulatingPrevMonth: 45 },
        },
        chains: ["Ethereum", "Tron"],
        price: 1.0002,
        priceUpdatedAt: 2_000,
      },
      {
        id: "usdc-circle",
        symbol: "USDC",
        circulating: { peggedUSD: 90 },
        chainCirculating: {},
        chains: ["Ethereum"],
        price: 1,
      },
    ] as unknown as never[];

    const result = dedupeCanonicalAssets(assets);

    expect(result.duplicateRows).toBe(1);
    expect(result.affectedIds).toEqual(["usdt-tether"]);
    expect(result.dedupedAssets).toHaveLength(2);
    expect(result.dedupedAssets.find((asset) => asset.id === "usdt-tether")).toMatchObject({
      circulating: { peggedUSD: 125 },
      chains: ["Ethereum", "Tron"],
      price: 1.0002,
    });
  });

  it("flags stale price snapshots when >95% of compared rows are identical", () => {
    const previous = Array.from({ length: 60 }, (_, i) => ({ id: `coin-${i}`, price: 1 + i * 0.001 }));
    const current = previous.map((row, i) => ({ ...row, price: i < 58 ? row.price : row.price + 0.1 }));

    const summary = computePriceStalenessSummary(previous as never[], current as never[]);

    expect(summary.compared).toBe(60);
    expect(summary.identical).toBe(58);
    expect(summary.stale).toBe(true);
  });

  it("does not flag stale when compared population is too small", () => {
    const previous = Array.from({ length: 20 }, (_, i) => ({ id: `coin-${i}`, price: 1 }));
    const current = previous.map((row) => ({ ...row, price: row.price }));

    const summary = computePriceStalenessSummary(previous as never[], current as never[]);

    expect(summary.compared).toBe(20);
    expect(summary.stale).toBe(false);
  });
});
