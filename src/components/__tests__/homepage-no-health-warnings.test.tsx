// @vitest-environment jsdom

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { Suspense, lazy, type ComponentType, type ReactNode } from "react";
import { act, cleanup, render as rtlRender, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { HomeAltDdrOverview } from "@/components/home-alt-ddr-overview";
import { HomeAltHero } from "@/components/home-alt-hero";
import { HomeAltHeroLiveChart } from "@/components/home-alt-hero-live-chart";
import { HomeAltRankingsSection } from "@/components/home-alt-rankings-section";
import { HomeAltStatusTelegram } from "@/components/home-alt-status-telegram";
import { HomeAltUpcomingHorizonConstellation } from "@/components/home-alt-upcoming-horizon-constellation";
import { HomeAltYieldOverview } from "@/components/home-alt-yield-overview";
import { ActiveDepegsCard } from "@/components/home-alt-mini-cards/active-depegs-card";
import { DailyDigestCard } from "@/components/home-alt-mini-cards/daily-digest-card";
import { MintBurnCard } from "@/components/home-alt-mini-cards/mint-burn-card";
import { PegHealthCard } from "@/components/home-alt-mini-cards/peg-health-card";
import { PsiBandCard } from "@/components/home-alt-mini-cards/psi-band-card";
import { RecentFreezesCard } from "@/components/home-alt-mini-cards/recent-freezes-card";
import { SupplyMovesCard } from "@/components/home-alt-mini-cards/supply-moves-card";
import { HomeSectionErrorBoundary } from "@/components/home-section-error-boundary";
import { RegimeBar } from "@/components/regime-bar";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import type { ApiMeta } from "@/lib/api";
import { makeMintBurnFlowCoin } from "@/test-utils/mint-burn-fixtures";
import { buildLiveHomepageHeroSnapshot } from "@shared/lib/homepage-hero-snapshot";
import { makeStablecoin } from "@shared/test-utils/stablecoin";

// Owner rule (docs/homepage.md#data-health): the homepage never renders
// data-health warnings. Data renders as-is; no data is a neutral placeholder.
// Every section renders with its real shared descendants (next/dynamic is
// resolved, not stubbed), so a warning added inside a shared component that
// the homepage renders fails here even though lint only sees direct imports.

const hooks = vi.hoisted(() => ({
  useActiveDepegEvents: vi.fn(),
  useBlacklistEventsPage: vi.fn(),
  useBlacklistSummary: vi.fn(),
  useDepegResolverSurfaces: vi.fn(),
  useDexLiquidityTable: vi.fn(),
  useDigestPromo: vi.fn(),
  useHomepageHistory: vi.fn(),
  useHomepageSnapshot: vi.fn(),
  useMintBurnFlows: vi.fn(),
  usePegSummary: vi.fn(),
  useReportCardsV9Table: vi.fn(),
  useStabilityIndex: vi.fn(),
  useStablecoins: vi.fn(),
  useTelegramPulse: vi.fn(),
  useYieldRankingsSummary: vi.fn(),
}));
vi.mock("@/hooks/api-hooks", () => ({
  useDexLiquidityTable: hooks.useDexLiquidityTable,
  useDigestPromo: hooks.useDigestPromo,
  useHomepageHistory: hooks.useHomepageHistory,
  useHomepageSnapshot: hooks.useHomepageSnapshot,
  usePegSummary: hooks.usePegSummary,
  useReportCardsV9Table: hooks.useReportCardsV9Table,
  useStabilityIndex: hooks.useStabilityIndex,
  useTelegramPulse: hooks.useTelegramPulse,
  useYieldRankingsSummary: hooks.useYieldRankingsSummary,
}));
vi.mock("@/hooks/use-blacklist-events", () => ({
  useBlacklistEventsPage: hooks.useBlacklistEventsPage,
  useBlacklistSummary: hooks.useBlacklistSummary,
}));
vi.mock("@/hooks/use-depeg-events", () => ({ useActiveDepegEvents: hooks.useActiveDepegEvents }));
vi.mock("@/hooks/use-depeg-resolver-surfaces", () => ({ useDepegResolverSurfaces: hooks.useDepegResolverSurfaces }));
vi.mock("@/hooks/use-mint-burn-flows", () => ({ useMintBurnFlows: hooks.useMintBurnFlows }));
vi.mock("@/hooks/use-stablecoins", () => ({ useStablecoins: hooks.useStablecoins }));
vi.mock("@/hooks/use-home-alt-filters", () => ({
  useHomeAltFilters: () => ({ activeFilters: [], activeUniverse: "catalog", setActiveUniverse: vi.fn() }),
}));
vi.mock("@/hooks/use-pinned-stablecoins", () => ({ usePinnedStablecoins: () => ({ pinnedIds: [], togglePinned: vi.fn() }) }));
vi.mock("@/hooks/use-hydrated", () => ({ useHydrated: () => true }));
vi.mock("@/components/home-alt-hero-chart-gate", () => ({ HomeAltHeroChartGate: () => <div /> }));
vi.mock("@/lib/analytics", () => ({ trackFreshDataReady: vi.fn() }));
vi.mock("@/lib/fonts/digest", () => ({ digestDisplay: { className: "digest-font" } }));
vi.mock("@/lib/logos", () => ({ logosById: {}, getLogoSrc: () => undefined }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/image", () => ({
  default: ({ alt = "", ...props }: React.ImgHTMLAttributes<HTMLImageElement>) => <img alt={alt} {...props} />,
}));
// Resolve dynamic imports for real so shared descendants (e.g. StablecoinTable) render.
vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<unknown>) => {
    const Lazy = lazy(async () => {
      const loaded = (await loader()) as { default?: ComponentType<object> } | ComponentType<object>;
      return { default: (typeof loaded === "object" && loaded && "default" in loaded ? loaded.default : loaded) as ComponentType<object> };
    });
    return function Dynamic(props: object) {
      return <Suspense fallback={null}><Lazy {...props} /></Suspense>;
    };
  },
}));

// Shared descendants may own extra queries; they stay idle (no network in tests).
function render(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const NOW = Date.parse("2026-10-10T12:00:00Z");
const NOW_SEC = NOW / 1000;
const WARNING_COPY =
  /data quality warning|quality check|refresh failed|last successful update|\bstale\b|degraded|retained|freshness unavailable|temporarily unavailable|older snapshot|saved data|initial data|retry|try again|ratings are held|warnings?\b/i;

const HEALTH_TONE =
  /bg-state-warn-subtle|border-state-warn(?=[\s"])|bg-state-warn-solid\/15|text-state-warn-(ink|strong)|state-danger-subtle|bg-amber-500\/(8|15)\b|border-amber-500\/30|text-amber-800/;

type HealthCase = { label: string; meta: ApiMeta | undefined; error: Error | null; hasData: boolean };
const CASES: HealthCase[] = [
  { label: "stale producer", meta: { updatedAt: NOW_SEC - 7 * 86_400, ageSeconds: 7 * 86_400, status: "stale" }, error: null, hasData: true },
  {
    label: "source degradation",
    meta: { updatedAt: NOW_SEC, ageSeconds: 0, status: "degraded", warning: "199 pharos source degraded",
      dependencies: { source: { updatedAt: NOW_SEC - 86_400, ageSeconds: 86_400, status: "stale" } } },
    error: null,
    hasData: true,
  },
  { label: "failed refresh with retained data", meta: { updatedAt: NOW_SEC - 60, ageSeconds: 60, status: "fresh" }, error: new Error("refresh failed"), hasData: true },
  { label: "503 unavailable", meta: undefined, error: new Error("503"), hasData: false },
];

// --- fixtures ---------------------------------------------------------------

const stablecoins = {
  peggedAssets: [makeStablecoin({
    id: "usdc-circle", name: "USD Coin", symbol: "USDC",
    circulating: { peggedUSD: 20_000_000 }, circulatingPrevWeek: { peggedUSD: 10_000_000 },
  })],
};
const pegSummary = {
  coins: [{ id: "usdc-circle", activeDepeg: true, currentDeviationBps: -75 }],
  summary: { activeDepegCount: 1, coinsAtPeg: 0, medianDeviationBps: 75, totalTracked: 1 },
};
const activeEvents = { events: [{ id: 1, stablecoinId: "usdc-circle", symbol: "USDC", startedAt: NOW_SEC - 100 }] };
const psi = {
  current: {
    avg24h: 39, avg24hBand: "BEDROCK", band: "BEDROCK", components: { breadth: 1, severity: 1, stressBreadth: 1, trend: 1 },
    computedAt: NOW_SEC - 7 * 86_400, contributors: [], methodologyVersion: "test", score: 40, totalMcapUsd: 1,
  },
  history: [{ date: NOW_SEC - 8 * 86_400, score: 38, band: "BEDROCK", methodologyVersion: "test" }],
};
const flows = { coins: [makeMintBurnFlowCoin({ has24hActivity: true, netFlow24hUsd: 1_000_000 })], gauge: { band: "MINTING", score: 10 } };
const freezes = { events: [{ amountUsdAtEvent: 1_000, eventType: "blacklist", id: "f-1", stablecoin: "USDC", stablecoinId: "usdc-circle", timestamp: NOW_SEC - 60 }] };
const freezeSummary = {
  stats: {
    recentFreezeCount24h: 1, recentFreezeCount7d: 1, recentFreezeAmount24hUsd: 1_000, recentFreezeAmount7dUsd: 1_000,
    valuationCoverage: { recent24h: { knownCount: 1, unavailableCount: 0 }, recent7d: { knownCount: 1, unavailableCount: 0 } },
  },
};
const yieldRow = (id: string, symbol: string, apy: number, pys: number) => ({
  id, symbol, name: `${symbol} Stablecoin`, currentApy: apy, apy30d: apy, yieldSource: "Compound V3",
  yieldType: "lending-opportunity", dataSource: "protocol-api", sourceTvlUsd: 1_000_000, pharosYieldScore: pys,
  pysNullReason: null, safetyScore: 80, safetyGrade: "B+", benchmarkKey: "USD", benchmarkLabel: "USD 3M T-Bill",
  benchmarkRate: 4, yieldStability: 0.9, apyMin30d: 3, apyMax30d: 6, warningSignals: [], alternateSourceCount: 0, altSources: [],
});
const yieldSummary = {
  projection: "summary", rankings: [yieldRow("usdc-circle", "USDC", 4.2, 61), yieldRow("usdt-tether", "USDT", 3.1, 55)],
  riskFreeRate: 4, benchmarks: {}, scalingFactor: 8, medianApy: 3.65, updatedAt: NOW_SEC,
  provenance: { safetySnapshot: { coveredCount: 2, trackedCount: 3 } },
  warnings: [{ code: "benchmark-unavailable", message: "USD reference evidence unavailable", reasons: ["reference-source-missing"] }],
};
const historyRows = [0, 1, 2].map((index) => ({
  ts: NOW - (3 - index) * 86_400_000, total: 100 + index, usdt: 60, usdc: 20, sky: 10, others: 10 + index, nonUsd: 1,
}));
const digestPromo = { latest: { digestTitle: "USDT sheds", editionNumber: 9, excerpt: "Excerpt." }, previousEditions: [] };

function query<T>(c: HealthCase, data: T) {
  return {
    data: c.hasData ? data : undefined,
    dataUpdatedAt: c.hasData ? NOW : 0,
    error: c.error,
    isError: c.error !== null && !c.hasData,
    isLoading: false,
    meta: c.meta,
    refetch: vi.fn(),
  };
}

function configure(c: HealthCase) {
  const stale = c.meta?.status !== "fresh";
  const ddrMeta = { computedAt: NOW_SEC - 3_600, degraded: stale, degradedReason: stale ? "stale-cache" : null };
  const laneMeta = c.meta ?? { updatedAt: null, ageSeconds: null, status: "unknown" as const, reason: "missing-generation" };
  hooks.useStablecoins.mockReturnValue(query(c, stablecoins));
  hooks.usePegSummary.mockReturnValue(query(c, pegSummary));
  hooks.useActiveDepegEvents.mockReturnValue({ ...query(c, activeEvents), loadedCount: c.hasData ? 1 : 0 });
  hooks.useStabilityIndex.mockReturnValue(query(c, psi));
  hooks.useMintBurnFlows.mockReturnValue(query(c, flows));
  hooks.useBlacklistEventsPage.mockReturnValue(query(c, freezes));
  hooks.useBlacklistSummary.mockReturnValue(query(c, freezeSummary));
  // Optional ranking lanes fail independently of the market lane.
  hooks.useDexLiquidityTable.mockReturnValue({ ...query({ ...c, hasData: false }, {}), error: new Error("503") });
  hooks.useReportCardsV9Table.mockReturnValue({ ...query({ ...c, hasData: false }, {}), error: new Error("503") });
  hooks.useYieldRankingsSummary.mockReturnValue(query(c, yieldSummary));
  hooks.useDigestPromo.mockReturnValue(query(c, digestPromo));
  hooks.useTelegramPulse.mockReturnValue(query(c, { activeWatchers: 10, coinSubscriptions: 20 }));
  hooks.useHomepageHistory.mockReturnValue(query(c, { sources: { total: laneMeta }, rows: historyRows }));
  hooks.useHomepageSnapshot.mockReturnValue(query(c, {
    market: { data: buildLiveHomepageHeroSnapshot(stablecoins, c.meta?.updatedAt ?? undefined), meta: laneMeta },
    psi: { data: { score: 91.9, band: "BEDROCK", computedAt: NOW_SEC }, meta: laneMeta },
    incidents: { data: { activeDepegCount: 1 }, meta: laneMeta },
  }));
  hooks.useDepegResolverSurfaces.mockReturnValue({
    resolverEnabled: true, resolverReviewerEnabled: true,
    resolver: { ...query(c, { _meta: ddrMeta, rows: [] }) },
    resolverReview: { ...query(c, {
      _meta: ddrMeta,
      summary: { headline: { recoveryLikelihoodScoredCount: 10, recoveryLikelihoodAccuracyPct: 0.8,
        lockedPredictionCount: 12, durationScoredCount: 5, horizonHitRates: [] } },
    }) },
  });
}

function expectNoHealthUi(container: HTMLElement) {
  expect(container.querySelector('[role="status"], [role="alert"]')).toBeNull();
  expect(container.textContent).not.toMatch(WARNING_COPY);
  // Accessible names and tooltips count too.
  for (const element of container.querySelectorAll("[aria-label], [title]")) {
    expect(`${element.getAttribute("aria-label") ?? ""} ${element.getAttribute("title") ?? ""}`).not.toMatch(WARNING_COPY);
  }
  // Health-notice tones (tinted warning boxes/chips), not data bands like the Mild peg band.
  expect(container.innerHTML).not.toMatch(HEALTH_TONE);
  for (const button of container.querySelectorAll("button")) expect(button.textContent).not.toMatch(/retry|try again/i);
}

const SECTIONS: [string, () => ReactNode][] = [
  ["Market Pulse hero + state line", () => (
    <HomeAltHero snapshot={buildLiveHomepageHeroSnapshot(stablecoins, NOW_SEC - 30 * 86_400)} fallbackSelectedAtMs={NOW} />
  )],
  ["hero history chart", () => <HomeAltHeroLiveChart nowMs={NOW} />],
  ["Peg health card", () => <PegHealthCard />],
  ["Stability Index card", () => <PsiBandCard />],
  ["Mint / Burn card", () => <MintBurnCard />],
  ["Daily Digest card", () => <DailyDigestCard />],
  ["Supply moves card", () => <SupplyMovesCard />],
  ["FreezeWatch card", () => <RecentFreezesCard />],
  ["Active depegs card", () => <ActiveDepegsCard />],
  ["Stablecoin Overview rankings", () => <HomeAltRankingsSection titleId="rankings-title" />],
  ["Upcoming teaser", () => <HomeAltUpcomingHorizonConstellation />],
  ["Depeg Duration Resolver overview", () => <HomeAltDdrOverview />],
  ["Yield Intelligence overview", () => <HomeAltYieldOverview />],
  ["status bar", () => <HomeAltStatusTelegram />],
  // Global chrome rendered on the homepage too; the PSI fixture is a week old.
  ["global regime bar", () => <RegimeBar />],
];

// Preloaded once so lazily resolved shared descendants mount within a settle tick.
async function settleLazyChildren() {
  for (let pass = 0; pass < 3; pass++) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
}

beforeAll(async () => {
  await Promise.all([import("@/components/stablecoin-table"), import("@/components/home-alt-hero-chart")]);
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}, 60_000);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe.each(CASES)("homepage under $label", (c) => {
  it.each(SECTIONS)("%s renders without data-health UI", async (_name, renderSection) => {
    configure(c);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(<>{renderSection()}</>);
    await settleLazyChildren();
    expectNoHealthUi(container);
  });

  it("renders the real shared rankings table, not a stub", { timeout: 30_000 }, async () => {
    configure(c);
    const { container } = render(<HomeAltRankingsSection titleId="rankings-title" />);
    // Generous budget: the first lazy import of the table is slow under a loaded machine.
    if (c.hasData) await waitFor(() => expect(container.querySelector("table")).not.toBeNull(), { timeout: 15_000 });
    expectNoHealthUi(container);
  });

  it("keeps the R1 data rules: figures are never zero-filled", async () => {
    configure(c);
    const { container } = render(<><ActiveDepegsCard /><HomeAltDdrOverview /></>);
    if (!c.hasData) {
      expect(container.textContent).not.toMatch(/confirmed depegs? right now/);
      expect(container.textContent).not.toMatch(/\b0 graded/);
      expect(container.textContent).toContain("Updating");
    }
  });
});

describe("homepage section crash fallback", () => {
  function Boom(): React.JSX.Element {
    throw new Error("render exploded");
  }

  it("renders a calm placeholder while still logging the render error", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(<HomeSectionErrorBoundary name="yield intelligence overview"><Boom /></HomeSectionErrorBoundary>);
    expectNoHealthUi(container);
    expect(container.textContent).toBe("Updating");
    expect(container.querySelector("button")).toBeNull();
    expect(log.mock.calls.some(([message]) => String(message).includes("[yield intelligence overview] render error"))).toBe(true);
  });

  it("leaves the shared boundary's notice unchanged for other routes", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { getByRole } = render(<SectionErrorBoundary name="chain table"><Boom /></SectionErrorBoundary>);
    expect(getByRole("alert").textContent).toContain("The chain table section is temporarily unavailable.");
  });
});

describe("homepage source guard", () => {
  const files = [
    "src/app/page.tsx",
    ...readdirSync("src/components").filter((name) => /^home(page)?-.*\.tsx$/.test(name) && name !== "home-section-error-boundary.tsx").map((name) => join("src/components", name)),
    ...readdirSync("src/components/home-alt-mini-cards").map((name) => join("src/components/home-alt-mini-cards", name)),
  ];

  it.each(files)("%s carries no data-health warning copy", (file) => {
    const source = readFileSync(file, "utf8");
    expect(source).not.toMatch(/Data quality warning|Refresh failed|Freshness unavailable|temporarily unavailable|Retained (snapshot|observation)|>\s*Retry\s*<|<SectionErrorBoundary\b/);
    // JSX text only: state words in rendered copy, not identifiers like `isStale`.
    expect(source).not.toMatch(/>[^<>{}]*\b(stale|retained|degraded)\b[^<>{}]*</i);
  });
});

describe("homepage render-tree import guard", () => {
  const BANNED = /\/(stale-data-banner|query-freshness-notices|query-error-notice|data-health-banner|query-state-notice|yield\/yield-data-health|safety-score-v9-status-notice|ops-status-chip|section-error-boundary)\.tsx$/;
  // Reviewed importers reachable from the homepage whose banned import is not rendered there.
  const REVIEWED: Record<string, string> = {
    // Expanded yield rows only; the homepage renders YieldSafetyBadge from yield-leaderboard-row-parts.
    "src/components/yield-history-chart.tsx": "data-health-banner, query-error-notice",
    // The homepage wrapper that supplies the neutral crash fallback.
    "src/components/home-section-error-boundary.tsx": "section-error-boundary",
  };

  function resolveImport(from: string, spec: string): string | null {
    const base = spec.startsWith("@/") ? resolve("src", spec.slice(2))
      : spec.startsWith("@shared/") ? resolve("shared", spec.slice(8))
        : spec.startsWith(".") ? resolve(dirname(from), spec) : null;
    if (!base) return null;
    for (const ext of [".tsx", ".ts", "/index.tsx", "/index.ts"]) if (existsSync(base + ext)) return base + ext;
    return /\.(tsx?)$/.test(base) && existsSync(base) ? base : null;
  }

  it("reaches no banned warning component except reviewed, non-rendered paths", () => {
    const seen = new Set<string>();
    const queue = [resolve("src/app/page.tsx")];
    const offenders: string[] = [];
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/^(?!import type|export type)(?:import|export)[^;]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/gm)) {
        const target = resolveImport(file, match[1] ?? match[2]!);
        if (!target) continue;
        if (BANNED.test(target) && !(relative(process.cwd(), file) in REVIEWED)) offenders.push(`${relative(process.cwd(), file)} -> ${relative(process.cwd(), target)}`);
        queue.push(target);
      }
    }
    expect(seen.size).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });
});
