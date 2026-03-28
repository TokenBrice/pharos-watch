import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import MethodologyPage from "@/app/methodology/page";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

describe("MethodologyPage", () => {
  it("renders the reader guide, reading map, and section rail", () => {
    const html = renderToStaticMarkup(<MethodologyPage />);

    expect(html).toContain("Methodology");
    expect(html).toContain("How to Read This Page");
    expect(html).toContain("Reader mode keeps summaries up front.");
    expect(html).toContain("Pricing Pipeline");
    expect(html).toContain("Safety Scores");
    expect(html).toContain("Reader");
    expect(html).toContain("Analyst");
  });
});
