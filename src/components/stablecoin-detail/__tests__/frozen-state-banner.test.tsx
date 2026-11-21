// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { StablecoinObituary } from "@shared/types/stablecoin-meta-schemas";
import { FrozenDataNote } from "../frozen-data-note";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

const { FrozenStateBanner } = await import("../frozen-state-banner");

const obituary: StablecoinObituary = {
  causeOfDeath: "abandoned",
  deathDate: "2026-04",
  epitaph: "Sunset by issuer.",
  obituary: "Resolv USR was wound down in April 2026 following protocol-level losses.",
  peakMcap: 99_000_000,
  sourceUrl: "https://example.com/resolv-shutdown",
  sourceLabel: "Resolv announcement",
};

describe("FrozenStateBanner", () => {
  it("renders the epitaph, cause, and both destinations from one obituary", () => {
    render(<FrozenStateBanner symbol="USR" frozenAt="2026-04-27" obituary={obituary} />);

    expect(screen.getByRole("heading", { name: /Sunset by issuer\./ })).toBeTruthy();
    expect(screen.getByText(/Abandoned/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /cemetery/i }).getAttribute("href")).toBe("/cemetery/");
    expect(screen.getByRole("link", { name: /Resolv announcement/i }).getAttribute("href")).toBe(obituary.sourceUrl);
  });

  it("uses non-inverted expand/collapse labels for the obituary toggle", () => {
    render(<FrozenStateBanner symbol="USR" frozenAt="2026-04-27" obituary={obituary} />);

    const hideButton = screen.getByRole("button", { name: "Hide full obituary" });
    expect(hideButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(obituary.obituary)).toBeTruthy();

    fireEvent.click(hideButton);
    const readButton = screen.getByRole("button", { name: "Read full obituary" });
    expect(readButton.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(obituary.obituary)).toBeNull();

    fireEvent.click(readButton);
    expect(screen.getByRole("button", { name: "Hide full obituary" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(obituary.obituary)).toBeTruthy();
  });
});

describe("FrozenDataNote", () => {
  it("states the freeze date and that collection has stopped", () => {
    render(<FrozenDataNote frozenAt="2026-04-27" />);

    expect(screen.getByText(/2026-04-27/)).toBeTruthy();
    expect(screen.getByText(/no longer collects new metrics/i)).toBeTruthy();
  });
});
