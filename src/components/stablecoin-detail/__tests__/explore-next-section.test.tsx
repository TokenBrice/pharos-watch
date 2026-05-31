// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const { ExploreNextSection } = await import("../explore-next-section");

const coin = {
  id: "test-cdp-dollar",
  name: "Test CDP Dollar",
  symbol: "TCDP",
  mechanismArchetype: "cdp",
  flags: {
    governance: "decentralized",
    backing: "crypto-backed",
    pegCurrency: "USD",
    yieldBearing: false,
    rwa: false,
    navToken: false,
  },
  infrastructures: [],
} as unknown as StablecoinMeta;

describe("ExploreNextSection", () => {
  afterEach(() => cleanup());

  it("links mechanism tracker CTAs to the canonical plural screener parameter", () => {
    render(<ExploreNextSection coin={coin} related={[]} staticComparisonPages={[]} logos={{}} />);

    expect(screen.getByRole("link", { name: "See all CDP stablecoins" }).getAttribute("href")).toBe(
      "/screener/?mechanisms=cdp",
    );
  });
});
