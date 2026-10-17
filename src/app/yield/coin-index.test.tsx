// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { YieldCoinIndex } from "@/components/yield/coin-index";

describe("YieldCoinIndex", () => {

  it("renders at least one yield-type group with linked coin chips", () => {
    render(<YieldCoinIndex />);
    const links = screen.getAllByRole("link");
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.getAttribute("href")).toMatch(/^\/stablecoin\/[^/]+\/yield\/?$/);
    }
  });
});
