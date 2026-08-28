import type { Page, Route } from "@playwright/test";
import { summarizeDdrrRows } from "../../../shared/lib/depeg-resolver-review/summary";
import { makeYieldRanking } from "../../../shared/test-utils/yield-ranking-fixtures";
import { projectYieldRankingsSummary } from "../../../shared/lib/yield-rankings-summary";
import {
  DepegEventsResponseSchema,
  PegSummaryResponseSchema,
  StablecoinListResponseSchema,
  StressSignalsAllResponseSchema,
} from "../../../shared/types/market";
import { DdrResponseSchema } from "../../../shared/types/depeg-resolver";
import { DdrrResponseSchema } from "../../../shared/types/depeg-resolver-review";
import { YieldAdapterManifestResponseSchema } from "../../../shared/types/yield";
import { YieldRankingsSummaryResponseSchema } from "../../../shared/types/yield-summary";

type HydratedFixtureSet = "depeg" | "yield";

const FIXTURE_NOW = Math.floor(Date.now() / 1000);
const METHODOLOGY = {
  version: "fixture-v1",
  versionLabel: "Fixture v1",
  currentVersion: "fixture-v1",
  currentVersionLabel: "Fixture v1",
  changelogPath: "/methodology/depeg-changelog/",
  asOf: FIXTURE_NOW,
  isCurrent: true,
} as const;

const stablecoins = StablecoinListResponseSchema.parse({
  peggedAssets: [
    {
      id: "usdt-tether",
      name: "Tether",
      symbol: "USDT",
      geckoId: "tether",
      pegType: "peggedUSD",
      pegMechanism: "fiat-backed",
      price: 1,
      priceSource: "fixture",
      circulating: { peggedUSD: 100_000_000_000 },
      circulatingPrevDay: { peggedUSD: 100_000_000_000 },
      circulatingPrevWeek: { peggedUSD: 99_000_000_000 },
      circulatingPrevMonth: { peggedUSD: 98_000_000_000 },
      chainCirculating: {},
      chains: [],
    },
  ],
});

const pegSummary = PegSummaryResponseSchema.parse({
  coins: [
    {
      id: "usdt-tether",
      symbol: "USDT",
      name: "Tether",
      pegType: "peggedUSD",
      pegCurrency: "USD",
      governance: "centralized",
      currentDeviationBps: -8,
      pegScore: 99,
      pegPct: 99.92,
      severityScore: 8,
      spreadPenalty: 0,
      eventCount: 1,
      worstDeviationBps: -120,
      activeDepeg: false,
      lastEventAt: FIXTURE_NOW - 3_600,
      trackingSpanDays: 365,
      methodologyVersion: METHODOLOGY.version,
    },
  ],
  summary: {
    activeDepegCount: 0,
    medianDeviationBps: 8,
    worstCurrent: { id: "usdt-tether", symbol: "USDT", bps: -8 },
    coinsAtPeg: 1,
    totalTracked: 1,
    depegEventsToday: 0,
    depegEventsYesterday: 1,
  },
  methodology: METHODOLOGY,
});

const stressSignals = StressSignalsAllResponseSchema.parse({
  signals: {
    "usdt-tether": {
      score: 12,
      band: "CALM",
      signals: { peg: { value: 8, available: true } },
      computedAt: FIXTURE_NOW,
      methodologyVersion: METHODOLOGY.version,
      ageClassification: "fresh",
    },
  },
  updatedAt: FIXTURE_NOW,
  eligibleCount: 1,
  computedCount: 1,
  missingCount: 0,
  oldestComputedAt: FIXTURE_NOW,
  coverageRatio: 1,
  malformedRows: 0,
  coverageStatus: "ok",
  coverageReasons: [],
  methodology: METHODOLOGY,
});

const depegEvents = DepegEventsResponseSchema.parse({
  events: [
    {
      id: 1,
      stablecoinId: "usdt-tether",
      symbol: "USDT",
      pegType: "peggedUSD",
      direction: "below",
      peakDeviationBps: -120,
      startedAt: FIXTURE_NOW - 7_200,
      endedAt: FIXTURE_NOW - 3_600,
      startPrice: 0.999,
      peakPrice: 0.988,
      recoveryPrice: 1,
      pegReference: 1,
      source: "live",
    },
  ],
  total: 1,
  totalExact: true,
  nextCursor: null,
  pending: [],
  methodology: METHODOLOGY,
});

const depegResolver = DdrResponseSchema.parse({
  _meta: {
    schemaVersion: 2,
    dataAsOf: FIXTURE_NOW,
    modelAsOf: FIXTURE_NOW,
    computedAt: FIXTURE_NOW,
    expiresAt: FIXTURE_NOW + 1_800,
    snapshotToken: null,
    snapshotGeneration: null,
    publicPredictionIds: [],
    publicPredictionRowHashes: {},
    basePayloadHash: null,
    readOverlay: {
      degradedLockDeferralIncidentKeys: [],
      closedPendingReviewIncidentKeys: [],
      suppressedIncidentKeys: [],
    },
    degraded: false,
    degradedReason: null,
    publicWarning: "Fixture forecast data. Not investment advice or a credit rating.",
    resolutionRubricVersion: "fixture-v1",
    durationModelVersion: "fixture-v1",
    incidentGroupingVersion: "fixture-v1",
    supportRulesVersion: "fixture-v1",
    lineage: null,
  },
  rows: [],
  methodology: METHODOLOGY,
});

const depegResolverReview = DdrrResponseSchema.parse({
  _meta: {
    computedAt: FIXTURE_NOW,
    expiresAt: FIXTURE_NOW + 1_800,
    degraded: false,
    degradedReason: null,
    reviewerVersion: "fixture-v1",
    publicWarning: "Fixture review data.",
    assessedEventCount: 0,
    reviewedEventCount: 0,
    pendingEventCount: 0,
    durationScoredCount: 0,
    verdictScoredCount: 0,
    assessmentRowLimit: 20_000,
    assessmentRowsTruncated: false,
    incidentRowLimit: 20_000,
    incidentRowsTruncated: false,
    publicRowLimit: 100,
    publicRowsTruncated: false,
    methodologyVersions: [],
  },
  summary: summarizeDdrrRows([]),
  rows: [],
  methodology: METHODOLOGY,
});

const benchmark = {
  key: "USD",
  label: "USD 3M T-Bill",
  currency: "USD",
  rate: 4.25,
  recordDate: "2026-07-09",
  fetchedAt: FIXTURE_NOW,
  ageSeconds: 0,
  source: "fixture",
  isFallback: false,
  fallbackMode: null,
  isProxy: false,
} as const;

const yieldRankings = YieldRankingsSummaryResponseSchema.parse({
  ...projectYieldRankingsSummary({
    rankings: [makeYieldRanking()],
    riskFreeRate: benchmark.rate,
    benchmarks: { USD: benchmark },
    scalingFactor: 1,
    medianApy: 5,
    updatedAt: FIXTURE_NOW,
    warnings: [],
  }),
  _meta: { updatedAt: FIXTURE_NOW, ageSeconds: 0, status: "fresh" },
});

const yieldAdapterManifest = YieldAdapterManifestResponseSchema.parse({
  methodologyVersion: "fixture-v1",
  updatedAt: FIXTURE_NOW,
  entries: [],
});

const FIXTURES: Record<HydratedFixtureSet, ReadonlyMap<string, unknown>> = {
  depeg: new Map<string, unknown>([
    ["/api/depeg-events", depegEvents],
    ["/api/depeg-resolver", depegResolver],
    ["/api/depeg-resolver-review", depegResolverReview],
    ["/api/peg-summary", pegSummary],
    ["/api/stablecoins", stablecoins],
    ["/api/stress-signals", stressSignals],
  ]),
  yield: new Map<string, unknown>([
    ["/api/yield-adapter-manifest", yieldAdapterManifest],
    ["/api/yield-rankings", yieldRankings],
  ]),
};

function canonicalApiPath(url: URL): string {
  return url.pathname.startsWith("/_site-data/") ? `/api${url.pathname.slice("/_site-data".length)}` : url.pathname;
}

async function fulfillFixture(route: Route, fixtures: ReadonlyMap<string, unknown>): Promise<void> {
  const url = new URL(route.request().url());
  const path = canonicalApiPath(url);
  const payload = fixtures.get(path);
  if (payload === undefined || (path === "/api/yield-rankings" && url.searchParams.get("projection") !== "summary")) {
    await route.fallback();
    return;
  }

  await route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      "X-Data-Age": "0",
    },
    body: JSON.stringify(payload),
  });
}

export async function installHydratedApiFixtures(page: Page, fixtureSet: HydratedFixtureSet): Promise<void> {
  const fixtures = FIXTURES[fixtureSet];
  const handler = (route: Route) => fulfillFixture(route, fixtures);
  await page.route("**/api/**", handler);
  await page.route("**/_site-data/**", handler);
}
