// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { readFileSync } from "node:fs";
import { compile } from "tailwindcss";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PortfolioClient } from "./client";
import PortfolioPage from "./page";
import type { ReportCardsV9Response } from "@shared/types/report-cards-v9-current";
import { makeReportCardsV9Response, makeV9Card } from "@/test/fixtures/safety-score-v9";
import { makeReportCardsV9PartialCard, makeReportCardsV9PipelineGapCard } from "@shared/test-utils/report-cards-v9";

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
  data: ReportCardsV9Response | undefined;
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
const bootstrapScript = readFileSync("public/portfolio-bootstrap.js", "utf8");

vi.mock("@/hooks/api-hooks", () => ({
  useReportCardsV9Table: (options: { enabled: boolean }) => {
    reportQueryOptions(options);
    return { ...reportCardsState, refetch: vi.fn() };
  },
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
  CoinSelector: () => <div>coin-selector</div>,
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

vi.mock("@/components/portfolio-empty-state", () => ({
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
    shareUrl: vi.fn(() => "https://pharos.watch/portfolio/"),
  };
}

describe("PortfolioClient URL sync", () => {

  beforeEach(() => {
    portfolioState = basePortfolioState();
    reportCardsState.data = undefined;
    reportCardsState.isLoading = false;
    reportQueryOptions.mockClear();
    window.history.replaceState(null, "", "/portfolio/");
  });

  it("renders the empty editor without requesting report cards", () => {
    reportCardsState.isLoading = true;
    render(<PortfolioClient />);
    expect(reportQueryOptions).toHaveBeenLastCalledWith({ enabled: false });
    expect(screen.getByText("coin-selector")).toBeTruthy();
    expect(screen.getByText("portfolio-empty-state")).toBeTruthy();
  });

  it("uses Economic Control in the live subtotals and the empty preview", async () => {
    portfolioState = { ...basePortfolioState(), holdings: [{ coinId: "usdc-circle", amount: 100 }], totalUsd: 100 };
    reportCardsState.data = makeReportCardsV9Response({ cards: [makeV9Card({ id: "usdc-circle" })] });
    render(<PortfolioClient />);
    expect(screen.getByText("Economic Control")).toBeTruthy();

    const { PortfolioEmptyState } = await vi.importActual<typeof import("@/components/portfolio-empty-state")>("@/components/portfolio-empty-state");
    const preview = renderToStaticMarkup(<PortfolioEmptyState presets={[]} onApplyPreset={() => {}} />);
    expect(preview).toContain(">Economic Control</span>");
    expect(preview).toContain("Backing, Exit and Economic Control subtotals");
    expect(preview).not.toContain("Economic control");
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
    expect(screen.queryByText(/Weighted V10 safety aggregate/)).toBeNull();
  });

  it.each([false, true])("normalizes legacy URL holdings (retained %s)", async (retained) => {
    portfolioState.holdings = retained ? [{ coinId: "usdt-tether", amount: 25 }] : [];
    window.history.replaceState(null, "", "/portfolio/?p=1:25");

    render(<PortfolioClient />);

    await waitFor(() => {
      expect(window.location.search).toBe(retained ? "?p=usdt-tether%3A25" : "");
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
    expect(screen.getByText("Known-only weighted V10 safety subtotal")).toBeTruthy();
    expect(screen.getByText("exit · known-only subtotal").parentElement?.textContent).toContain("60/100");
    expect(screen.getByText("exit · known-only subtotal").parentElement?.textContent).toContain("100 USD of 400 USD");
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
