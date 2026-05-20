// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SelectorInput } from "@shared/lib/selector";

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
  pegCurrency?: "USD" | "EUR" | "CHF" | "GOLD";
  input?: SelectorInput;
  recommended?: unknown[];
  lowerRanked?: unknown[];
  closestSurvivors?: unknown[];
} = {}) {
  const profile = overrides.profile ?? "treasury";
  const pegCurrency = overrides.pegCurrency ?? "USD";
  const input = overrides.input ?? {
    profile,
    pegCurrency,
    horizon: "6mplus" as const,
    depegTolerance: "zero" as const,
    composability: "none" as const,
    exitSpeed: "any" as const,
    minApy: null,
    yieldNativeOnly: false,
    decentralization: "any" as const,
    custodyOk: "any" as const,
  };
  return {
    profile,
    input,
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
    engineVersion: "selector-v1.2",
    methodologyVersions: {
      safetyScore: "v7.25",
      pegScoreAndDews: "v3",
      yieldIntelligence: "v8",
      bluechipAlignment: "v1",
      exclusionFilters: "selector-v1.2",
    },
    datasetHash: "abc123",
  };
}

vi.mock("@shared/lib/selector", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@shared/lib/selector/types");
  return {
    ...actual,
    runSelector: vi.fn((input: SelectorInput) => mockSelectorOutput({
      profile: input.profile,
      pegCurrency: input.pegCurrency ?? "USD",
      input,
    })),
    buildScreenerUrl: vi.fn((_input: unknown, baseUrl: string) => ({
      url: `${baseUrl}?dewsMax=60`,
      divergenceWarnings: [],
    })),
    selectorAnswersToScreenerFilters: vi.fn(() => ({ filters: {}, divergenceWarnings: [] })),
    computeSnapshotId: vi.fn(async () => "stub-sid"),
    getTemplate: vi.fn(() => ({ oneLineExplanation: "Dimension watch line for test." })),
    canonicalizeForDatasetHash: vi.fn((v: unknown) => JSON.stringify(v)),
    SELECTOR_VERSION: "selector-v1.2",
    ENGINE_VERSION: "selector-v1.2",
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

vi.mock("@/hooks/use-hydrated", () => ({
  useHydrated: () => true,
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
    useRedemptionBackstops: () => ({ data: { coins: {} }, dataUpdatedAt: 1, error: null }),
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
    // p=treasury only; USD peg is the default, so it lands on horizon post-rehydrate.
    expect(
      screen.getAllByText(/How long do you plan to hold this position/i).length,
    ).toBeGreaterThan(0);
  });

  it("records a selected peg in the URL before moving to horizon", async () => {
    render(<SelectorClient />);

    fireEvent.click(screen.getByLabelText(/Hold safely/i));
    expect(
      (await screen.findAllByText(/Which peg currency should it target/i)).length,
    ).toBeGreaterThan(0);

    fireEvent.click(screen.getByLabelText(/EUR/i));
    fireEvent.click(screen.getByRole("button", { name: /Next/i }));

    expect(window.location.search).toContain("peg=EUR");
    expect(
      screen.getAllByText(/How long do you plan to hold this position/i).length,
    ).toBeGreaterThan(0);
  });

  it("includes CHF and Gold in Yield peg choices while hiding unsupported pegs", async () => {
    render(<SelectorClient />);

    fireEvent.click(screen.getByLabelText(/Earn yield/i));
    expect(
      (await screen.findAllByText(/Which peg currency should it target/i)).length,
    ).toBeGreaterThan(0);

    expect(screen.getByLabelText(/CHF/i)).toBeTruthy();
    expect(screen.getByLabelText(/Gold/i)).toBeTruthy();
    expect(screen.queryByLabelText(/AUD/i)).toBeNull();
  });

  it("walks Treasury × 6mplus × zero × custody directly to result (Q5 skip)", async () => {
    setUrlSearch("p=treasury&h=6mplus&d=zero&v=custody&step=result");
    render(<SelectorClient />);
    // Result page renders the summary universe funnel.
    expect(await screen.findByText(/tracked USD stablecoins → /)).toBeTruthy();
  });

  it("renders the result page with mocked engine output", async () => {
    setUrlSearch("p=treasury&h=6mplus&d=zero&v=custody&step=result");
    render(<SelectorClient />);
    // Shortlist heading + first card.
    expect((await screen.findAllByText(/Shortlist/i)).length).toBeGreaterThan(0);
    expect(screen.getByText("USDC")).toBeTruthy();
    expect(screen.getByText(/Treasury profile result/i)).toBeTruthy();
  });

  it("links the shortlist to Compare with selected answers and shortlisted ids", async () => {
    const mod = await import("@shared/lib/selector");
    (mod.runSelector as ReturnType<typeof vi.fn>).mockImplementationOnce((input: SelectorInput) =>
      mockSelectorOutput({
        profile: "yield",
        pegCurrency: "GOLD",
        input,
        recommended: [
          {
            ...baseRecommendation,
            id: "xaut-tether",
            symbol: "XAUT",
            name: "Tether Gold",
            rank: 1,
            profile: "yield",
            recommendedSource: {
              protocol: "yo-protocol",
              chain: "Ethereum",
              apy30d: 6.5,
              pharosYieldScore: 17,
              sourceRiskTier: "mid",
              freshness: { capturedAt: 1_700_000_000_000, ageSeconds: 60 },
            },
            perInputStaleness: null,
          },
          {
            ...baseRecommendation,
            id: "paxg-paxos",
            symbol: "PAXG",
            name: "PAX Gold",
            rank: 2,
            profile: "yield",
            recommendedSource: {
              protocol: "hydration-dex",
              chain: "Polkadot",
              apy30d: 6.5,
              pharosYieldScore: 18,
              sourceRiskTier: "mid",
              freshness: { capturedAt: 1_700_000_000_000, ageSeconds: 60 },
            },
            perInputStaleness: null,
          },
        ],
      }));

    setUrlSearch("p=yield&peg=GOLD&h=1to6m&d=moderate&v=all&u=any&step=result");
    render(<SelectorClient />);

    const link = await screen.findByRole("link", {
      name: /Compare the shortlisted stablecoins/i,
    });
    expect(link.getAttribute("href")).toBe(
      "/compare/?p=yield&peg=GOLD&h=1to6m&d=moderate&v=all&u=any&step=result&coins=xaut-tether%2Cpaxg-paxos",
    );
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
      await screen.findByText(/No tracked USD stablecoin currently passes/i),
    ).toBeTruthy();
  });
});

describe("SelectorClient — snapshot recall", () => {
  it("renders sid-only share links from the frozen snapshot output", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockSelectorOutput(),
    } as Response);
    vi.stubGlobal("fetch", fetchMock);

    setUrlSearch("sid=00112233445566778899aabbccddeeff");
    render(<SelectorClient />);

    expect((await screen.findAllByText(/Shortlist/i)).length).toBeGreaterThan(0);
    expect(screen.getByText("USDC")).toBeTruthy();
    expect(screen.getByText(/Showing snapshot/i)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "/selector-snapshot/00112233445566778899aabbccddeeff",
      expect.objectContaining({ method: "GET" }),
    );

    vi.unstubAllGlobals();
  });

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

  it("clears the snapshot id when adjusting a frozen result", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockSelectorOutput(),
    } as Response);
    vi.stubGlobal("fetch", fetchMock);

    setUrlSearch("sid=00112233445566778899aabbccddeeff");
    render(<SelectorClient />);

    const adjust = await screen.findByText(/Adjust answers/i);
    fireEvent.click(adjust);

    expect(window.location.search).not.toContain("sid=");
    expect(
      screen.getAllByText(/What are you using this stablecoin for/i).length,
    ).toBeGreaterThan(0);

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
  // Regression: ticking a Yield venue checkbox previously auto-advanced,
  // making multi-select impossible. The reducer split (`set-venue` vs
  // `answer-venue`) keeps the user on venue step until they press Next.
  it("does not advance to exit when ticking a Yield venue checkbox", async () => {
    setUrlSearch("p=yield&h=1to4w&d=tight&step=5");
    render(<SelectorClient />);

    // Venue prompt visible (text appears both in the legend and the aria-live
    // announcement region; either presence proves the step rendered).
    expect((await screen.findAllByText(/Where will you put it to work/i)).length)
      .toBeGreaterThan(0);

    // Tick a checkbox; the URL stays on step 5 and the exit prompt does NOT appear.
    const checkbox = screen.getByLabelText(/Major lending protocols/i);
    fireEvent.click(checkbox);

    expect(screen.queryByText(/how fast do you need to be out/i)).toBeNull();
    expect(window.location.search).toContain("step=5");
  });
});
