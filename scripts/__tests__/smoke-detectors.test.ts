import { describe, expect, it } from "vitest";
import { resolveMissingYieldWorkbenchRedirect } from "../../functions/stablecoin/[[path]]";
import { assertOgImageResult, isRetryableStatus } from "../maintenance/smoke-api.mjs";
import {
  assertRouteSummary,
  getMobileWorkerCount,
  getTableScanOutcome,
  getTouchScanOutcome,
} from "../maintenance/smoke-mobile-ui.mjs";
import {
  assertNonceProtectedHtml,
  shouldSkipCanaryOpsUiProxyAssertion,
  shouldRetryDirectOpsJson,
  shouldSkipOpsUiProxyAssertion,
  shouldRetryOpsUiProxyStatus,
} from "../maintenance/smoke-ops.mjs";
import { verifyBrowserPass, verifyDocument } from "../maintenance/smoke-pages-assets.mjs";
import {
  findFrameworkErrorMarker,
  getTopYieldRankingIds,
  getUnsafeHtmlCacheDirectives,
  classifyFirstPartyAsset,
  hasExpectedAssetMime,
  isFatalRuntimeMessage,
  isExpectedYieldDeepRouteUrl,
} from "../lib/pages-asset-smoke.mjs";
import { jsonResponse } from "./smoke-ops.test-support";
import { withRedirectFixture } from "./smoke-route-identity.test-support";

describe("smoke-api retry policy", () => {
  it.each([
    [403, true], [408, true], [429, true], [500, true], [401, false], [404, false],
  ] as const)("outwaits WAF blocks without retrying normal client errors: %s", (status, expected) => {
    expect(isRetryableStatus(status)).toBe(expected);
  });
});
describe("smoke-api og image assertion", () => {
  it.each([
    { label: "healthy PNG", path: "/api/og/depeg", status: 200, contentType: "image/png", renderErrorClass: null, bytes: 84_211, result: "82kb png", error: null },
    { label: "503 render error", path: "/api/og/stablecoin/usdt-tether", status: 503, contentType: "text/plain", renderErrorClass: "Error", bytes: 26, result: null, error: "returned 503 (x-render-error-class: Error)" },
    { label: "non-PNG type", path: "/api/og/depeg", status: 200, contentType: "text/html", renderErrorClass: null, bytes: 84_211, result: null, error: 'content-type "text/html"' },
    { label: "tiny payload", path: "/api/og/depeg", status: 200, contentType: "image/png", renderErrorClass: null, bytes: 312, result: null, error: "suspiciously small image (312b)" },
  ])("validates $label", ({ path, status, contentType, renderErrorClass, bytes, result, error }) => {
    if (error === null) {
      expect(assertOgImageResult(path, { status, contentType, renderErrorClass, bytes })).toBe(result);
    } else {
      expect(() => assertOgImageResult(path, { status, contentType, renderErrorClass, bytes })).toThrow(error);
    }
  });
});
describe("getMobileWorkerCount", () => {
  it("clamps worker count by task count and max cap", () => {
    expect(getMobileWorkerCount(1, "3")).toBe(1);
    expect(getMobileWorkerCount(12, "99")).toBe(6);
  });
});

describe("console and table scan outcomes", () => {
  it.each([
    { status: 400 },
    { textLength: 19 },
    { overflowDelta: 2 },
    { hasFrameworkOverlay: true },
    { finalUrl: "https://pharos.watch/" },
  ])("rejects each boundary independently: %j", (invalid) => {
    const valid = {
      routeUrl: "https://pharos.watch/cemetery/",
      finalUrl: "https://pharos.watch/cemetery/",
      status: 399,
      textLength: 20,
      hasFrameworkOverlay: false,
      overflowDelta: 1,
      scrollWidth: 392,
      innerWidth: 390,
      tableScan: { checked: 0, issues: [] },
      touchScan: { violations: [] },
    };
    expect(assertRouteSummary(valid, { strictTouchTargets: true })).toEqual([]);
    expect(assertRouteSummary({ ...valid, ...invalid }, { strictTouchTargets: true })).toHaveLength(1);
  });
  it("surfaces table geometry issues as route failures", () => {
    const failures = assertRouteSummary(
      {
        routeUrl: "https://pharos.watch/flows/",
        finalUrl: "https://pharos.watch/flows/",
        status: 200,
        textLength: 100,
        hasFrameworkOverlay: false,
        overflowDelta: 0,
        tableScan: {
          checked: 1,
          issues: [{ kind: "header-text-overflow", detail: "Name overlaps Score" }],
        },
        touchScan: { violations: [] },
      },
      { strictTouchTargets: true },
    );

    expect(getTableScanOutcome({ issues: [{ kind: "header-overlap" }] }).failCount).toBe(1);
    expect(failures.join("\n")).toContain("table geometry failures=1");
  });
});
describe("getTouchScanOutcome", () => {
  const scan = {
    violations: [
      { selector: "button.small", severity: "target", height: 32 },
      { selector: "a.tiny", severity: "hard-floor", height: 20 },
    ],
  };

  it("always fails hard-floor violations", () => {
    expect(getTouchScanOutcome(scan)).toMatchObject({
      failCount: 1,
      hardFloor: [{ selector: "a.tiny", severity: "hard-floor" }],
      targetWarnings: [{ selector: "button.small", severity: "target" }],
    });
  });

  it("can fail all sub-44px target findings in strict mode", () => {
    expect(getTouchScanOutcome(scan, { strictTouchTargets: true }).failCount).toBe(2);
  });

  it("keeps non-common sub-44px target findings advisory in strict mode", () => {
    expect(
      getTouchScanOutcome(
        {
          violations: [
            { selector: "a.footer-pill", severity: "target", strictRequired: false, height: 28 },
            { selector: "tr.row", severity: "target", strictRequired: true, height: 41 },
          ],
        },
        { strictTouchTargets: true },
      ).failCount,
    ).toBe(1);
  });
});
describe("assertNonceProtectedHtml", () => {
  it.each([
    {
      label: "matching nonce",
      csp: "default-src 'self'; script-src 'self' 'nonce-abc123' 'unsafe-eval'",
      html: '<html><body><script nonce="abc123">self.__next_f=[];</script><script src="/_next/static/chunk.js"></script></body></html>',
      error: null,
    },
    {
      label: "missing CSP nonce",
      csp: "default-src 'self'; script-src 'self' 'unsafe-eval'",
      html: "<html><body><script>self.__next_f=[];</script></body></html>",
      error: "Ops UI CSP script-src is missing a nonce",
    },
    {
      label: "wrong and absent script nonces",
      csp: "default-src 'self'; script-src 'self' 'nonce-abc123' 'unsafe-eval'",
      html: '<html><body><script nonce="wrong">self.__next_f=[];</script><script>window.__INLINE__=true;</script></body></html>',
      error: "Ops UI has 2 inline script(s) without the CSP nonce",
    },
  ])("checks $label", ({ csp, html, error }) => {
    const response = new Response(null, { headers: { "Content-Security-Policy": csp } });
    if (error === null) expect(() => assertNonceProtectedHtml(response, html, "Ops UI")).not.toThrow();
    else expect(() => assertNonceProtectedHtml(response, html, "Ops UI")).toThrow(error);
  });
});
describe("shouldSkipOpsUiProxyAssertion", () => {
  it.each([
    { status: 401, error: "Unauthorized", cookie: "cf_clearance=bot-cookie", skip: true },
    { status: 401, error: "Unauthorized", cookie: "CF_Authorization=ui-session", skip: true },
    { status: 502, error: "Upstream failed", cookie: "CF_Authorization=ui-session", skip: false },
  ])("classifies status=$status cookie=$cookie", ({ status, error, cookie, skip }) => {
    expect(shouldSkipOpsUiProxyAssertion(jsonResponse({ error }, status), cookie)).toBe(skip);
  });
});

describe("shouldSkipCanaryOpsUiProxyAssertion", () => {
  it("skips exhausted transient proxy failures only for canary smokes", () => {
    const response = new Response("gateway timeout", {
      status: 504,
      headers: { "content-type": "text/html" },
    });

    expect(shouldSkipCanaryOpsUiProxyAssertion(response, "CF_Authorization=ui-session", "canary")).toBe(true);
    expect(shouldSkipCanaryOpsUiProxyAssertion(response, "CF_Authorization=ui-session", "full")).toBe(false);
  });
});

describe("ops retry detectors", () => {
  it.each([
    { detector: shouldRetryOpsUiProxyStatus, status: 502, body: "bad gateway", retry: true },
    { detector: shouldRetryOpsUiProxyStatus, status: 504, body: "gateway timeout", retry: true },
    { detector: shouldRetryOpsUiProxyStatus, status: 401, body: { error: "Unauthorized" }, retry: false },
    { detector: shouldRetryOpsUiProxyStatus, status: 500, body: { error: "upstream failed" }, retry: false },
    { detector: shouldRetryDirectOpsJson, status: 500, body: "internal error", retry: true },
    { detector: shouldRetryDirectOpsJson, status: 502, body: "bad gateway", retry: true },
    { detector: shouldRetryDirectOpsJson, status: 503, body: "unavailable", retry: true },
    { detector: shouldRetryDirectOpsJson, status: 504, body: "gateway timeout", retry: true },
    { detector: shouldRetryDirectOpsJson, status: 401, body: { error: "Unauthorized" }, retry: false },
    { detector: shouldRetryDirectOpsJson, status: 200, body: { dryRun: true }, retry: false },
  ])("$detector.name classifies $status $body", ({ detector, status, body, retry }) => {
    const response = typeof body === "string" ? new Response(body, { status }) : jsonResponse(body, status);
    expect(detector(response)).toBe(retry);
  });
});
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

  it("ignores Cloudflare edge-injected /cdn-cgi/ scripts but still checks Pages scripts", () => {
    const origin = "https://pharos.watch";
    expect(classifyFirstPartyAsset(`${origin}/cdn-cgi/challenge-platform/scripts/jsd/main.js`, "script", origin)).toBeNull();
    expect(classifyFirstPartyAsset(`${origin}/_next/static/chunks/app.js`, "script", origin)).toBe("script");
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
