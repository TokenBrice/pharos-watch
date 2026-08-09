import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/font/local", () => ({
  default: () => ({ className: "mock-local-font", variable: "--mock-local-font" }),
}));

import ChangelogPage from "@/app/changelog/page";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

describe("ChangelogPage", () => {
  it("renders the page title and lead paragraph", () => {
    const html = renderToStaticMarkup(<ChangelogPage />);
    expect(html).toContain("Changelog");
  });

  it("renders at least one changelog entry", () => {
    const html = renderToStaticMarkup(<ChangelogPage />);
    expect(html).toContain("Mar 25");
    expect(html).toContain("Yield intelligence overhaul");
  });
});
