// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

// ----------------------------------------------------------------------------
// Engine mock — installed BEFORE the client import so the synchronous engine
// call inside `useSelector` resolves to a deterministic SelectorOutput.
// ----------------------------------------------------------------------------

const baseRecommendation = {
  id: "usdc-usd-coin",
  symbol: "USDC",
  name: "USD Coin",
  rank: 1 as const,
  score: 87.4,
  confidence: 88,
  components: [
    {
      key: "resilience" as const,
      weight: 20,
      rawValue: 91,
      normalizedValue: 91,
      contribution: 18.2,
      redistributed: false,
    },
    {
      key: "dependencyRisk" as const,
      weight: 17,
      rawValue: 88,
      normalizedValue: 88,
      contribution: 14.96,
      redistributed: false,
    },
  ],
  whyKeys: ["top-safety", "strong-resilience"],
  lowestSubDimension: {
    key: "decentralization" as const,
    score: 45,
    contextKeys: [],
  },
  chainHints: { topByLiquidity: ["Ethereum"], topByYield: [], primary: "Ethereum" },
  isRecentListing: false,
  bluechipGrade: "A" as const,
  safetyGrade: "A" as const,
  supplyUsd: 32_000_000_000,
  isBeta: true as const,
};

function mockSelectorOutput(overrides: {
  profile?: "treasury" | "yield" | "trading";
  recommended?: unknown[];
  lowerRanked?: unknown[];
  closestSurvivors?: unknown[];
} = {}) {
  const profile = overrides.profile ?? "treasury";
  return {
    profile,
    input: {
      profile,
      pegCurrency: "USD" as const,
      horizon: "6mplus" as const,
      depegTolerance: "zero" as const,
      composability: "none" as const,
      exitSpeed: "any" as const,
      minApy: null,
      yieldNativeOnly: false,
      decentralization: "any" as const,
      custodyOk: "any" as const,
    },
    universe: { active: 380, surviving: 12 },
    recommended:
      overrides.recommended
      ?? [
        { ...baseRecommendation, profile, recommendedSource: null, perInputStaleness: null },
      ],
    lowerRanked: overrides.lowerRanked ?? [],
    coverageWarnings: {
      skippedForCoverageCount: 0,
      skippedForCoverage: [],
      sparse: false,
      uneven: false,
      newListingCount: 0,
      redistributionCount: 0,
    },
    lowConfidence: false,
    timestamp: 1_700_000_000_000,
    engineVersion: "selector-v1.0",
    methodologyVersions: {
      safetyScore: "v7.25",
      pegScoreAndDews: "v3",
      yieldIntelligence: "v8",
      bluechipAlignment: "v1",
      exclusionFilters: "selector-v1.0",
    },
    datasetHash: "abc123",
  };
}

vi.mock("@shared/lib/selector", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@shared/lib/selector/types");
  return {
    ...actual,
    runSelector: vi.fn((input: { profile: "treasury" | "yield" | "trading" }) =>
      mockSelectorOutput({ profile: input.profile })),
    buildScreenerUrl: vi.fn((_input: unknown, baseUrl: string) => ({
      url: `${baseUrl}?dewsMax=60`,
      divergenceWarnings: [],
    })),
    selectorAnswersToScreenerFilters: vi.fn(() => ({ filters: {}, divergenceWarnings: [] })),
    computeSnapshotId: vi.fn(async () => "stub-sid"),
    getTemplate: vi.fn(() => ({ oneLineExplanation: "Dimension watch line for test." })),
    canonicalizeForDatasetHash: vi.fn((v: unknown) => JSON.stringify(v)),
    ENGINE_VERSION: "selector-v1.0",
  };
});

// ----------------------------------------------------------------------------
// Hooks: stub the data-fetching layer so the engine receives "ready" data.
// ----------------------------------------------------------------------------

vi.mock("@/hooks/use-stablecoins", () => ({
  useStablecoins: () => ({
    data: { peggedAssets: [{ id: "usdc-usd-coin", circulating: { peggedUSD: 32_000_000_000 } }] },
    dataUpdatedAt: 1,
    isLoading: false,
    isSuccess: true,
    error: null,
  }),
}));

vi.mock("@/hooks/api-hooks", () => {
  const stub = () => ({ data: { coins: [] }, dataUpdatedAt: 1, error: null });
  return {
    usePegSummary: () => ({ data: { coins: [] }, dataUpdatedAt: 1, error: null }),
    useReportCards: () => ({
      data: {
        cards: [
          {
            id: "usdc-usd-coin",
            overallGrade: "A",
            overallScore: 90,
            dimensions: {
              pegStability: { score: 96 },
              liquidity: { score: 88 },
              resilience: { score: 91 },
              decentralization: { score: 45 },
              dependencyRisk: { score: 88 },
            },
          },
        ],
      },
      dataUpdatedAt: 1,
      error: null,
    }),
    useStressSignals: () => ({ data: { signals: {} }, dataUpdatedAt: 1, error: null }),
    useDexLiquidity: () => ({ data: {}, dataUpdatedAt: 1, error: null }),
    useYieldRankings: () => ({ data: { rankings: [] }, dataUpdatedAt: 1, error: null }),
    useBluechipRatings: () => ({ data: {}, dataUpdatedAt: 1, error: null }),
    _stub: stub,
  };
});

vi.mock("@/hooks/use-logos", () => ({
  useLogos: () => ({ data: {} }),
}));

vi.mock("next/link", async () => {
  const React = await import("react");
  return {
    default: React.forwardRef<HTMLAnchorElement, { href: string; children: React.ReactNode }>(
      function MockLink({ href, children, ...rest }, ref) {
        return React.createElement("a", { ref, href, ...rest }, children);
      },
    ),
  };
});

// Import AFTER mocks
import { SelectorClient } from "./client";

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function setUrlSearch(search: string) {
  window.history.replaceState(null, "", `/screener/selector/${search ? `?${search}` : ""}`);
}

beforeEach(() => {
  window.localStorage.clear();
  setUrlSearch("");
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
});

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe("SelectorClient — state machine", () => {
  it("renders Q1 on initial mount with no URL state", () => {
    render(<SelectorClient />);
    expect(
      screen.getAllByText(/What are you using this stablecoin for/i).length,
    ).toBeGreaterThan(0);
    // Q1's three option labels render.
    expect(screen.getByText(/Hold safely/i)).toBeTruthy();
    expect(screen.getByText(/Earn yield/i)).toBeTruthy();
    expect(screen.getByText(/Trade actively/i)).toBeTruthy();
  });

  it("rehydrates down when URL claims a step beyond what's answerable", () => {
    setUrlSearch("p=treasury&step=5");
    render(<SelectorClient />);
    // p=treasury only; should land on Q2 (horizon) post-rehydrate.
    expect(
      screen.getAllByText(/How long do you plan to hold this position/i).length,
    ).toBeGreaterThan(0);
  });

  it("walks Treasury × 6mplus × zero × custody directly to result (Q5 skip)", async () => {
    setUrlSearch("p=treasury&h=6mplus&d=zero&v=custody&step=result");
    render(<SelectorClient />);
    // Result page renders the summary universe funnel.
    expect(await screen.findByText(/tracked → /)).toBeTruthy();
  });

  it("renders the result page with mocked engine output", async () => {
    setUrlSearch("p=treasury&h=6mplus&d=zero&v=custody&step=result");
    render(<SelectorClient />);
    // Shortlist heading + first card.
    expect((await screen.findAllByText(/Shortlist/i)).length).toBeGreaterThan(0);
    expect(screen.getByText("USDC")).toBeTruthy();
    expect(screen.getByText(/Best fit for Treasury/i)).toBeTruthy();
  });
});

describe("SelectorClient — empty state", () => {
  it("renders SelectorEmptyState when engine returns 0 recommended", async () => {
    // Re-mock for this test only:
    const mod = await import("@shared/lib/selector");
    (mod.runSelector as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      mockSelectorOutput({ recommended: [] }));

    setUrlSearch("p=treasury&h=6mplus&d=zero&v=custody&step=result");
    render(<SelectorClient />);
    expect(
      await screen.findByText(/No tracked stablecoin currently passes/i),
    ).toBeTruthy();
  });
});

describe("SelectorClient — snapshot recall", () => {
  it("shows a snapshot-miss banner when GET 404s and falls back to live engine", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    } as Response);
    vi.stubGlobal("fetch", fetchMock);

    setUrlSearch("p=treasury&h=6mplus&d=zero&v=custody&step=result&sid=missing-sid");
    render(<SelectorClient />);

    await act(async () => {
      // Allow the async snapshot fetch to settle.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      await screen.findByText(/Original snapshot no longer cached/i),
    ).toBeTruthy();

    vi.unstubAllGlobals();
  });
});

describe("SelectorClient — adjust flow", () => {
  it("Adjust answers returns to Q1 with answers preserved in URL", async () => {
    setUrlSearch("p=treasury&h=6mplus&d=zero&v=custody&step=result");
    render(<SelectorClient />);

    const adjust = await screen.findByText(/Adjust answers/i);
    fireEvent.click(adjust);
    expect(
      screen.getAllByText(/What are you using this stablecoin for/i).length,
    ).toBeGreaterThan(0);
    // Existing answers preserved in URL params.
    expect(window.location.search).toContain("p=treasury");
  });
});

describe("SelectorClient — Q4 multi-select", () => {
  // Regression: ticking a Yield Q4 checkbox previously auto-advanced to Q5,
  // making multi-select impossible. The reducer split (`set-venue` vs
  // `answer-venue`) keeps the user on step 4 until they press Next.
  it("does not advance to Q5 when ticking a Yield Q4 checkbox", async () => {
    setUrlSearch("p=yield&h=1to4w&d=tight&step=4");
    render(<SelectorClient />);

    // Q4 prompt visible (text appears both in the legend and the aria-live
    // announcement region; either presence proves the step rendered).
    expect((await screen.findAllByText(/Where will you put it to work/i)).length)
      .toBeGreaterThan(0);

    // Tick a checkbox; the URL stays on step 4 and the Q5 prompt does NOT appear.
    const checkbox = screen.getByLabelText(/Major lending protocols/i);
    fireEvent.click(checkbox);

    expect(screen.queryByText(/how fast do you need to be out/i)).toBeNull();
    expect(window.location.search).toContain("step=4");
  });
});
