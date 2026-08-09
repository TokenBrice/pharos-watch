import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/font/local", () => ({
  default: () => ({ className: "mock-local-font", variable: "--mock-local-font" }),
}));

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

import MethodologyPage from "@/app/methodology/page";

describe("MethodologyPage", () => {
  it("renders the reader guide, reading map, and section rail", () => {
    const html = renderToStaticMarkup(<MethodologyPage />);

    expect(html).toContain("Methodology");
    expect(html).toContain("How to Read This Page");
    expect(html).toContain("Reader mode keeps summaries up front.");
    expect(html).toContain("Pricing Pipeline");
    expect(html).toContain("Safety Scores");
    expect(html).toContain("Mint Authority Score");
    expect(html).toContain("Safety Score V9 Economic Control pillar, mint component");
    expect(html).toContain("Reader");
    expect(html).toContain("Analyst");
    expect(html).toContain("universal 15-minute onset confirmation window");
    expect(html).toContain("$1M");
    expect(html).toContain("March 9, 2026 trust-floor boundary");
  });
});
