import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { buildStablecoinDetailClientCoin } from "../stablecoin-detail-client-coin";
import { projectReserveLookThroughClientSummary } from "../stablecoin-detail-reserve-look-through-client";

function coin(id: string, overrides: Record<string, unknown> = {}): StablecoinMeta {
  return { id, symbol: id.toUpperCase(), ...overrides } as unknown as StablecoinMeta;
}

const PARENT = coin("par", {
  symbol: "PAR",
  reserves: [
    { name: "Cash", pct: 60, risk: "very-low", assetClass: "cash", liquidityHorizon: "immediate", issuerOrObligor: "Banks" },
    { name: "BTC", pct: 40, risk: "high", assetClass: "cryptoasset", liquidityHorizon: "one-day" },
  ],
  reserveReview: { reviewedAt: "2026-09-30" },
});
const UNCLASSIFIED_PARENT = coin("raw", {
  symbol: "RAW",
  reserves: [{ name: "Strategy basket", pct: 100, risk: "medium", issuerOrObligor: "Strategy desk" }],
});
const PARENTS: ReadonlyMap<string, StablecoinMeta> = new Map([
  [PARENT.id, PARENT],
  [UNCLASSIFIED_PARENT.id, UNCLASSIFIED_PARENT],
  ["empty", coin("empty", { reserves: [] })],
]);

const wrapperOf = (parentId: string, sliceOverrides: Record<string, unknown> = {}) =>
  coin("wrapper", {
    reserves: [{ name: "Vault shares", pct: 100, risk: "medium", coinId: parentId, depType: "wrapper", ...sliceOverrides }],
  });

describe("projectReserveLookThroughClientSummary", () => {
  it.each(["selected-slices", "classification-only", "dependency-relationships"])(
    "rejects explicitly contextual wrapper or parent scope even when rows total 100%% (%s)",
    (scope) => {
      const wrapper = wrapperOf("par");
      expect(projectReserveLookThroughClientSummary({
        ...wrapper, reserveReview: { scope } as never,
      }, PARENTS)).toBeNull();
      expect(projectReserveLookThroughClientSummary(wrapper, new Map([
        ["par", { ...PARENT, reserveReview: { scope } as never }],
      ]))).toBeNull();
      expect(projectReserveLookThroughClientSummary({
        ...wrapper, reserveReview: { scope: "full-composition" } as never,
      }, new Map([["par", { ...PARENT, reserveReview: { scope: "full-composition" } as never }]])))
        .toMatchObject({ parentId: "par" });
    },
  );
  it("joins a single wrapper slice to its parent's reviewed slices, dated by the parent's review", () => {
    const summary = projectReserveLookThroughClientSummary(wrapperOf("par"), PARENTS);
    expect(summary).toMatchObject({ parentId: "par", parentSymbol: "PAR", parentReviewedAt: "2026-09-30" });
    expect(summary!.slices.map((slice) => [slice.name, slice.pct, slice.risk])).toEqual([
      ["Cash", 60, "very-low"],
      ["BTC", 40, "high"],
    ]);
    expect(summary!.slices.every((slice) => slice.assetClassLabel != null)).toBe(true);
  });

  it("carries a parent's unclassified slices without inventing an asset class", () => {
    const summary = projectReserveLookThroughClientSummary(wrapperOf("raw"), PARENTS);
    expect(summary!.slices).toMatchObject([
      { name: "Strategy basket", pct: 100, risk: "medium", obligor: "Strategy desk", assetClassLabel: null },
    ]);
    expect(summary!.parentReviewedAt).toBeNull();
  });

  it.each([
    ["a non-wrapper dependency", wrapperOf("par", { depType: "collateral" })],
    ["an unlinked slice", wrapperOf("par", { coinId: undefined, depType: undefined })],
    ["an untracked parent", wrapperOf("missing")],
    ["a parent with no reviewed slices", wrapperOf("empty")],
    ["a self-link", coin("par", { reserves: [{ name: "Self", pct: 100, risk: "low", coinId: "par", depType: "wrapper" }] })],
    ["a basket of two slices", coin("wrapper", {
      reserves: [
        { name: "Vault shares", pct: 50, risk: "medium", coinId: "par", depType: "wrapper" },
        { name: "Cash", pct: 50, risk: "very-low" },
      ],
    })],
  ])("does not join %s", (_case, wrapper) => {
    expect(projectReserveLookThroughClientSummary(wrapper, PARENTS)).toBeNull();
  });

  it("needs the parent registry", () => {
    expect(projectReserveLookThroughClientSummary(wrapperOf("par"), undefined)).toBeNull();
  });
});

describe("buildStablecoinDetailClientCoin reserve look-through", () => {
  it("attaches the look-through only when the join holds", () => {
    expect(buildStablecoinDetailClientCoin(wrapperOf("par"), { parentById: PARENTS }).reserveLookThrough?.parentSymbol).toBe("PAR");
    expect("reserveLookThrough" in buildStablecoinDetailClientCoin(wrapperOf("par"))).toBe(false);
    expect("reserveLookThrough" in buildStablecoinDetailClientCoin(PARENT, { parentById: PARENTS })).toBe(false);
  });

  it("joins the tracked sUSDe wrapper to USDe's reviewed slices", () => {
    const parent = TRACKED_META_BY_ID.get("usde-ethena")!;
    const clientCoin = buildStablecoinDetailClientCoin(TRACKED_META_BY_ID.get("susde-ethena")!, { parentById: TRACKED_META_BY_ID });
    expect(clientCoin.reserveLookThrough?.parentSymbol).toBe(parent.symbol);
    expect(clientCoin.reserveLookThrough?.slices).toHaveLength(parent.reserves!.length);
  });
});
