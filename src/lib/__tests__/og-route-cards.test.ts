import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { OG_LIVE_PAGE_SLUGS, OG_ROUTE_CARDS, formatOgStampTime, ogRouteCardHost } from "@shared/lib/og-route-cards";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OG_ROUTE_GLYPHS, type OgRouteGlyphElement } from "@shared/lib/og-route-glyphs";
import { NAV_ITEMS } from "@/lib/nav-config";
import { buildLiveRouteOgImageUrl } from "@/lib/page-metadata";

/** Geometry of an svg's shape elements, ignoring keys and presentation attributes. */
function glyphGeometry(markup: string): string[] {
  return [...markup.matchAll(/<(path|rect|circle)\b([^>]*?)\/?>/g)].map(([, tag, attrs]) =>
    `${tag} ${[...attrs!.matchAll(/([\w-]+)="([^"]*)"/g)].filter(([, name]) => name !== "class").map(([, n, v]) => `${n}=${v}`).sort().join(" ")}`);
}

function glyphMarkup(elements: readonly OgRouteGlyphElement[]): string {
  return elements.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([n, v]) => `${n}="${v}"`).join(" ")}/>`).join("");
}

const ROOT = resolve(__dirname, "../../..");
const pageSource = (slug: string) =>
  readFileSync(resolve(ROOT, slug === "home" ? "src/app/page.tsx" : `src/app/${slug}/page.tsx`), "utf-8");

describe("route share cards", () => {
  it("every live route selects its Worker card, so it cannot drift back to a static screenshot", () => {
    for (const slug of OG_LIVE_PAGE_SLUGS) {
      expect(pageSource(slug), slug).toContain(`buildLiveRouteOgImageUrl("${slug}")`);
    }
    expect(buildLiveRouteOgImageUrl("chains")).toMatch(/\/api\/og\/page\/chains$/);
  });

  it("every route card has a committed timeless PNG and number-free copy", () => {
    for (const [key, card] of Object.entries(OG_ROUTE_CARDS)) {
      expect(existsSync(resolve(ROOT, "public", card.file)), key).toBe(true);
      expect([card.kicker, ...card.promise].join(" "), key).not.toMatch(/\d/);
    }
  });

  it("draws each route glyph exactly as the route's navigation icon", () => {
    for (const key of Object.keys(OG_ROUTE_CARDS) as Array<keyof typeof OG_ROUTE_CARDS>) {
      const nav = NAV_ITEMS.find((item) => item.href === OG_ROUTE_CARDS[key].path);
      expect(nav, key).toBeDefined();
      const navGeometry = glyphGeometry(renderToStaticMarkup(createElement(nav!.icon)));
      expect(navGeometry.length, key).toBeGreaterThan(0);
      expect(glyphGeometry(glyphMarkup(OG_ROUTE_GLYPHS[key])), key).toEqual(navGeometry);
    }
  });

  it("formats the stamp from the generation time in UTC", () => {
    expect(formatOgStampTime(1_790_000_000)).toBe("21 Sep 2026, 14:13 UTC");
    expect(ogRouteCardHost("/")).toBe("pharos.watch");
    expect(ogRouteCardHost("/dependency-map/")).toBe("pharos.watch/dependency-map");
  });
});
