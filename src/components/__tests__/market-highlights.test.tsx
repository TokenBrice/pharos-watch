import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MarketHighlights } from "@/components/market-highlights";
import type { StablecoinData } from "@shared/types";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock("@/components/stablecoin-logo", () => ({
  StablecoinLogo: ({ name }: { name: string }) => <span>logo:{name}</span>,
}));

vi.mock("@/components/methodology-hint", () => ({
  MethodologyHint: ({ topic }: { topic: string }) => <span data-testid={`methodology-hint-${topic}`} />,
  MethodologyLabel: ({ children, topic }: { children: ReactNode; topic: string }) => (
    <span>
      <span>{children}</span>
      <span data-testid={`methodology-hint-${topic}`} />
    </span>
  ),
}));

describe("MarketHighlights copy (Task 1.2)", () => {
  it("uses the 'Biggest 7-Day Supply Moves' kicker and the depeg bps hint", () => {
    const data: StablecoinData[] = [];
    const html = renderToStaticMarkup(<MarketHighlights data={data} />);

    // New kicker copy (source case — CSS renders uppercase)
    expect(html).toContain("Biggest 7-Day Supply Moves");
    expect(html).not.toContain("Biggest Supply Changes 7D");

    // MethodologyHint attached to the depeg kicker
    expect(html).toContain('data-testid="methodology-hint-depegBps"');
  });
});
