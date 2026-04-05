// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  formatTreasuryUsd,
  formatTreasuryUsdNullable,
  formatTreasuryPct,
  denominatorStatusLabel,
  denominatorStatusClassName,
  coverageSummary,
  sortTreasuryExposureEntities,
} from "@/lib/treasury-table-utils";
import type { TreasuryStableExposureEntity } from "@shared/types";

function makeEntity(
  overrides: Partial<TreasuryStableExposureEntity> & { slug: string; name: string },
): TreasuryStableExposureEntity {
  return {
    protocolId: overrides.slug,
    slug: overrides.slug,
    name: overrides.name,
    category: overrides.category ?? "Protocol treasury",
    source: "defillama-github",
    adapterFile: null,
    chains: ["ethereum"],
    directWalletUsd: overrides.directWalletUsd ?? 1_000_000,
    treasuryUsd: overrides.treasuryUsd ?? 1_000_000,
    stablecoinSleeveUsd: overrides.stablecoinSleeveUsd ?? 500_000,
    trackedStableUsd: overrides.trackedStableUsd ?? 400_000,
    decentralizedStableUsd: overrides.decentralizedStableUsd ?? 200_000,
    decentralizedStablePctOfTreasury: overrides.decentralizedStablePctOfTreasury ?? 20,
    decentralizedStablePctOfStableSleeve: overrides.decentralizedStablePctOfStableSleeve ?? 40,
    weightedSafetyScore: overrides.weightedSafetyScore ?? 75,
    weightedSafetyGrade: overrides.weightedSafetyGrade ?? "B",
    governanceBuckets: overrides.governanceBuckets ?? {
      centralizedUsd: 200_000,
      centralizedDependentUsd: 0,
      decentralizedUsd: 200_000,
    },
    holdings: overrides.holdings ?? [],
    coverage: overrides.coverage ?? {
      extractionMode: "static-seeded",
      ownerCount: 1,
      ownerChainCount: 1,
      denominatorStatus: "direct-only",
      directWalletUsd: 1_000_000,
      defiPositionUsd: 0,
      consumedDirectBalanceUsd: 0,
      trackedStableUsd: 400_000,
      stablecoinSleeveUsd: 500_000,
      untrackedStableUsd: 100_000,
      derivedUntrackedStableUsd: 0,
      ratedTrackedStableUsd: 400_000,
      trackedStablePctOfTreasury: 40,
      trackedStablePctOfStableSleeve: 80,
      ratedTrackedStablePct: 100,
      untrackedStableCount: 1,
      derivedUntrackedStableCount: 0,
      skippedDerivedPositionCount: 0,
      notes: [],
    },
  };
}

describe("treasury-table-utils", () => {
  describe("formatTreasuryUsd", () => {
    it("formats positive values as compact USD", () => {
      expect(formatTreasuryUsd(1_234_567)).toBe("$1,234,567");
    });

    it("formats zero", () => {
      expect(formatTreasuryUsd(0)).toBe("$0");
    });
  });

  describe("formatTreasuryUsdNullable", () => {
    it("returns N/A for null", () => {
      expect(formatTreasuryUsdNullable(null)).toBe("N/A");
    });

    it("formats number values", () => {
      expect(formatTreasuryUsdNullable(500)).toBe("$500");
    });
  });

  describe("formatTreasuryPct", () => {
    it("returns N/A for null", () => {
      expect(formatTreasuryPct(null)).toBe("N/A");
    });

    it("formats percentage with one decimal", () => {
      expect(formatTreasuryPct(12.34)).toBe("12.3%");
    });
  });

  describe("denominatorStatusLabel", () => {
    it("maps adjusted-with-defi to Treasury-comparable", () => {
      const entity = makeEntity({
        slug: "x",
        name: "X",
        coverage: {
          ...makeEntity({ slug: "x", name: "X" }).coverage,
          denominatorStatus: "adjusted-with-defi",
        },
      });
      expect(denominatorStatusLabel(entity)).toBe("Treasury-comparable");
    });

    it("maps partial to Partial denominator", () => {
      const entity = makeEntity({
        slug: "x",
        name: "X",
        coverage: {
          ...makeEntity({ slug: "x", name: "X" }).coverage,
          denominatorStatus: "partial",
        },
      });
      expect(denominatorStatusLabel(entity)).toBe("Partial denominator");
    });

    it("maps invalid to Invalid denominator", () => {
      const entity = makeEntity({
        slug: "x",
        name: "X",
        coverage: {
          ...makeEntity({ slug: "x", name: "X" }).coverage,
          denominatorStatus: "invalid",
        },
      });
      expect(denominatorStatusLabel(entity)).toBe("Invalid denominator");
    });

    it("maps direct-only to Direct-only denominator", () => {
      const entity = makeEntity({ slug: "x", name: "X" });
      expect(denominatorStatusLabel(entity)).toBe("Direct-only denominator");
    });
  });

  describe("coverageSummary", () => {
    it("returns invalid message for invalid status", () => {
      const entity = makeEntity({
        slug: "x",
        name: "X",
        coverage: {
          ...makeEntity({ slug: "x", name: "X" }).coverage,
          denominatorStatus: "invalid",
        },
      });
      expect(coverageSummary(entity)).toBe("Invalid treasury denominator");
    });

    it("returns tracked percentage for valid status", () => {
      const entity = makeEntity({ slug: "x", name: "X" });
      expect(coverageSummary(entity)).toBe("Tracked 80.0% of stable sleeve");
    });
  });

  describe("sortTreasuryExposureEntities", () => {
    it("sorts by decentralizedStableUsd descending by default", () => {
      const a = makeEntity({ slug: "a", name: "A", decentralizedStableUsd: 100 });
      const b = makeEntity({ slug: "b", name: "B", decentralizedStableUsd: 500 });
      const sorted = sortTreasuryExposureEntities([a, b], "decentralizedStableUsd");
      expect(sorted[0]!.slug).toBe("b");
      expect(sorted[1]!.slug).toBe("a");
    });

    it("breaks ties alphabetically by name", () => {
      const a = makeEntity({ slug: "a", name: "Alpha", decentralizedStableUsd: 100 });
      const b = makeEntity({ slug: "b", name: "Beta", decentralizedStableUsd: 100 });
      const sorted = sortTreasuryExposureEntities([a, b], "decentralizedStableUsd");
      expect(sorted[0]!.slug).toBe("a");
      expect(sorted[1]!.slug).toBe("b");
    });

    it("sorts by weightedSafetyScore descending", () => {
      const a = makeEntity({ slug: "a", name: "A", weightedSafetyScore: 60 });
      const b = makeEntity({ slug: "b", name: "B", weightedSafetyScore: 90 });
      const sorted = sortTreasuryExposureEntities([a, b], "weightedSafetyScore");
      expect(sorted[0]!.slug).toBe("b");
    });
  });
});
