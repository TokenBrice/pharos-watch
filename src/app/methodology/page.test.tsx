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
import { METHODOLOGY_CONTEXT } from "@/lib/methodology-context";

describe("MethodologyPage", () => {

  it("renders every section anchor that methodology context deep-links to", () => {
    const html = renderToStaticMarkup(<MethodologyPage />);
    const anchors = new Set(
      Object.values(METHODOLOGY_CONTEXT)
        .map((item) => item.methodologyPath)
        .filter((path) => path.startsWith("/methodology/#"))
        .map((path) => path.slice("/methodology/#".length)),
    );

    expect(anchors.size).toBeGreaterThan(0);
    for (const anchor of anchors) {
      expect(html, `methodologyPath anchor #${anchor} is not rendered on /methodology/`).toContain(`id="${anchor}"`);
    }
  });
});
