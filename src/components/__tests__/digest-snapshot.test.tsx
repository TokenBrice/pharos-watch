// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DigestSnapshot } from "@/components/digest-snapshot";

const { useDigestSnapshotMock } = vi.hoisted(() => ({
  useDigestSnapshotMock: vi.fn(),
}));

vi.mock("@/hooks/api-hooks", () => ({
  useDigestSnapshot: useDigestSnapshotMock,
}));

afterEach(() => {
  vi.clearAllMocks();
});

function mockSnapshot(inputData: Record<string, unknown>, depegEvents: unknown[] = []) {
  useDigestSnapshotMock.mockReturnValue({
    data: { date: "2026-09-01", inputData, prevInputData: null, depegEvents, blacklistEvents: [] },
    isLoading: false,
    isError: false,
  });
}

describe("DigestSnapshot", () => {
  it("keeps the edition's captured depeg count when the day-overlap query returns other episodes", () => {
    mockSnapshot(
      {
        totalMcapUsd: 250_000_000_000,
        activeDepegCount: 1,
        topDepegs: [{ stablecoinId: "usdx-x", symbol: "USDX", bps: -120, startedAt: 1_756_684_800 }],
      },
      [
        { stablecoinId: "usdy-y", symbol: "USDY", direction: "below", peakDeviationBps: -300, startedAt: 1_756_600_000, endedAt: 1_756_650_000 },
        { stablecoinId: "usdz-z", symbol: "USDZ", direction: "above", peakDeviationBps: 210, startedAt: 1_756_610_000, endedAt: null },
      ],
    );

    render(<DigestSnapshot date="2026-09-01" />);

    expect(screen.getByText(/active depeg at publication/)).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText(/USDX/)).toBeTruthy();
    expect(screen.getByText("Episodes active at any point this day")).toBeTruthy();
    expect(screen.getByText(/USDY/)).toBeTruthy();
  });

  it("marks absent market fields as uncaptured instead of publishing zero readings", () => {
    mockSnapshot({ totalMcapUsd: 250_000_000_000, activeDepegCount: 0, topDepegs: [] });

    render(<DigestSnapshot date="2026-09-01" />);

    expect(screen.getAllByText("Not captured for this edition")).toHaveLength(1);
    expect(screen.queryByText(/\$0/)).toBeNull();
    expect(screen.queryByText(/\+0\.00%/)).toBeNull();
  });
});
