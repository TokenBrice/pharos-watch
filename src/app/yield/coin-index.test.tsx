// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { YieldCoinIndex } from "@/components/yield/coin-index";
import { CLIENT_ACTIVE_TOKENIZED_FUND_IDS } from "@shared/lib/stablecoins/aggregate-client-registry";

describe("YieldCoinIndex", () => {

  it("renders yield-bearing stablecoin groups while excluding tokenized funds", () => {
    render(<YieldCoinIndex />);
    const links = screen.getAllByRole("link");
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      const href = link.getAttribute("href") ?? "";
      expect(href).toMatch(/^\/stablecoin\/[^/]+\/yield\/?$/);
      const id = href.replace(/^\/stablecoin\/([^/]+)\/yield\/?$/, "$1");
      expect(CLIENT_ACTIVE_TOKENIZED_FUND_IDS.has(id)).toBe(false);
    }
  });
});
