// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DEWSAlertFeed } from "@/components/dews-alert-feed";
import type { StressSignalEntry } from "@shared/types";

vi.mock("@/hooks/use-prefetch-stablecoin", () => ({
  usePrefetchStablecoin: () => vi.fn(),
}));

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});


function makeSignal(overrides: Partial<StressSignalEntry> = {}): StressSignalEntry {
  return {
    score: 70,
    band: "WARNING",
    signals: {
      supply: { value: 80, available: true },
      diverg: { value: 60, available: true },
    },
    amplifiers: { psi: 1.1, contagion: 1.08 },
    computedAt: 1_700_000_000,
    methodologyVersion: "v1",
    ...overrides,
  };
}

describe("DEWSAlertFeed", () => {
  it("shows top drivers and amplifiers for elevated rows", () => {
    render(<DEWSAlertFeed signals={{ "test-coin": makeSignal() }} />);

    expect(screen.getByText(/Supply Velocity/i)).toBeTruthy();
    expect(screen.getByText(/PSI 1.10x/i)).toBeTruthy();
    expect(screen.getByText(/Contagion 1.08x/i)).toBeTruthy();
  });

  it("uses current-coverage all-clear copy", () => {
    render(<DEWSAlertFeed signals={{ "test-coin": makeSignal({ score: 5, band: "CALM" }) }} />);

    expect(screen.getByText("All coins with current DEWS coverage are below ALERT.")).toBeTruthy();
  });
});
