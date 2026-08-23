/**
 * 24-cell template-coverage matrix (8 live LowestSubDimensionKeys × 3 profiles).
 *
 * Per plan §10 (Milestone 10) the MVP target is the full live `(key × profile)`
 * matrix; contextKey-refined templates are post-MVP. The three axes retired at
 * `selector-v2.0` (`dependencyRisk`, `collateralQuality`, `custodyModel`) keep
 * their slot in `LOWEST_SUB_DIMENSION_KEYS` for stored snapshots but no longer
 * carry template cells; the assertions below pin that they resolve to `null`.
 */
import { describe, expect, it } from "vitest";
import {
  LOWEST_SUB_DIMENSION_KEYS,
  SELECTOR_PROFILES,
  type LowestSubDimension,
  type MergedRow,
} from "../types";
import { makeMergedRow } from "./fixture";
import { getTemplate, renderWatchText, TEMPLATES } from "../what-to-watch-templates";
import type { LiveWatchKey } from "../what-to-watch-templates";

const RETIRED_WATCH_KEYS = ["dependencyRisk", "collateralQuality", "custodyModel"] as const;

const LIVE_WATCH_KEYS = LOWEST_SUB_DIMENSION_KEYS.filter(
  (key): key is LiveWatchKey =>
    !(RETIRED_WATCH_KEYS as readonly string[]).includes(key),
);

function makeRow(overrides: Partial<MergedRow> = {}): MergedRow {
  return makeMergedRow({
    id: "watch-row",
    symbol: "WATCH",
    name: "Watch Row",
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

  it("retired axes resolve to null in every profile", () => {
    for (const profile of SELECTOR_PROFILES) {
      for (const key of RETIRED_WATCH_KEYS) {
        expect(getTemplate(key, profile)).toBeNull();
      }
    }
  });

  it("matrix size = 24 cells", () => {
    let count = 0;
    for (const profile of SELECTOR_PROFILES) {
      const row = TEMPLATES[profile];
      for (const key of LIVE_WATCH_KEYS) {
        if (row[key] != null) count += 1;
      }
    }
    expect(count).toBe(24);
  });

  it("oneLineExplanation prose stays under 100 chars (design §2.7 + buffer)", () => {
    const tooLong: string[] = [];
    for (const profile of SELECTOR_PROFILES) {
      for (const key of LIVE_WATCH_KEYS) {
        const text = TEMPLATES[profile][key].oneLineExplanation;
        if (text.length > 100) {
          tooLong.push(`${profile}/${key}: ${text.length} chars`);
        }
      }
    }
    expect(tooLong).toEqual([]);
  });

  it("renders row-specific watch text without exposing raw keys", () => {
    const cases = [
      renderWatchText(
        lowest("activeDepegHistory", ["depeg-history"]),
        "treasury",
        makeRow({ depegEventCount: 3 }),
      ),
      renderWatchText(
        lowest("pegStability", ["current-deviation"]),
        "trading",
        makeRow({ currentDeviationBps: -64 }),
      ),
      renderWatchText(
        lowest("governanceOverride"),
        "treasury",
        makeRow({ canBeBlacklisted: true }),
      ),
      renderWatchText(
        lowest("sourceRisk"),
        "yield",
        makeRow({ sourceRiskScore: 72, venueRiskTier: "high" }),
      ),
      renderWatchText(
        lowest("liquidity", ["thin-tvl"]),
        "yield",
        makeRow({ warningSignals: ["thin-tvl"], effectiveTvlUsd: 10_000_000 }),
      ),
      renderWatchText(
        lowest("decentralization"),
        "trading",
        makeRow({ governance: "centralized" }),
      ),
      renderWatchText(lowest("resilience"), "treasury", makeRow({ isRecentListing: true })),
    ];

    expect(cases).toEqual([
      "Depeg log shows 3 events; keep PegScore and peg history in view.",
      "Current peg is 64 bps off; compare against the tolerance setting.",
      "Freeze or supply controls exist; review issuer permissions before routing.",
      "Yield route carries elevated source risk; check venue depth before sizing.",
      "Yield venue depth is thin; size the route against source TVL.",
      "Governance is centralized; admin decisions can change transfer rules.",
      "Recent listing; compare fresh readings before sizing.",
    ]);
    for (const text of cases) {
      expect(text).not.toMatch(/depeg-event-count|thin-tvl|sourceRiskScore|canBeBlacklisted|top-|strong-|weak-/);
    }
  });
});
