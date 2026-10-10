// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DigestSnapshot } from "@/components/digest-snapshot";
import { makeReportCardsV9Response } from "@/test/fixtures/safety-score-v9";

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
  it.each([
    ["9.98", "V9"],
    ["10.0", "V10"],
  ])("labels the captured %s publication without relabelling historical editions", (methodologyVersion, majorLabel) => {
    const { safetyScoreIdentity } = makeReportCardsV9Response();
    mockSnapshot({
      totalMcapUsd: 250_000_000_000,
      safetyScores: {
        model: "v9",
        mentionedCoins: [],
        gradeDistribution: { A: 1, B: 2 },
        provenance: { ...safetyScoreIdentity, methodologyVersion, publishedAt: 1_756_684_800 },
      },
    });

    render(<DigestSnapshot date="2026-09-01" />);

    expect(screen.getByText(`${majorLabel} distribution: A 1, B 2`)).toBeTruthy();
  });

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

  it("renders captured current severity separately from a deep historical peak", () => {
    mockSnapshot({
      totalMcapUsd: 1e9, activeDepegCount: 1,
      topDepegs: [{ stablecoinId: "usdc-circle", symbol: "USDC", bps: -5000,
        currentBps: -100, severityBasis: "current", mcapUsd: 1e8 }],
    });
    render(<DigestSnapshot date="2026-09-01" />);
    const row = screen.getByText(/USDC:/);
    expect(row.textContent).toContain("-100 bps below peg");
    expect(row.textContent).toContain("historical peak -5000 bps");
    expect(row.textContent).not.toContain("-5000 bps below peg");
  });

  it("labels a peak fallback and legacy capture as historical with current unavailable", () => {
    mockSnapshot({
      totalMcapUsd: 1e9, activeDepegCount: 2,
      topDepegs: [
        { symbol: "USDC", bps: -5000, severityBasis: "peak-fallback", mcapUsd: 1e8 },
        { symbol: "USDT", bps: -900, mcapUsd: 1e8 },
      ],
    });
    render(<DigestSnapshot date="2026-09-01" />);
    expect(screen.getByText(/USDC:/).textContent).toContain("historical peak; current unavailable");
    expect(screen.getByText(/USDT:/).textContent).toContain("historical peak; current unavailable");
  });

  it("marks absent market fields as uncaptured instead of publishing zero readings", () => {
    mockSnapshot({ totalMcapUsd: 250_000_000_000, activeDepegCount: 0, topDepegs: [] });

    render(<DigestSnapshot date="2026-09-01" />);

    expect(screen.getAllByText("Not captured for this edition")).toHaveLength(1);
    expect(screen.queryByText(/\$0/)).toBeNull();
    expect(screen.queryByText(/\+0\.00%/)).toBeNull();
  });

  it.each([null, 0])("renders a failed depeg read unavailable, not an observed %s or day-overlap count", (activeDepegCount) => {
    mockSnapshot({
      totalMcapUsd: 1e9, activeDepegCount, resolvedDepegCount: null,
      depegSignalKeys: { active: null, resolved: null }, degradedSources: ["active-depegs-query"], topDepegs: [],
    }, [{ stablecoinId: "usdc-circle", symbol: "USDC", direction: "below", peakDeviationBps: -200, startedAt: 1, endedAt: null }]);
    render(<DigestSnapshot date="2026-10-10" />);
    expect(screen.getByText("Active depeg count unavailable for this edition")).toBeTruthy();
    expect(screen.getByText("Episodes active at any point this day")).toBeTruthy();
    expect(screen.queryByText("No active depegs at publication")).toBeNull();
    expect(screen.queryByText(/active depegs? at publication/)).toBeNull();
  });

  it("publishes full daily count and qualified subtotal rather than capped sample statistics", () => {
    useDigestSnapshotMock.mockReturnValue({
      data: {
        date: "2026-09-01", inputData: { totalMcapUsd: 100e9 }, prevInputData: null, depegEvents: [],
        blacklistEvents: Array.from({ length: 50 }, (_, i) => ({
          stablecoin: "USDC", chainName: "Ethereum", eventType: "blacklist", address: `address-${i}`,
          amountNative: null, amountUsdAtEvent: i === 0 ? null : 10, amountStatus: "resolved", timestamp: i,
        })),
        blacklistSummary: { totalEvents: 52, knownAmountUsd: 500, valuedEvents: 50, unavailableAmountEvents: 2 },
      },
      isLoading: false, isError: false,
    });
    render(<DigestSnapshot date="2026-09-01" />);
    expect(screen.getByText(/events on this day/).textContent).toContain("52");
    expect(screen.getByText(/known subtotal/).textContent).toContain("$500");
    expect(screen.getByText(/known subtotal/).textContent).toContain("2 unvalued");
    expect(screen.getByText("Showing latest 5 of 52 events")).toBeTruthy();
    expect(screen.queryByText(/totaling/)).toBeNull();
  });
});
