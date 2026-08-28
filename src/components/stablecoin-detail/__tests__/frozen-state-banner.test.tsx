// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { StablecoinObituary } from "@shared/types";

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

  it("renders the epitaph headline", () => {
    render(<FrozenStateBanner symbol="USR" frozenAt="2026-04-27" obituary={obituary} />);
    expect(screen.getByRole("heading", { name: /Sunset by issuer\./ })).toBeTruthy();
  });

  it("renders the cause-of-death label", () => {
    render(<FrozenStateBanner symbol="USR" frozenAt="2026-04-27" obituary={obituary} />);
    expect(screen.getByText(/Abandoned/i)).toBeTruthy();
  });

  it("links to the cemetery", () => {
    render(<FrozenStateBanner symbol="USR" frozenAt="2026-04-27" obituary={obituary} />);
    const link = screen.getByRole("link", { name: /cemetery/i });
    expect(link.getAttribute("href")).toBe("/cemetery/");
  });

  it("links to the obituary source", () => {
    render(<FrozenStateBanner symbol="USR" frozenAt="2026-04-27" obituary={obituary} />);
    expect(screen.getByRole("link", { name: /Resolv announcement/i }).getAttribute("href")).toBe(obituary.sourceUrl);
  });
});
