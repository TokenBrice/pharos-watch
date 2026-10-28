// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DepegHistoryPreview } from "../depeg-history-preview";
import type { StablecoinDetailHistorySnapshot } from "@/lib/stablecoin-detail-history-snapshot";

function makeSnapshot(overrides: Partial<StablecoinDetailHistorySnapshot> = {}): StablecoinDetailHistorySnapshot {
  return {
    stablecoinId: "usdt-tether",
    symbol: "USDT",
    sourceGeneration: `sha256:${"a".repeat(64)}`,
    capturedFrom: Math.floor(Date.parse("2026-10-17T23:57:51.608Z") / 1000),
    capturedAt: Math.floor(Date.parse("2026-10-17T23:58:10.527Z") / 1000),
    methodologyVersion: "v6.34",
    recordedCount: 248,
    earliestStartedAt: 1_600_000_000,
    latestStartedAt: 1_679_500_000,
    coverage: "retained-ledger",
    events: [
      {
        id: 1,
        startedAt: 1_679_500_000,
        endedAt: 1_679_586_400,
        peakDeviationBps: 128,
        pegType: "peggedUSD",
        pegReference: 1,
        closure: "recovered",
        durationSeconds: 86_400,
        source: "backfill",
        href: "/depeg/usdt-2023-03-23/",
        provenance: null,
        coverage: null,
      },
      {
        id: 2,
        startedAt: 1_679_000_000,
        endedAt: null,
        peakDeviationBps: -481,
        pegType: "peggedUSD",
        pegReference: 1,
        closure: "open",
        durationSeconds: null,
        source: "live",
        href: null,
        provenance: null,
        coverage: null,
      },
    ],
    ...overrides,
  };
}

describe("DepegHistoryPreview", () => {
  it("captions the display slice against the full retained count and capture date", () => {
    render(<DepegHistoryPreview snapshot={makeSnapshot()} />);

    expect(screen.getByText(/Latest 2 of 248 archived incidents/)).toBeTruthy();
    expect(screen.getByText(/as of 2026-10-17 UTC/)).toBeTruthy();
    expect(screen.getByText(/Recorded history; coverage may be incomplete\./)).toBeTruthy();
    for (const label of ["Date", "Peak deviation", "Duration", "Recorded status", "Source"]) {
      expect(screen.getByRole("columnheader", { name: label })).toBeTruthy();
    }
  });

  it("qualifies recorded states and open durations at capture", () => {
    render(<DepegHistoryPreview snapshot={makeSnapshot()} />);

    expect(screen.getByText("Recovered")).toBeTruthy();
    expect(screen.getByText("Open at capture")).toBeTruthy();
    expect(screen.getByLabelText("Duration unavailable at capture")).toBeTruthy();
    expect(screen.getByText("+128 bps")).toBeTruthy();
    expect(screen.getByText("-481 bps")).toBeTruthy();
  });

  it("links only a permanent event page and names the recorded source otherwise", () => {
    render(<DepegHistoryPreview snapshot={makeSnapshot()} />);

    const link = screen.getByRole("link", { name: "Event record" });
    expect(link.getAttribute("href")).toBe("/depeg/usdt-2023-03-23/");
    expect(screen.getByText("Live observation")).toBeTruthy();
  });

  it("never renders more than six recorded incidents", () => {
    const events = Array.from({ length: 6 }, (_, index) => ({
      ...makeSnapshot().events[0],
      id: index + 1,
      href: null,
    }));
    render(<DepegHistoryPreview snapshot={makeSnapshot({ recordedCount: 17, events })} />);
    expect(screen.getByText(/Latest 6 of 17 archived incidents/)).toBeTruthy();
    expect(screen.getAllByRole("row")).toHaveLength(7); // header + six events
  });
});
