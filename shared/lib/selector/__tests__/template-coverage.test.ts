/**
 * 33-cell template-coverage matrix (11 LowestSubDimensionKeys × 3 profiles).
 *
 * Per plan §10 (Milestone 10) the MVP target is the 33-cell `(key × profile)`
 * matrix; contextKey-refined templates are post-MVP.
 */
import { describe, expect, it } from "vitest";
import {
  LOWEST_SUB_DIMENSION_KEYS,
  SELECTOR_PROFILES,
  type LowestSubDimension,
  type MergedRow,
} from "../types";
import { getTemplate, renderWatchText, TEMPLATES } from "../what-to-watch-templates";

function makeRow(overrides: Partial<MergedRow> = {}): MergedRow {
  return {
    id: "watch-row",
    symbol: "WATCH",
    name: "Watch Row",
    protocolSlug: "watch",
    variantOf: null,
    isYieldBearing: false,
    pegCurrency: "USD",
    lifecycle: "active",
    governance: "decentralized",
    canBeBlacklisted: false,
    mechanismArchetype: "cdp",
    supplyUsd: 1_000_000_000,
    pegScore: 95,
    activeDepeg: false,
    currentDeviationBps: 5,
    depegEventCount: 0,
    lastEventAt: null,
    dewsScore: 20,
    safetyGrade: "A",
    safetyScore: 90,
    safetyResilienceScore: 85,
    safetyDecentralizationScore: 80,
    safetyLiquidityScore: 78,
    custodyModel: "onchain",
    bluechipGrade: "A",
    liquidityScore: 80,
    effectiveTvlUsd: 100_000_000,
    concentrationHhi: 0.2,
    chainTvl: { ethereum: 100_000_000 },
    effectiveExitScore: 82,
    pharosYieldScore: 80,
    apy30d: 5,
    apyVariance30d: 0.4,
    benchmarkRate: 4.5,
    sourceRiskScore: 20,
    venueRiskTier: "low",
    warningSignals: [],
    deploymentPlace: "native-wrapper",
    sourceSwitch: false,
    yieldProtocolSlug: "watch",
    yieldVenueChain: "ethereum",
    yieldHistoryDays: 365,
    yieldFreshness: { capturedAt: 0, ageSeconds: 60 },
    trackingSpanDays: 365,
    isRecentListing: false,
    pegSummaryAgeSec: 60,
    dexTvlAgeSec: 60,
    dewsAgeSec: 60,
    ...overrides,
  };
}

function lowest(
  key: LowestSubDimension["key"],
  contextKeys: LowestSubDimension["contextKeys"] = [],
): LowestSubDimension {
  return { key, score: 40, contextKeys };
}

describe("template coverage", () => {
  it("every (key × profile) cell has a non-fallback template", () => {
    const gaps: string[] = [];
    for (const profile of SELECTOR_PROFILES) {
      for (const key of LOWEST_SUB_DIMENSION_KEYS) {
        const template = getTemplate(key, profile);
        if (template == null) {
          gaps.push(`${profile} × ${key}`);
        }
      }
    }
    expect(gaps).toEqual([]);
  });

  it("matrix size = 33 cells", () => {
    let count = 0;
    for (const profile of SELECTOR_PROFILES) {
      const row = TEMPLATES[profile];
      for (const key of LOWEST_SUB_DIMENSION_KEYS) {
        if (row[key] != null) count += 1;
      }
    }
    expect(count).toBe(33);
  });

  it("oneLineExplanation prose stays under 100 chars (design §2.7 + buffer)", () => {
    const tooLong: string[] = [];
    for (const profile of SELECTOR_PROFILES) {
      for (const key of LOWEST_SUB_DIMENSION_KEYS) {
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
        lowest("custodyModel"),
        "treasury",
        makeRow({ custodyModel: "institutional-regulated" }),
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
      "Custody depends on one institutional rail; counterparty exposure is concentrated.",
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
