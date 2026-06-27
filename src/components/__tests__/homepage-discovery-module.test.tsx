// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Activity, BookOpen, ShieldCheck, Waves, Wallet } from "lucide-react";

import { HomepageDiscoveryModule } from "@/components/homepage-discovery-module";
import type { HomepageDiscoverySuggestion } from "@/lib/homepage-discovery";

describe("HomepageDiscoveryModule", () => {
  afterEach(() => {
    cleanup();
  });

  it("defaults to the Figma route sequence", () => {
    render(<HomepageDiscoveryModule />);

    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual([
      "SpotlightChains",
      "ANALYZEPortfolio AuditLook through your holdings as one combined stablecoin book",
      "MONITORUpcoming",
      "COREAlt-Pegs",
      "TRACKCemetery",
    ]);
    expect(screen.getByRole("button", { name: /refresh/i })).toBeTruthy();
    expect(screen.queryByText(/ipsum/i)).toBeNull();
  });

  it("renders a labelled page-discovery nav with five route links", async () => {
    const suggestions: HomepageDiscoverySuggestion[] = [
      {
        title: "Safety Scores",
        description: "Cross-market safety grades",
        shortDescription: "Report cards per coin",
        href: "/safety-scores/",
        groupLabel: "CORE",
        accent: "var(--brand-accent)",
        icon: ShieldCheck,
      },
      {
        title: "Liquidity",
        description: "DEX depth and durability",
        shortDescription: "DEX scores",
        href: "/liquidity/",
        groupLabel: "TRACK",
        accent: "var(--p-teal-500)",
        icon: Waves,
      },
      {
        title: "Depeg Tracker",
        description: "Live incident board",
        shortDescription: "Peg incidents and DDR",
        href: "/depeg/",
        groupLabel: "MONITOR",
        accent: "var(--p-amber-500)",
        icon: Activity,
      },
      {
        title: "Portfolio",
        description: "Audit your holdings",
        shortDescription: "Holdings risk audit",
        href: "/portfolio/",
        groupLabel: "ANALYZE",
        accent: "var(--p-purple-500)",
        icon: Wallet,
      },
      {
        title: "Methodology",
        description: "Formula reference",
        shortDescription: "Formula reference",
        href: "/methodology/",
        groupLabel: "REFERENCE",
        accent: "var(--p-blue-500)",
        icon: BookOpen,
      },
    ];

    render(<HomepageDiscoveryModule suggestions={suggestions} />);

    const nav = screen.getByRole("navigation", { name: /page discovery/i });
    expect(nav).toBeTruthy();

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(5);
    expect(screen.getByRole("link", { name: /safety scores/i }).getAttribute("href")).toBe("/safety-scores");
    expect(screen.getByText("Spotlight")).toBeTruthy();
    expect(screen.getByText("DEX depth and durability")).toBeTruthy();
    expect(screen.queryByText("DEX scores")).toBeNull();
    expect(screen.queryByText(/ipsum/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /previous routes/i })).toBeNull();
  });
});
