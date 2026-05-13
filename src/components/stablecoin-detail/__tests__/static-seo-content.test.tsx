// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StablecoinAiSummary, StablecoinMeta } from "@shared/types";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const { StablecoinDetailSeoContent } = await import("../static-seo-content");

const coin: StablecoinMeta = {
  id: "test-dollar",
  name: "Test Dollar",
  symbol: "TSTD",
  flags: {
    governance: "centralized-dependent",
    backing: "rwa-backed",
    pegCurrency: "USD",
    yieldBearing: false,
    rwa: true,
    navToken: false,
  },
  collateral: "Cash, Treasury bills, and overnight repos.",
  pegMechanism: "Primary market mint and redeem arbitrage plus secondary market liquidity.",
  jurisdiction: {
    country: "United States",
    regulator: "NYDFS",
    license: "Limited Purpose Trust",
  },
  proofOfReserves: {
    type: "independent-audit",
    provider: "Example Auditor",
    url: "https://example.com/reserves",
  },
  contracts: [
    { chain: "ethereum", address: "0x0000000000000000000000000000000000000001", decimals: 6 },
    { chain: "base", address: "0x0000000000000000000000000000000000000002", decimals: 6 },
    { chain: "solana", address: "So11111111111111111111111111111111111111112", decimals: 6 },
  ],
  infrastructures: ["m0"],
};

const summary: StablecoinAiSummary = {
  title: "Test Dollar profile",
  text: "The profile summary is concise and specific. Extra detail should stay short enough for the static block.",
  updatedAt: "2026-05-02",
};

describe("StablecoinDetailSeoContent", () => {
  afterEach(() => cleanup());

  it("renders one hidden h1 plus a visible static profile with taxonomy links and facts", () => {
    const { container } = render(<StablecoinDetailSeoContent coin={coin} summary={summary} />);

    const headings = container.querySelectorAll("h1");
    expect(headings).toHaveLength(1);
    expect(headings[0]?.className).toContain("sr-only");
    expect(headings[0]?.textContent).toContain("Test Dollar (TSTD) stablecoin analytics");

    expect(screen.getByRole("heading", { name: "Static stablecoin profile" })).toBeTruthy();
    expect(screen.getByText(/governance model CeFi-Dependent; backing model Real-World Asset Backed; peg US Dollar/)).toBeTruthy();

    expect(screen.getByRole("link", { name: "Browse CeFi-Dependent stablecoins" }).getAttribute("href")).toBe(
      "/stablecoins/governance/cefi-dependent/",
    );
    expect(screen.getByRole("link", { name: "Browse Real-World Asset Backed stablecoins" }).getAttribute("href")).toBe(
      "/stablecoins/backing/rwa/",
    );
    expect(screen.getByRole("link", { name: "Browse US Dollar stablecoins" }).getAttribute("href")).toBe(
      "/stablecoins/usd/",
    );
    expect(screen.getByRole("link", { name: "Browse M0 infrastructure stablecoins" }).getAttribute("href")).toBe(
      "/stablecoins/infrastructure/m0/",
    );

    expect(screen.getByText("Cash, Treasury bills, and overnight repos.")).toBeTruthy();
    expect(screen.getByText("Primary market mint and redeem arbitrage plus secondary market liquidity.")).toBeTruthy();
    expect(screen.getByText("United States / NYDFS / Limited Purpose Trust")).toBeTruthy();
    expect(screen.getByText(/Independent Audit by Example Auditor/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Reserve source" }).getAttribute("href")).toBe(
      "https://example.com/reserves",
    );
    expect(screen.getByText("3 deployments tracked across Ethereum, Base, and Solana.")).toBeTruthy();
    expect(screen.getByText("AI summary / Updated May 2, 2026")).toBeTruthy();
    expect(screen.getByText(/The profile summary is concise and specific/)).toBeTruthy();
    expect(container.textContent).toContain("Source: checked-in StablecoinMeta profile fields.");
    expect(container.textContent).toContain("the summary above was last updated May 2, 2026");
  });

  it("uses archive h1 wording for frozen stablecoins", () => {
    const frozenCoin: StablecoinMeta = { ...coin, status: "frozen", frozenAt: "2026-05-01" };
    const { container } = render(<StablecoinDetailSeoContent coin={frozenCoin} summary={summary} />);

    expect(container.querySelector("h1")?.textContent).toContain("Test Dollar (TSTD) frozen stablecoin archive");
  });
});
