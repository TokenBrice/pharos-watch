// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { YieldLeaderboard } from "@/components/yield/yield-leaderboard";
import { YieldSourceSheet } from "@/components/yield/yield-source-sheet";
import { makeAltYieldSource as mkAlt, makeYieldProvenance as mkProv, makeYieldRanking as mkYRank } from "@shared/test-utils/yield-ranking-fixtures";
import type { YieldRanking } from "@shared/types/yield";
import { makeDeliveryOnlyYieldResponse } from "./yield-detail.test-support";
import { makeYieldViewModelRow, REGISTRY_WITH_EUR } from "./yield-test-support";

vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }));
const useRankMock = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/api-hooks", async (orig) => ({ ...await orig<typeof import("@/hooks/api-hooks")>(), useYieldRankings: useRankMock }));
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  SheetTrigger: ({ children }: { children: React.ReactNode }) => children,
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  SheetDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  SheetFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/yield/yield-history-chart", () => ({
  YieldHistoryChart: ({ externalSourceKey, benchmarkRate, benchmarkLabel }: { externalSourceKey: string; benchmarkRate: number | null; benchmarkLabel?: string }) => (
    <div data-testid="yield-history-chart" data-benchmark-rate={benchmarkRate} data-benchmark-label={benchmarkLabel}>{externalSourceKey}</div>
  ),
}));
vi.mock("@/components/stablecoin-logo", () => ({ StablecoinLogo: ({ name }: { name: string }) => <div>{name}</div> }));
vi.mock("@/components/yield/yield-source-risk-bar", () => ({
  YieldSourceRiskBar: ({ score }: { score: number | null }) => <div data-testid="yield-source-risk-bar">{score == null ? "unavailable" : String(score)}</div>,
}));

const renderSheet = (ranking: YieldRanking, ov: Partial<React.ComponentProps<typeof YieldSourceSheet>> = {}) =>
  render(<YieldSourceSheet ranking={ranking} logo={undefined} riskFreeRate={0.02} medianApy={0.03} open onOpenChange={vi.fn()} {...ov} />);
const mkRank = (id: string, best: string, alt: string): YieldRanking => mkYRank({
  id, symbol: id.toUpperCase(), name: id === "usdc" ? "USD Coin" : "Tether", yieldSource: `${id}-best`, yieldSourceUrl: `https://example.com/${id}/best`,
  provenance: mkProv({ sourceKey: best }),
  altSources: [mkAlt({ sourceKey: alt, yieldSource: `${id}-alt`, yieldSourceUrl: `https://example.com/${id}/alt`, apy30d: 0.04, currentApy: 0.04, sourceTvlUsd: 500_000 })],
});
const chart = () => screen.getByTestId("yield-history-chart");
const clickBtn = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));

describe("YieldSourceSheet", () => {
  let scrollDesc: PropertyDescriptor | undefined;
  beforeEach(() => { scrollDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView"); HTMLElement.prototype.scrollIntoView = vi.fn(); });
  afterEach(() => {
    if (scrollDesc) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scrollDesc);
    else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    vi.restoreAllMocks(); vi.useRealTimers();
  });

  it("withdraws delivery-only qualification in the open source sheet at the batch deadline", () => {
    vi.useFakeTimers({ now: 1_776_000_000_000 });
    const data = makeDeliveryOnlyYieldResponse();
    useRankMock.mockReturnValue({ data, dataUpdatedAt: Date.now() });
    render(<QueryClientProvider client={new QueryClient()}><YieldLeaderboard rows={[makeYieldViewModelRow(data.rankings[0])]} logos={{}} riskFreeRate={4.25} medianApy={4} scalingFactor={8} /></QueryClientProvider>);
    clickBtn("2 sources"); act(() => vi.advanceTimersByTime(50)); act(() => vi.advanceTimersByTime(1949));
    expect(screen.getByText("Partial evidence")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText("Partial evidence")).toBeNull(); expect(screen.getByText("Not rated")).toBeTruthy();
  });

  it("shows the advanced observation age rather than the publication-time age", () => {
    const r = mkRank("usdc", "selected", "alternate");
    r.sourceRisk = { sourceRiskScore: null, sourceRiskPenalty: null, sourceDepthRatio: null, rewardShare: null, sourceAgeSeconds: 14401, observationCount30d: null, sourceSwitchCount30d: null };
    r.provenance = mkProv({ sourceFreshness: "stale", sourceObservedAt: null, sourceAgeSeconds: 14401 });
    renderSheet(r);
    expect(screen.getAllByText(/4h ago/).length).toBeGreaterThan(0); expect(screen.queryByText(/0s ago/)).toBeNull();
  });

  it("keeps the sheet open through loading, error, retry, unavailable and loaded states", () => {
    const onRetry = vi.fn(), p = { logo: undefined, riskFreeRate: 3, medianApy: null, open: true, onOpenChange: vi.fn(), onRetry };
    const { rerender } = render(<YieldSourceSheet {...p} ranking={null} loading />);
    expect(screen.getByRole("heading", { name: "Yield source details" })).toBeTruthy(); expect(screen.queryByRole("status")).toBeNull();
    rerender(<YieldSourceSheet {...p} ranking={null} error={new Error("source fetch failed")} />);
    expect(screen.getByRole("heading", { name: "Yield source details" })).toBeTruthy();
    clickBtn("Retry"); expect(onRetry).toHaveBeenCalledOnce();
    rerender(<YieldSourceSheet {...p} ranking={null} />);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull(); expect(screen.getByRole("heading", { name: "Yield source details" })).toBeTruthy();
    rerender(<YieldSourceSheet {...p} ranking={mkRank("usdc", "best-usdc", "alt-usdc")} />);
    expect(screen.getByRole("link", { name: "usdc-best" }).getAttribute("href")).toBe("https://example.com/usdc/best"); expect(chart()).toBeTruthy();
    const ret = mkRank("usdc", "best-usdc", "alt-usdc");
    clickBtn(/usdc-alt/i);
    rerender(<YieldSourceSheet {...p} ranking={ret} error={new Error("refresh failed")} />);
    expect(screen.getByRole("link", { name: "usdc-best" })).toBeTruthy(); expect(chart().textContent).toContain("alt-usdc");
    expect(screen.queryByRole("status")).toBeNull(); expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    rerender(<YieldSourceSheet {...p} ranking={ret} />);
    expect(screen.queryByRole("status")).toBeNull(); expect(chart().textContent).toContain("alt-usdc");
  });

  it("resets the selected source when the ranking changes", () => {
    const { rerender } = renderSheet(mkRank("usdc", "best-usdc", "alt-usdc"));
    clickBtn(/usdc-alt/i); expect(chart().textContent).toContain("alt-usdc");
    rerender(<YieldSourceSheet ranking={mkRank("usdt", "best-usdt", "alt-usdt")} logo={undefined} riskFreeRate={0.02} medianApy={0.03} open onOpenChange={vi.fn()} />);
    expect(chart().textContent).toContain("best-usdt");
  });

  it.each([2])("returns to chosen history after selecting among %i alternates without reopening", (count) => {
    const r = mkRank("usdc", "best-usdc", "alt-usdc");
    if (count === 2) r.altSources.push(mkAlt({ sourceKey: "alt-second", yieldSource: "second-alt" }));
    renderSheet(r); clickBtn(/usdc-alt/i); expect(chart().textContent).toContain("alt-usdc");
    clickBtn("Show chosen source history"); expect(chart().textContent).toContain("best-usdc");
    expect(screen.getByRole("button", { name: "Show chosen source history" }).getAttribute("aria-pressed")).toBe("true");
  });

  it.each(["retained", "removed", "reopened"])("aligns the inspected source when an alternate is %s", (upd) => {
    const r = mkRank("susde-ethena", "chosen", "alternate");
    r.sourceRisk = { sourceRiskScore: 72 }; r.altSources[0]!.sourceRisk = { sourceRiskScore: 31 };
    r.altSources.push(mkAlt({ sourceKey: "second", yieldSource: "second-alt" }));
    const p = { ranking: r, logo: undefined, riskFreeRate: 0.02, medianApy: 0.03, open: true, onOpenChange: vi.fn() };
    const { rerender } = renderSheet(r);
    clickBtn(/susde-ethena-alt/i); expect(chart().textContent).toBe("alternate");
    if (upd === "reopened") rerender(<YieldSourceSheet {...p} open={false} />);
    rerender(<YieldSourceSheet {...p} ranking={{ ...r, altSources: upd === "removed" ? r.altSources.slice(1) : r.altSources }} />);
    const ret = upd === "retained", lbl = `susde-ethena-${ret ? "alt" : "best"}`;
    expect(chart().textContent).toBe(ret ? "alternate" : "chosen");
    expect(screen.getByText("Showing").textContent).toBe(`Showing ${lbl}`);
    expect(screen.getByText("Source risk").nextElementSibling?.textContent).toBe(lbl);
    expect(screen.getByText("Score").nextElementSibling?.textContent).toBe(ret ? "31/100" : "72/100");
    expect(screen.getByRole("button", { name: "Show chosen source history" }).getAttribute("aria-pressed")).toBe(String(!ret));
    expect(screen.getByRole("link", { name: /Deep dive yield/i }).getAttribute("href")).toBe(`/stablecoin/susde-ethena/yield${ret ? "?sources=alternate" : ""}`);
  });

  it("resolves a missing row rate from its registry benchmark for the history chart", () => {
    renderSheet({ ...mkRank("eurc", "best-eurc", "alt-eurc"), benchmarkKey: "EUR", benchmarkLabel: "EUR 3M compounded €STR", benchmarkRate: undefined }, { benchmarks: REGISTRY_WITH_EUR });
    expect(chart().getAttribute("data-benchmark-rate")).toBe("1.94"); expect(chart().getAttribute("data-benchmark-label")).toBe("EUR 3M compounded €STR");
  });

  it("reads a native holder-yield source as depth not applicable in the sheet and card", () => {
    renderSheet({ ...mkRank("buidl", "best-buidl", "alt-buidl"), yieldType: "rebase", dataSource: "rate-derived", sourceTvlUsd: null, sourceRisk: { sourceDepthRatio: null, sourceRiskPenalty: 1 }, altSources: [] });
    expect(screen.getByText("Native · depth n/a")).toBeTruthy(); expect(screen.getByText("Depth").nextElementSibling?.textContent).toBe("Native");
    expect(screen.queryByText(/Unknown depth/)).toBeNull(); expect(screen.getByText("Clean")).toBeTruthy(); expect(screen.queryByText("Watch")).toBeNull();
  });

  it("shows current and previous source identity for source changes", () => {
    renderSheet({ ...mkRank("usdc", "best-usdc", "alt-usdc"), provenance: mkProv({ sourceKey: "best-usdc", sourceSwitch: true, previousBestSourceKey: "alt-usdc", selectionReason: "Higher confidence than retained alternates." }), decisionLedger: { selectedReasonCode: "curated-over-discovered", previousBestSourceKey: "alt-usdc", sourceSwitch: true, apy30dDeltaFromPrevious: 0.8, rejectedCount: 1, alternatives: [{ sourceKey: "alt-usdc", yieldSource: "usdc-alt", apy30dDelta: -0.2, rejectionReasonCode: "lower-confidence" }] } });
    for (const t of ["Current source key:", "Previous source:", "Curated source preferred", "Source changed (+0.80 pp APY30d)", "1 alternate rejected"]) expect(screen.getByText(t)).toBeTruthy();
    for (const t of ["best-usdc", "usdc-alt", "alt-usdc", "Curated"]) expect(screen.getAllByText(t).length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Why this source won")).toBeTruthy();
  });

  it("shows modeled evidence qualification without presenting it as a direct observation", () => {
    renderSheet({ ...mkRank("usdc", "best-usdc", "alt-usdc"), provenance: mkProv({ sourceKey: "rate-derived:usdc", confidenceTier: "deterministic", calculationMode: "benchmark-model", evidenceClass: "modeled-proxy", evidenceCompleteness: 0.7143, scoreQualification: "estimated", selectionReason: "Modeled proxy retained as context." }) });
    for (const t of ["Estimated", "Modeled proxy", "Benchmark model", "71% evidence"]) expect(screen.getByText(t)).toBeTruthy();
  });

  it("renders the source-risk sparkbar under the APY with the provided score", () => {
    renderSheet({ ...mkRank("usdc", "best-usdc", "alt-usdc"), sourceRisk: { sourceRiskScore: 72, sourceAgeSeconds: null } });
    expect(screen.getAllByTestId("yield-source-risk-bar").map((n) => n.textContent)).toContain("72");
    expect(screen.getByText("Score")).toBeTruthy(); expect(screen.getByText("72/100")).toBeTruthy(); expect(screen.getByText("Penalty")).toBeTruthy();
    expect(screen.getAllByText("1.00x").length).toBeGreaterThan(0);
  });

  it("renders the sparkbar in the unavailable variant when sourceRiskScore is missing", () => {
    renderSheet(mkRank("usdc", "best-usdc", "alt-usdc"));
    expect(screen.getAllByTestId("yield-source-risk-bar").some((n) => n.textContent === "unavailable")).toBe(true);
  });

  it("renders a freshness stamp when sourceAgeSeconds is provided", () => {
    const b = mkRank("usdc", "best-usdc", "alt-usdc");
    renderSheet({ ...b, provenance: { ...b.provenance!, sourceFreshness: "fresh", sourceObservedAt: null }, sourceRisk: { sourceRiskScore: null, sourceAgeSeconds: 90 * 60 } });
    expect(screen.getAllByText("Observed 1h ago").find((n) => n.getAttribute("title")?.startsWith("Source observed 1h ago"))).toBeTruthy();
  });

  it("does not render a freshness stamp when sourceAgeSeconds is missing", () => {
    const b = mkRank("usdc", "best-usdc", "alt-usdc");
    renderSheet({ ...b, provenance: { ...b.provenance!, sourceObservedAt: null, sourceAgeSeconds: null }, sourceRisk: null, altSources: b.altSources.map((s) => ({ ...s, sourceRisk: null })) });
    expect(screen.queryByText(/ago$/)).toBeNull();
  });

  it("renders the deep-dive yield link without a sources param by default", () => {
    renderSheet(mkRank("susde-ethena", "selected", "alternate"));
    expect(screen.getByRole("link", { name: /Deep dive yield/i }).getAttribute("href")).toBe("/stablecoin/susde-ethena/yield");
  });

  it("appends sources param to deep-dive link when an alternate is selected", () => {
    renderSheet(mkRank("susde-ethena", "selected", "alternate")); clickBtn(/susde-ethena-alt/i);
    expect(screen.getByRole("link", { name: /Deep dive yield/i }).getAttribute("href")).toBe("/stablecoin/susde-ethena/yield?sources=alternate");
  });

  it("normalizes malformed unicode source keys in the deep-dive link", () => {
    renderSheet(mkRank("susde-ethena", "selected", "\uD800")); clickBtn(/susde-ethena-alt/i);
    expect(screen.getByRole("link", { name: /Deep dive yield/i }).getAttribute("href")).toBe("/stablecoin/susde-ethena/yield?sources=%EF%BF%BD");
  });

  it("uses an honestly named leaderboard fallback for dynamically covered USDC, without source params", () => {
    renderSheet(mkRank("usdc-circle", "selected", "alternate")); clickBtn(/usdc-circle-alt/i);
    expect(screen.getByRole("link", { name: /View yield opportunities/i }).getAttribute("href")).toBe("/yield?workbenchFallback=usdc-circle");
    expect(screen.queryByRole("link", { name: /Deep dive yield/i })).toBeNull();
  });
});
