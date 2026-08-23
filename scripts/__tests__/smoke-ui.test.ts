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
  HOMEPAGE_RECENT_EVENTS_SMOKE_PATH,
  isAnalyticsCspViolation,
  isExpectedGaCollectAbort,
  isExpectedGaCollectUrl,
  isExpectedGaPageViewCollectUrl,
  isToleratedGaCollectFailure,
  shouldRetryLiveAnalyticsSmoke,
  verifyAnalyticsSnippet,
} from "../maintenance/smoke-ui.mjs";

describe("hasGaConfigInit", () => {
  it("accepts the single-quoted GA config emitted by older builds", () => {
    expect(hasGaConfigInit("gtag('config', 'G-6TS0KG8H04');", "G-6TS0KG8H04")).toBe(true);
  });

  it("accepts the double-quoted GA config emitted by JSON.stringify", () => {
    expect(hasGaConfigInit("gtag('config', \"G-6TS0KG8H04\");", "G-6TS0KG8H04")).toBe(true);
  });

  it("accepts GA config calls with options", () => {
    expect(hasGaConfigInit("gtag('config', \"G-6TS0KG8H04\", { send_page_view: false });", "G-6TS0KG8H04")).toBe(true);
  });

  it("accepts the JSON-escaped GA config emitted in static RSC payloads", () => {
    expect(hasGaConfigInit("gtag('config', \\\"G-6TS0KG8H04\\\");", "G-6TS0KG8H04")).toBe(true);
  });

  it("rejects a different GA measurement id", () => {
    expect(hasGaConfigInit("gtag('config', \"G-OTHER\");", "G-6TS0KG8H04")).toBe(false);
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

describe("isExpectedGaPageViewCollectUrl", () => {
  it("accepts successful GA4 page_view collect URLs from both GA hosts", () => {
    expect(
      isExpectedGaPageViewCollectUrl(
        "https://analytics.google.com/g/collect?v=2&tid=G-6TS0KG8H04&en=page_view",
        "G-6TS0KG8H04",
      ),
    ).toBe(true);
    expect(
      isExpectedGaPageViewCollectUrl(
        "https://www.google-analytics.com/g/collect?v=2&tid=G-6TS0KG8H04&en=page_view",
        "G-6TS0KG8H04",
      ),
    ).toBe(true);
  });

  it("rejects non-pageview or wrong-measurement collect URLs", () => {
    expect(
      isExpectedGaPageViewCollectUrl(
        "https://analytics.google.com/g/collect?v=2&tid=G-OTHER&en=page_view",
        "G-6TS0KG8H04",
      ),
    ).toBe(false);
    expect(
      isExpectedGaPageViewCollectUrl(
        "https://analytics.google.com/g/collect?v=2&tid=G-6TS0KG8H04&en=scroll",
        "G-6TS0KG8H04",
      ),
    ).toBe(false);
  });
});

describe("isExpectedGaCollectUrl", () => {
  it("accepts GA4 collect URLs for the configured measurement id even without an event name", () => {
    expect(
      isExpectedGaCollectUrl(
        "https://www.google-analytics.com/g/collect?v=2&tid=G-6TS0KG8H04&dp=%2F&dt=Pharos",
        "G-6TS0KG8H04",
      ),
    ).toBe(true);
  });

  it("rejects collect URLs for other measurement ids", () => {
    expect(
      isExpectedGaCollectUrl(
        "https://www.google-analytics.com/g/collect?v=2&tid=G-OTHER&dp=%2F&dt=Pharos",
        "G-6TS0KG8H04",
      ),
    ).toBe(false);
  });
});

describe("isToleratedGaCollectFailure", () => {
  it("tolerates Playwright net::ERR_ABORTED reports for collect URLs that also returned success", () => {
    const url = "https://analytics.google.com/g/collect?v=2&tid=G-6TS0KG8H04&en=page_view";
    expect(isToleratedGaCollectFailure({ errorText: "net::ERR_ABORTED", url }, new Set([url]))).toBe(true);
    expect(isToleratedGaCollectFailure({ errorText: "net::ERR_ABORTED", url }, new Set())).toBe(false);
  });
});

describe("isExpectedGaCollectAbort", () => {
  it("accepts aborted GA4 collect requests for the expected measurement id", () => {
    expect(
      isExpectedGaCollectAbort(
        {
          errorText: "net::ERR_ABORTED",
          url: "https://www.google-analytics.com/g/collect?v=2&tid=G-6TS0KG8H04&dp=%2F&dt=Pharos",
        },
        "G-6TS0KG8H04",
      ),
    ).toBe(true);
  });

  it("rejects unrelated collect aborts", () => {
    expect(
      isExpectedGaCollectAbort(
        {
          errorText: "net::ERR_ABORTED",
          url: "https://www.google-analytics.com/g/collect?v=2&tid=G-OTHER&en=page_view",
        },
        "G-6TS0KG8H04",
      ),
    ).toBe(false);
    expect(
      isExpectedGaCollectAbort(
        {
          errorText: "net::ERR_FAILED",
          url: "https://www.google-analytics.com/g/collect?v=2&tid=G-6TS0KG8H04&en=page_view",
        },
        "G-6TS0KG8H04",
      ),
    ).toBe(false);
  });
});

describe("getUnexpectedGaAnalyticsFailures", () => {
  it("tolerates expected GA collect aborts after a successful collect signal", () => {
    const successfulUrl = "https://www.google-analytics.com/g/collect?v=2&tid=G-6TS0KG8H04&en=page_view";
    const abortedUrl = "https://www.google-analytics.com/g/collect?v=2&tid=G-6TS0KG8H04&_s=2";

    expect(
      getUnexpectedGaAnalyticsFailures(
        [{ errorText: "net::ERR_ABORTED", url: abortedUrl }],
        new Set([successfulUrl]),
        "G-6TS0KG8H04",
        { tolerateExpectedCollectAbort: true },
      ),
    ).toEqual([]);
  });

  it("keeps wrong-measurement GA collect aborts as failures", () => {
    const successfulUrl = "https://www.google-analytics.com/g/collect?v=2&tid=G-6TS0KG8H04&en=page_view";
    const abortedUrl = "https://www.google-analytics.com/g/collect?v=2&tid=G-OTHER&_s=2";

    expect(
      getUnexpectedGaAnalyticsFailures(
        [{ errorText: "net::ERR_ABORTED", url: abortedUrl }],
        new Set([successfulUrl]),
        "G-6TS0KG8H04",
        { tolerateExpectedCollectAbort: true },
      ),
    ).toEqual([{ errorText: "net::ERR_ABORTED", url: abortedUrl }]);
  });
});

describe("isAnalyticsCspViolation", () => {
  it("ignores unrelated first-party eval probes", () => {
    expect(
      isAnalyticsCspViolation(
        {
          blockedURI: "eval",
          effectiveDirective: "script-src",
          sourceFile: "http://127.0.0.1:4173/_next/static/chunks/036srswv-1d~3.js",
          violatedDirective: "script-src",
        },
        "G-6TS0KG8H04",
      ),
    ).toBe(false);
  });

  it("detects blocked GA and GTM resources", () => {
    expect(
      isAnalyticsCspViolation(
        {
          blockedURI: "https://www.googletagmanager.com/gtag/js?id=G-6TS0KG8H04",
          effectiveDirective: "script-src",
          sourceFile: "http://127.0.0.1:4173/",
          violatedDirective: "script-src",
        },
        "G-6TS0KG8H04",
      ),
    ).toBe(true);
    expect(
      isAnalyticsCspViolation(
        {
          blockedURI: "https://www.google-analytics.com/g/collect?v=2&tid=G-6TS0KG8H04&en=page_view",
          effectiveDirective: "connect-src",
          sourceFile: "https://www.googletagmanager.com/gtag/js?id=G-6TS0KG8H04",
          violatedDirective: "connect-src",
        },
        "G-6TS0KG8H04",
      ),
    ).toBe(true);
  });
});

describe("getUnexpectedGaCspViolations", () => {
  it("keeps only analytics CSP violations", () => {
    const analyticsViolation = {
      blockedURI: "https://analytics.google.com/g/collect?v=2&tid=G-6TS0KG8H04&en=page_view",
      effectiveDirective: "connect-src",
      sourceFile: "https://www.googletagmanager.com/gtag/js?id=G-6TS0KG8H04",
      violatedDirective: "connect-src",
    };

    expect(
      getUnexpectedGaCspViolations(
        [
          {
            blockedURI: "eval",
            effectiveDirective: "script-src",
            sourceFile: "http://127.0.0.1:4173/_next/static/chunks/036srswv-1d~3.js",
            violatedDirective: "script-src",
          },
          analyticsViolation,
        ],
        "G-6TS0KG8H04",
      ),
    ).toEqual([analyticsViolation]);
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

describe("hasRetryBlockingGaAnalyticsSignal", () => {
  it("ignores unrelated CSP violations when deciding live analytics retry eligibility", () => {
    expect(
      hasRetryBlockingGaAnalyticsSignal(
        {
          requests: [],
          responses: [],
          failures: [],
          violations: [
            {
              blockedURI: "eval",
              effectiveDirective: "script-src",
              sourceFile: "https://pharos.watch/_next/static/chunks/0abpcssvqzw-7.js",
              violatedDirective: "script-src",
            },
          ],
        },
        "G-6TS0KG8H04",
      ),
    ).toBe(false);
  });

  it("treats analytics CSP violations as retry-blocking evidence", () => {
    expect(
      hasRetryBlockingGaAnalyticsSignal(
        {
          requests: [],
          responses: [],
          failures: [],
          violations: [
            {
              blockedURI: "https://www.googletagmanager.com/gtag/js?id=G-6TS0KG8H04",
              effectiveDirective: "script-src",
              sourceFile: "https://pharos.watch/",
              violatedDirective: "script-src",
            },
          ],
        },
        "G-6TS0KG8H04",
      ),
    ).toBe(true);
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
  it("uses the Playwright-managed browser by default outside GitHub Actions", () => {
    withEnv("GITHUB_ACTIONS", undefined, () => {
      withEnv("SMOKE_UI_BROWSER_CHANNEL", undefined, () => {
        withEnv("SMOKE_UI_BROWSER_EXECUTABLE_PATH", undefined, () => {
          expect(getBrowserLaunchOptions()).toEqual({ headless: true });
        });
      });
    });
  });

  it("uses the system Chrome channel on GitHub Actions", () => {
    withEnv("GITHUB_ACTIONS", "true", () => {
      withEnv("SMOKE_UI_BROWSER_CHANNEL", undefined, () => {
        withEnv("SMOKE_UI_BROWSER_EXECUTABLE_PATH", undefined, () => {
          expect(getBrowserLaunchOptions()).toEqual({ channel: "chrome", headless: true });
        });
      });
    });
  });

  it("allows an explicit browser channel override", () => {
    withEnv("GITHUB_ACTIONS", "true", () => {
      withEnv("SMOKE_UI_BROWSER_CHANNEL", "msedge", () => {
        expect(getBrowserLaunchOptions()).toEqual({ channel: "msedge", headless: true });
      });
    });
  });

  it("prefers an explicit executable path over browser channels", () => {
    withEnv("SMOKE_UI_BROWSER_CHANNEL", "chrome", () => {
      withEnv("SMOKE_UI_BROWSER_EXECUTABLE_PATH", "/usr/bin/chromium", () => {
        expect(getBrowserLaunchOptions()).toEqual({ executablePath: "/usr/bin/chromium", headless: true });
      });
    });
  });
});

describe("getOverflowRoutes", () => {
  it("includes the public API access page in local smoke coverage", () => {
    const previousRoutes = process.env.SMOKE_UI_OVERFLOW_ROUTES;
    delete process.env.SMOKE_UI_OVERFLOW_ROUTES;
    try {
      expect(getOverflowRoutes("local")).toContain("/api/");
    } finally {
      if (previousRoutes == null) {
        delete process.env.SMOKE_UI_OVERFLOW_ROUTES;
      } else {
        process.env.SMOKE_UI_OVERFLOW_ROUTES = previousRoutes;
      }
    }
  });

  it("includes the public PharosWatchBot page in local and live canary coverage", () => {
    const previousRoutes = process.env.SMOKE_UI_OVERFLOW_ROUTES;
    const previousCanary = process.env.SMOKE_UI_CANARY_ROUTE;
    delete process.env.SMOKE_UI_OVERFLOW_ROUTES;
    delete process.env.SMOKE_UI_CANARY_ROUTE;
    try {
      expect(getOverflowRoutes("local")).toContain("/pharoswatchbot/");
      expect(getOverflowRoutes("live")).toContain("/pharoswatchbot/");
    } finally {
      if (previousRoutes == null) delete process.env.SMOKE_UI_OVERFLOW_ROUTES;
      else process.env.SMOKE_UI_OVERFLOW_ROUTES = previousRoutes;
      if (previousCanary == null) delete process.env.SMOKE_UI_CANARY_ROUTE;
      else process.env.SMOKE_UI_CANARY_ROUTE = previousCanary;
    }
  });
});

describe("HOMEPAGE_RECENT_EVENTS_SMOKE_PATH", () => {
  it("checks the same same-origin site-data path used by the homepage tape", () => {
    expect(HOMEPAGE_RECENT_EVENTS_SMOKE_PATH).toBe("/_site-data/events?limit=1");
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
