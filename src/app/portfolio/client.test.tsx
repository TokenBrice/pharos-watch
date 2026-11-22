// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { readFileSync } from "node:fs";
import { compile } from "tailwindcss";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PortfolioClient } from "./client";
import PortfolioPage from "./page";
import type { ReportCardsV9Response } from "@shared/types/report-cards-v9-current";
import type { ReportCardsV9TableResponse } from "@shared/types/report-cards-v9-projections";
import { projectV9Table } from "@shared/lib/report-cards-v9-projections";
import { makeReportCardsV9Response, makeV9Card } from "@/test/fixtures/safety-score-v9";
import { makeReportCardsV9PartialCard, makeReportCardsV9PipelineGapCard } from "@shared/test-utils/report-cards-v9";
import { mutateWatchlist } from "@/lib/watchlist-storage";

let portfolioState: {
  holdings: Array<{ coinId: string; amount: number }>;
  initialized: boolean;
  totalUsd: number;
  addCoin: ReturnType<typeof vi.fn>;
  clearAll: ReturnType<typeof vi.fn>;
  removeCoin: ReturnType<typeof vi.fn>;
  setAmount: ReturnType<typeof vi.fn>;
  shareUrl: ReturnType<typeof vi.fn>;
};

const reportCardsState: {
  data: ReportCardsV9Response | ReportCardsV9TableResponse | undefined;
  isLoading: boolean;
  dataUpdatedAt: number;
  error: Error | null;
  meta: Record<string, unknown>;
} = {
  data: undefined,
  isLoading: false,
  dataUpdatedAt: 0,
  error: null,
  meta: {},
};
const reportQueryOptions = vi.hoisted(() => vi.fn());
const coinStates = vi.hoisted(() => ({ byId: new Map() as ReadonlyMap<string, readonly unknown[]> }));
const copyTextMock = vi.hoisted(() => vi.fn());
const bootstrapScript = readFileSync("public/portfolio-bootstrap.js", "utf8");

vi.mock("@/hooks/api-hooks", () => ({
  useReportCardsV9Table: (options: { enabled: boolean }) => {
    reportQueryOptions(options);
    return { ...reportCardsState, refetch: vi.fn() };
  },
}));

vi.mock("@/hooks/use-coin-states", () => ({
  useCoinStates: () => ({ byId: coinStates.byId, liveReady: true }),
}));

vi.mock("@/lib/clipboard", () => ({
  copyText: (...args: unknown[]) => copyTextMock(...args),
}));

vi.mock("@/lib/logos", () => ({
  logosById: {},
}));

vi.mock("@/hooks/use-portfolio", () => ({
  usePortfolio: () => portfolioState,
}));

vi.mock("@/lib/analytics", () => ({
  trackEvent: vi.fn(),
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}));

vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: () => <div>skeleton</div>,
}));

vi.mock("@/components/coin-selector", () => ({
  CoinSelector: ({ onSelect }: { onSelect: (coin: { id: string }) => void }) => (
    <button type="button" onClick={() => onSelect({ id: "usdc-circle" })}>
      coin-selector
    </button>
  ),
}));

vi.mock("@/components/stablecoin-logo", () => ({
  StablecoinLogo: ({ name }: { name: string }) => <div>{name}</div>,
}));

vi.mock("@/components/stale-data-banner", () => ({
  StaleDataBanner: () => null,
}));

vi.mock("@/components/query-error-notice", () => ({
  QueryErrorNotice: () => null,
}));

vi.mock("@/components/portfolio/portfolio-empty-state", () => ({
  PortfolioEmptyState: () => <div>portfolio-empty-state</div>,
}));

function basePortfolioState(): typeof portfolioState {
  return {
    holdings: [],
    initialized: true,
    totalUsd: 0,
    addCoin: vi.fn(),
    clearAll: vi.fn(),
    removeCoin: vi.fn(),
    setAmount: vi.fn(),
    shareUrl: vi.fn(() => "https://pharos.watch/portfolio/?p=usdc-circle:100"),
  };
}

describe("PortfolioClient URL sync and risk workspace", () => {
  beforeEach(() => {
    portfolioState = basePortfolioState();
    reportCardsState.data = undefined;
    reportCardsState.isLoading = false;
    reportQueryOptions.mockClear();
    copyTextMock.mockReset();
    copyTextMock.mockResolvedValue({ ok: true });
    coinStates.byId = new Map();
    mutateWatchlist(() => []);
    window.localStorage.clear();
    window.history.replaceState(null, "", "/portfolio/");
  });

  afterEach(() => {
    vi.useRealTimers();
    mutateWatchlist(() => []);
    window.localStorage.clear();
  });

  it("leads with exceptional holdings and names what known-only subtotals leave out", () => {
    coinStates.byId = new Map([["usdc-circle", [{ kind: "dews", band: "ALERT" }]], ["usdt-tether", [{ kind: "critical", notice: { type: "danger", title: "Halted" } }]]]);
    portfolioState = { ...basePortfolioState(), holdings: [{ coinId: "usdc-circle", amount: 100 }, { coinId: "usdt-tether", amount: 300 }], totalUsd: 400 };
    reportCardsState.data = makeReportCardsV9Response({ cards: [makeV9Card({ id: "usdc-circle" }), makeReportCardsV9PipelineGapCard("control", "A", { id: "usdt-tether" })] });
    render(<PortfolioClient />);
    const callout = screen.getByRole("region", { name: "Holdings in an exceptional state" });
    expect(within(callout).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["USDT$300Critical notice · Halted", "USDC$100DEWS Alert"]);
    screen.getByText("Sum of your entered amounts at face value, not live prices");
    const exitLabel = screen.getByText("Exit · known-only subtotal");
    expect(exitLabel.parentElement?.parentElement?.textContent).toContain("100 USD of 400 USD · excludes USDT");
  });

  it("drops the Modelable stablecoins empty hero and surfaces starter mixes above the fold without requesting report cards", () => {
    reportCardsState.isLoading = true;
    render(<PortfolioClient />);
    expect(reportQueryOptions).toHaveBeenLastCalledWith({ enabled: false });
    expect(screen.queryByText(/Modelable stablecoins/i)).toBeNull();
    expect(screen.getByRole("group", { name: "Starter mixes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "CeFi Core" })).toBeTruthy();
    expect(screen.getByText("coin-selector")).toBeTruthy();
    expect(screen.getByText("portfolio-empty-state")).toBeTruthy();
  });

  it("shows Import my Watchlist (N) when starred coins exist and imports them into the portfolio", () => {
    mutateWatchlist(() => ["usdc-circle", "usdt-tether"]);

    render(<PortfolioClient />);

    const importButton = screen.getByRole("button", { name: /Import my Watchlist \(2\)/i });
    fireEvent.click(importButton);
    expect(portfolioState.addCoin).toHaveBeenCalledWith("usdc-circle", 0);
    expect(portfolioState.addCoin).toHaveBeenCalledWith("usdt-tether", 0);
  });

  it("auto-focuses newly added holding inputs, debounces amount edits, and shows live % weights", () => {
    vi.useFakeTimers();
    portfolioState = {
      ...basePortfolioState(),
      holdings: [
        { coinId: "usdc-circle", amount: 750 },
        { coinId: "usdt-tether", amount: 250 },
      ],
      totalUsd: 1000,
    };
    const { rerender } = render(<PortfolioClient />);

    expect(screen.getByLabelText("USDC portfolio weight 75.0%").textContent).toBe("75.0%");
    expect(screen.getByLabelText("USDT portfolio weight 25.0%").textContent).toBe("25.0%");

    // Simulate adding USDC via CoinSelector to trigger auto-focus on its amount input.
    fireEvent.click(screen.getByRole("button", { name: "coin-selector" }));
    rerender(<PortfolioClient />);
    const usdcInput = screen.getByLabelText("Amount in USD for USD Coin");
    expect(document.activeElement).toBe(usdcInput);

    // Type a new USD amount and verify smooth debounced commit.
    fireEvent.focus(usdcInput);
    fireEvent.change(usdcInput, { target: { value: "1250" } });
    expect(portfolioState.setAmount).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(260);
    });
    expect(portfolioState.setAmount).toHaveBeenCalledWith("usdc-circle", 1250);
  });

  it("renders grouped dependencyExposure[], concentration strips, and outbound Compare / Dependency / Telegram links", () => {
    portfolioState = {
      ...basePortfolioState(),
      holdings: [
        { coinId: "dai-makerdao", amount: 6000 },
        { coinId: "frax-frax", amount: 4000 },
      ],
      totalUsd: 10_000,
    };
    const table = projectV9Table(
      makeReportCardsV9Response({
        cards: [
          makeV9Card({ id: "dai-makerdao", score: 85 }),
          makeV9Card({ id: "frax-frax", score: 75 }),
          makeV9Card({ id: "usdc-circle", score: 90 }),
        ],
      }),
    );
    table.dependencyGraph = {
      edges: [
        {
          from: "usdc-circle",
          to: "dai-makerdao",
          kind: "basket",
          weight: 0.25,
          upstreamScore: 90,
          materiality: "basket-weighted",
        },
        {
          from: "usdc-circle",
          to: "frax-frax",
          kind: "basket",
          weight: null,
          upstreamScore: 90,
          materiality: "basket-bounded-unknown",
        },
      ],
    };
    reportCardsState.data = table;

    render(<PortfolioClient />);

    // Upstream exposure breakdown grouped by upstream coin
    const upstreamList = screen.getByRole("list", { name: "Upstream collateral exposure by asset" });
    expect(upstreamList.textContent).toContain("USDC");
    expect(upstreamList.textContent).toContain("$1,500");
    expect(upstreamList.textContent).toContain("15.0%");
    expect(upstreamList.textContent).toContain("+1 unmeasured route");
    expect(upstreamList.textContent).toContain("DAI");
    expect(upstreamList.textContent).toContain("FRAX");
    const mapLink = within(upstreamList).getByRole("link", { name: /Trace on Dependency Map/i });
    expect(mapLink.getAttribute("href")).toMatch(/^\/dependency-map\/?\?mode=exposure&root=usdc-circle$/);

    // Concentration strips
    expect(screen.getByTestId("portfolio-concentration-freeze")).toBeTruthy();
    expect(screen.getByTestId("portfolio-concentration-governance")).toBeTruthy();
    expect(screen.getByTestId("portfolio-concentration-custody")).toBeTruthy();
    expect(screen.getByTestId("portfolio-concentration-peg")).toBeTruthy();

    // Outbound cross-tool actions
    expect(screen.getByRole("link", { name: /Compare holdings/i }).getAttribute("href")).toMatch(
      /^\/compare\/?\?coins=dai-makerdao,frax-frax$/,
    );
    expect(screen.getByRole("link", { name: /Trace upstream risks/i }).getAttribute("href")).toMatch(
      /^\/dependency-map\/?\?mode=exposure&root=usdc-circle$/,
    );
    expect(screen.getByRole("heading", { name: "Follow book in Telegram" })).toBeTruthy();
    expect(screen.getByText("/subscribe dews, depeg, safety dai-makerdao, frax-frax")).toBeTruthy();

    // No V9/V10 engine prefixes in reader-facing copy
    expect(screen.queryByText(/V10|V9/)).toBeNull();
  });

  it("uses an inline share fallback instead of window.prompt when clipboard access fails", async () => {
    const promptSpy = vi.spyOn(window, "prompt").mockImplementation(() => null);
    copyTextMock.mockResolvedValue({ ok: false });
    portfolioState = {
      ...basePortfolioState(),
      holdings: [{ coinId: "usdc-circle", amount: 100 }],
      totalUsd: 100,
    };

    render(<PortfolioClient />);
    fireEvent.click(screen.getByRole("button", { name: /Share/i }));

    const fallbackRegion = await screen.findByRole("region", { name: "Shareable portfolio link" });
    expect(within(fallbackRegion).getByDisplayValue("https://pharos.watch/portfolio/?p=usdc-circle:100")).toBeTruthy();
    expect(promptSpy).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  it("uses Economic Control in the live subtotals and the empty preview without V10 prefixes", async () => {
    portfolioState = { ...basePortfolioState(), holdings: [{ coinId: "usdc-circle", amount: 100 }], totalUsd: 100 };
    reportCardsState.data = makeReportCardsV9Response({ cards: [makeV9Card({ id: "usdc-circle" })] });
    render(<PortfolioClient />);
    expect(screen.getByText("Economic Control")).toBeTruthy();
    expect(screen.getByText("Weighted safety aggregate")).toBeTruthy();

    const { PortfolioEmptyState } = await vi.importActual<typeof import("@/components/portfolio/portfolio-empty-state")>("@/components/portfolio/portfolio-empty-state");
    const preview = renderToStaticMarkup(<PortfolioEmptyState presets={[]} onApplyPreset={() => {}} />);
    expect(preview).toContain(">Economic Control</span>");
    expect(preview).toContain("Backing, Exit and Economic Control subtotals");
    expect(preview).not.toContain("Economic control");
    expect(preview).not.toContain("V10");
  });

  it.each([
    ["", "[]", true, true],
    ["", "[]", false, false],
    ["", '[{"coinId":"usdc-circle","amount":100}]', true, false],
    ["?p=usdc-circle:100", "[]", true, false],
    ["?coins=usdc-circle", "[]", true, false],
  ] as const)("prerenders safely (%s, %s, bootstrap %s)", async (search, stored, runs, firstVisit) => {
    portfolioState.initialized = false;
    window.history.replaceState(null, "", `/portfolio/${search}`);
    window.localStorage.setItem("pharos:portfolio", stored);
    const html = renderToString(<PortfolioPage />);
    expect(html).toContain("portfolio-empty-state");
    expect(html).toContain("Add holdings manually or load a starter mix below.");
    expect(html).not.toContain("<!--$");
    if (runs) new Function(bootstrapScript)();
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);
    const note = container.querySelector(".pharos-empty-note");
    const { rerender } = render(<PortfolioPage />, { container, hydrate: true });
    const empty = screen.getByText("portfolio-empty-state").parentElement!;
    const loading = empty.nextElementSibling!;
    const style = document.createElement("style");
    style.textContent = (await compile("@tailwind utilities;")).build([...empty.classList, ...loading.classList]);
    document.head.append(style);
    expect(getComputedStyle(empty).display).toBe(firstVisit ? "block" : "none");
    expect(getComputedStyle(loading).display).toBe(firstVisit ? "none" : "block");
    portfolioState.initialized = true;
    rerender(<PortfolioPage />);
    expect(container.querySelector(".pharos-empty-note")).toBe(note);
    expect(screen.getAllByText(/Add holdings manually/)).toHaveLength(1);
    style.remove();
    document.documentElement.removeAttribute("data-portfolio-empty");
    expect(reportQueryOptions).toHaveBeenLastCalledWith({ enabled: false });
  });

  it("stops using the pre-paint selector once holdings initialize", () => {
    portfolioState.initialized = false;
    document.documentElement.setAttribute("data-portfolio-empty", "");
    const { container, rerender } = render(<PortfolioClient />);
    const root = container.firstElementChild;
    expect(container.children).toHaveLength(1);
    portfolioState = { ...basePortfolioState(), holdings: [{ coinId: "usdc-circle", amount: 100 }] };
    rerender(<PortfolioClient />);
    expect(container.firstElementChild).toBe(root);
    expect(container.innerHTML).not.toContain("data-portfolio-empty");
    expect(screen.queryByText("portfolio-empty-state")).toBeNull();
    expect(screen.getByText("Total portfolio value")).toBeTruthy();
    document.documentElement.removeAttribute("data-portfolio-empty");
  });

  it("keeps holdings editable while risk enrichment is pending", () => {
    portfolioState = { ...basePortfolioState(), holdings: [{ coinId: "usdc-circle", amount: 100 }] };
    reportCardsState.isLoading = true;
    render(<PortfolioClient />);
    expect(reportQueryOptions).toHaveBeenLastCalledWith({ enabled: true });
    expect(screen.getByText("coin-selector")).toBeTruthy();
    expect(screen.getByText("Loading holdings safety evidence…")).toBeTruthy();
    expect(screen.queryByText(/Weighted safety aggregate/)).toBeNull();
  });

  it.each([false, true])("normalizes legacy URL holdings (retained %s)", async (retained) => {
    portfolioState.holdings = retained ? [{ coinId: "usdt-tether", amount: 25 }] : [];
    window.history.replaceState(null, "", "/portfolio/?p=1:25");

    render(<PortfolioClient />);

    await waitFor(() => {
      expect(window.location.search).toBe(retained ? "?p=usdt-tether%3A25" : "");
    });
  });

  it("consumes ?coins= handoff into ?p= and clears ?coins= when holdings are removed or cleared", async () => {
    window.history.replaceState(null, "", "/portfolio/?coins=usdc-circle,usdt-tether");
    portfolioState = {
      ...basePortfolioState(),
      holdings: [
        { coinId: "usdc-circle", amount: 0 },
        { coinId: "usdt-tether", amount: 0 },
      ],
    };

    const { rerender } = render(<PortfolioClient />);

    await waitFor(() => {
      const params = new URLSearchParams(window.location.search);
      expect(params.has("coins")).toBe(false);
      expect(params.get("p")).toBe("usdc-circle:0,usdt-tether:0");
    });

    portfolioState = {
      ...basePortfolioState(),
      holdings: [{ coinId: "usdt-tether", amount: 0 }],
    };
    rerender(<PortfolioClient />);
    await waitFor(() => {
      const params = new URLSearchParams(window.location.search);
      expect(params.has("coins")).toBe(false);
      expect(params.get("p")).toBe("usdt-tether:0");
    });

    portfolioState = {
      ...basePortfolioState(),
      holdings: [],
    };
    rerender(<PortfolioClient />);
    await waitFor(() => {
      expect(window.location.search).toBe("");
    });
  });

  it("labels partial score and pillar averages by their own known-only holding coverage", () => {
    portfolioState = { ...basePortfolioState(), holdings: [{ coinId: "usdc-circle", amount: 100 }, { coinId: "usdt-tether", amount: 300 }] };
    const complete = makeV9Card({ id: "usdc-circle", score: 80, pillars: {
      ...makeV9Card().pillars, backing: { ...makeV9Card().pillars.backing, score: 80 }, exit: { ...makeV9Card().pillars.exit, score: 60 }, control: { ...makeV9Card().pillars.control, score: 80 },
    } });
    const partialPillars = makeReportCardsV9PartialCard("exit", "B").pillars;
    const partial = makeReportCardsV9PartialCard("exit", "B", { id: "usdt-tether", score: 90,
      pillars: { ...partialPillars, backing: { ...partialPillars.backing, score: 90 }, control: { ...partialPillars.control, score: 90 } } });
    reportCardsState.data = makeReportCardsV9Response({ cards: [complete, partial] });
    render(<PortfolioClient />);
    expect(screen.getByText("Known-only weighted safety subtotal")).toBeTruthy();
    const exitCard = screen.getByText("Exit · known-only subtotal").parentElement?.parentElement;
    expect(exitCard?.textContent).toContain("60/100");
    expect(exitCard?.textContent).toContain("100 USD of 400 USD");
    const curationGap = screen.getByText("Exit excluded · awaiting curation");
    expect(curationGap.getAttribute("title")).toBe(
      "Exit is left out of the score for now (public data awaiting curation); the measured pillars carry the weight.",
    );
    expect(screen.queryByText("15/100")).toBeNull();
  });

  it("does not manufacture a grade or aggregate when every holding has a Pipeline gap", () => {
    portfolioState = { ...basePortfolioState(), holdings: [{ coinId: "usdc-circle", amount: 100 }] };
    reportCardsState.data = makeReportCardsV9Response({ cards: [makeReportCardsV9PipelineGapCard("control", "A", { id: "usdc-circle" })] });
    render(<PortfolioClient />);
    expect(screen.getByText("Pipeline gap")).toBeTruthy();
    expect(screen.getAllByText("Unavailable")).toHaveLength(3);
    expect(screen.getByText(/Pipeline gap · fewer than two pillars available/)).toBeTruthy();
    expect(screen.queryByText(/NR|0\/100|100\/100/)).toBeNull();
  });

  it("keeps every carded holding's grade visible when one holding has no card", () => {
    portfolioState = {
      ...basePortfolioState(),
      holdings: [
        { coinId: "usdc-circle", amount: 100 },
        { coinId: "usdv-solomon", amount: 300 },
      ],
    };
    reportCardsState.data = makeReportCardsV9Response({ cards: [makeV9Card({ id: "usdc-circle", score: 80 })] });
    render(<PortfolioClient />);
    expect(screen.getByRole("alert").textContent).toContain("portfolio-card-unavailable");
    expect(screen.getByLabelText("Safety grade A-, score 80")).toBeTruthy();
  });
});

describe("portfolio pre-paint selector", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-portfolio-empty");
    window.history.replaceState(null, "", "/portfolio/");
  });

  it.each([null, "[]", "not json", "{}"])("keeps the static empty state for storage %s", (stored) => {
    if (stored !== null) window.localStorage.setItem("pharos:portfolio", stored);
    new Function(bootstrapScript)();
    expect(document.documentElement.hasAttribute("data-portfolio-empty")).toBe(true);
  });

  it.each(["", "?p=usdc-circle:100", "?coins=usdc-circle"])("hides the empty state for saved/shared holdings (%s)", (search) => {
    window.history.replaceState(null, "", `/portfolio/${search}`);
    if (!search) window.localStorage.setItem("pharos:portfolio", '[{"coinId":"usdc-circle","amount":100}]');
    new Function(bootstrapScript)();
    expect(document.documentElement.hasAttribute("data-portfolio-empty")).toBe(false);
  });

  it("keeps first visits visible when storage access is blocked", () => {
    const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    try {
      expect(() => new Function(bootstrapScript)()).not.toThrow();
      expect(document.documentElement.hasAttribute("data-portfolio-empty")).toBe(true);
      window.history.replaceState(null, "", "/portfolio/?p=usdc-circle:100");
      new Function(bootstrapScript)();
      expect(document.documentElement.hasAttribute("data-portfolio-empty")).toBe(false);
    } finally {
      read.mockRestore();
      document.documentElement.removeAttribute("data-portfolio-empty");
    }
  });
});
