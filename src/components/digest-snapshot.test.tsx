// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DigestSnapshot } from "@/components/digest-snapshot";
import { COMPLETE_DIGEST_SAFETY_MAP as completeSafetyMap } from "@shared/test-utils/digest-safety-map";

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
