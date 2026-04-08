import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import DepegPage from "@/app/depeg/page";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

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
  });
});
