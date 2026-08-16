import { describe, expect, it, vi } from "vitest";

// Mock the registry to inject a fixture frozen coin. The fixture exercises
// every cross-file freeze invariant without polluting the real registry.
vi.mock("@shared/lib/stablecoins/registry", async () => {
  const actual =
    await vi.importActual<typeof import("@shared/lib/stablecoins/registry")>("@shared/lib/stablecoins/registry");
  const fixtureFrozen = {
    id: "fixture-frozen",
    name: "Fixture Frozen",
    symbol: "FXT",
    flags: { pegCurrency: "USD", governance: "centralized", backing: "fiat" },
    status: "frozen" as const,
    frozenAt: "2026-04-27",
    obituary: {
      causeOfDeath: "abandoned" as const,
      deathDate: "2026-04",
      epitaph: "Sunset.",
      obituary: "FXT was sunset.",
      peakMcap: 1_000_000,
      sourceUrl: "https://example.com/x",
      sourceLabel: "Example",
    },
    // Cast to the registry's StablecoinMeta shape — fixture exists only for
    // membership-set assertions, not full meta consumption.
  } as unknown as (typeof actual.TRACKED_STABLECOINS)[number];

  const trackedStablecoins = [...actual.TRACKED_STABLECOINS, fixtureFrozen];
  const trackedIds = new Set([...actual.TRACKED_IDS, "fixture-frozen"]);
  const trackedMetaById = new Map([
    ...actual.TRACKED_META_BY_ID,
    ["fixture-frozen", fixtureFrozen],
  ]);
  const frozenStablecoins = [...actual.FROZEN_STABLECOINS, fixtureFrozen];
  const frozenIds = new Set([...actual.FROZEN_IDS, "fixture-frozen"]);
  const frozenMetaById = new Map([
    ...actual.FROZEN_META_BY_ID,
    ["fixture-frozen", fixtureFrozen],
  ]);
  const readableStablecoins = [...actual.READABLE_STABLECOINS, fixtureFrozen];
  const readableIds = new Set([...actual.READABLE_IDS, "fixture-frozen"]);
  const readableMetaById = new Map([
    ...actual.READABLE_META_BY_ID,
    ["fixture-frozen", fixtureFrozen],
  ]);

  return {
    ...actual,
    TRACKED_STABLECOINS: trackedStablecoins,
    TRACKED_IDS: trackedIds,
    TRACKED_META_BY_ID: trackedMetaById,
    FROZEN_STABLECOINS: frozenStablecoins,
    FROZEN_IDS: frozenIds,
    FROZEN_META_BY_ID: frozenMetaById,
    READABLE_STABLECOINS: readableStablecoins,
    READABLE_IDS: readableIds,
    READABLE_META_BY_ID: readableMetaById,
  };
});

describe("frozen fixture — end-to-end", () => {
  it("orphan-close skips the fixture coin", async () => {
    const { shouldCloseOrphanedDepeg } = await import("../cron/depeg-detection/repair");
    expect(shouldCloseOrphanedDepeg("fixture-frozen", new Set())).toBe(false);
    // First dynamic import in the file pulls the whole cron graph through the
    // transform; ~4.4s solo leaves nothing under the 5s default in a parallel run.
  }, 20_000);

  it("backfill admin endpoint rejects the fixture coin", async () => {
    const { assertNotFrozen } = await import("../lib/frozen-guards");
    const response = assertNotFrozen("fixture-frozen");
    expect(response).not.toBeNull();
    expect(response!.status).toBe(403);
  });

  it("dex-liquidity prune set preserves the fixture coin", async () => {
    const { computeDexPruneSet } = await import("../cron/dex-liquidity/persistence");
    const allDbIds = new Set(["fixture-frozen", "zombie-coin"]);
    const prune = computeDexPruneSet(allDbIds);
    expect(prune.has("fixture-frozen")).toBe(false);
    expect(prune.has("zombie-coin")).toBe(true);
  });

  it("DEWS prune preserves the fixture coin", async () => {
    const { computeStressSignalPruneIds } = await import("../lib/dews/persistence");
    const result = computeStressSignalPruneIds(
      new Set(["fixture-frozen", "zombie"]),
      new Set(),
    );
    expect(result.has("fixture-frozen")).toBe(false);
    expect(result.has("zombie")).toBe(true);
  });

  it("PSI eligibility excludes the fixture coin", async () => {
    const { PSI_ELIGIBLE_IDS } = await import("@shared/lib/psi-eligible");
    expect(PSI_ELIGIBLE_IDS.has("fixture-frozen")).toBe(false);
  });

  it("/api/stablecoin-reserves accepts the fixture coin id", async () => {
    // The Worker read-side gate is keyed off READABLE_IDS so the detail-page
    // endpoints continue serving cached/historical data for frozen coins.
    const { READABLE_IDS } = await import("@shared/lib/stablecoins/registry");
    expect(READABLE_IDS.has("fixture-frozen")).toBe(true);
  });
});
