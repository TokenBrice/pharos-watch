// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DigestArchiveClient } from "@/components/digest-archive-client";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { FRESHNESS_RATIOS } from "@shared/lib/status-thresholds";
import type { DailyDigestResponse, DigestContentEntry } from "@shared/types/digest";

const { useDailyDigestMock, useDigestArchiveMock, useUrlFiltersMock, bannerMode } = vi.hoisted(() => ({
  useDailyDigestMock: vi.fn(() => ({ data: undefined as Partial<DailyDigestResponse> | undefined, isLoading: true, error: null as Error | null })),
  useDigestArchiveMock: vi.fn(),
  useUrlFiltersMock: vi.fn(),
  bannerMode: { real: false },
}));

vi.mock("@/hooks/api-hooks", () => ({
  useDigestArchive: useDigestArchiveMock,
  useDailyDigest: useDailyDigestMock,
}));

vi.mock("@/hooks/use-url-filters", () => ({
  useUrlFilters: useUrlFiltersMock,
}));

vi.mock("next/font/local", () => ({
  default: () => ({ className: "mock-local-font", variable: "--mock-local-font" }),
}));
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
  digestMonthKey: (ts: number) => new Date(ts * 1000).toISOString().slice(0, 7),
  formatDigestMonthLabel: (key: string) => key,
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
  parseDigestParagraph: (paragraph: string) => ({ bodyText: paragraph }),
  splitDigestParagraphs: () => [],
  getDigestBodyParagraphs: ({ digest }: { digest: string }) => [digest],
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

const leadEdition: DigestContentEntry = {
  date: "2026-08-31",
  generatedAt: Date.parse("2026-08-31T00:30:00Z") / 1000,
  digestType: "daily",
  title: "Build-time lead",
  text: "Captured edition text",
  extended: "",
  editionNumber: 42,
};

const liveRiskContent: Pick<DailyDigestResponse, "riskSignal" | "riskTape" | "nextTriggers"> = {
  riskSignal: { kind: "depeg", symbol: "PMUSD", bps: -5284, mcapUsd: null, severity: "critical" },
  riskTape: [{ id: "depegs", label: "Depegs", value: "1 active", tone: "critical" }],
  nextTriggers: [{ id: "pmusd", label: "PMUSD recovery", metric: "depeg-bps", comparator: "lte", thresholdLabel: "100 bps",
    rationale: "Watch the peg", detail: "PMUSD returns within 100 bps." }],
};

afterEach(() => {
  useDailyDigestMock.mockReturnValue({ data: undefined, isLoading: true, error: null });
});

describe("DigestArchiveClient build-time lead", () => {
  function mockArchive(overrides: Record<string, unknown> = {}) {
    useDigestArchiveMock.mockReturnValue({
      data: undefined, isLoading: true, dataUpdatedAt: 0, error: null, refetch: vi.fn(), meta: null,
      ...overrides,
    });
    useUrlFiltersMock.mockReturnValue({
      searchParams: new URLSearchParams(), setParam: vi.fn(), replaceParams: vi.fn(),
    });
  }

  it("renders the dated seed during loading and after a failed initial refresh", () => {
    mockArchive();
    const view = render(<DigestArchiveClient initialLead={leadEdition} />);
    expect(screen.getByRole("heading", { name: "Build-time lead" })).toBeTruthy();
    expect(screen.getByText("August 31, 2026")).toBeTruthy();
    expect(screen.queryByText("Today's Lead")).toBeNull();
    expect(screen.getByRole("link", { name: /Continue reading/ }).getAttribute("href")).toBe("/digest/2026-08-31");

    useDailyDigestMock.mockReturnValue({ data: undefined, isLoading: false, error: new Error("Offline") });
    mockArchive({ isLoading: false, error: new Error("Offline") });
    view.rerender(<DigestArchiveClient initialLead={leadEdition} />);
    expect(screen.getByRole("heading", { name: "Build-time lead" })).toBeTruthy();
    expect(screen.getByText("Query error notice")).toBeTruthy();
    expect(screen.queryByText(/Critical depeg:/)).toBeNull();
    expect(screen.queryByText("Depegs")).toBeNull();
    expect(screen.queryByText("Next:")).toBeNull();
  });

  it.each(["daily", "archive"])("enriches the same slug in place from %s with risk content below the lead paragraph", (source) => {
    mockArchive();
    const view = render(<DigestArchiveClient initialLead={leadEdition} />);
    const paragraph = screen.getByText("Captured edition text");

    if (source === "daily") {
      useDailyDigestMock.mockReturnValue({ data: {
        digest: "Live summary", digestTitle: "Live title", digestExtended: "Live extended",
        generatedAt: leadEdition.generatedAt + 60, ...liveRiskContent,
      }, isLoading: false, error: null });
    } else {
      mockArchive({ data: { digests: [{ ...digest(leadEdition.generatedAt + 60, "Live title"), ...liveRiskContent }] }, isLoading: false });
    }
    view.rerender(<DigestArchiveClient initialLead={leadEdition} />);

    expect(screen.getByRole("heading", { name: "Build-time lead" })).toBeTruthy();
    expect(screen.getByText("Captured edition text")).toBe(paragraph);
    for (const risk of [screen.getByText(/Critical depeg: PMUSD/), screen.getByText("Depegs"), screen.getByText("Next:")]) {
      expect(paragraph.compareDocumentPosition(risk) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(screen.getByText("PMUSD returns within 100 bps.")).toBeTruthy();
    expect(screen.getByText("August 31, 2026")).toBeTruthy();
  });

  it("leaves every live edition in the archive when the seed is missing", () => {
    mockArchive({ data: { digests: [digest(leadEdition.generatedAt, "Live edition")] }, isLoading: false });
    render(<DigestArchiveClient />);
    expect(screen.getByRole("link", { name: /Live edition/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Continue reading/ })).toBeNull();
  });

  it.each(["daily", "archive"])("replaces an older seed from %s with a newer live edition, including its date and risk content", (source) => {
    const olderLead = { ...leadEdition, date: "2026-08-30", generatedAt: leadEdition.generatedAt - 86400 };
    mockArchive({ data: { digests: [digest(olderLead.generatedAt, "Seed archive row")] }, isLoading: false });
    const view = render(<DigestArchiveClient initialLead={olderLead} />);
    const newerAt = leadEdition.generatedAt;
    if (source === "daily") {
      useDailyDigestMock.mockReturnValue({ data: {
        digest: "Newer live text", digestTitle: "Newer live edition", generatedAt: newerAt, ...liveRiskContent,
      }, isLoading: false, error: null });
    } else {
      useDailyDigestMock.mockReturnValue({ data: {
        digest: "Older daily text", digestTitle: "Older daily edition", generatedAt: olderLead.generatedAt,
      }, isLoading: false, error: null });
    }
    mockArchive({ data: { digests: [
      { ...digest(newerAt, "Newer live edition"), ...(source === "archive" ? liveRiskContent : {}) },
      { ...digest(olderLead.generatedAt, "Same-day weekly"), digestType: "weekly" },
      digest(olderLead.generatedAt, "Seed archive row"),
    ] }, isLoading: false });
    view.rerender(<DigestArchiveClient initialLead={{ ...leadEdition, date: "2026-09-01", generatedAt: newerAt, title: "Newer seed" }} />);
    expect(screen.getByRole("heading", { name: "Newer live edition" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Build-time lead" })).toBeNull();
    expect(screen.getByRole("link", { name: /Continue reading/ }).getAttribute("href")).toBe("/digest/2026-08-31");
    expect(screen.getByRole("link", { name: /Seed archive row/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Newer live edition/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Same-day weekly/ })).toBeTruthy();
    expect(screen.getByText("August 31, 2026")).toBeTruthy();
    expect(screen.getByText(/Critical depeg: PMUSD/)).toBeTruthy();
    expect(screen.getByText("Depegs")).toBeTruthy();
    expect(screen.getByText("Next:")).toBeTruthy();
    expect(screen.queryByText("Today's Lead")).toBeNull();
  });
});

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

describe("DigestArchiveClient month default", () => {
  it("defaults to the newest month that still has archive rows after the lead is removed", () => {
    const leadAt = Date.parse("2026-11-01T00:30:00Z") / 1000;
    const archivedAt = Date.parse("2026-10-31T00:30:00Z") / 1000;
    useDigestArchiveMock.mockReturnValue({
      data: { digests: [digest(leadAt, "Lead edition"), digest(archivedAt, "Archived edition")] },
      isLoading: false, dataUpdatedAt: 0, error: null, refetch: vi.fn(), meta: null,
    });
    useUrlFiltersMock.mockReturnValue({
      searchParams: new URLSearchParams(), setParam: vi.fn(), replaceParams: vi.fn(),
    });

    render(<DigestArchiveClient initialLead={{ ...leadEdition, date: "2026-11-01", generatedAt: leadAt, title: "Lead edition" }} />);

    expect(screen.getByText("Showing 1 archive entry.")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Archived edition/ }).getAttribute("href")).toBe("/digest/2026-10-31");
    expect(screen.queryByText("No digests match these filters.")).toBeNull();
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
    render(<DigestArchiveClient initialLead={leadEdition} />);
    expect(screen.getByText("August 31, 2026")).toBeTruthy();
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
