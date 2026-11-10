// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UpcomingPegCoinsSection } from "@/components/peg-hub-sections";
import type { UpcomingPegCoinEntry } from "@/lib/peg-hub-content";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

afterEach(cleanup);

const entries: UpcomingPegCoinEntry[] = [
  {
    id: "alpha-pre",
    href: "/stablecoins/alpha-pre/",
    name: "Alpha",
    symbol: "ALP",
    status: "Testnet · target H2 2026",
    launched: false,
  },
  {
    id: "beta-live",
    href: "/stablecoins/beta-live/",
    name: "Beta",
    symbol: "BET",
    status: "Launched · since Oct 2026",
    launched: true,
  },
];

describe("UpcomingPegCoinsSection", () => {
  it("renders launched-awaiting-data coins below the upcoming grid under their own heading", () => {
    render(<UpcomingPegCoinsSection shortLabel="Euro" entries={entries} />);

    expect(screen.getByRole("heading", { name: "Upcoming Euro stablecoins" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "Launched – not yet tracked" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Alpha (ALP)" }).getAttribute("href")).toBe("/stablecoins/alpha-pre/");
    expect(screen.getByRole("link", { name: "Beta (BET)" }).getAttribute("href")).toBe("/stablecoins/beta-live/");
  });

  it("omits the upcoming module and its description when every coin has launched", () => {
    render(<UpcomingPegCoinsSection shortLabel="Euro" entries={[entries[1]]} />);

    expect(screen.queryByRole("heading", { name: "Upcoming Euro stablecoins" })).toBeNull();
    expect(screen.queryByText(/Announced coins Pharos tracks/)).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "Launched – not yet tracked" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Beta (BET)" })).toBeTruthy();
  });
});
