// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DEWSAlertFeed } from "@/components/dews-alert-feed";
import type { StressSignalEntry } from "@shared/types";
import { makeDews } from "./depeg.test-support";

vi.mock("@/hooks/use-prefetch-stablecoin", () => ({
  usePrefetchStablecoin: () => vi.fn(),
}));

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});


function makeSignal(overrides: Partial<StressSignalEntry> = {}): StressSignalEntry {
  return makeDews({
    score: 70,
    band: "WARNING",
    signals: {
      supply: { value: 80, available: true },
      diverg: { value: 60, available: true },
    },
    amplifiers: { psi: 1.1, contagion: 1.08 },
    computedAt: 1_700_000_000,
    ...overrides,
  });
}

describe("DEWSAlertFeed", () => {
  it("shows top drivers and amplifiers for elevated rows", () => {
    render(<DEWSAlertFeed signals={{ "test-coin": makeSignal() }} />);

    expect(screen.getByText(/Supply Velocity/i)).toBeTruthy();
    expect(screen.getByText(/PSI 1.10x/i)).toBeTruthy();
    expect(screen.getByText(/Contagion 1.08x/i)).toBeTruthy();
  });

  it("omits the module when the DEWS aggregate is empty or unreadable", () => {
    const { container } = render(<DEWSAlertFeed signals={{}} />);

    expect(container.firstChild).toBeNull();
    expect(screen.queryByText(/below ALERT/)).toBeNull();
  });

  it("keeps the all-clear only for a census whose assets were actually observed", () => {
    render(<DEWSAlertFeed signals={{ "test-coin": makeSignal({ band: "CALM" }) }} />);

    expect(screen.getByText("All peg-catalog assets with DEWS coverage are below ALERT.")).toBeTruthy();
  });
});
