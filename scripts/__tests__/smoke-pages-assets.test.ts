import { describe, expect, it } from "vitest";
import { resolveMissingYieldWorkbenchRedirect } from "../../functions/stablecoin/[[path]]";
import { parseRouteOverride, verifyBrowserPass, verifyDocument } from "../maintenance/smoke-pages-assets.mjs";
import { withRedirectFixture } from "./smoke-route-identity.test-support";
import { withEnv } from "./helpers/test-state";

import {
  REPRESENTATIVE_YIELD_CANARY_IDS,
  buildYieldDeepRoutes,
  classifyFirstPartyAsset,
  extractScriptUrls,
  findFrameworkErrorMarker,
  getTopYieldRankingIds,
  getUnsafeHtmlCacheDirectives,
  hasExpectedAssetMime,
  isFatalRuntimeMessage,
  isExpectedYieldDeepRouteUrl,
} from "../lib/pages-asset-smoke.mjs";
import { chunkRoundRobin } from "../lib/smoke-runtime.mjs";

describe("Pages asset-coherence smoke helpers", () => {
  it("selects unique top rankings and appends representative deep routes", () => {
    const rankingIds = getTopYieldRankingIds(
      { rankings: [{ id: "usds-sky" }, { id: "usds-sky" }, { id: "ausd-agora" }] },
      2,
    );
    const routes = buildYieldDeepRoutes(rankingIds, ["usdc-circle", "usds-sky"]);

    expect(rankingIds).toEqual(["usds-sky", "ausd-agora"]);
    expect(routes).toEqual([
      { id: "usds-sky", route: "/stablecoin/usds-sky/yield/" },
      { id: "ausd-agora", route: "/stablecoin/ausd-agora/yield/" },
      { id: "usdc-circle", route: "/stablecoin/usdc-circle/yield/" },
    ]);
    expect(REPRESENTATIVE_YIELD_CANARY_IDS).toEqual(
      expect.arrayContaining(["usdc-circle", "usdt-tether", "syrupusdc-maple", "apyusd-apyx"]),
    );
  });

  it("retains query overrides when parsing selected smoke routes", () => {
    const route = "/stablecoin/usdc-circle/yield/?compare=usdt-tether&from=portfolio";
    withEnv("SMOKE_PAGES_ASSET_ROUTES", route, () => {
      expect(parseRouteOverride()).toEqual([{ id: "usdc-circle", route }]);
    });
  });

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

  it("extracts script sources with HTML attribute parsing and URL resolution", () => {
    const html = [
      '<script nonce="abc" src="/_next/static/chunks/a.js"></script>',
      "<script src='./relative.js'></script>",
      '<script src="/_next/static/chunks/a.js"></script>',
      "<script>window.inline = true</script>",
    ].join("");

    expect(extractScriptUrls(html, "https://pharos.watch/stablecoin/usdc-circle/yield/")).toEqual([
      "https://pharos.watch/_next/static/chunks/a.js",
      "https://pharos.watch/stablecoin/usdc-circle/yield/relative.js",
    ]);
  });

  it("classifies only first-party scripts, styles, and fonts", () => {
    expect(
      classifyFirstPartyAsset("https://pharos.watch/_next/static/chunks/123.js", "script", "https://pharos.watch"),
    ).toBe("script");
    expect(
      classifyFirstPartyAsset("https://pharos.watch/_next/static/media/font.woff2", "font", "https://pharos.watch"),
    ).toBe("font");
    expect(
      classifyFirstPartyAsset("https://www.googletagmanager.com/gtag/js", "script", "https://pharos.watch"),
    ).toBeNull();
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

  it("chunks work evenly without dropping routes", () => {
    expect(chunkRoundRobin([1, 2, 3, 4, 5], 2)).toEqual([
      [1, 3, 5],
      [2, 4],
    ]);
  });
});
