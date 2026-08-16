import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SitemapTreePage from "./page";
import { PUBLIC_ROUTE_PATHS } from "@/lib/public-route-inventory";

describe("human sitemap route inventory", () => {
  it("links every route from the canonical public inventory", () => {
    const html = renderToStaticMarkup(<SitemapTreePage />);
    const linkedPaths = new Set(
      Array.from(html.matchAll(/href="([^"]+)"/g), (match) => {
        const href = match[1]!;
        if (!href.startsWith("/") || href === "/") return href;
        const [pathname] = href.split(/[?#]/, 1);
        return `${pathname.replace(/\/+$/, "")}/`;
      }),
    );
    for (const href of PUBLIC_ROUTE_PATHS) {
      expect(linkedPaths.has(href), href).toBe(true);
    }
  });
});
