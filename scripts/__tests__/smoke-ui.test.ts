import { describe, expect, it } from "vitest";
import { withEnv } from "./helpers/test-state";

import {
  chunkOverflowRoutes,
  getBrowserLaunchOptions,
  getAnalyticsPayloadUrls,
  getOverflowRoutes,
  getOverflowWorkerCount,
  getExpectedGaNetworkSignals,
  getUnexpectedGaCspViolations,
  getUnexpectedGaAnalyticsFailures,
  hasRetryBlockingGaAnalyticsSignal,
  hasGaConfigInit,
  hasAnyGaAnalyticsSignal,
  hasExpectedGaRuntimeState,
  isAnalyticsCspViolation,
  isExpectedGaCollectAbort,
  isExpectedGaCollectUrl,
  isExpectedGaPageViewCollectUrl,
  isToleratedGaCollectFailure,
  shouldRetryLiveAnalyticsSmoke,
  verifyAnalyticsSnippet,
} from "../maintenance/smoke-ui.mjs";

const GA_ID = "G-6TS0KG8H04";
const GTAG_SCRIPT_URL = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
const PAGE_VIEW_COLLECT_URL = `https://www.google-analytics.com/g/collect?v=2&tid=${GA_ID}&en=page_view`;

function cspViolation(blockedURI: string, directive = "script-src", sourceFile = "https://pharos.watch/") {
  return { blockedURI, effectiveDirective: directive, sourceFile, violatedDirective: directive };
}

describe("hasGaConfigInit", () => {
  it.each([
    ["the single-quoted config emitted by older builds", "gtag('config', 'G-6TS0KG8H04');", true],
    ["the double-quoted config emitted by JSON.stringify", "gtag('config', \"G-6TS0KG8H04\");", true],
    ["a config call with options", "gtag('config', \"G-6TS0KG8H04\", { send_page_view: false });", true],
    ["the JSON-escaped config emitted in static RSC payloads", "gtag('config', \\\"G-6TS0KG8H04\\\");", true],
    ["a different GA measurement id", "gtag('config', \"G-OTHER\");", false],
  ] as const)("reads %s as %s", (_name, snippet, expected) => {
    expect(hasGaConfigInit(snippet, GA_ID)).toBe(expected);
  });
});

describe("getAnalyticsPayloadUrls", () => {
  it("returns root static payload candidates", () => {
    expect(getAnalyticsPayloadUrls("https://pharos.watch/")).toEqual([
      "https://pharos.watch/index.txt",
      "https://pharos.watch/__next._index.txt",
      "https://pharos.watch/__next._full.txt",
    ]);
  });
});

describe("GA collect URL classification", () => {
  it.each([
    {
      name: "a page_view collect from analytics.google.com",
      url: `https://analytics.google.com/g/collect?v=2&tid=${GA_ID}&en=page_view`,
      collect: true,
      pageView: true,
    },
    { name: "a page_view collect from www.google-analytics.com", url: PAGE_VIEW_COLLECT_URL, collect: true, pageView: true },
    {
      name: "a collect URL without an event name",
      url: `https://www.google-analytics.com/g/collect?v=2&tid=${GA_ID}&dp=%2F&dt=Pharos`,
      collect: true,
      pageView: false,
    },
    {
      name: "a non-pageview event",
      url: `https://analytics.google.com/g/collect?v=2&tid=${GA_ID}&en=scroll`,
      collect: true,
      pageView: false,
    },
    {
      name: "another measurement id",
      url: "https://analytics.google.com/g/collect?v=2&tid=G-OTHER&en=page_view",
      collect: false,
      pageView: false,
    },
    {
      name: "a lookalike host",
      url: `https://google-analytics.com.evil.test/g/collect?tid=${GA_ID}&en=page_view`,
      collect: false,
      pageView: false,
    },
    {
      name: "an analytics host smuggled into the query",
      url: `https://evil.test/g/collect?host=google-analytics.com&tid=${GA_ID}&en=page_view`,
      collect: false,
      pageView: false,
    },
    {
      name: "a malformed URL",
      url: `not a URL google-analytics.com/g/collect?tid=${GA_ID}&en=page_view`,
      collect: false,
      pageView: false,
    },
    {
      name: "a non-collect path",
      url: `https://www.google-analytics.com/g/collect/other?tid=${GA_ID}&en=page_view`,
      collect: false,
      pageView: false,
    },
    {
      name: "a non-HTTP scheme",
      url: `ftp://www.google-analytics.com/g/collect?tid=${GA_ID}&en=page_view`,
      collect: false,
      pageView: false,
    },
  ])("classifies $name", ({ url, collect, pageView }) => {
    expect(isExpectedGaCollectUrl(url, GA_ID)).toBe(collect);
    expect(isExpectedGaPageViewCollectUrl(url, GA_ID)).toBe(pageView);
  });
});

describe("GA collect failure tolerance", () => {
  it.each([
    { name: "a collect URL that also returned success", successful: [PAGE_VIEW_COLLECT_URL], tolerated: true },
    { name: "a collect URL with no successful twin", successful: [] as string[], tolerated: false },
  ])("tolerates an abort for $name: $tolerated", ({ successful, tolerated }) => {
    expect(
      isToleratedGaCollectFailure({ errorText: "net::ERR_ABORTED", url: PAGE_VIEW_COLLECT_URL }, new Set(successful)),
    ).toBe(tolerated);
  });

  it.each([
    {
      name: "an aborted collect for the expected measurement id",
      failure: {
        errorText: "net::ERR_ABORTED",
        url: `https://www.google-analytics.com/g/collect?v=2&tid=${GA_ID}&dp=%2F&dt=Pharos`,
      },
      expected: true,
    },
    {
      name: "an aborted collect for another measurement id",
      failure: {
        errorText: "net::ERR_ABORTED",
        url: "https://www.google-analytics.com/g/collect?v=2&tid=G-OTHER&en=page_view",
      },
      expected: false,
    },
    {
      name: "a non-abort collect failure",
      failure: { errorText: "net::ERR_FAILED", url: PAGE_VIEW_COLLECT_URL },
      expected: false,
    },
  ])("reads $name as an expected abort: $expected", ({ failure, expected }) => {
    expect(isExpectedGaCollectAbort(failure, GA_ID)).toBe(expected);
  });

  it.each([
    {
      name: "tolerates expected GA collect aborts after a successful collect signal",
      abortedUrl: `https://www.google-analytics.com/g/collect?v=2&tid=${GA_ID}&_s=2`,
      unexpected: false,
    },
    {
      name: "keeps wrong-measurement GA collect aborts as failures",
      abortedUrl: "https://www.google-analytics.com/g/collect?v=2&tid=G-OTHER&_s=2",
      unexpected: true,
    },
  ])("$name", ({ abortedUrl, unexpected }) => {
    const failure = { errorText: "net::ERR_ABORTED", url: abortedUrl };

    expect(
      getUnexpectedGaAnalyticsFailures([failure], new Set([PAGE_VIEW_COLLECT_URL]), GA_ID, {
        tolerateExpectedCollectAbort: true,
      }),
    ).toEqual(unexpected ? [failure] : []);
  });
});

describe("analytics CSP violations", () => {
  const unrelatedViolation = cspViolation(
    "eval",
    "script-src",
    "http://127.0.0.1:4173/_next/static/chunks/036srswv-1d~3.js",
  );
  const blockedGtagScript = cspViolation(GTAG_SCRIPT_URL, "script-src", "http://127.0.0.1:4173/");
  const blockedCollect = cspViolation(PAGE_VIEW_COLLECT_URL, "connect-src", GTAG_SCRIPT_URL);

  it.each([
    { name: "an unrelated first-party eval probe", violation: unrelatedViolation, analytics: false },
    { name: "a blocked gtag.js script", violation: blockedGtagScript, analytics: true },
    { name: "a blocked GA collect connection", violation: blockedCollect, analytics: true },
  ])("classifies $name", ({ violation, analytics }) => {
    expect(isAnalyticsCspViolation(violation, GA_ID)).toBe(analytics);
  });

  it("keeps only analytics CSP violations", () => {
    expect(getUnexpectedGaCspViolations([unrelatedViolation, blockedCollect], GA_ID)).toEqual([blockedCollect]);
  });

  it.each([
    { name: "ignores unrelated CSP violations when deciding live analytics retry eligibility", violation: unrelatedViolation, retryBlocking: false },
    { name: "treats analytics CSP violations as retry-blocking evidence", violation: blockedGtagScript, retryBlocking: true },
  ])("$name", ({ violation, retryBlocking }) => {
    expect(
      hasRetryBlockingGaAnalyticsSignal({ requests: [], responses: [], failures: [], violations: [violation] }, GA_ID),
    ).toBe(retryBlocking);
  });
});

describe("hasExpectedGaRuntimeState", () => {
  it("requires the gtag global, expected config, and page_view dataLayer entry", () => {
    expect(
      hasExpectedGaRuntimeState({
        dataLayerLength: 4,
        gtagType: "function",
        hasExpectedConfig: true,
        hasPageView: true,
        pageViewPath: "/",
      }),
    ).toBe(true);
    expect(
      hasExpectedGaRuntimeState({
        dataLayerLength: 0,
        gtagType: "undefined",
        hasExpectedConfig: false,
        hasPageView: false,
        pageViewPath: null,
      }),
    ).toBe(false);
  });
});

describe("hasAnyGaAnalyticsSignal", () => {
  it("detects request, response, failure, or CSP violation evidence", () => {
    expect(hasAnyGaAnalyticsSignal({ requests: [] })).toBe(false);
    expect(hasAnyGaAnalyticsSignal({ requests: [{ url: "https://www.googletagmanager.com/gtag/js?id=G-TEST" }] })).toBe(
      true,
    );
    expect(hasAnyGaAnalyticsSignal({ responses: [{ status: 200 }] })).toBe(true);
    expect(hasAnyGaAnalyticsSignal({ failures: [{ errorText: "net::ERR_FAILED" }] })).toBe(true);
    expect(hasAnyGaAnalyticsSignal({ violations: [{ blockedURI: "https://www.googletagmanager.com" }] })).toBe(true);
  });
});

describe("shouldRetryLiveAnalyticsSmoke", () => {
  const missingRuntime = {
    dataLayerLength: 0,
    gtagType: "undefined",
    hasExpectedConfig: false,
    hasPageView: false,
    pageViewPath: null,
    timedOut: true,
  };

  it("retries only live smoke runs with no runtime or network analytics signal", () => {
    expect(
      shouldRetryLiveAnalyticsSmoke({
        expectedGaId: "G-6TS0KG8H04",
        mode: "live",
        network: { failures: [], requests: [], responses: [], violations: [] },
        runtime: missingRuntime,
      }),
    ).toBe(true);
  });

  it("does not retry local smoke runs, healthy runtime state, or concrete analytics failures", () => {
    expect(
      shouldRetryLiveAnalyticsSmoke({
        expectedGaId: "G-6TS0KG8H04",
        mode: "local",
        network: { failures: [], requests: [], responses: [], violations: [] },
        runtime: missingRuntime,
      }),
    ).toBe(false);
    expect(
      shouldRetryLiveAnalyticsSmoke({
        expectedGaId: "G-6TS0KG8H04",
        mode: "live",
        network: { failures: [], requests: [], responses: [], violations: [] },
        runtime: {
          dataLayerLength: 4,
          gtagType: "function",
          hasExpectedConfig: true,
          hasPageView: true,
          pageViewPath: "/",
        },
      }),
    ).toBe(false);
    expect(
      shouldRetryLiveAnalyticsSmoke({
        expectedGaId: "G-6TS0KG8H04",
        mode: "live",
        network: {
          failures: [{ errorText: "net::ERR_FAILED", url: "https://www.googletagmanager.com/gtag/js?id=G-6TS0KG8H04" }],
          requests: [],
          responses: [],
          violations: [],
        },
        runtime: missingRuntime,
      }),
    ).toBe(false);
  });

  it("retries live smoke when only an unrelated first-party CSP violation was observed", () => {
    expect(
      shouldRetryLiveAnalyticsSmoke({
        expectedGaId: "G-6TS0KG8H04",
        mode: "live",
        network: {
          failures: [],
          requests: [],
          responses: [],
          violations: [
            {
              blockedURI: "eval",
              effectiveDirective: "script-src",
              sourceFile: "https://pharos.watch/_next/static/chunks/0abpcssvqzw-7.js",
              violatedDirective: "script-src",
            },
          ],
        },
        runtime: missingRuntime,
      }),
    ).toBe(true);
  });
});

describe("getExpectedGaNetworkSignals", () => {
  it("requires both gtag.js and a successful page_view collect response", () => {
    const signals = getExpectedGaNetworkSignals(
      {
        failures: [],
        responses: [
          {
            status: 200,
            url: "https://www.googletagmanager.com/gtag/js?id=G-6TS0KG8H04",
          },
          {
            status: 204,
            url: "https://www.google-analytics.com/g/collect?v=2&tid=G-6TS0KG8H04&en=page_view",
          },
        ],
      },
      "G-6TS0KG8H04",
    );

    expect(signals.hasGtagScriptResponse).toBe(true);
    expect(signals.hasCollectSignal).toBe(true);
    expect(signals.collectResponses).toHaveLength(1);
  });

  it("can treat expected collect aborts as a local smoke signal", () => {
    const signals = getExpectedGaNetworkSignals(
      {
        failures: [
          {
            errorText: "net::ERR_ABORTED",
            url: "https://www.google-analytics.com/g/collect?v=2&tid=G-6TS0KG8H04&en=page_view",
          },
        ],
        responses: [
          {
            status: 200,
            url: "https://www.googletagmanager.com/gtag/js?id=G-6TS0KG8H04",
          },
        ],
      },
      "G-6TS0KG8H04",
      { tolerateCollectAbortAsSignal: true },
    );

    expect(signals.hasGtagScriptResponse).toBe(true);
    expect(signals.hasCollectSignal).toBe(true);
    expect(signals.collectAborts).toHaveLength(1);
  });
});

describe("getBrowserLaunchOptions", () => {
  it("uses the Playwright-managed browser outside GitHub Actions", () => {
    expect(getBrowserLaunchOptions({ NODE_ENV: "test" })).toEqual({ headless: true });
  });

  it("uses the system Chrome channel on GitHub Actions", () => {
    expect(getBrowserLaunchOptions({ NODE_ENV: "test", GITHUB_ACTIONS: "true" })).toEqual({ channel: "chrome", headless: true });
  });

  it("allows an explicit browser channel override", () => {
    expect(getBrowserLaunchOptions({ NODE_ENV: "test", GITHUB_ACTIONS: "true", SMOKE_UI_BROWSER_CHANNEL: "msedge" }))
      .toEqual({ channel: "msedge", headless: true });
  });

  it("prefers an explicit executable path over browser channels", () => {
    expect(getBrowserLaunchOptions({
      NODE_ENV: "test",
      SMOKE_UI_BROWSER_CHANNEL: "chrome",
      SMOKE_UI_BROWSER_EXECUTABLE_PATH: "/usr/bin/chromium",
    })).toEqual({ executablePath: "/usr/bin/chromium", headless: true });
  });
});

describe("getOverflowRoutes", () => {
  it("includes the public API access page in local smoke coverage", () => {
    withEnv("SMOKE_UI_OVERFLOW_ROUTES", undefined, () => {
      expect(getOverflowRoutes("local")).toContain("/api/");
    });
  });

  it("includes the public PharosWatchBot page in local and live canary coverage", () => {
    withEnv("SMOKE_UI_OVERFLOW_ROUTES", undefined, () => {
      withEnv("SMOKE_UI_CANARY_ROUTE", undefined, () => {
        expect(getOverflowRoutes("local")).toContain("/pharoswatchbot/");
        expect(getOverflowRoutes("live")).toContain("/pharoswatchbot/");
      });
    });
  });
});

describe("getOverflowWorkerCount", () => {
  it("defaults local overflow sweeps to two workers", () => {
    withEnv("SMOKE_UI_OVERFLOW_WORKERS", undefined, () => {
      expect(getOverflowWorkerCount("local", 11)).toBe(2);
    });
  });

  it("keeps live overflow sweeps single-session by default", () => {
    withEnv("SMOKE_UI_OVERFLOW_WORKERS", undefined, () => {
      expect(getOverflowWorkerCount("live", 4)).toBe(1);
    });
  });

  it("allows env overrides while capping workers to six and route count", () => {
    withEnv("SMOKE_UI_OVERFLOW_WORKERS", "8", () => {
      expect(getOverflowWorkerCount("local", 11)).toBe(6);
      expect(getOverflowWorkerCount("local", 2)).toBe(2);
    });
  });

  it("falls back for invalid env values and disables workers when overflow is skipped", () => {
    withEnv("SMOKE_UI_OVERFLOW_WORKERS", "nope", () => {
      expect(getOverflowWorkerCount("local", 11)).toBe(2);
      expect(getOverflowWorkerCount("local", 11, true)).toBe(0);
      expect(getOverflowWorkerCount("local", 0)).toBe(0);
    });
  });
});

describe("chunkOverflowRoutes", () => {
  it("splits routes into deterministic contiguous chunks", () => {
    expect(chunkOverflowRoutes(["/", "/alt-pegs/", "/flows/", "/yield/", "/api/"], 2)).toEqual([
      ["/", "/alt-pegs/", "/flows/"],
      ["/yield/", "/api/"],
    ]);
  });

  it("caps chunks to the number of routes", () => {
    expect(chunkOverflowRoutes(["/", "/api/"], 3)).toEqual([["/"], ["/api/"]]);
  });

  it("returns no chunks for empty input or disabled workers", () => {
    expect(chunkOverflowRoutes([], 2)).toEqual([]);
    expect(chunkOverflowRoutes(["/"], 0)).toEqual([]);
  });
});

describe("verifyAnalyticsSnippet", () => {
  it("accepts runtime-loaded GA without a first-paint preload", async () => {
    const fetchMock: typeof fetch = async (input) => {
      const url = String(input);
      if (url === "https://pharos.watch/") {
        return new Response("<html><body>Pharos</body></html>");
      }
      return new Response("not found", { status: 404 });
    };

    await expect(verifyAnalyticsSnippet("https://pharos.watch/", "G-6TS0KG8H04", fetchMock)).resolves.toBeUndefined();
  });

  it("rejects GA script preloads in the HTML shell", async () => {
    const fetchMock: typeof fetch = async (input) => {
      const url = String(input);
      if (url === "https://pharos.watch/") {
        return new Response(
          '<link rel="preload" href="https://www.googletagmanager.com/gtag/js?id=G-6TS0KG8H04" as="script"/>',
        );
      }
      return new Response("not found", { status: 404 });
    };

    await expect(verifyAnalyticsSnippet("https://pharos.watch/", "G-6TS0KG8H04", fetchMock)).rejects.toThrow(
      "not a first-paint HTML preload",
    );
  });
});
