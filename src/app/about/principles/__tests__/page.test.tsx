import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import AboutPrinciplesPage from "../page";
import { PRINCIPLES_AXIOMS } from "../content";

vi.mock("next/link", () => ({
  default: ({ children, href, className }: { children: ReactNode; href: string; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

describe("AboutPrinciplesPage", () => {
  it("renders the breadcrumb, the title, and every axiom", () => {
    const html = renderToStaticMarkup(<AboutPrinciplesPage />);
    const document = new JSDOM(html).window.document;
    document.querySelectorAll("script").forEach((script) => script.remove());
    const visibleText = document.body.textContent ?? "";

    expect(visibleText).toContain("Pharos Principles");
    expect(visibleText).toContain("Principles");

    for (const axiom of PRINCIPLES_AXIOMS) {
      expect(visibleText).toContain(axiom.title);
    }

    // Pointers required by the brief
    expect(html).toContain("/about/editorial/");
    expect(html).toContain("/funding/");
  });
});
