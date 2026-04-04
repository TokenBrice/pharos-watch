import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ChangelogPage from "@/app/changelog/page";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

describe("ChangelogPage", () => {
  it("renders the page title and lead paragraph", () => {
    const html = renderToStaticMarkup(<ChangelogPage />);
    expect(html).toContain("Changelog");
  });

  it("renders at least one changelog entry", () => {
    const html = renderToStaticMarkup(<ChangelogPage />);
    expect(html).toContain("Mar 17");
    expect(html).toContain("Broader coverage");
  });
});
