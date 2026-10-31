import { describe, expect, it } from "vitest";
import { FROZEN_SNAPSHOTS_BY_ID } from "@shared/lib/stablecoins/frozen-snapshots";
import { mergeFrozenSnapshots } from "../intake";
import { applyTrackedAssetOverrides, filterStructurallyValidAssets } from "../phase-helpers";
import { applyConsensusResults, createValidationContextResolver } from "../pricing";
import { normalizeStablecoinsPayload } from "../shared";
import { makePeggedAsset } from "./_fixtures";

describe("mergeFrozenSnapshots", () => {
  const snapshots = [
    {
      id: "fixture-frozen",
      capturedAt: "2026-04-27T00:00:00Z",
      peggedAssetRow: { id: "fixture-frozen", name: "Fixture", symbol: "FXT" } as Record<string, unknown> & { id: string },
    },
  ];

  it("appends a snapshot row when upstream is missing it", () => {
    const upstream = [{ id: "usdt-tether", name: "Tether", symbol: "USDT" } as never];
    const merged = mergeFrozenSnapshots(upstream, snapshots);
    expect(merged).toHaveLength(2);
    expect(merged.find((a) => (a as { id: string }).id === "fixture-frozen")).toMatchObject({ name: "Fixture" });
  });

  it("does not duplicate when upstream already contains the row", () => {
    const upstream = [
      { id: "fixture-frozen", name: "Fixture (live)", symbol: "FXT" } as never,
      { id: "usdt-tether", name: "Tether", symbol: "USDT" } as never,
    ];
    const merged = mergeFrozenSnapshots(upstream, snapshots);
    expect(merged).toHaveLength(2);
    // upstream wins — preserves anything upstream still serves
    expect((merged.find((a) => (a as { id: string }).id === "fixture-frozen") as { name: string }).name).toBe("Fixture (live)");
  });

  it("does not duplicate when an upstream DefiLlama id maps to the snapshot canonical id", () => {
    const upstream = [
      { id: "1", name: "Tether (live)", symbol: "USDT" } as never,
    ];
    const merged = mergeFrozenSnapshots(upstream, [
      {
        id: "usdt-tether",
        capturedAt: "2026-04-27T00:00:00Z",
        peggedAssetRow: { id: "usdt-tether", name: "Tether (snapshot)", symbol: "USDT" },
      },
    ]);
    expect(merged).toHaveLength(1);
    expect((merged[0] as { name: string }).name).toBe("Tether (live)");
  });

  it("deduplicates repeated snapshots before the canonical dedupe stage", () => {
    const upstream = [{ id: "usdt-tether", name: "Tether", symbol: "USDT" } as never];
    const merged = mergeFrozenSnapshots(upstream, [...snapshots, ...snapshots]);
    expect(merged.filter((a) => (a as { id: string }).id === "fixture-frozen")).toHaveLength(1);
  });

  it("returns input unchanged when no snapshots provided", () => {
    const upstream = [{ id: "usdt-tether", name: "Tether", symbol: "USDT" } as never];
    expect(mergeFrozenSnapshots(upstream, [])).toBe(upstream);
  });
});

describe("frozen-snapshot price provenance", () => {
  it("does not republish a captured snapshot price as this run's DefiLlama observation", () => {
    const syncStartSec = Math.floor(Date.parse("2026-10-30T12:00:00Z") / 1000);
    const snapshot = FROZEN_SNAPSHOTS_BY_ID.get("aeur-anchored-coins");
    if (!snapshot) throw new Error("expected the checked-in AEUR frozen snapshot");
    expect(snapshot.capturedAt).toBe("2026-07-08T08:00:33.000Z");
    expect(snapshot.peggedAssetRow).toMatchObject({ price: 1.117990454919679, priceSource: "defillama" });
    expect(snapshot.peggedAssetRow).not.toHaveProperty("priceObservedAt");
    expect(snapshot.peggedAssetRow).not.toHaveProperty("priceUpdatedAt");

    // DefiLlama no longer serves AEUR, so intake appends the captured row. With
    // no geckoId/CEX/curve/redstone lane the primary collector returns no quote
    // for it; the undated `defillama-list` consensus leg is rejected by
    // `requiresObservedAt`, exactly as in production.
    const merged = mergeFrozenSnapshots(
      [
        makePeggedAsset({
          id: "usdt-tether",
          name: "Tether",
          symbol: "USDT",
          price: 1,
          priceSource: "defillama",
          circulating: { peggedUSD: 100_000_000 },
        }),
      ],
      [{ ...snapshot, peggedAssetRow: structuredClone(snapshot.peggedAssetRow) }],
    );
    const { validAssets } = filterStructurallyValidAssets(merged);
    applyTrackedAssetOverrides(validAssets);
    const frozenRow = validAssets.find((asset) => asset.id === "aeur-anchored-coins");
    if (!frozenRow) throw new Error("expected the injected AEUR row to pass structural admission");
    expect(frozenRow.geckoId).toBeUndefined();
    expect(frozenRow.priceObservedAt).toBe(Date.parse(snapshot.capturedAt) / 1000);

    applyConsensusResults({
      assets: validAssets,
      primaryPriceResults: new Map(),
      validationContexts: createValidationContextResolver(),
      syncStartSec,
      reason: "primary",
    });

    const [published] = normalizeStablecoinsPayload({ peggedAssets: [frozenRow] }, syncStartSec).peggedAssets;

    // R6: the 2026-07-08 captured value was not read from DefiLlama this run, so
    // publication must not claim it as a DefiLlama consensus observation nor date
    // it to the run clock (docs/pricing-pipeline.md#timestamp-semantics).
    expect(published?.consensusSources ?? []).not.toContain("defillama");
    expect(published?.agreeSources ?? []).not.toContain("defillama");
    expect(published?.priceObservedAt ?? null).not.toBe(syncStartSec);
    expect(published?.priceUpdatedAt ?? null).not.toBe(syncStartSec);
  });
});
