// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { HomeAltDdrOverview } from "@/components/home-alt-ddr-overview";
import { QueryFreshnessNotices } from "@/components/query-freshness-notices";
import type * as FreshnessNotices from "@/components/query-freshness-notices";
import { ApiMetaEnvelopeSchema, type ApiMetaEnvelope } from "@shared/types/api-meta";
import { applyDurationStaleness } from "@shared/lib/depeg-resolver/public-contract";
import type { DdrResponse } from "@shared/types/depeg-resolver";

const { useDepegResolverSurfacesMock } = vi.hoisted(() => ({
  useDepegResolverSurfacesMock: vi.fn(),
}));

vi.mock("@/hooks/use-depeg-resolver-surfaces", () => ({
  useDepegResolverSurfaces: useDepegResolverSurfacesMock,
}));

vi.mock("@/components/query-freshness-notices", async (importOriginal) => {
  const original = await importOriginal<typeof FreshnessNotices>();
  return { ...original, QueryFreshnessNotices: vi.fn(original.QueryFreshnessNotices) };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const COMPUTED_AT = 1_800_000_000;
const refetchResolver = vi.fn();
const refetchReviewer = vi.fn();
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

function setSources({ rows = [forecast], stale = false, resolverError = null, reviewerError = null, unavailable = false }: {
  rows?: typeof forecast[];
  stale?: boolean;
  resolverError?: Error | null;
  reviewerError?: Error | null;
  unavailable?: boolean;
} = {}) {
  const meta = { computedAt: COMPUTED_AT, degraded: stale, degradedReason: stale ? "stale-cache" : null };
  useDepegResolverSurfacesMock.mockReturnValue({
    resolverEnabled: true, resolverReviewerEnabled: true,
    resolver: {
      data: unavailable ? undefined : { _meta: meta, rows },
      error: resolverError, dataUpdatedAt: COMPUTED_AT * 1000, refetch: refetchResolver,
    },
    resolverReview: {
      data: unavailable ? undefined : {
        _meta: { ...meta, computedAt: COMPUTED_AT - 60 },
        summary: { headline: { recoveryLikelihoodScoredCount: 10, recoveryLikelihoodAccuracyPct: 0.8,
          lockedPredictionCount: 12, durationScoredCount: 5, horizonHitRates: [] } },
      },
      error: reviewerError, dataUpdatedAt: COMPUTED_AT * 1000, refetch: refetchReviewer,
    },
  });
}

describe("HomeAltDdrOverview", () => {
  it("keeps invalidated, pending, and no-call states visible without live verdicts or durations", () => {
    const frozen = {
      resolution: { tier: "recovery_likely", factors: [] },
      duration: { suppressed: false, medianSec: 86_400 },
      sourceRow: { currentDeviationBps: -300, peakDeviationBps: -300 },
    };
    const base = { name: "Fixture", pegCurrency: "USD", direction: "below",
      live: { currentDeviationBps: -45, peakDeviationBps: -300 } };
    useDepegResolverSurfacesMock.mockReturnValue({
      resolverEnabled: true, resolverReviewerEnabled: false,
      resolver: { error: null, data: { _meta: { degraded: false }, rows: [
        { ...base, stablecoinId: "valid", symbol: "VALID", kind: "prediction", prediction: { state: "frozen" }, frozen },
        { ...base, stablecoinId: "withdrawn", symbol: "WITHDRAWN", kind: "invalidated_prediction",
          prediction: { state: "invalidated" }, originalKind: "prediction", originalOutcome: frozen },
        { ...base, stablecoinId: "pending", symbol: "PENDING", kind: "pending", prediction: { state: "pending_lock" } },
        { ...base, stablecoinId: "no-call", symbol: "NO-CALL", kind: "no_call", prediction: { state: "no_call" } },
      ] } },
      resolverReview: { data: undefined, error: null },
    });
    render(<HomeAltDdrOverview />);

    expect(screen.getByText("1 forecasts")).toBeTruthy();
    expect(screen.getByText("WITHDRAWN").closest("a")?.textContent).toContain("invalidated");
    expect(screen.getByText("PENDING").closest("a")?.textContent).toContain("pending lock");
    expect(screen.getByText("NO-CALL").closest("a")?.textContent).toContain("no call");
    expect(screen.getByText("VALID").closest("a")?.textContent).toContain("locked ~1d");
    expect(screen.getByText("WITHDRAWN").closest("a")?.textContent).not.toContain("~1d");
    expect(screen.getByText("WITHDRAWN").closest("a")?.textContent).not.toContain("Likely");
    expect(screen.getAllByText("locked ~1d")).toHaveLength(1);
  });

  it("shows a sealed forecast's current live deviation rather than its lock-time deviation", () => {
    useDepegResolverSurfacesMock.mockReturnValue({
      resolverEnabled: true,
      resolverReviewerEnabled: false,
      resolver: {
        data: {
          _meta: { degraded: false },
          rows: [
            {
              kind: "prediction",
              stablecoinId: "test-usd",
              symbol: "TUSD",
              name: "Test USD",
              pegCurrency: "USD",
              direction: "below",
              prediction: { state: "frozen" },
              frozen: {
                resolution: { tier: "at_risk", factors: [] },
                duration: { suppressed: true, medianSec: null },
                sourceRow: { currentDeviationBps: -300, peakDeviationBps: -300 },
              },
              live: { currentDeviationBps: -45, peakDeviationBps: -300 },
            },
          ],
        },
        error: null,
      },
      resolverReview: { data: undefined, error: null },
    });
    render(<HomeAltDdrOverview />);

    expect(screen.getByText("-45 bps")).toBeTruthy();
    expect(screen.queryByText("-300 bps")).toBeNull();
  });

  it("discloses independent stale-cache generations without promoting retained rows to live forecasts", () => {
    setSources({ stale: true });
    render(<HomeAltDdrOverview />);
    expect(screen.getByText(/Resolver: Retained snapshot/).textContent).toContain("stale-cache");
    expect(screen.getByText(/Reviewer: Retained snapshot/).textContent).toContain("stale-cache");
    expect(screen.getByText(/Resolver: Retained snapshot/).textContent).not.toBe(screen.getByText(/Reviewer: Retained snapshot/).textContent);
    expect(screen.getByText("TUSD")).toBeTruthy();
    expect(screen.queryByText(/live forecasts|1 live/i)).toBeNull();
  });

  it.each([false, true])("scopes empty forecast copy to its snapshot (stale-cache: %s)", (stale) => {
    setSources({ rows: [], stale });
    render(<HomeAltDdrOverview />);
    expect(screen.getByText(/No published active forecasts/)).toBeTruthy();
    expect(screen.queryByText(/all clear|every monitored coin is on peg/i)).toBeNull();
    if (stale) expect(screen.getByText(/Resolver: Retained snapshot/)).toBeTruthy();
  });

  it("keeps retained values with independent refetch errors and retry actions", () => {
    setSources({ resolverError: new Error("resolver refresh failed"), reviewerError: new Error("reviewer refresh failed") });
    render(<HomeAltDdrOverview />);
    expect(screen.getByText("TUSD")).toBeTruthy();
    expect(screen.getByText("80.0%")).toBeTruthy();
    expect(screen.getByText(/Resolver: Retained snapshot/)).toBeTruthy();
    expect(screen.getByText(/Reviewer: Retained snapshot/)).toBeTruthy();
    const retries = screen.getAllByRole("button", { name: "Retry" });
    fireEvent.click(retries[0]!);
    fireEvent.click(retries[1]!);
    expect(refetchResolver).toHaveBeenCalledTimes(1);
    expect(refetchReviewer).toHaveBeenCalledTimes(1);
  });

  it("shows both unavailable sources and retries when initial reads fail", () => {
    setSources({ unavailable: true, resolverError: new Error("resolver failed"), reviewerError: new Error("reviewer failed") });
    render(<HomeAltDdrOverview />);
    expect(screen.getByText(/Resolver: Unavailable/)).toBeTruthy();
    expect(screen.getByText(/Reviewer: Unavailable/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(2);
    expect(screen.queryByText(/No published active forecasts/)).toBeNull();
  });

  const metaCases: { label: string; meta: ApiMetaEnvelope | undefined; status: string }[] = [
    { label: "absent", meta: undefined, status: "fresh" },
    { label: "unknown unavailable", meta: { updatedAt: null, ageSeconds: null, status: "unknown", reason: "missing-generation" }, status: "fresh" },
    { label: "stale unavailable", meta: { updatedAt: null, ageSeconds: null, status: "stale", reason: "missing-generation" }, status: "stale" },
    { label: "warning-only", meta: { status: "degraded", warning: "source warning" }, status: "degraded" },
    { label: "assessed available", meta: { updatedAt: COMPUTED_AT - 60, ageSeconds: 60, status: "degraded",
      warning: "source warning", dependencies: { source: { status: "stale" } },
      assessedAt: COMPUTED_AT, freshBudgetSec: 900, degradedBudgetSec: 1800 }, status: "degraded" },
  ];
  it.each(metaCases)(
    "normalizes $label metadata to a valid producer-generation envelope",
    ({ meta, status }) => {
      setSources();
      const configured = useDepegResolverSurfacesMock();
      configured.resolver.meta = meta;
      render(<HomeAltDdrOverview />);
      const envelope = vi.mocked(QueryFreshnessNotices).mock.calls[0]![0].queries[0]!.meta;
      expect(ApiMetaEnvelopeSchema.safeParse(envelope).success).toBe(true);
      expect(envelope).toEqual({
        ...(meta?.updatedAt != null ? {
          warning: meta.warning, dependencies: meta.dependencies, assessedAt: meta.assessedAt,
          freshBudgetSec: meta.freshBudgetSec, degradedBudgetSec: meta.degradedBudgetSec,
        } : {}),
        updatedAt: COMPUTED_AT, ageSeconds: meta?.ageSeconds ?? 0, status,
      });
      expect(envelope).not.toHaveProperty("reason");
    },
  );

  it("preserves unavailable metadata when no producer generation exists", () => {
    setSources({ unavailable: true, resolverError: new Error("resolver unavailable") });
    const configured = useDepegResolverSurfacesMock();
    const meta: ApiMetaEnvelope = { updatedAt: null, ageSeconds: null, status: "unknown", reason: "missing-generation" };
    configured.resolver.meta = meta;
    render(<HomeAltDdrOverview />);
    expect(vi.mocked(QueryFreshnessNotices).mock.calls[0]![0].queries[0]!.meta).toBe(meta);
  });

  it("switches the same frozen duration to overdue after the authoritative live overlay deadline", () => {
    const payload = { rows: [forecast] } as unknown as DdrResponse;
    setSources({ rows: applyDurationStaleness(payload, COMPUTED_AT + 86_399).rows as unknown as typeof forecast[] });
    const view = render(<HomeAltDdrOverview />);
    expect(screen.getByText("locked ~1d").getAttribute("title")).toContain("Locked estimate as of");
    const aged = applyDurationStaleness(payload, COMPUTED_AT + 86_401);
    setSources({ rows: aged.rows as unknown as typeof forecast[] });
    view.rerender(<HomeAltDdrOverview />);
    expect(screen.getByText("overdue ~1d").getAttribute("title")).toContain("duration-exceeded");
    expect(screen.queryByText("locked ~1d")).toBeNull();
    expect(aged.rows[0]!.frozen).toBe(payload.rows[0]!.frozen);
    expect(payload.rows[0]!.live.stale).toBe(false);
  });
});
