import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import TimelinePage from "@/app/timeline/page";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

vi.mock("@/app/timeline/client", () => ({
  TimelineClient: () => <div data-testid="timeline-client" />,
}));

describe("TimelinePage", () => {
  it("renders the page shell with title, breadcrumb, CollectionPage + ItemList JSON-LD", () => {
    const html = renderToStaticMarkup(<TimelinePage />);

    expect(html).toContain("Timeline");
    expect(html).toContain("CollectionPage");
    expect(html).toContain("ItemList");
    // `safeJsonLd` escapes `/` as `/`; check the escaped path instead.
    expect(html).toContain("\\u002ftimeline\\u002f");
    expect(html).toContain("timeline-client");
    // ItemList enumerates the shipped class category links.
    expect(html).toContain("Depegs");
    expect(html).toContain("Freezes");
    expect(html).toContain("Methodology");
    // Freshness signal: CollectionPage carries datePublished + dateModified.
    expect(html).toContain("datePublished");
    expect(html).toContain("2026-05-15T00:00:00Z");
    expect(html).toContain("dateModified");
  });
});
