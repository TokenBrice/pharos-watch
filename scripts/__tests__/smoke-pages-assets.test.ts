import { describe, expect, it } from "vitest";

import {
  REPRESENTATIVE_YIELD_CANARY_IDS,
  buildYieldDeepRoutes,
  chunkItems,
  classifyFirstPartyAsset,
  extractScriptUrls,
  findFrameworkErrorMarker,
  getTopYieldRankingIds,
  getUnsafeHtmlCacheDirectives,
  hasExpectedAssetMime,
  isFatalRuntimeMessage,
} from "../lib/pages-asset-smoke.mjs";

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
    expect(chunkItems([1, 2, 3, 4, 5], 2)).toEqual([
      [1, 3, 5],
      [2, 4],
    ]);
  });
});
