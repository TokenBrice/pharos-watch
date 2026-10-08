// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ReserveDriftEntry } from "@shared/types";
import { MetadataIntegrityCard } from "../metadata-integrity-card";

function makeWarning(index: number): ReserveDriftEntry {
  return {
    coinId: `warning-${index}`,
    liveCollateralScore: 50,
    curatedCollateralScore: 75,
    delta: 25,
  };
}

describe("MetadataIntegrityCard", () => {
  it("discloses the full warning count while initially showing six rows", async () => {
    const warnings = Array.from({ length: 8 }, (_, index) => makeWarning(index + 1));

    render(<MetadataIntegrityCard reserveDrift={warnings} />);

    expect(screen.getByText("8 warnings (6 shown)")).toBeTruthy();
    expect(screen.getByText("warning-6")).toBeTruthy();
    expect(screen.queryByText("warning-7")).toBeNull();

    fireEvent.click(screen.getByText("Show remaining 2 warnings"));

    expect(await screen.findByText("warning-7")).toBeTruthy();
    expect(screen.getByText("warning-8")).toBeTruthy();
  });

  it("distinguishes a clean empty watchlist from an unavailable or failed read", () => {
    const { rerender } = render(<MetadataIntegrityCard reserveDrift={[]} />);
    expect(screen.getByText(/No reserve-score drift above/)).toBeTruthy();
    rerender(<MetadataIntegrityCard reserveDrift={undefined} />);
    expect(screen.getByText(/no zero count is inferred/)).toBeTruthy();
    rerender(<MetadataIntegrityCard reserveDrift={undefined} reserveDriftError={{ code: "reserve_drift_computation_failed", message: "Unavailable" }} />);
    expect(screen.getByText(/Reserve drift loader failed/)).toBeTruthy();
  });
});
