// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SelectorInput } from "@shared/lib/selector";
import {
  cleanupFrontendTest,
  createNextLinkMock,
  installMatchMediaMock,
  resetBrowserStorage,
} from "@/test-utils/frontend";

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

function mockSelectorOutput(
  overrides: {
    profile?: "treasury" | "yield" | "trading";
    pegCurrency?: "USD" | "EUR" | "CHF" | "GOLD";
    input?: SelectorInput;
    recommended?: unknown[];
    lowerRanked?: unknown[];
    closestSurvivors?: unknown[];
  } = {},
) {
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
    recommended: overrides.recommended ?? [
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
    usedRelaxedFallback: false,
    relaxedReasons: [],
    exclusionSummary: [],
    closestSurvivors: overrides.closestSurvivors ?? [],
    relaxableConstraints: [],
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

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const { runSelectorMock } = vi.hoisted(() => ({
  runSelectorMock: vi.fn(),
}));

vi.mock("@shared/lib/selector", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@shared/lib/selector/types");
  return {
    ...actual,
    runSelector: runSelectorMock,
    buildScreenerUrl: vi.fn((_input: unknown, baseUrl: string) => ({
      url: `${baseUrl}?dewsMax=60`,
      divergenceWarnings: [],
    })),
    selectorAnswersToScreenerFilters: vi.fn(() => ({ filters: {}, divergenceWarnings: [] })),
    computeSnapshotId: vi.fn(async () => "stub-sid"),
    validateSelectorSnapshotResponse: vi.fn((value: unknown) => {
      if (
        value != null &&
        typeof value === "object" &&
        Array.isArray((value as { recommended?: unknown }).recommended) &&
        (value as { input?: unknown }).input != null
      ) {
        return { ok: true, snapshot: value };
      }
      return { ok: false, error: "shape" };
    }),
    getTemplate: vi.fn(() => ({ oneLineExplanation: "Dimension watch line for test." })),
    canonicalizeForDatasetHash: vi.fn((v: unknown) => JSON.stringify(v)),
    SELECTOR_VERSION: "selector-v1.2",
    ENGINE_VERSION: "selector-v1.2",
  };
});

vi.mock("./selector-data-adapter", () => ({
  buildSelectorRows: vi.fn(() => ({
    rows: new Map(),
    timestamp: 1_700_000_000_000,
    datasetHash: "abc123",
    methodologyVersions: {
      safetyScore: "v9",
      pegScoreAndDews: "v3",
      yieldIntelligence: "v8",
      bluechipAlignment: "unversioned",
      exclusionFilters: "selector-v1.2",
    },
  })),
}));

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
  useSupplyHistory: () => ({
    data: [],
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
    useReportCardsV9: () => ({
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
  return createNextLinkMock();
});

// Import AFTER mocks
import { SelectorClient } from "./client";
import { SELECTOR_STATE_DEFAULTS, toSelectorInput } from "./selector-state";

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function setUrlSearch(search: string) {
  window.history.replaceState(null, "", `/screener/picker/${search ? `?${search}` : ""}`);
}

beforeEach(() => {
  resetBrowserStorage();
  setUrlSearch("");
  installMatchMediaMock();
  runSelectorMock.mockReset();
  runSelectorMock.mockImplementation((input: SelectorInput) =>
    mockSelectorOutput({
      profile: input.profile,
      pegCurrency: input.pegCurrency ?? "USD",
      input,
    }),
  );
});

afterEach(() => {
  cleanupFrontendTest();
});

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe("SelectorClient — state machine", () => {
  it("renders Q1 on initial mount with no URL state", () => {
    render(<SelectorClient />);
    expect(screen.getAllByText(/What are you using this stablecoin for/i).length).toBeGreaterThan(0);
    // Q1's three option labels render.
    expect(screen.getByText(/Hold under Treasury constraints/i)).toBeTruthy();
    expect(screen.getByText(/Earn yield/i)).toBeTruthy();
    expect(screen.getByText(/Trade actively/i)).toBeTruthy();
  });

  it("rehydrates down when URL claims a step beyond what's answerable", () => {
    setUrlSearch("p=treasury&step=5");
    render(<SelectorClient />);
    // p=treasury only; USD peg is the default, so it lands on horizon post-rehydrate.
    expect(screen.getAllByText(/How long do you plan to hold this position/i).length).toBeGreaterThan(0);
  });

  it("records a selected peg in the URL before moving to horizon", async () => {
    render(<SelectorClient />);

    fireEvent.click(screen.getByLabelText(/Hold under Treasury constraints/i));
    fireEvent.click(screen.getByRole("button", { name: /Next/i }));
    expect((await screen.findAllByText(/Which peg currency should it target/i)).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByLabelText(/EUR/i));
    fireEvent.click(screen.getByRole("button", { name: /Next/i }));

    expect(window.location.search).toContain("peg=EUR");
    expect(screen.getAllByText(/How long do you plan to hold this position/i).length).toBeGreaterThan(0);
  });

  it("includes CHF and Gold in Yield peg choices while hiding unsupported pegs", async () => {
    render(<SelectorClient />);

    fireEvent.click(screen.getByLabelText(/Earn yield/i));
    fireEvent.click(screen.getByRole("button", { name: /Next/i }));
    expect((await screen.findAllByText(/Which peg currency should it target/i)).length).toBeGreaterThan(0);

    expect(screen.getByLabelText(/CHF/i)).toBeTruthy();
    expect(screen.getByLabelText(/Gold/i)).toBeTruthy();
    expect(screen.queryByLabelText(/AUD/i)).toBeNull();
  });

  it("renders the result page with mocked engine output", async () => {
    setUrlSearch("p=treasury&h=6mplus&d=zero&v=custody&step=result");
    render(<SelectorClient />);
    // Shortlist heading + first card.
    expect((await screen.findAllByText(/Shortlist/i)).length).toBeGreaterThan(0);
    expect(screen.getByText("USDC")).toBeTruthy();
    // Funnel headline ("… tracked USD stablecoins → … filtered → … shortlist
    // entries") is the canonical "result page rendered" marker.
    expect(screen.getByText(/tracked USD stablecoins/)).toBeTruthy();
    // Single-result shortlist: Compare these is hidden in favor of the
    // per-card prominent Open detail link.
    expect(screen.queryByRole("link", { name: /Compare these/i })).toBeNull();
    expect(screen.getByText("Open detail")).toBeTruthy();
  });

  it("logs selector engine failures and shows the error state", async () => {
    const mod = await import("@shared/lib/selector");
    const engineError = new Error("engine exploded");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    (mod.runSelector as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw engineError;
    });

    try {
      setUrlSearch("p=treasury&h=6mplus&d=zero&v=custody&step=result");
      render(<SelectorClient />);

      expect(await screen.findByText(/Selector could not produce a result \(engine failed\)/i)).toBeTruthy();
      expect(consoleError).toHaveBeenCalledWith("[selector] Selector engine failed", engineError);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("offers a Telegram subscribe command for the shortlisted stablecoins", async () => {
    const mod = await import("@shared/lib/selector");
    (mod.runSelector as ReturnType<typeof vi.fn>).mockImplementation((input: SelectorInput) =>
      mockSelectorOutput({
        input,
        recommended: [
          { ...baseRecommendation, profile: "treasury", recommendedSource: null, perInputStaleness: null },
          {
            ...baseRecommendation,
            id: "usdt-tether",
            symbol: "USDT",
            name: "Tether USDt",
            rank: 2,
            profile: "treasury",
            recommendedSource: null,
            perInputStaleness: null,
          },
          {
            ...baseRecommendation,
            id: "dai-makerdao",
            symbol: "DAI",
            name: "Dai",
            rank: 3,
            profile: "treasury",
            recommendedSource: null,
            perInputStaleness: null,
          },
        ],
      }),
    );

    setUrlSearch("p=treasury&h=6mplus&d=zero&v=custody&step=result");
    render(<SelectorClient />);

    expect(await screen.findByText("/subscribe dews, depeg, safety USDC, USDT, DAI")).toBeTruthy();
    const botLink = screen.getByRole("link", { name: /Open PharosWatchBot/i });
    expect(botLink.getAttribute("href")).toBe("https://t.me/PharosWatchBot");
  });

  it("excludes unsafe snapshot tokens from the Telegram subscribe command", async () => {
    const mod = await import("@shared/lib/selector");
    (mod.runSelector as ReturnType<typeof vi.fn>).mockImplementation((input: SelectorInput) =>
      mockSelectorOutput({
        input,
        recommended: [
          {
            ...baseRecommendation,
            id: "all depeg-step 100 usd-top25",
            symbol: "$USDC",
            profile: "treasury",
            recommendedSource: null,
            perInputStaleness: null,
          },
          {
            ...baseRecommendation,
            id: "safe-fallback",
            symbol: "unsafe token",
            name: "Safe Fallback",
            rank: 2,
            profile: "treasury",
            recommendedSource: null,
            perInputStaleness: null,
          },
          {
            ...baseRecommendation,
            id: "reserved-symbol-fallback",
            symbol: "all",
            name: "Reserved Symbol Fallback",
            rank: 3,
            profile: "treasury",
            recommendedSource: null,
            perInputStaleness: null,
          },
        ],
      }),
    );

    setUrlSearch("p=treasury&h=6mplus&d=zero&v=custody&step=result");
    render(<SelectorClient />);

    expect(
      await screen.findByText("/subscribe dews, depeg, safety safe-fallback, reserved-symbol-fallback"),
    ).toBeTruthy();
    expect(screen.queryByText(/all depeg-step 100 usd-top25/)).toBeNull();
  });

  it("shows near misses even when a shortlist is present", async () => {
    const mod = await import("@shared/lib/selector");
    (mod.runSelector as ReturnType<typeof vi.fn>).mockImplementation((input: SelectorInput) =>
      mockSelectorOutput({
        input,
        closestSurvivors: [
          {
            id: "near",
            symbol: "NEAR",
            failingDimension: "liquidity-floor",
            liveReading: "Liquidity 42",
            reason: "liquidity-floor",
            hypotheticalScore: 74.5,
          },
        ],
      }),
    );

    setUrlSearch("p=treasury&h=6mplus&d=zero&v=custody&step=result");
    render(<SelectorClient />);

    expect(await screen.findByText(/Near misses \/ why not shown/i)).toBeTruthy();
    expect(screen.getByText(/NEAR/)).toBeTruthy();
    expect(screen.getByText(/missed on liquidity/i)).toBeTruthy();
    expect(screen.getByText(/Hypothetical score 74.5/i)).toBeTruthy();
  });

  it("does not render a duplicate compare link inside the shortlist section", async () => {
    const mod = await import("@shared/lib/selector");
    (mod.runSelector as ReturnType<typeof vi.fn>).mockImplementation((input: SelectorInput) =>
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
      }),
    );

    setUrlSearch("p=yield&peg=GOLD&h=1to6m&d=moderate&v=all&u=any&step=result");
    render(<SelectorClient />);

    expect(await screen.findByRole("heading", { name: "Shortlist" })).toBeTruthy();
    const yieldInspectLinks = screen.getAllByRole("link", { name: /Inspect on Yield Intelligence/i });
    expect(yieldInspectLinks.map((link) => link.getAttribute("href"))).toEqual([
      "/yield/?from=selector&compare=xaut-tether%2Cpaxg-paxos",
      "/stablecoin/xaut-tether/yield/",
      "/stablecoin/paxg-paxos/yield/",
    ]);
    expect(
      screen.queryByRole("link", {
        name: /Compare the shortlisted stablecoins/i,
      }),
    ).toBeNull();
  });

  it("does not advance desktop depeg, venue, or exit choices until Next", async () => {
    setUrlSearch("p=treasury&h=1to6m&d=tight&v=custody&u=24h&step=4");
    render(<SelectorClient />);

    fireEvent.click(await screen.findByLabelText(/Moderate/i));
    expect(window.location.search).toContain("step=4");
    expect(screen.getAllByText(/How tight does the peg need to hold/i).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: /Next/i }));
    expect((await screen.findAllByText(/What custody or rail setup do you prefer/i)).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByLabelText(/Regulated custody/i));
    expect(window.location.search).toContain("step=5");
    expect(screen.queryByText(/how fast do you need to be out/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Next/i }));
    expect((await screen.findAllByText(/how fast do you need to be out/i)).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByLabelText(/Same day/i));
    expect(window.location.search).toContain("step=6");
    expect(screen.queryByText(/tracked USD stablecoins/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /See my shortlist/i }));
    expect(await screen.findByText(/tracked USD stablecoins/i)).toBeTruthy();
  });

  it("keeps mobile answer handlers local until the sticky CTA commits results", async () => {
    (window.matchMedia as ReturnType<typeof vi.fn>).mockImplementation((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    setUrlSearch("p=trading&step=2");
    render(<SelectorClient />);

    fireEvent.click(await screen.findByLabelText(/1 – 7 days/i));
    fireEvent.click(screen.getByLabelText(/Within 0.5%/i));
    fireEvent.click(screen.getByLabelText(/Centralized venues/i));
    fireEvent.click(screen.getByLabelText(/Same day/i));

    expect(window.location.search).toContain("step=2");
    expect(screen.queryByText(/tracked USD stablecoins/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /See my shortlist/i }));
    expect(await screen.findByText(/tracked USD stablecoins/i)).toBeTruthy();
  });

  it("blocks Trading share links when per-input staleness exceeds its cadence-aware limit", async () => {
    const mod = await import("@shared/lib/selector");
    (mod.runSelector as ReturnType<typeof vi.fn>).mockImplementation((input: SelectorInput) =>
      mockSelectorOutput({
        profile: "trading",
        input,
        recommended: [
          {
            ...baseRecommendation,
            profile: "trading",
            recommendedSource: null,
            perInputStaleness: { pegSummary: 500, dexTvl: 901, dews: 1_800 },
          },
        ],
      }),
    );

    setUrlSearch("p=trading&h=1to7d&d=tight&v=cex&u=24h&step=result");
    render(<SelectorClient />);

    const copy = await screen.findByRole("button", { name: /Copy share link/i });
    expect(copy.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/share-link freshness limit/i)).toBeTruthy();
  });

  it("blocks Trading share links when required freshness timestamps are missing", async () => {
    const mod = await import("@shared/lib/selector");
    (mod.runSelector as ReturnType<typeof vi.fn>).mockImplementation((input: SelectorInput) =>
      mockSelectorOutput({
        profile: "trading",
        input,
        recommended: [
          {
            ...baseRecommendation,
            profile: "trading",
            recommendedSource: null,
            perInputStaleness: {},
          },
        ],
      }),
    );

    setUrlSearch("p=trading&h=1to7d&d=tight&v=cex&u=24h&step=result");
    render(<SelectorClient />);

    const copy = await screen.findByRole("button", { name: /Copy share link/i });
    expect(copy.hasAttribute("disabled")).toBe(true);
  });

  it("jumps directly to an answer step from result edit chips and clears snapshot state", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(mockSelectorOutput()));
    vi.stubGlobal("fetch", fetchMock);

    setUrlSearch("p=treasury&h=6mplus&d=zero&v=custody&step=result&sid=00112233445566778899aabbccddeeff");
    render(<SelectorClient />);

    const pegEdit = await screen.findByRole("button", { name: /Edit peg:/i });
    fireEvent.click(pegEdit);

    expect(window.location.search).not.toContain("sid=");
    expect(screen.getAllByText(/Which peg currency should it target/i).length).toBeGreaterThan(0);

    vi.unstubAllGlobals();
  });

  it("offers a session-scoped restore for the last live result", async () => {
    setUrlSearch("p=treasury&h=6mplus&d=zero&v=custody&step=result");
    render(<SelectorClient />);
    expect(await screen.findByText("USDC")).toBeTruthy();

    await act(async () => {
      await Promise.resolve();
    });
    cleanup();
    setUrlSearch("");
    render(<SelectorClient />);

    const restore = await screen.findByRole("button", { name: /Restore previous result/i });
    fireEvent.click(restore);

    expect(await screen.findByText(/Restored from this tab/i)).toBeTruthy();
    expect(await screen.findByText("USDC")).toBeTruthy();
  });
});

describe("SelectorClient — empty state", () => {
  it("renders SelectorEmptyState", async () => {
    // Re-mock for this test only:
    const mod = await import("@shared/lib/selector");
    (mod.runSelector as ReturnType<typeof vi.fn>).mockImplementation(() => mockSelectorOutput({ recommended: [] }));

    setUrlSearch("p=treasury&h=6mplus&d=zero&v=custody&step=result");
    render(<SelectorClient />);
    expect(await screen.findByText(/No tracked USD stablecoin currently passes/i)).toBeTruthy();
  });
});

describe("selector-state input adapter", () => {
  it("persists exact venue preferences into SelectorInput", () => {
    expect(
      toSelectorInput({
        ...SELECTOR_STATE_DEFAULTS,
        profile: "yield",
        pegCurrency: "USD",
        horizon: "1to4w",
        depegTolerance: "tight",
        venue: ["dex"],
        exitSpeed: "24h",
      })?.venuePreferences,
    ).toEqual(["dex"]);
  });

  it("maps Treasury DeFi-native rail preference to stronger selector intent", () => {
    const input = toSelectorInput({
      ...SELECTOR_STATE_DEFAULTS,
      profile: "treasury",
      pegCurrency: "USD",
      horizon: "1to6m",
      depegTolerance: "tight",
      venue: ["active"],
      exitSpeed: "any",
    });

    expect(input?.custodyOk).toBe("onchain-only");
    expect(input?.decentralization).toBe("required");
  });

  it("maps Treasury regulated custody rail preference to regulated custody intent", () => {
    const input = toSelectorInput({
      ...SELECTOR_STATE_DEFAULTS,
      profile: "treasury",
      pegCurrency: "USD",
      horizon: "1to6m",
      depegTolerance: "tight",
      venue: ["custody"],
      exitSpeed: "any",
    });

    expect(input?.custodyOk).toBe("regulated-only");
    expect(input?.decentralization).toBe("any");
  });
});

describe("SelectorClient — snapshot recall", () => {
  it("renders sid-only share links from the frozen snapshot output", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(mockSelectorOutput()));
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

  it("renders server-recomputed replay output as Pharos-verified", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ...mockSelectorOutput(),
        provenance: "pharos-verified",
        snapshotSchemaVersion: 3,
        verification: {
          kind: "pharos-server-recomputed-v1",
          datasetHash: "abc123",
          engineVersion: "selector-v1.2",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    setUrlSearch("sid=00112233445566778899aabbccddeeff");
    render(<SelectorClient />);

    expect(await screen.findByText("Pharos-verified snapshot")).toBeTruthy();
    expect(screen.getByText(/recomputed this snapshot from canonical source data/i)).toBeTruthy();
    expect(screen.queryByText("Unverified client snapshot")).toBeNull();

    vi.unstubAllGlobals();
  });

  it("shows a snapshot-miss banner when a missing snapshot is recomputed from current data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 404));
    vi.stubGlobal("fetch", fetchMock);

    setUrlSearch("p=treasury&h=6mplus&d=zero&v=custody&step=result&sid=ffffffffffffffffffffffffffffffff");
    render(<SelectorClient />);

    await act(async () => {
      // Allow the async snapshot fetch to settle.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(await screen.findByText(/Original snapshot no longer cached/i)).toBeTruthy();
    expect(screen.getByText("USDC")).toBeTruthy();

    vi.unstubAllGlobals();
  });

  it("rejects structurally corrupt snapshot payloads returned with 200", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ input: { profile: "treasury" }, rows: "not-an-array" }));
    vi.stubGlobal("fetch", fetchMock);

    setUrlSearch("sid=00112233445566778899aabbccddeeff");
    render(<SelectorClient />);

    expect(await screen.findByText(/snapshot data is corrupt/i)).toBeTruthy();

    vi.unstubAllGlobals();
  });

  it("does not fetch malformed snapshot ids and shows the invalid-link error", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    setUrlSearch("sid=not-a-valid-sid");
    render(<SelectorClient />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await screen.findByText(/snapshot id is invalid/i)).toBeTruthy();

    vi.unstubAllGlobals();
  });

  it("keeps a frozen snapshot visible and compares it to current data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(mockSelectorOutput()));
    vi.stubGlobal("fetch", fetchMock);

    setUrlSearch("sid=00112233445566778899aabbccddeeff");
    render(<SelectorClient />);

    const compare = await screen.findByRole("button", { name: /Compare to today/i });
    fireEvent.click(compare);

    expect(screen.getByText(/Showing snapshot/i)).toBeTruthy();
    expect(screen.getByText(/Current shortlist comparison/i)).toBeTruthy();

    vi.unstubAllGlobals();
  });

  it("clears the snapshot id when adjusting a frozen result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(mockSelectorOutput()));
    vi.stubGlobal("fetch", fetchMock);

    setUrlSearch("sid=00112233445566778899aabbccddeeff");
    render(<SelectorClient />);

    const adjust = await screen.findByText(/Adjust answers/i);
    fireEvent.click(adjust);

    expect(window.location.search).not.toContain("sid=");
    expect(screen.getAllByText(/What are you using this stablecoin for/i).length).toBeGreaterThan(0);

    vi.unstubAllGlobals();
  });
});

describe("SelectorClient — adjust flow", () => {
  it("Adjust answers returns to Q1 with answers preserved in URL", async () => {
    setUrlSearch("p=treasury&h=6mplus&d=zero&v=custody&step=result");
    render(<SelectorClient />);

    const adjust = await screen.findByText(/Adjust answers/i);
    fireEvent.click(adjust);
    expect(screen.getAllByText(/What are you using this stablecoin for/i).length).toBeGreaterThan(0);
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
    expect((await screen.findAllByText(/Where will you put it to work/i)).length).toBeGreaterThan(0);

    // Tick a checkbox; the URL stays on step 5 and the exit prompt does NOT appear.
    const checkbox = screen.getByLabelText(/Lending and structured opportunities/i);
    fireEvent.click(checkbox);

    expect(screen.queryByText(/how fast do you need to be out/i)).toBeNull();
    expect(window.location.search).toContain("step=5");
  });
});
