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

  it("scopes its all-clear copy to the peg catalog it filters on", () => {
    render(<DEWSAlertFeed signals={{ "test-coin": makeSignal({ score: 5, band: "CALM" }) }} />);

    expect(screen.getByText("All peg-catalog assets with DEWS coverage are below ALERT.")).toBeTruthy();
  });

  it("drops its own alert count when embedded, since the hero rail owns that figure", () => {
    const signals = { "test-coin": makeSignal({ score: 47, band: "ALERT" }) };

    const standalone = render(<DEWSAlertFeed signals={signals} />);
    expect(screen.getByText(/at alert or worse/i)).toBeTruthy();
    standalone.unmount();

    render(<DEWSAlertFeed signals={signals} embedded />);
    expect(screen.queryByText(/at alert or worse/i)).toBeNull();
  });
});
