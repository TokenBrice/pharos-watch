/**
 * 24-cell template-coverage matrix (8 live LowestSubDimensionKeys × 3 profiles).
 *
 * Per plan §10 (Milestone 10) the MVP target is the full live `(key × profile)`
 * matrix; contextKey-refined templates are post-MVP. The three axes retired at
 * `selector-v2.0` (`dependencyRisk`, `collateralQuality`, `custodyModel`) keep
 * their slot in `LOWEST_SUB_DIMENSION_KEYS` for stored snapshots but no longer
 * carry template cells.
 */
import { describe, expect, it } from "vitest";
import {
  LOWEST_SUB_DIMENSION_KEYS,
  SELECTOR_PROFILES,
  type LowestSubDimension,
  type MergedRow,
} from "../types";
import { makeMergedRowWithIdentity } from "./fixture";
import { getTemplate, renderWatchText } from "../what-to-watch-templates";
import type { LiveWatchKey } from "../what-to-watch-templates";

const RETIRED_WATCH_KEYS = ["dependencyRisk", "collateralQuality", "custodyModel"] as const;

const LIVE_WATCH_KEYS = LOWEST_SUB_DIMENSION_KEYS.filter(
  (key): key is LiveWatchKey =>
    !(RETIRED_WATCH_KEYS as readonly string[]).includes(key),
);

function makeRow(overrides: Partial<MergedRow> = {}): MergedRow {
  return makeMergedRowWithIdentity({ id: "watch-row", symbol: "WATCH", name: "Watch Row" }, {
    protocolSlug: "watch",
    mechanismArchetype: "cdp",
    pegScore: 95,
    currentDeviationBps: 5,
    safetyResilienceScore: 85,
    safetyScore: 90,
    safetyLiquidityScore: 78,
    effectiveTvlUsd: 100_000_000,
    apyVariance30d: 0.4,
    yieldProtocolSlug: "watch",
    yieldVenueChain: "ethereum",
    yieldFreshness: { capturedAt: 0, ageSeconds: 60 },
    pegSummaryAgeSec: 60,
    dexTvlAgeSec: 60,
    dewsAgeSec: 60,
    ...overrides,
  });
}

function lowest(
  key: LowestSubDimension["key"],
  contextKeys: LowestSubDimension["contextKeys"] = [],
): LowestSubDimension {
  return { key, score: 40, contextKeys };
}

describe("template coverage", () => {
  it("every live (key × profile) cell has a non-fallback template", () => {
    const gaps: string[] = [];
    for (const profile of SELECTOR_PROFILES) {
      for (const key of LIVE_WATCH_KEYS) {
        const template = getTemplate(key, profile);
        if (template == null) {
          gaps.push(`${profile} × ${key}`);
        }
      }
    }
    expect(gaps).toEqual([]);
  });

  it("prioritizes the selected peg warning over recent listing and other warnings", () => {
    const selected = lowest("pegStability", ["current-deviation", "recent-listing", "depeg-history"]);
    const row = makeRow({ currentDeviationBps: -64 });
    const expected = renderWatchText(selected, "trading", row);
    expect(expected).toMatch(/\b64\b/);
    expect(renderWatchText(selected, "trading", {
      ...row, isRecentListing: true, depegEventCount: 3, canBeBlacklisted: true,
    })).toBe(expected);
    expect(renderWatchText(lowest("resilience"), "trading", {
      ...row, isRecentListing: true,
    })).not.toBe(expected);
  });
});
