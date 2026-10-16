import { describe, expect, it } from "vitest";
import { resolveMissingYieldWorkbenchRedirect } from "../../functions/stablecoin/[[path]]";
import { verifyBrowserPass, verifyDocument } from "../maintenance/smoke-pages-assets.mjs";
import { withRedirectFixture } from "./smoke-route-identity.test-support";

import {
  findFrameworkErrorMarker,
  getTopYieldRankingIds,
  getUnsafeHtmlCacheDirectives,
  hasExpectedAssetMime,
  isFatalRuntimeMessage,
  isExpectedYieldDeepRouteUrl,
} from "../lib/pages-asset-smoke.mjs";

describe("Pages asset-coherence smoke helpers", () => {
  it("accepts direct workbenches and canonical producer fallbacks including query overrides", () => {
    const baseUrl = "https://pharos.watch";
    const id = "usdc-circle";
    for (const query of ["", "?compare=usdt-tether&from=portfolio&workbenchFallback=usdt-tether&lens=depth"]) {
      const routeInfo = { id, route: `/stablecoin/${id}/yield/${query}` };
      const requested = new URL(routeInfo.route, baseUrl);
      const fallback = resolveMissingYieldWorkbenchRedirect(requested, 404, new Set([id]));
      expect(isExpectedYieldDeepRouteUrl(requested.toString(), routeInfo, baseUrl)).toBe(true);
      requested.pathname = requested.pathname.replace(/\/$/, "");
      expect(isExpectedYieldDeepRouteUrl(requested.toString(), routeInfo, baseUrl)).toBe(true);
      expect(isExpectedYieldDeepRouteUrl(fallback, routeInfo, baseUrl)).toBe(true);
    }
  });

  it.each([
    "/yield/",
    "/yield/?compare=usdc-circle",
    "/yield/?compare=usdc-circle&workbenchFallback=usdc-circle",
    "/yield/?compare=usdc-circle&from=detail-fallback",
    "/yield/?compare=usdt-tether&from=detail-fallback&workbenchFallback=usdc-circle",
    "/yield/?compare=usdc-circle&from=detail-fallback&workbenchFallback=usdt-tether",
  ])("rejects fallback selection or marker loss: %s", (destination) => {
    expect(isExpectedYieldDeepRouteUrl(
      `https://pharos.watch${destination}`,
      { id: "usdc-circle", route: "/stablecoin/usdc-circle/yield/" },
      "https://pharos.watch",
    )).toBe(false);
  });

  it("fails document smoke on a local redirect that drops the selected coin", async () => {
    await withRedirectFixture("/stablecoin/usdc-circle/yield/", "/yield/", async (url) => {
      const scriptChecks = new Map();
      await expect(verifyDocument(
        { id: "usdc-circle", route: "/stablecoin/usdc-circle/yield/" },
        url, "local", scriptChecks,
      )).rejects.toThrow("redirected to unexpected URL");
      expect(scriptChecks.size).toBe(0);
    });
  });

  it("rejects a healthy browser fallback that loses the coin", async () => {
    const page = {
      goto: async () => ({ status: () => 200 }),
      waitForLoadState: async () => {},
      evaluate: async () => {},
      locator: () => ({ innerText: async () => "A healthy yield leaderboard" }),
      url: () => "https://pharos.watch/yield/",
    };
    await expect(verifyBrowserPass(
      page, { id: "usdc-circle", route: "/stablecoin/usdc-circle/yield/" }, "https://pharos.watch",
      { assetFailures: [], pageErrors: [], consoleErrors: [] }, "cold", 1000, 0,
    )).rejects.toThrow("landed on unexpected URL");
  });

  it("rejects malformed or undersized ranking payloads", () => {
    expect(() => getTopYieldRankingIds({}, 1)).toThrow("missing rankings[]");
    expect(() => getTopYieldRankingIds({ rankings: [{ id: "not valid" }] }, 1)).toThrow("only 0 valid unique id(s)");
  });

  it("validates static asset MIME types", () => {
    expect(hasExpectedAssetMime("script", "application/javascript; charset=utf-8")).toBe(true);
    expect(hasExpectedAssetMime("script", "text/html; charset=utf-8")).toBe(false);
    expect(hasExpectedAssetMime("style", "text/css; charset=utf-8")).toBe(true);
    expect(hasExpectedAssetMime("font", "font/woff2")).toBe(true);
  });

  it("detects stale document directives and fatal browser signals", () => {
    expect(getUnsafeHtmlCacheDirectives("public, max-age=0, s-maxage=300, stale-while-revalidate=86400")).toEqual([
      "s-maxage=300",
      "stale-while-revalidate=86400",
    ]);
    expect(getUnsafeHtmlCacheDirectives("public, max-age=0, must-revalidate")).toEqual([]);
    expect(isFatalRuntimeMessage("ChunkLoadError: Loading chunk 1211 failed")).toBe(true);
    expect(isFatalRuntimeMessage("Hydration failed because the initial UI does not match")).toBe(true);
    expect(isFatalRuntimeMessage("API request returned 503")).toBe(false);
    expect(findFrameworkErrorMarker("This coin's page didn't load. Try again.")).toBe("This coin's page didn't load.");
  });
});
