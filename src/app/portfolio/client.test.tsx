// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { readFileSync } from "node:fs";
import { compile } from "tailwindcss";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PORTFOLIO_PRESETS } from "./presets";
import { PortfolioClient } from "./client";
import PortfolioPage from "./page";
import type { ReportCardsV9Response } from "@shared/types/report-cards-v9-current";
import type { ReportCardsV9TableResponse } from "@shared/types/report-cards-v9-projections";
import { projectV9Table } from "@shared/lib/report-cards-v9-projections";
import { makeReportCardsV9Response, makeV9Card } from "@/test/fixtures/safety-score-v9";
import { makeReportCardsV9PartialCard, makeReportCardsV9PipelineGapCard } from "@shared/test-utils/report-cards-v9";
import { mutateWatchlist } from "@/lib/watchlist-storage";

type Holding = { coinId: string; amount: number };
let portfolioState: {
  holdings: Holding[]; initialized: boolean; totalUsd: number;
  addCoin: ReturnType<typeof vi.fn>; clearAll: ReturnType<typeof vi.fn>;
  removeCoin: ReturnType<typeof vi.fn>; setAmount: ReturnType<typeof vi.fn>;
  shareUrl: ReturnType<typeof vi.fn>;
};

const reportCardsState: {
  data: ReportCardsV9Response | ReportCardsV9TableResponse | undefined;
  isLoading: boolean; dataUpdatedAt: number; error: Error | null; meta: Record<string, unknown>;
} = { data: undefined, isLoading: false, dataUpdatedAt: 0, error: null, meta: {} };
const reportQueryOptions = vi.hoisted(() => vi.fn());
const coinStates = vi.hoisted(() => ({ byId: new Map() as ReadonlyMap<string, readonly unknown[]> }));
const copyTextMock = vi.hoisted(() => vi.fn());
const bootstrapScript = readFileSync("public/portfolio-bootstrap.js", "utf8");
const runBootstrap = () => { new Function(bootstrapScript)(); };
const emptyAttr = () => document.documentElement.hasAttribute("data-portfolio-empty");
const clearEmptyAttr = () => document.documentElement.removeAttribute("data-portfolio-empty");
const setPath = (path: string) => window.history.replaceState(null, "", path);
const USDC = "usdc-circle";
const USDT = "usdt-tether";
const h = (coinId: string, amount: number): Holding => ({ coinId, amount });
const res = (...cards: ReturnType<typeof makeV9Card>[]) => makeReportCardsV9Response({ cards });

vi.mock("@/hooks/api-hooks", () => ({
  useReportCardsV9Table: (options: { enabled: boolean }) => { reportQueryOptions(options); return { ...reportCardsState, refetch: vi.fn() }; },
}));
vi.mock("@/hooks/use-coin-states", () => ({ useCoinStates: () => ({ byId: coinStates.byId, liveReady: true }) }));
vi.mock("@/lib/clipboard", () => ({ copyText: (...args: unknown[]) => copyTextMock(...args) }));
vi.mock("@/lib/logos", () => ({ logosById: {} }));
vi.mock("@/hooks/use-portfolio", () => ({ usePortfolio: () => portfolioState }));
vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }));
vi.mock("@/components/ui/card", () => {
  const Box = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return { Card: Box, CardContent: Box, CardHeader: Box, CardTitle: Box };
});
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}));
vi.mock("@/components/ui/skeleton", () => ({ Skeleton: () => <div>skeleton</div> }));
vi.mock("@/components/coin-selector", () => ({
  CoinSelector: ({ onSelect }: { onSelect: (coin: { id: string }) => void }) => (
    <button type="button" onClick={() => onSelect({ id: "usdc-circle" })}>coin-selector</button>
  ),
}));
vi.mock("@/components/stablecoin-logo", () => ({ StablecoinLogo: ({ name }: { name: string }) => <div>{name}</div> }));
vi.mock("@/components/stale-data-banner", () => ({ StaleDataBanner: () => null }));
vi.mock("@/components/query-error-notice", () => ({ QueryErrorNotice: () => null }));
vi.mock("@/components/portfolio/portfolio-empty-state", () => ({ PortfolioEmptyState: () => <div>portfolio-empty-state</div> }));

function basePortfolioState(holdings: Holding[] = [], initialized = true): typeof portfolioState {
  return {
    holdings, initialized, totalUsd: holdings.reduce((sum, h) => sum + h.amount, 0),
    addCoin: vi.fn(), clearAll: vi.fn(), removeCoin: vi.fn(), setAmount: vi.fn(),
    shareUrl: vi.fn(() => "https://pharos.watch/portfolio/?p=usdc-circle:100"),
  };
}

function renderPortfolio(
  holdings: Holding[] = [],
  data?: ReportCardsV9Response | ReportCardsV9TableResponse,
  opts: { isLoading?: boolean; initialized?: boolean; scenarioCoinIds?: readonly string[] } = {},
) {
  portfolioState = basePortfolioState(holdings, opts.initialized ?? true);
  reportCardsState.data = data;
  reportCardsState.isLoading = opts.isLoading ?? false;
  return render(<PortfolioClient scenarioCoinIds={opts.scenarioCoinIds} />);
}

describe("PortfolioClient URL sync and risk workspace", () => {
  beforeEach(() => {
    portfolioState = basePortfolioState();
    reportCardsState.data = undefined;
    reportCardsState.isLoading = false;
    reportQueryOptions.mockClear();
    copyTextMock.mockReset().mockResolvedValue({ ok: true });
    coinStates.byId = new Map();
    mutateWatchlist(() => []);
    window.localStorage.clear();
    setPath("/portfolio/");
  });

  afterEach(() => {
    vi.useRealTimers();
    mutateWatchlist(() => []);
    window.localStorage.clear();
  });

  it("leads with exceptional holdings and names what known-only subtotals leave out", () => {
    coinStates.byId = new Map([[USDC, [{ kind: "dews", band: "ALERT" }]], [USDT, [{ kind: "critical", notice: { type: "danger", title: "Halted" } }]]]);
    renderPortfolio([h(USDC, 100), h(USDT, 300)], res(makeV9Card({ id: USDC }), makeReportCardsV9PipelineGapCard("control", "A", { id: USDT })));
    const callout = screen.getByRole("region", { name: "Holdings in an exceptional state" });
    expect(within(callout).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["USDT$300Critical notice · Halted", "USDC$100DEWS Alert"]);
    screen.getByText("Sum of your entered amounts at face value, not live prices");
    expect(screen.getByText("Exit · known-only subtotal").parentElement?.parentElement?.textContent).toContain("100 USD of 400 USD · excludes USDT");
    expect(screen.queryByRole("region", { name: /Failure scenarios for your holdings/i })).toBeNull();
  });

  it("drops the Modelable stablecoins empty hero and surfaces starter mixes without requesting report cards", () => {
    renderPortfolio([], undefined, { isLoading: true });
    expect(reportQueryOptions).toHaveBeenLastCalledWith({ enabled: false });
    expect(screen.queryByText(/Modelable stablecoins/i)).toBeNull();
    expect(screen.getByRole("group", { name: "Starter mixes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "CeFi Core" })).toBeTruthy();
    expect(screen.getByText("coin-selector")).toBeTruthy();
    expect(screen.getByText("portfolio-empty-state")).toBeTruthy();
  });

  it("shows Import my Watchlist (N) when starred coins exist and imports them into the portfolio", () => {
    mutateWatchlist(() => [USDC, USDT]);
    renderPortfolio();
    fireEvent.click(screen.getByRole("button", { name: /Import my Watchlist \(2\)/i }));
    expect(portfolioState.addCoin).toHaveBeenCalledWith(USDC, 0);
    expect(portfolioState.addCoin).toHaveBeenCalledWith(USDT, 0);
  });

  it("auto-focuses newly added holding inputs, debounces amount edits, and shows live % weights", () => {
    vi.useFakeTimers();
    const { rerender } = renderPortfolio([h(USDC, 750), h(USDT, 250)]);
    expect(screen.getByLabelText("USDC portfolio weight 75.0%").textContent).toBe("75.0%");
    expect(screen.getByLabelText("USDT portfolio weight 25.0%").textContent).toBe("25.0%");

    fireEvent.click(screen.getByRole("button", { name: "coin-selector" }));
    rerender(<PortfolioClient />);
    const usdcInput = screen.getByLabelText("Amount in USD for USD Coin");
    expect(document.activeElement).toBe(usdcInput);

    fireEvent.focus(usdcInput);
    fireEvent.change(usdcInput, { target: { value: "1250" } });
    expect(portfolioState.setAmount).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(260); });
    expect(portfolioState.setAmount).toHaveBeenCalledWith(USDC, 1250);
  });

  it("renders grouped dependencyExposure[], concentration strips, and outbound Compare / Dependency / Telegram links", () => {
    const table = projectV9Table(res(makeV9Card({ id: "dai-makerdao", score: 85 }), makeV9Card({ id: "frax-frax", score: 75 }), makeV9Card({ id: USDC, score: 90 })));
    table.dependencyGraph = {
      edges: [
        { from: USDC, to: "dai-makerdao", kind: "basket", weight: 0.25, upstreamScore: 90, materiality: "basket-weighted" },
        { from: USDC, to: "frax-frax", kind: "basket", weight: null, upstreamScore: 90, materiality: "basket-bounded-unknown" },
      ],
    };
    renderPortfolio([h("dai-makerdao", 6000), h("frax-frax", 4000)], table, { scenarioCoinIds: ["dai-makerdao", USDC] });

    const upstreamList = screen.getByRole("list", { name: "Upstream collateral exposure by asset" });
    for (const text of ["USDC", "$1,500", "15.0%", "+1 unmeasured route", "DAI", "FRAX"]) {
      expect(upstreamList.textContent).toContain(text);
    }
    expect(within(upstreamList).getByRole("link", { name: /Trace on Dependency Map/i }).getAttribute("href"))
      .toMatch(/^\/dependency-map\/?\?mode=exposure&root=usdc-circle$/);

    for (const id of ["freeze", "governance", "custody", "peg"]) {
      expect(screen.getByTestId(`portfolio-concentration-${id}`)).toBeTruthy();
    }
    expect(screen.getByRole("link", { name: /Compare holdings/i }).getAttribute("href")).toMatch(/^\/compare\/?\?coins=dai-makerdao,frax-frax$/);
    expect(screen.getByRole("link", { name: /Trace upstream risks/i }).getAttribute("href")).toMatch(/^\/dependency-map\/?\?mode=exposure&root=usdc-circle$/);
    const scenarios = screen.getByRole("region", { name: /Failure scenarios for your holdings/i });
    expect(within(scenarios).getAllByRole("link").map((el) => el.getAttribute("href")?.replace(/\/(?=#|$)/, "")))
      .toEqual(["/learn/scenarios", "/stablecoin/dai-makerdao#how-it-breaks"]);
    expect(screen.getByRole("heading", { name: "Follow book in Telegram" })).toBeTruthy();
    expect(screen.getByText("/subscribe dews, depeg, safety DAI, FRAX")).toBeTruthy();
    expect(screen.queryByText(/V10|V9/)).toBeNull();
  });

  it("uses an inline share fallback instead of window.prompt when clipboard access fails", async () => {
    const promptSpy = vi.spyOn(window, "prompt").mockImplementation(() => null);
    copyTextMock.mockResolvedValue({ ok: false });
    renderPortfolio([h(USDC, 100)]);
    fireEvent.click(screen.getByRole("button", { name: /Share/i }));

    const fallbackRegion = await screen.findByRole("region", { name: "Shareable portfolio link" });
    expect(within(fallbackRegion).getByDisplayValue("https://pharos.watch/portfolio/?p=usdc-circle:100")).toBeTruthy();
    expect(promptSpy).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  it("uses Economic Control in the live subtotals and the empty preview without V10 prefixes", async () => {
    renderPortfolio([h(USDC, 100)], res(makeV9Card({ id: USDC })));
    expect(screen.getByText("Economic Control")).toBeTruthy();
    expect(screen.getByText("Weighted safety aggregate")).toBeTruthy();

    const { PortfolioEmptyState } = await vi.importActual<typeof import("@/components/portfolio/portfolio-empty-state")>("@/components/portfolio/portfolio-empty-state");
    const preview = renderToStaticMarkup(<PortfolioEmptyState presets={[]} onApplyPreset={() => {}} />);
    expect(preview).toContain("Economic Control");
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
    setPath(`/portfolio/${search}`);
    window.localStorage.setItem("pharos:portfolio", stored);
    const html = renderToString(<PortfolioPage />);
    expect(html).toContain("portfolio-empty-state");
    expect(html).toContain("Add holdings manually or load a starter mix below.");
    expect(html).not.toContain("<!--$");
    if (runs) runBootstrap();
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
    clearEmptyAttr();
    expect(reportQueryOptions).toHaveBeenLastCalledWith({ enabled: false });
  });

  it("stops using the pre-paint selector once holdings initialize", () => {
    document.documentElement.setAttribute("data-portfolio-empty", "");
    const { container, rerender } = renderPortfolio([], undefined, { initialized: false });
    const root = container.firstElementChild;
    expect(container.children).toHaveLength(1);
    portfolioState = basePortfolioState([h(USDC, 100)]);
    rerender(<PortfolioClient />);
    expect(container.firstElementChild).toBe(root);
    expect(container.innerHTML).not.toContain("data-portfolio-empty");
    expect(screen.queryByText("portfolio-empty-state")).toBeNull();
    expect(screen.getByText("Total portfolio value")).toBeTruthy();
    clearEmptyAttr();
  });

  it("keeps holdings editable while risk enrichment is pending", () => {
    renderPortfolio([h(USDC, 100)], undefined, { isLoading: true });
    expect(reportQueryOptions).toHaveBeenLastCalledWith({ enabled: true });
    expect(screen.getByText("coin-selector")).toBeTruthy();
    expect(screen.getByText("Loading holdings safety evidence…")).toBeTruthy();
    expect(screen.queryByText(/Weighted safety aggregate/)).toBeNull();
  });

  it.each([false, true])("normalizes legacy URL holdings (retained %s)", async (retained) => {
    setPath("/portfolio/?p=1:25");
    renderPortfolio(retained ? [h(USDT, 25)] : []);
    await waitFor(() => expect(window.location.search).toBe(retained ? "?p=usdt-tether%3A25" : ""));
  });

  it("consumes ?coins= handoff into ?p= and clears ?coins= when holdings are removed or cleared", async () => {
    setPath("/portfolio/?coins=usdc-circle,usdt-tether");
    const { rerender } = renderPortfolio([h(USDC, 0), h(USDT, 0)]);

    for (const [next, expectedP] of [
      [null, "usdc-circle:0,usdt-tether:0"],
      [[h(USDT, 0)], "usdt-tether:0"],
      [[], null],
    ] as const) {
      if (next !== null) {
        portfolioState = basePortfolioState([...next]);
        rerender(<PortfolioClient />);
      }
      await waitFor(() => {
        if (expectedP === null) expect(window.location.search).toBe("");
        else {
          const params = new URLSearchParams(window.location.search);
          expect(params.has("coins")).toBe(false);
          expect(params.get("p")).toBe(expectedP);
        }
      });
    }
  });

  it("labels partial score and pillar averages by their own known-only holding coverage", () => {
    const base = makeV9Card().pillars;
    const complete = makeV9Card({ id: USDC, score: 80, pillars: { ...base, backing: { ...base.backing, score: 80 }, exit: { ...base.exit, score: 60 }, control: { ...base.control, score: 80 } } });
    const pp = makeReportCardsV9PartialCard("exit", "B").pillars;
    const partial = makeReportCardsV9PartialCard("exit", "B", { id: USDT, score: 90, pillars: { ...pp, backing: { ...pp.backing, score: 90 }, control: { ...pp.control, score: 90 } } });
    renderPortfolio([h(USDC, 100), h(USDT, 300)], res(complete, partial));

    expect(screen.getByText("Known-only weighted safety subtotal")).toBeTruthy();
    const exitCard = screen.getByText("Exit · known-only subtotal").parentElement?.parentElement;
    expect(exitCard?.textContent).toContain("60/100");
    expect(exitCard?.textContent).toContain("100 USD of 400 USD");
    expect(screen.getByText("Exit excluded · awaiting curation").getAttribute("title")).toBe(
      "Exit is left out of the score for now (public data awaiting curation); the measured pillars carry the weight.",
    );
    expect(screen.queryByText("15/100")).toBeNull();
  });

  it("does not manufacture a grade or aggregate when every holding has a Pipeline gap", () => {
    renderPortfolio([h(USDC, 100)], res(makeReportCardsV9PipelineGapCard("control", "A", { id: USDC })));
    expect(screen.getByText("Pipeline gap")).toBeTruthy();
    expect(screen.getAllByText("Unavailable")).toHaveLength(3);
    expect(screen.getByText(/Pipeline gap · fewer than two pillars available/)).toBeTruthy();
    expect(screen.queryByText(/NR|0\/100|100\/100/)).toBeNull();
  });

  it("keeps every carded holding's grade visible when one holding has no card", () => {
    renderPortfolio([h(USDC, 100), h("usdv-solomon", 300)], res(makeV9Card({ id: USDC, score: 80 })));
    expect(screen.getByRole("alert").textContent).toContain("portfolio-card-unavailable");
    expect(screen.getByLabelText("Safety grade A-, score 80")).toBeTruthy();
  });

  it("computes a weighted safety aggregate for Treasury Heavy and labels manually held funds as ungraded", () => {
    const treasury = PORTFOLIO_PRESETS.find((preset) => preset.title === "Treasury Heavy")!;
    const cards = [...treasury.holdings]
      .sort((a, b) => a.coinId.localeCompare(b.coinId))
      .map((holding) => makeV9Card({ id: holding.coinId, score: 80 }));
    const view = renderPortfolio([...treasury.holdings], res(...cards));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(view.container.textContent).not.toContain("portfolio-card-not-rated");
    view.unmount();

    const fundCard = makeV9Card({ id: "buidl-blackrock", grade: "NR", score: null, ratingStatus: "not-rated" });
    renderPortfolio([h("buidl-blackrock", 100)], res(fundCard));
    expect(screen.getByText("Tokenized fund · not graded")).toBeTruthy();
    expect(screen.queryByLabelText("Safety grade NR")).toBeNull();
  });
});

describe("portfolio pre-paint selector", () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearEmptyAttr();
    setPath("/portfolio/");
  });

  it.each([null, "[]", "not json", "{}"])("keeps the static empty state for storage %s", (stored) => {
    if (stored !== null) window.localStorage.setItem("pharos:portfolio", stored);
    runBootstrap();
    expect(emptyAttr()).toBe(true);
  });

  it.each(["", "?p=usdc-circle:100", "?coins=usdc-circle"])("hides the empty state for saved/shared holdings (%s)", (search) => {
    setPath(`/portfolio/${search}`);
    if (!search) window.localStorage.setItem("pharos:portfolio", '[{"coinId":"usdc-circle","amount":100}]');
    runBootstrap();
    expect(emptyAttr()).toBe(false);
  });

  it("keeps first visits visible when storage access is blocked", () => {
    const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    try {
      expect(runBootstrap).not.toThrow();
      expect(emptyAttr()).toBe(true);
      setPath("/portfolio/?p=usdc-circle:100");
      runBootstrap();
      expect(emptyAttr()).toBe(false);
    } finally {
      read.mockRestore();
      clearEmptyAttr();
    }
  });
});
