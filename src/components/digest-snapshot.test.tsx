// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DigestSnapshot } from "@/components/digest-snapshot";

const { useDigestSnapshotMock } = vi.hoisted(() => ({
  useDigestSnapshotMock: vi.fn(),
}));

vi.mock("@/hooks/api-hooks", () => ({
  useDigestSnapshot: useDigestSnapshotMock,
}));

function makeSnapshot(safetyMap: unknown) {
  return {
    date: "2026-08-30",
    inputData: {
      totalMcapUsd: 100_000_000_000,
      mcap7dDelta: 0,
      activeDepegCount: 0,
      topDepegs: [],
      safetyMap,
    },
    prevInputData: null,
    depegEvents: [],
    blacklistEvents: [],
  };
}

const completeSafetyMap = {
  imageUrl: "https://pharos.watch/safety-scores/map.png?date=2026-08-30",
  freshness: "current",
  ageDays: 0,
  manifest: {
    date: "2026-08-30",
    mapSummary: {
      date: "2026-08-30",
      asOfSec: 1_788_000_000,
      methodologyVersion: "v9.4",
      gradedCount: 10,
      notRatedCount: 2,
      totalMcapUsd: 100_000_000_000,
      floorMcapByTier: { a: 1_000_000, other: 100_000 },
      tiers: [
        { tier: "A", range: "90–100", count: 2, mcapUsd: 70_000_000_000, sharePct: 70, leaders: [] },
        { tier: "B", range: "80–89", count: 2, mcapUsd: 15_000_000_000, sharePct: 15, leaders: [] },
        { tier: "C", range: "70–79", count: 2, mcapUsd: 8_000_000_000, sharePct: 8, leaders: [] },
        { tier: "D", range: "60–69", count: 2, mcapUsd: 5_000_000_000, sharePct: 5, leaders: [] },
        { tier: "F", range: "0–59", count: 2, mcapUsd: 2_000_000_000, sharePct: 2, leaders: [] },
      ],
    },
  },
} as const;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("DigestSnapshot safety map", () => {
  it("renders the stored dated poster and deterministic tally", () => {
    useDigestSnapshotMock.mockReturnValue({ data: makeSnapshot(completeSafetyMap), isLoading: false, isError: false });

    render(<DigestSnapshot date="2026-08-30" />);

    const image = screen.getByAltText(/Safety Score Map for August 30, 2026/i);
    expect(image.getAttribute("src")).toContain("date=2026-08-30");
    expect(image.getAttribute("src")).not.toContain("latest");
    const mapRegion = screen.getByRole("region", { name: "The dated market census behind this edition" });
    expect(mapRegion.textContent).toContain("Mapped supply: $100.0B across 10 coins");
    expect(mapRegion.textContent).toContain("A tier: 2 coins · 70.0%");
    expect(mapRegion.textContent).toContain("C/D/F tiers: 6 coins · 15.0%");
  });

  it("fails closed when the stored map is incomplete", () => {
    useDigestSnapshotMock.mockReturnValue({
      data: makeSnapshot({
        ...completeSafetyMap,
        imageUrl: "https://pharos.watch/safety-scores/map.png",
      }),
      isLoading: false,
      isError: false,
    });

    render(<DigestSnapshot date="2026-08-30" />);

    expect(screen.queryByText("The dated market census behind this edition")).toBeNull();
    expect(screen.queryByText(/Mapped supply:/)).toBeNull();
  });

  it("uses the unavailable panel when the dated poster returns an image error", () => {
    useDigestSnapshotMock.mockReturnValue({ data: makeSnapshot(completeSafetyMap), isLoading: false, isError: false });

    render(<DigestSnapshot date="2026-08-30" />);

    fireEvent.error(screen.getByAltText(/Safety Score Map for August 30, 2026/i));

    expect(screen.getByText("The map is not available right now")).toBeTruthy();
    expect(screen.queryByText(/Mapped supply:/)).toBeNull();
  });
});
