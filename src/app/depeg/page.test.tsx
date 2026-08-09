import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import DepegPage from "@/app/depeg/page";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

vi.mock("next/dynamic", () => ({
  default: (_loader: unknown, options?: { loading?: () => ReactNode }) => {
    return function MockDynamicComponent() {
      return <>{options?.loading?.() ?? null}</>;
    };
  },
}));

describe("DepegPage", () => {
  it("renders FAQ copy that matches the shipped peg-score and confirmation contract", () => {
    const html = renderToStaticMarkup(<DepegPage />);

    expect(html).toContain("fewer than 7 days of tracking history");
    expect(html).toContain("7 to 30 days are labeled Early score");
    expect(html).toContain("same-direction corroboration");
    expect(html).toContain("CoinGecko or DefiLlama");
    expect(html).toContain("Binance");
    expect(html).toContain("surface pre-price and live-market stress signals");
    expect(html).not.toContain("before it hits the price");
  });

  it("renders the Telegram setup CTA once in the header action area", () => {
    const html = renderToStaticMarkup(<DepegPage />);

    const matches = html.match(/Get instant Telegram alerts/g) ?? [];
    expect(matches).toHaveLength(1);
    expect(html).toContain('href="/pharoswatchbot/#bot"');
    expect(html).toContain("Set up alerts");
  });
});
