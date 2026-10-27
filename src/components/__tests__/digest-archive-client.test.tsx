// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DigestArchiveClient } from "@/components/digest-archive-client";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { FRESHNESS_RATIOS } from "@shared/lib/status-thresholds";

const { useDigestArchiveMock, useUrlFiltersMock, bannerMode } = vi.hoisted(() => ({
  useDigestArchiveMock: vi.fn(),
  useUrlFiltersMock: vi.fn(),
  bannerMode: { real: false },
}));

vi.mock("@/hooks/api-hooks", () => ({
  useDigestArchive: useDigestArchiveMock,
}));

vi.mock("@/hooks/use-url-filters", () => ({
  useUrlFilters: useUrlFiltersMock,
}));

vi.mock("@/components/daily-digest", () => ({ DailyDigest: () => null }));
vi.mock("@/components/stale-data-banner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/stale-data-banner")>();
  return {
    StaleDataBanner: (props: Parameters<typeof actual.StaleDataBanner>[0]) =>
      bannerMode.real ? <actual.StaleDataBanner {...props} /> : null,
  };
});
vi.mock("@/components/query-error-notice", () => ({
  QueryErrorNotice: ({ hasData }: { hasData?: boolean }) => (hasData ? null : <p>Query error notice</p>),
}));

vi.mock("@/lib/digest", () => ({
  buildDigestTriggerRecord: () => ({
    total: 0,
    hit: 0,
    missed: 0,
    expired: 0,
    pending: 0,
    unavailable: 0,
    hitRate: null,
    buckets: [],
    unclassifiedCount: 0,
  }),
  EDITORIAL_BODY_STYLE: {},
  EDITORIAL_META_STYLE: {},
  formatDigestTriggerRate: () => "—",
  parseDigestParagraph: () => ({ bodyText: "" }),
  splitDigestParagraphs: () => [],
}));

function digest(generatedAt: number, digestTitle: string) {
  return {
    generatedAt,
    digestType: "daily" as const,
    digestTitle,
    digestText: "Archive copy",
    digestExtended: null,
    editionNumber: null,
    psiScore: null,
    psiBand: null,
    totalMcapUsd: null,
    riskSignal: null,
  };
}

describe("DigestArchiveClient UTC dates", () => {
  it("renders the same UTC day in the archive label and digest slug", () => {
    const latest = Date.parse("2026-08-31T00:30:00Z") / 1000;
    const archived = Date.parse("2026-08-30T00:30:00Z") / 1000;
    useDigestArchiveMock.mockReturnValue({
      data: { digests: [digest(latest, "Latest digest"), digest(archived, "Archived digest")] },
      isLoading: false,
      dataUpdatedAt: 0,
      error: null,
      refetch: vi.fn(),
      meta: null,
    });
    useUrlFiltersMock.mockReturnValue({
      searchParams: new URLSearchParams(),
      setParam: vi.fn(),
      replaceParams: vi.fn(),
    });

    render(<DigestArchiveClient />);

    const link = screen.getByRole("link", { name: /Archived digest/i });
    expect(link.getAttribute("href")).toBe("/digest/2026-08-30");
    expect(link.textContent).toContain("AUG 30");
  });
});

describe("DigestArchiveClient risk-signal badges", () => {
  it("renders below-peg risk signals with a negative bps sign", () => {
    useDigestArchiveMock.mockReturnValue({
      data: {
        digests: [
          digest(Date.parse("2026-08-31T00:30:00Z") / 1000, "Latest digest"),
          {
            ...digest(Date.parse("2026-08-30T00:30:00Z") / 1000, "Below-peg digest"),
            riskSignal: { kind: "depeg", symbol: "PMUSD", bps: -5284, mcapUsd: null, severity: "critical" },
          },
        ],
      },
      isLoading: false,
      dataUpdatedAt: 0,
      error: null,
      refetch: vi.fn(),
      meta: null,
    });
    useUrlFiltersMock.mockReturnValue({
      searchParams: new URLSearchParams(),
      setParam: vi.fn(),
      replaceParams: vi.fn(),
    });

    render(<DigestArchiveClient />);

    expect(screen.getAllByText("PMUSD -5284 bps").length).toBeGreaterThan(0);
    expect(screen.queryByText("PMUSD +5284 bps")).toBeNull();
  });
});

describe("DigestArchiveClient supply coverage", () => {
  it.each([
    [0, { complete: false, observedCount: 0, unavailableCount: 2 }, "Mcap unavailable", null],
    [100e9, { complete: false, observedCount: 1, unavailableCount: 1 }, "Known mcap subtotal", "1/2 coins observed"],
    [100e9, undefined, "Known mcap subtotal", "coverage unproven"],
    [0, { complete: true, observedCount: 2, unavailableCount: 0 }, "Total mcap: $0", "2/2 coins observed"],
  ])("keeps supply evidence qualified in archive links", (totalMcapUsd, supplyCoverage, label, qualifier) => {
    useDigestArchiveMock.mockReturnValue({
      data: { digests: [
        digest(Date.parse("2026-08-31T00:30:00Z") / 1000, "Latest digest"),
        { ...digest(Date.parse("2026-08-30T00:30:00Z") / 1000, "Supply evidence"), totalMcapUsd, supplyCoverage },
      ] },
      isLoading: false, dataUpdatedAt: 0, error: null, refetch: vi.fn(), meta: null,
    });
    useUrlFiltersMock.mockReturnValue({
      searchParams: new URLSearchParams(), setParam: vi.fn(), replaceParams: vi.fn(),
    });
    render(<DigestArchiveClient />);
    const link = screen.getByRole("link", { name: /Supply evidence/i });
    expect(link.textContent).toContain(label);
    if (qualifier) expect(link.textContent).toContain(qualifier);
    if (supplyCoverage?.observedCount === 0) expect(link.textContent).not.toContain("$0");
    if (!supplyCoverage?.complete) expect(link.textContent).not.toContain("Total mcap:");
  });
});

describe("DigestArchiveClient retention and health", () => {
  afterEach(() => {
    bannerMode.real = false;
    vi.useRealTimers();
  });

  function mockFilters() {
    useUrlFiltersMock.mockReturnValue({
      searchParams: new URLSearchParams(), setParam: vi.fn(), replaceParams: vi.fn(),
    });
  }

  it("ages an empty generation through a failed refetch, crosses its public budget, then recovers", () => {
    bannerMode.real = true;
    vi.useFakeTimers();
    const t0 = Date.parse("2026-10-20T12:00:00Z");
    vi.setSystemTime(t0);
    const sourceAt = Math.floor(t0 / 1000) - 3600;
    const meta = { updatedAt: sourceAt, ageSeconds: 3600, status: "fresh" as const };
    mockFilters();
    useDigestArchiveMock.mockReturnValue({
      data: { digests: [] }, isLoading: false, dataUpdatedAt: t0, error: null, refetch: vi.fn(), meta,
    });
    const view = render(<DigestArchiveClient />);
    // Let the shared hydration gate (two animation frames) settle so the boundary clock runs.
    act(() => { vi.advanceTimersByTime(50); });
    expect(screen.getByText("No digests yet. Check back tomorrow.")).toBeTruthy();
    expect(screen.queryByText("Showing an older snapshot")).toBeNull();

    // Failed refetch: receipt stays, producer clock stays, no fabricated editions.
    useDigestArchiveMock.mockReturnValue({
      data: { digests: [] }, isLoading: false, dataUpdatedAt: t0, error: new Error("Offline"), refetch: vi.fn(), meta,
    });
    view.rerender(<DigestArchiveClient />);
    expect(screen.getByText("No digests yet. Check back tomorrow.")).toBeTruthy();
    expect(screen.queryByText("Query error notice")).toBeNull();
    expect(screen.queryByText("Showing an older snapshot")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(FRESHNESS_RATIOS.DEGRADED * API_FRESHNESS_MAX_AGE_SEC.digestArchive * 1000);
    });
    expect(screen.getByText("Showing an older snapshot")).toBeTruthy();
    expect(screen.getByText("No digests yet. Check back tomorrow.")).toBeTruthy();
    expect(screen.queryByText("Today's Lead")).toBeNull();

    const recoveredAt = Date.now();
    useDigestArchiveMock.mockReturnValue({
      data: { digests: [] }, isLoading: false, dataUpdatedAt: recoveredAt, error: null, refetch: vi.fn(),
      meta: { updatedAt: Math.floor(recoveredAt / 1000), ageSeconds: 0, status: "fresh" as const },
    });
    view.rerender(<DigestArchiveClient />);
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByText("Showing an older snapshot")).toBeNull();
    expect(screen.getByText("No digests yet. Check back tomorrow.")).toBeTruthy();
  });

  it("keeps retained edition links through a failed refetch", () => {
    mockFilters();
    const digests = [
      digest(Date.parse("2026-08-31T00:30:00Z") / 1000, "Latest digest"),
      digest(Date.parse("2026-08-30T00:30:00Z") / 1000, "Archived digest"),
    ];
    useDigestArchiveMock.mockReturnValue({
      data: { digests }, isLoading: false, dataUpdatedAt: 1, error: new Error("Offline"), refetch: vi.fn(), meta: null,
    });
    render(<DigestArchiveClient />);
    expect(screen.getByText("Today's Lead")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Archived digest/i }).getAttribute("href")).toBe("/digest/2026-08-30");
    expect(screen.queryByText("Query error notice")).toBeNull();
  });

  it("shows the error notice only when the initial read fails with nothing retained", () => {
    mockFilters();
    useDigestArchiveMock.mockReturnValue({
      data: undefined, isLoading: false, dataUpdatedAt: 0, error: new Error("Offline"), refetch: vi.fn(), meta: null,
    });
    render(<DigestArchiveClient />);
    expect(screen.getByText("Query error notice")).toBeTruthy();
    expect(screen.queryByText("No digests yet. Check back tomorrow.")).toBeNull();
  });
});
