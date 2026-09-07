// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/font/local", () => ({
  default: () => ({ className: "mock-local-font", variable: "--mock-local-font" }),
}));

const { replaceParamsMock, setParamMock, useDigestArchiveMock, useUrlFiltersMock } = vi.hoisted(() => ({
  replaceParamsMock: vi.fn(),
  setParamMock: vi.fn(),
  useDigestArchiveMock: vi.fn(),
  useUrlFiltersMock: vi.fn(),
}));

vi.mock("@/hooks/api-hooks", () => ({
  useDigestArchive: useDigestArchiveMock,
}));

vi.mock("@/hooks/use-url-filters", () => ({
  useUrlFilters: useUrlFiltersMock,
}));

vi.mock("@/components/daily-digest", () => ({
  DailyDigest: () => <div data-testid="daily-digest" />,
}));

vi.mock("@/components/stale-data-banner", () => ({
  StaleDataBanner: () => null,
}));

import {
  DigestArchiveClient,
  filterDigestArchiveEntries,
  normalizeDigestArchiveView,
  resolveLatestDailyDigestSlug,
} from "./digest-archive-client";
import type { DigestArchiveEntry } from "@shared/types/digest";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function entry(
  generatedAt: number,
  digestType: "daily" | "weekly",
  title: string,
  body: string,
): DigestArchiveEntry {
  return {
    digestText: body,
    digestTitle: title,
    digestExtended: body,
    generatedAt,
    psiScore: null,
    psiBand: null,
    totalMcapUsd: null,
    digestType,
    editionNumber: 1,
  };
}

function configureArchiveClient(entries: DigestArchiveEntry[]) {
  useDigestArchiveMock.mockReturnValue({
    data: { digests: entries },
    isLoading: false,
    dataUpdatedAt: 1_800_000_000_000,
    error: null,
    refetch: vi.fn(),
    meta: null,
  });
  useUrlFiltersMock.mockReturnValue({
    searchParams: new URLSearchParams(),
    setParam: setParamMock,
    replaceParams: replaceParamsMock,
  });
}

describe("resolveLatestDailyDigestSlug", () => {
  it("selects the latest daily digest even when a newer weekly recap is first", () => {
    expect(
      resolveLatestDailyDigestSlug([
        { generatedAt: Date.parse("2026-06-15T08:08:19Z") / 1000, digestType: "weekly" },
        { generatedAt: Date.parse("2026-06-15T08:08:16Z") / 1000, digestType: "daily" },
      ]),
    ).toBe("2026-06-15");
  });

  it("returns null when the archive contains only weekly recaps", () => {
    expect(
      resolveLatestDailyDigestSlug([
        { generatedAt: Date.parse("2026-06-15T08:08:19Z") / 1000, digestType: "weekly" },
      ]),
    ).toBeNull();
  });
});

describe("digest archive URL filters", () => {
  const entries = [
    entry(Date.parse("2026-08-30T08:00:00Z") / 1000, "daily", "Gauge turns", "Flow pressure eased."),
    entry(Date.parse("2026-08-24T08:00:00Z") / 1000, "weekly", "The week in review", "Liquidity and depeg recap."),
    entry(Date.parse("2026-07-30T08:00:00Z") / 1000, "daily", "Quiet month", "Supply held steady."),
  ];

  it("normalizes unsupported view values to the all-editions view", () => {
    expect(normalizeDigestArchiveView(null)).toBe("all");
    expect(normalizeDigestArchiveView("monthly")).toBe("all");
    expect(normalizeDigestArchiveView("weekly")).toBe("weekly");
  });

  it("combines type, month, body/title search, and latest-lead exclusion", () => {
    expect(
      filterDigestArchiveEntries(entries, {
        view: "daily",
        month: "2026-08",
        query: "liquidity",
        latestDailySlug: "2026-08-30",
      }),
    ).toHaveLength(0);
    expect(
      filterDigestArchiveEntries(entries, {
        view: "weekly",
        month: "2026-08",
        query: "liquidity",
      }).map((digest) => digest.digestTitle),
    ).toEqual(["The week in review"]);
    expect(
      filterDigestArchiveEntries(entries, {
        view: "daily",
        month: "2026-07",
        query: "supply",
      }).map((digest) => digest.digestTitle),
    ).toEqual(["Quiet month"]);
  });

  it("does not exclude a weekly recap sharing the latest daily date", () => {
    const sameDayWeekly = entry(Date.parse("2026-08-30T09:00:00Z") / 1000, "weekly", "Same day recap", "Weekly context.");
    expect(
      filterDigestArchiveEntries([entries[0]!, sameDayWeekly], {
        view: "all",
        month: "2026-08",
        query: "",
        latestDailySlug: "2026-08-30",
      }).map((digest) => digest.digestTitle),
    ).toEqual(["Same day recap"]);
  });

  it("exposes URL-addressable type, month, and text controls", () => {
    configureArchiveClient(entries);

    render(<DigestArchiveClient />);

    fireEvent.click(screen.getByRole("button", { name: "daily" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by month" }), { target: { value: "2026-07" } });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search digest title and body" }), { target: { value: "supply" } });

    expect(setParamMock).toHaveBeenNthCalledWith(1, "view", "daily");
    expect(setParamMock).toHaveBeenNthCalledWith(2, "month", "2026-07");
    expect(replaceParamsMock).toHaveBeenCalledTimes(1);
    const updateSearch = replaceParamsMock.mock.calls[0]?.[0] as (params: URLSearchParams) => void;
    const params = new URLSearchParams();
    updateSearch(params);
    expect(params.get("q")).toBe("supply");
  });
});
