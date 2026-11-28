// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import { HomeAltDdrOverview } from "@/components/homepage/home-alt-ddr-overview";
import { applyDurationStaleness } from "@shared/lib/depeg-resolver/public-contract";
import type { DdrResponse } from "@shared/types/depeg-resolver";
import { predictionRow } from "@/components/depeg-resolver-review-test-support";

const { useDepegResolverSurfacesMock, usePegSummaryMock } = vi.hoisted(() => ({
  useDepegResolverSurfacesMock: vi.fn(),
  usePegSummaryMock: vi.fn(() => ({ data: undefined as unknown })),
}));
vi.mock("@/hooks/use-depeg-resolver-surfaces", () => ({ useDepegResolverSurfaces: useDepegResolverSurfacesMock }));
vi.mock("@/hooks/api-hooks", () => ({ usePegSummary: usePegSummaryMock }));
afterEach(() => { cleanup(); vi.clearAllMocks(); usePegSummaryMock.mockReturnValue({ data: undefined }); });

const COMPUTED_AT = 1_800_000_000, refetchResolver = vi.fn(), refetchReviewer = vi.fn();
const forecast = {
  kind: "prediction", stablecoinId: "test-usd", symbol: "TUSD", name: "Test USD",
  pegCurrency: "USD", direction: "below", prediction: { state: "frozen" },
  frozen: {
    resolution: { tier: "recovery_likely", factors: [] },
    duration: { suppressed: false, medianSec: 86_400, remainingAsOf: COMPUTED_AT, medianResolveAt: COMPUTED_AT + 86_400 },
    sourceRow: { currentDeviationBps: -300, peakDeviationBps: -300 },
  },
  live: { currentDeviationBps: -45, peakDeviationBps: -300, stale: false, degradedReason: null },
};

function setSources({ rows = [forecast], reviewRows = [predictionRow], stale = false, resolverError = null, reviewerError = null, unavailable = false }: {
  rows?: typeof forecast[]; reviewRows?: typeof predictionRow[]; stale?: boolean;
  resolverError?: Error | null; reviewerError?: Error | null; unavailable?: boolean;
} = {}) {
  const meta = { computedAt: COMPUTED_AT, degraded: stale, degradedReason: stale ? "stale-cache" : null };
  useDepegResolverSurfacesMock.mockReturnValue({
    resolverEnabled: true, resolverReviewerEnabled: true,
    resolver: { data: unavailable ? undefined : { _meta: meta, rows }, error: resolverError, dataUpdatedAt: COMPUTED_AT * 1000, refetch: refetchResolver },
    resolverReview: {
      data: unavailable ? undefined : {
        _meta: { ...meta, computedAt: COMPUTED_AT - 60 }, rows: reviewRows,
        summary: {
          headlineScope: "current_policy",
          headline: { recoveryLikelihoodScoredCount: 10, recoveryLikelihoodCorrectCount: 8, recoveryLikelihoodAccuracyPct: 0.8, baselineRecoverableCorrectCount: 9, lockedPredictionCount: 12, durationScoredCount: 5, horizonHitRates: [] },
          byPredictionPolicy: [
            { segmentKind: "prediction_policy", predictionMethodologyVersion: "3.04", predictionPolicyVersion: "sticky-24h-v1", metrics: { recoveryLikelihoodScoredCount: 4 } },
            { segmentKind: "prediction_policy", predictionMethodologyVersion: "4.6", predictionPolicyVersion: "sticky-24h-v1", metrics: { recoveryLikelihoodScoredCount: 6 } },
          ],
        },
      },
      error: reviewerError, dataUpdatedAt: COMPUTED_AT * 1000, refetch: refetchReviewer,
    },
  });
}

describe("HomeAltDdrOverview", () => {
  it("keeps invalidated, pending, and no-call states visible without live verdicts or durations", () => {
    const frozen = { resolution: { tier: "recovery_likely", factors: [] }, duration: { suppressed: false, medianSec: 86_400 }, sourceRow: { currentDeviationBps: -300, peakDeviationBps: -300 } };
    const base = { name: "Fixture", pegCurrency: "USD", direction: "below", live: { currentDeviationBps: -45, peakDeviationBps: -300 } };
    useDepegResolverSurfacesMock.mockReturnValue({
      resolverEnabled: true, resolverReviewerEnabled: false, resolverReview: { data: undefined, error: null },
      resolver: { error: null, data: { _meta: { degraded: false }, rows: [
        { ...base, stablecoinId: "valid", symbol: "VALID", kind: "prediction", prediction: { state: "frozen" }, frozen },
        { ...base, stablecoinId: "withdrawn", symbol: "WITHDRAWN", kind: "invalidated_prediction", prediction: { state: "invalidated" }, originalKind: "prediction", originalOutcome: frozen },
        { ...base, stablecoinId: "pending", symbol: "PENDING", kind: "pending", prediction: { state: "pending_lock" } },
        { ...base, stablecoinId: "no-call", symbol: "NO-CALL", kind: "no_call", prediction: { state: "no_call" } },
      ] } },
    });
    render(<HomeAltDdrOverview />);
    expect(screen.getByText("1 forecasts")).toBeTruthy();
    expect(screen.getByText("WITHDRAWN").closest("a")?.textContent).toContain("invalidated");
    expect(screen.getByText("PENDING").closest("a")?.textContent).toContain("Forecast not locked yet");
    expect(screen.getByText("NO-CALL").closest("a")?.textContent).toContain("no call");
    expect(screen.getByText("VALID").closest("a")?.textContent).toContain("locked ~1d");
    expect(screen.getByText("WITHDRAWN").closest("a")?.textContent).not.toContain("~1d");
    expect(screen.getByText("WITHDRAWN").closest("a")?.textContent).not.toContain("Likely");
    expect(screen.getAllByText("locked ~1d")).toHaveLength(1);
  });

  it("shows a sealed forecast's current live deviation rather than its lock-time deviation", () => {
    useDepegResolverSurfacesMock.mockReturnValue({
      resolverEnabled: true, resolverReviewerEnabled: false, resolverReview: { data: undefined, error: null },
      resolver: { error: null, data: { _meta: { degraded: false }, rows: [{ ...forecast, frozen: { ...forecast.frozen, resolution: { tier: "at_risk", factors: [] }, duration: { suppressed: true, medianSec: null } } }] } },
    });
    render(<HomeAltDdrOverview />);
    expect(screen.getByText("-45 bps")).toBeTruthy();
    expect(screen.queryByText("-300 bps")).toBeNull();
  });

  it("orders rows missing a current deviation by their live event peak, not the frozen lock peak", () => {
    const row = (id: string, frozenPeak: number, livePeak: number | null) => ({
      ...forecast, stablecoinId: id, symbol: id.toUpperCase(),
      frozen: { ...forecast.frozen, sourceRow: { currentDeviationBps: frozenPeak, peakDeviationBps: frozenPeak } },
      live: { ...forecast.live, currentDeviationBps: null, peakDeviationBps: livePeak },
    });
    setSources({ rows: [row("lockdeep", -1_000, -100), row("unknown", -2_000, null), row("livedeep", -100, -500)] as unknown as typeof forecast[] });
    render(<HomeAltDdrOverview />);
    expect(screen.getAllByText(/^(LOCKDEEP|UNKNOWN|LIVEDEEP)$/).map((n) => n.textContent)).toEqual(["LIVEDEEP", "LOCKDEEP", "UNKNOWN"]);
  });

  it("shows the promoted accuracy with its call fraction and no sub-text under the figure", () => {
    setSources(); render(<HomeAltDdrOverview />);
    expect(screen.getByText("80.0%")).toBeTruthy();
    expect(screen.getByText("Recovery calls correct: 8/10")).toBeTruthy();
    expect(screen.queryByText(/Always-recover baseline/)).toBeNull();
    expect(screen.queryByText(/Graded calls/)).toBeNull();
    expect(screen.queryByText(/recovery-call accuracy/)).toBeNull();
  });

  it("renders stale-cache generations with a neutral as-of stamp and no warning", () => {
    setSources({ stale: true });
    const view = render(<HomeAltDdrOverview />);
    expect(screen.getByText(/^Resolver · as of/)).toBeTruthy();
    expect(screen.getByText(/^Reviewer · as of/)).toBeTruthy();
    expect(view.container.textContent).not.toMatch(/Retained|stale-cache|Unavailable/);
    expect(screen.getByText("TUSD")).toBeTruthy();
    expect(screen.queryByText(/live forecasts|1 live/i)).toBeNull();
  });

  it("scopes empty forecast copy to its fresh snapshot", () => {
    setSources({ rows: [] }); render(<HomeAltDdrOverview />);
    expect(screen.getByText(/No published active forecasts/)).toBeTruthy();
    expect(screen.queryByText(/all clear|every monitored coin is on peg/i)).toBeNull();
  });

  it("withholds empty stale-cache snapshots independently for the resolver and reviewer", () => {
    setSources({ rows: [], stale: true });
    const view = render(<HomeAltDdrOverview />);
    expect(screen.getByText("Resolver · Updating")).toBeTruthy();
    expect(screen.queryByText(/No published active forecasts/)).toBeNull();
    expect(screen.getByText("80.0%")).toBeTruthy();
    setSources({ reviewRows: [], stale: true });
    view.rerender(<HomeAltDdrOverview />);
    expect(screen.getByText("TUSD")).toBeTruthy();
    expect(screen.getByText("Reviewer · Updating")).toBeTruthy();
    expect(screen.queryByText("80.0%")).toBeNull();
  });

  it("keeps retained values after refetch errors without failure notices or retry actions", () => {
    setSources({ resolverError: new Error("resolver refresh failed"), reviewerError: new Error("reviewer refresh failed") });
    render(<HomeAltDdrOverview />);
    expect(screen.getByText("TUSD")).toBeTruthy();
    expect(screen.getByText("80.0%")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("shows neutral placeholders when initial reads fail", () => {
    setSources({ unavailable: true, resolverError: new Error("resolver failed"), reviewerError: new Error("reviewer failed") });
    const view = render(<HomeAltDdrOverview />);
    expect(screen.getByText("Resolver · Updating")).toBeTruthy();
    expect(screen.getByText("Reviewer · Updating")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
    expect(view.container.textContent).not.toMatch(/Unavailable|failed/);
    expect(screen.queryByText(/No published active forecasts/)).toBeNull();
  });

  it("labels each forecast in the vocabulary it was locked under and splits a mixed book", () => {
    const lockedUnder = (id: string, version: string | null, tier: string) => ({
      ...forecast, stablecoinId: id, symbol: id.toUpperCase(),
      prediction: { state: "frozen", predictionMethodologyVersion: version },
      frozen: { ...forecast.frozen, resolution: { tier, factors: [] } },
    });
    setSources({ rows: [lockedUnder("v5a", "5.0", "at_risk"), lockedUnder("v5b", "5.0", "recovery_unlikely"), lockedUnder("old", "4.3", "at_risk")] });
    render(<HomeAltDdrOverview />);
    expect(screen.getByText("V5A").closest("a")?.textContent).toContain("Stress");
    expect(screen.getByText("V5B").closest("a")?.textContent).toContain("Terminal");
    expect(screen.getByText("V5B").closest("a")?.textContent).toContain("may not recover");
    expect(screen.getByText("OLD").closest("a")?.textContent).toContain("At risk");
    expect(screen.getByText("OLD").closest("a")?.textContent).not.toContain("Stress");
    expect(screen.getByText("3 forecasts").parentElement?.textContent).toBe("1Stress1At risk1Terminal3 forecasts");
  });

  it("switches the same frozen duration to overdue after the authoritative live overlay deadline", () => {
    const payload = { rows: [forecast] } as unknown as DdrResponse;
    setSources({ rows: applyDurationStaleness(payload, COMPUTED_AT + 86_399).rows as unknown as typeof forecast[] });
    const view = render(<HomeAltDdrOverview />);
    expect(screen.getByText("locked ~1d").getAttribute("title")).toContain("Locked estimate as of");
    const aged = applyDurationStaleness(payload, COMPUTED_AT + 86_401);
    setSources({ rows: aged.rows as unknown as typeof forecast[] });
    view.rerender(<HomeAltDdrOverview />);
    expect(screen.getByText("overdue ~1d").getAttribute("title")).toContain("median deadline passed");
    expect(screen.queryByText("locked ~1d")).toBeNull();
    expect(aged.rows[0]!.frozen).toBe(payload.rows[0]!.frozen);
    expect(payload.rows[0]!.live.stale).toBe(false);
  });

  it("joins openIncidents passively by eventId", () => {
    const D = 86_400, s = (eventId: number, d: number, e?: number) => ({ eventId, startedAt: COMPUTED_AT - d * D, escalatedAt: e ? COMPUTED_AT - e * D : null, coverage: null });
    const mk = (id: string, currentEventId: number) => ({ ...forecast, stablecoinId: id, symbol: id.toUpperCase(), live: { ...forecast.live, currentEventId, eventState: "active" } });
    usePegSummaryMock.mockReturnValue({ data: { openIncidentsAsOfSec: COMPUTED_AT, openIncidents: { esc: s(1, 45, 2), old: s(2, 60), miss: s(9, 60) } } });
    setSources({ rows: [mk("esc", 1), mk("old", 2), mk("miss", 3)] });
    render(<HomeAltDdrOverview />);
    expect(usePegSummaryMock).toHaveBeenCalledWith({ enabled: false });
    expect([screen.getByText("ESC").closest("a")?.textContent, screen.getByText("OLD").closest("a")?.textContent]).toEqual([expect.stringContaining("Escalating"), expect.stringContaining(">30d")]);
    expect(screen.getByText("MISS").closest("a")?.textContent).not.toMatch(/Escalating|>30d/);
    // The shared horizon clock fails closed for this passive reader while ESC crosses out of its 7d window.
    cleanup(); vi.useFakeTimers({ now: (COMPUTED_AT + 6 * D) * 1000 });
    render(<HomeAltDdrOverview />); act(() => { vi.advanceTimersByTime(1); });
    expect(screen.getByText("ESC").closest("a")?.textContent).not.toMatch(/Escalating|>30d/);
    vi.useRealTimers();
  });
});
