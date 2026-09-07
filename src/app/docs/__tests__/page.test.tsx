import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import DocPage from "../[slug]/page";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

describe("public API reference", () => {
  it("does not render admin reference headings", async () => {
    const html = renderToStaticMarkup(await DocPage({ params: Promise.resolve({ slug: "api-reference" }) }));

    expect(html).toContain("Public Endpoints");
    expect(html).not.toContain("Admin Auth And Idempotency");
    expect(html).not.toContain("Admin Endpoints");
  });
});
