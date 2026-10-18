// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DigestSnapshot } from "@/components/digest-snapshot";
import { makeReportCardsV9Response } from "@/test/fixtures/safety-score-v9";
import { COMPLETE_DIGEST_SAFETY_MAP as completeSafetyMap } from "@shared/test-utils/digest-safety-map";

const { useDigestSnapshotMock } = vi.hoisted(() => ({
  useDigestSnapshotMock: vi.fn(),
}));
const viewport = vi.hoisted(() => ({ near: true }));
vi.mock("@/hooks/use-near-viewport", () => ({
  useNearViewport: () => ({ ref: vi.fn(), near: viewport.near }),
}));

vi.mock("@/hooks/api-hooks", () => ({
  useDigestSnapshot: useDigestSnapshotMock,
}));

afterEach(() => {
  vi.clearAllMocks();
  viewport.near = true;
});

function mockSnapshot(inputData: Record<string, unknown>, depegEvents: unknown[] = []) {
  useDigestSnapshotMock.mockReturnValue({
    data: { date: "2026-09-01", inputData, prevInputData: null, depegEvents, blacklistEvents: [] },
    isLoading: false,
    isError: false,
  });
}

describe("DigestSnapshot", () => {
  it("does not admit the dated snapshot query until its article section reaches the viewport", () => {
    viewport.near = false;
    mockSnapshot({ totalMcapUsd: 1e9 });
    const { rerender } = render(<DigestSnapshot date="2026-09-01" />);
    expect(useDigestSnapshotMock).not.toHaveBeenCalled();
    viewport.near = true;
    rerender(<DigestSnapshot date="2026-09-01" />);
    expect(useDigestSnapshotMock).toHaveBeenCalledWith("2026-09-01");
  });

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

  it("prints rounded scores, labelled reason codes and duplicate symbols without debug syntax", () => {
    const { safetyScoreIdentity } = makeReportCardsV9Response();
    const coin = {
      symbol: "USDA",
      grade: "C",
      score: 47.81,
      pillars: { backing: { score: 53.239999999999995 }, exit: { score: 42.54 }, control: { score: 60 } },
      reasonCodes: ["missing-reserve-composition"],
      caps: [],
      bindingCap: null,
    };
    mockSnapshot({
      totalMcapUsd: 250_000_000_000,
      safetyScores: {
        model: "v9",
        mentionedCoins: [coin, { ...coin, score: 30 }],
        gradeDistribution: { C: 2 },
        provenance: { ...safetyScoreIdentity, methodologyVersion: "10.0", publishedAt: 1_756_684_800 },
      },
      yieldAnomalies: [{ symbol: "USDA", currentApy: 12.345678, apy7d: 10, apy30d: 8.5, warnings: ["negative-trend"], mcapUsd: 1 }],
    });

    const { container } = render(<DigestSnapshot date="2026-09-01" />);
    const text = container.textContent ?? "";

    expect(text).toContain("backing 53.2, exit 42.5, control 60");
    expect(text).toContain("Reserve composition not published");
    expect(text).toContain("12.35% APY");
    expect(text).toContain("Negative trend");
    expect(text).not.toMatch(/=|missing-reserve-composition|negative-trend/);
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
