// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CollateralizationCard } from "../collateralization-card";
import type { MechanismCollateralizationView } from "@/lib/mechanism-collateralization";

const reviewed: MechanismCollateralizationView = {
  ratio: 2.455,
  notApplicableRationale: null,
  liquidationCapacityRatio: 0.658,
  reviewedAt: "2026-07-15",
  sourceLabel: "Liquity V2 protocol stats API",
  sourceUrl: "https://example.com/stats",
};

describe("CollateralizationCard", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("renders the reviewed ratio with an overcollateralized badge and provenance", () => {
    render(<CollateralizationCard reviewed={reviewed} />);
    expect(screen.getByText("245.5%")).toBeTruthy();
    expect(screen.getByText("Overcollateralized")).toBeTruthy();
    expect(screen.getByText(/Reviewed 2026-07-15/)).toBeTruthy();
    expect(screen.getByText("65.8%")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Liquity V2 protocol stats API/ }).getAttribute("href")).toBe(
      "https://example.com/stats",
    );
  });

  it("labels an undercollateralized ratio honestly", () => {
    render(<CollateralizationCard reviewed={{ ...reviewed, ratio: 0.211, liquidationCapacityRatio: null }} />);
    expect(screen.getByText("21.1%")).toBeTruthy();
    expect(screen.getByText("Undercollateralized")).toBeTruthy();
  });

  it("prefers the live feed ratio over the reviewed one", () => {
    render(<CollateralizationCard reviewed={reviewed} liveRatio={5.176368} liveAtSec={1785168827} />);
    expect(screen.getByText("517.6%")).toBeTruthy();
    expect(screen.getByText(/Live/)).toBeTruthy();
    expect(screen.queryByText("245.5%")).toBeNull();
  });

  it("shows the age of a live feed timestamp expressed in Unix seconds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T12:00:00Z"));
    const twoHoursAgoSec = Date.parse("2026-07-28T10:00:00Z") / 1000;

    render(<CollateralizationCard reviewed={reviewed} liveRatio={1.1} liveAtSec={twoHoursAgoSec} />);

    expect(screen.getByText("Live · 2h ago")).toBeTruthy();
  });

  it("prefers a zero live ratio over reviewed data", () => {
    render(<CollateralizationCard reviewed={reviewed} liveRatio={0} />);
    expect(screen.getByText("0.0%")).toBeTruthy();
    expect(screen.getByText("Undercollateralized")).toBeTruthy();
    expect(screen.queryByText("245.5%")).toBeNull();
  });

  it("renders a reviewed not-applicable ruling without a number", () => {
    render(
      <CollateralizationCard
        reviewed={{
          ...reviewed,
          ratio: null,
          liquidationCapacityRatio: null,
          notApplicableRationale: "No independent per-token vault system exists.",
        }}
      />,
    );
    expect(screen.getByText("Not applicable")).toBeTruthy();
    expect(screen.getByText(/per-token vault system/)).toBeTruthy();
  });

  it("renders nothing when there is neither live nor reviewed data", () => {
    const { container } = render(<CollateralizationCard reviewed={null} />);
    expect(container.firstChild).toBeNull();
  });
});
