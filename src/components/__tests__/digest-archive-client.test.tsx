// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DigestArchiveClient } from "@/components/digest-archive-client";

const { useDigestArchiveMock, useUrlFiltersMock } = vi.hoisted(() => ({
  useDigestArchiveMock: vi.fn(),
  useUrlFiltersMock: vi.fn(),
}));

vi.mock("@/hooks/api-hooks", () => ({
  useDigestArchive: useDigestArchiveMock,
}));

vi.mock("@/hooks/use-url-filters", () => ({
  useUrlFilters: useUrlFiltersMock,
}));

vi.mock("@/components/daily-digest", () => ({ DailyDigest: () => null }));
vi.mock("@/components/stale-data-banner", () => ({ StaleDataBanner: () => null }));
vi.mock("@/components/query-error-notice", () => ({ QueryErrorNotice: () => null }));

vi.mock("@/lib/digest", () => ({
  buildDigestTriggerRecord: () => ({
    total: 0,
    hit: 0,
    missed: 0,
    expired: 0,
    pending: 0,
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
