import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import satori from "satori";
import satoriStandalone from "satori/standalone";
import { API_CACHE_PROFILES } from "@shared/lib/api-cache-profiles";
import { OG_LIVE_PAGE_SLUGS, OG_ROUTE_CARDS, type OgRouteCardKey } from "@shared/lib/og-route-cards";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { RouteCard } from "../../lib/og-templates/route-card";

const loaders = vi.hoisted(() => ({ home: vi.fn(), chains: vi.fn() }));

vi.mock("satori/standalone", () => ({
  init: vi.fn(),
  default: vi.fn(async () => "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1200\" height=\"628\"></svg>"),
}));
vi.mock("../og-page", () => ({ OG_PAGE_LOADERS: loaders }));

import { handleOg, resetOgWasmInitializationForTests } from "../og";

afterEach(() => {
  resetOgWasmInitializationForTests();
  vi.clearAllMocks();
});

function lastRenderedElement() {
  const calls = vi.mocked(satoriStandalone).mock.calls;
  return calls[calls.length - 1]?.[0] as React.ReactElement;
}

const NOW = Math.floor(Date.now() / 1000);

describe("/api/og/page/:slug", () => {
  it("returns 404 for a slug outside the live registry", async () => {
    expect((await handleOg(mockD1([]), "/api/og/page/not-a-route"))?.status).toBe(404);
    // A timeless-only route has no live card.
    expect((await handleOg(mockD1([]), "/api/og/page/funding"))?.status).toBe(404);
  });

  it("renders the live card stamped with the source generation, not the render clock", async () => {
    loaders.home.mockResolvedValue({
      kind: "ok", hero: "$310.4B", context: "total stablecoin market cap", support: ["PSI Steady 92.4"],
      asOfSec: 1_790_000_000, budgetSec: 7200, generation: "stablecoins:1790000000",
    });
    const res = await handleOg(mockD1([]), "/api/og/page/home");
    expect(res?.status).toBe(200);
    expect(res?.headers.get("Content-Type")).toBe("image/png");
    expect(res?.headers.get("X-Og-Status")).toBe("live");
    expect(res?.headers.get("X-Og-Generation")).toBe("stablecoins:1790000000");
    expect(res?.headers.get("X-Og-Freshness-Budget")).toBe("7200");
    const markup = renderToStaticMarkup(lastRenderedElement());
    expect(markup).toContain("$310.4B");
    expect(markup).toContain("As of 21 Sep 2026, 14:13 UTC");
  });

  it("never lets a live card be cached past its source's admission budget", async () => {
    const live = (asOfSec: number) => ({
      kind: "ok", hero: "$1B", context: "x", support: [], asOfSec, budgetSec: 1800, generation: "g",
    });
    loaders.home.mockResolvedValue(live(NOW - 60));
    expect((await handleOg(mockD1([]), "/api/og/page/home"))?.headers.get("Cache-Control")).toBe(API_CACHE_PROFILES.ogImage);
    loaders.home.mockResolvedValue(live(NOW - 1600));
    expect((await handleOg(mockD1([]), "/api/og/page/home"))?.headers.get("Cache-Control")).toMatch(/^public, max-age=(19\d|200), s-maxage=(19\d|200)$/);
    loaders.home.mockResolvedValue(live(NOW - 1799));
    expect((await handleOg(mockD1([]), "/api/og/page/home"))?.headers.get("Cache-Control")).toBe("public, max-age=60, s-maxage=60");
  });

  it("serves the figure-free timeless card with a named reason when the source is unavailable", async () => {
    loaders.chains.mockResolvedValue({ kind: "unavailable", reason: "stale-cache" });
    const res = await handleOg(mockD1([]), "/api/og/page/chains");
    expect(res?.status).toBe(200);
    expect(res?.headers.get("X-Og-Status")).toBe("timeless");
    expect(res?.headers.get("X-Og-Reason")).toBe("stale-cache");
    expect(res?.headers.get("Cache-Control")).toBe(API_CACHE_PROFILES.custom);
    expect(renderToStaticMarkup(lastRenderedElement())).toContain("Live figures at pharos.watch/chains");
  });

  it("degrades a loader throw and a render failure to the timeless card, never a 503 or a stale number", async () => {
    loaders.home.mockRejectedValue(new Error("D1 read failed"));
    const thrown = await handleOg(mockD1([]), "/api/og/page/home");
    expect(thrown?.status).toBe(200);
    expect(thrown?.headers.get("X-Og-Reason")).toBe("owner-error");

    loaders.home.mockResolvedValue({
      kind: "ok", hero: "$1", context: "x", support: [], asOfSec: NOW, budgetSec: 60, generation: "g",
    });
    vi.mocked(satoriStandalone).mockRejectedValueOnce(new Error("layout failed"));
    const failed = await handleOg(mockD1([]), "/api/og/page/home");
    expect(failed?.status).toBe(200);
    expect(failed?.headers.get("X-Og-Status")).toBe("timeless");
    expect(failed?.headers.get("X-Og-Reason")).toBe("render-error");
    expect(renderToStaticMarkup(lastRenderedElement())).not.toContain("$1");
  });
});

describe("RouteCard template", () => {
  const font = (file: string) =>
    readFileSync(fileURLToPath(new URL(`../../../assets/fonts/${file}`, import.meta.url).href));
  const fonts = [
    { name: "Geist Sans", data: font("Geist-Regular.ttf"), weight: 400 as const, style: "normal" as const },
    { name: "Geist Sans", data: font("Geist-Bold.ttf"), weight: 700 as const, style: "normal" as const },
    { name: "Geist Mono", data: font("GeistMono-Regular.ttf"), weight: 400 as const, style: "normal" as const },
  ];

  it("carries no figure, date or state claim in any timeless card", () => {
    for (const key of Object.keys(OG_ROUTE_CARDS) as OgRouteCardKey[]) {
      const text = renderToStaticMarkup(<RouteCard cardKey={key} variant="timeless" />).replace(/<[^>]+>/g, " ");
      expect(text, key).not.toMatch(/\d/);
      expect(text, key).not.toMatch(/\b(live|now|today|updated|open)\b(?! figures)/i);
    }
  });

  it("every live slug has timeless copy to fall back to", () => {
    for (const slug of OG_LIVE_PAGE_SLUGS) expect(OG_ROUTE_CARDS[slug].promise).toHaveLength(2);
  });

  it("lays out both variants through the real satori engine", async () => {
    const live = await satori(
      <RouteCard
        cardKey="flows"
        variant="live"
        data={{ hero: "≥ $200.0M", context: "gross stablecoin mint + burn, last 24h (known subtotal)", support: ["Printed $300.0M", "Shredded $100.0M"], stamp: "As of 12 Oct 2026, 14:05 UTC" }}
      />,
      { width: 1200, height: 628, fonts },
    );
    expect(live).toContain("<svg");
    const timeless = await satori(<RouteCard cardKey="freezewatch" variant="timeless" />, { width: 1200, height: 628, fonts });
    expect(timeless).toContain("<svg");
  });
});
