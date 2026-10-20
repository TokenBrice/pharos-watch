import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import satoriStandalone from "satori/standalone";
import { API_CACHE_PROFILES, buildOgImageCacheControl } from "@shared/lib/api-cache-profiles";
import { OG_ROUTE_CARDS, type OgRouteCardKey } from "@shared/lib/og-route-cards";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { RouteCard } from "../../lib/og-templates/route-card";

const loaders = vi.hoisted(() => ({ home: vi.fn(), chains: vi.fn() }));

vi.mock("satori/standalone", () => ({
  init: vi.fn(),
  default: vi.fn(async () => "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1200\" height=\"628\"></svg>"),
}));
vi.mock("../og-page", async () => ({
  // `upcoming` runs its real loader: the route is timeless by decision.
  OG_PAGE_LOADERS: { ...loaders, upcoming: (await import("../og-page/upcoming")).loadUpcomingOgPage },
}));

import { handleOg, resetOgWasmInitializationForTests } from "../og";

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
});

afterEach(() => {
  resetOgWasmInitializationForTests();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function lastRenderedElement() {
  const calls = vi.mocked(satoriStandalone).mock.calls;
  return calls[calls.length - 1]?.[0] as React.ReactElement;
}

const NOW = 1_790_000_060;

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

  it.each([1740, 900, 200, 60, 30, 1])("bounds a live card to %s seconds of source freshness", async (remaining) => {
    loaders.home.mockResolvedValue({
      kind: "ok", hero: "$1B", context: "x", support: [],
      asOfSec: NOW - 1800 + remaining, budgetSec: 1800, generation: "g",
    });
    const res = await handleOg(mockD1([]), "/api/og/page/home");
    const ttl = Math.min(900, remaining);
    expect(res?.headers.get("X-Og-Status")).toBe("live");
    expect(res?.headers.get("Cache-Control")).toBe(`public, max-age=${ttl}, s-maxage=${ttl}`);
  });

  it.each([0, -1])("serves timeless instead of a live figure with %s seconds remaining", async (remaining) => {
    loaders.home.mockResolvedValue({
      kind: "ok", hero: "$1B", context: "x", support: [],
      asOfSec: NOW - 1800 + remaining, budgetSec: 1800, generation: "g",
    });
    const res = await handleOg(mockD1([]), "/api/og/page/home");
    expect(res?.headers.get("X-Og-Status")).toBe("timeless");
    expect(res?.headers.get("X-Og-Reason")).toBe("stale-cache");
    expect(res?.headers.get("Cache-Control")).toBe(API_CACHE_PROFILES.custom);
    expect(renderToStaticMarkup(lastRenderedElement())).not.toContain("$1B");
  });

  it.each([29, 29.5, 30, 31])("reassesses an explicit expiry after a %s-second render", async (elapsed) => {
    loaders.home.mockResolvedValue({
      kind: "ok", hero: "$1B", context: "x", support: [],
      asOfSec: NOW, budgetSec: 1800, freshUntilSec: NOW + 30, generation: "g",
    });
    vi.mocked(satoriStandalone).mockImplementationOnce(async () => {
      vi.mocked(Date.now).mockReturnValue((NOW + elapsed) * 1000);
      return "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1200\" height=\"628\"></svg>";
    });
    const res = await handleOg(mockD1([]), "/api/og/page/home");
    expect(res?.headers.get("X-Og-Assessed-At")).toBe(String(Math.floor(NOW + elapsed)));
    if (elapsed < 30) {
      const ttl = Math.floor(30 - elapsed);
      expect(res?.headers.get("X-Og-Status")).toBe("live");
      expect(res?.headers.get("Cache-Control")).toBe(`public, max-age=${ttl}, s-maxage=${ttl}`);
    } else {
      expect(res?.headers.get("X-Og-Status")).toBe("timeless");
      expect(res?.headers.get("X-Og-Reason")).toBe("stale-cache");
      expect(res?.headers.get("Cache-Control")).toBe(API_CACHE_PROFILES.custom);
      expect(renderToStaticMarkup(lastRenderedElement())).not.toContain("$1B");
    }
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

  it("serves Upcoming's timeless card by decision, logged as info rather than a failure", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await handleOg(mockD1([]), "/api/og/page/upcoming");
      expect(res?.status).toBe(200);
      expect(res?.headers.get("Content-Type")).toBe("image/png");
      expect(res?.headers.get("X-Og-Status")).toBe("timeless");
      expect(res?.headers.get("X-Og-Reason")).toBe("timeless-by-decision");
      expect(res?.headers.get("Cache-Control")).toBe(API_CACHE_PROFILES.custom);
      expect(renderToStaticMarkup(lastRenderedElement())).toContain("Live figures at pharos.watch/upcoming");
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      const record = JSON.parse(String(info.mock.calls[info.mock.calls.length - 1]?.[0]));
      expect(record).toMatchObject({ level: "info", event: "og.page_timeless", metadata: { slug: "upcoming", reason: "timeless-by-decision" } });
    } finally {
      info.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
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

describe("buildOgImageCacheControl", () => {
  it.each([
    [-1, 0], [0, 0], [0.5, 0], [1, 1], [30, 30], [60, 60], [900, 900], [901, 900],
  ])("bounds %s seconds of freshness to a %s-second TTL", (remaining, ttl) => {
    expect(buildOgImageCacheControl(remaining)).toBe(`public, max-age=${ttl}, s-maxage=${ttl}`);
  });
});

describe("RouteCard template", () => {
  it("carries no figure, date or state claim in any timeless card", () => {
    for (const key of Object.keys(OG_ROUTE_CARDS) as OgRouteCardKey[]) {
      const text = renderToStaticMarkup(<RouteCard cardKey={key} variant="timeless" />).replace(/<[^>]+>/g, " ");
      expect(text, key).not.toMatch(/\d/);
      expect(text, key).not.toMatch(/\b(live|now|today|updated|open)\b(?! figures)/i);
    }
  });
});
