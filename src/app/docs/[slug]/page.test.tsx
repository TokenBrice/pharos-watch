import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import DocPage from "./page";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

describe("DocPage", () => {
  it("marks external markdown links as new-tab safe links", async () => {
    const html = renderToStaticMarkup(await DocPage({ params: Promise.resolve({ slug: "data-pipeline" }) }));

    expect(html).toContain('href="https://gold-api.com"');
    expect(html).toContain('href="https://gold-api.com" target="_blank" rel="noopener noreferrer"');
  });

  it("renders markdown tables with shared table chrome and compact cells", async () => {
    const html = renderToStaticMarkup(await DocPage({ params: Promise.resolve({ slug: "design-tokens" }) }));

    expect(html).toContain('data-slot="table-viewport"');
    expect(html).toContain('data-slot="table"');
    expect(html).toContain('data-slot="table-header"');
    expect(html).toContain('data-slot="table-head"');
    expect(html).toContain('data-slot="table-cell"');
    expect(html).toContain('data-slot="table-cell" class="whitespace-normal px-3 py-2 align-top"');

    const labels = Array.from(html.matchAll(/aria-label="(Documentation table:[^"]+)"/g), (match) => match[1]);
    expect(labels.length).toBeGreaterThan(1);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.some((label) => label.includes("Category, Examples, Notes"))).toBe(true);
  });
});
