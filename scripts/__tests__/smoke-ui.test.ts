import { describe, expect, it } from "vitest";

import {
  chunkOverflowRoutes,
  getBrowserLaunchOptions,
  getAnalyticsPayloadUrls,
  getOverflowRoutes,
  getOverflowWorkerCount,
  hasGaConfigInit,
  HOMEPAGE_RECENT_EVENTS_SMOKE_PATH,
  isExpectedGaPageViewCollectUrl,
  isToleratedGaCollectFailure,
  verifyAnalyticsSnippet,
} from "../smoke-ui.mjs";

function withEnv(key: string, value: string | undefined, fn: () => void) {
  const previous = process.env[key];
  if (value == null) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }

  try {
    fn();
  } finally {
    if (previous == null) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
}

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

describe("isToleratedGaCollectFailure", () => {
  it("tolerates Playwright net::ERR_ABORTED reports for collect URLs that also returned success", () => {
    const url = "https://analytics.google.com/g/collect?v=2&tid=G-6TS0KG8H04&en=page_view";
    expect(isToleratedGaCollectFailure({ errorText: "net::ERR_ABORTED", url }, new Set([url]))).toBe(true);
    expect(isToleratedGaCollectFailure({ errorText: "net::ERR_ABORTED", url }, new Set())).toBe(false);
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
  it("accepts the GA script tag before runtime analytics checks run", async () => {
    const fetchMock = async (url: string) => {
      if (url === "https://pharos.watch/") {
        return new Response(
          '<link rel="preload" href="https://www.googletagmanager.com/gtag/js?id=G-6TS0KG8H04" as="script"/>',
        );
      }
      return new Response("not found", { status: 404 });
    };

    await expect(verifyAnalyticsSnippet("https://pharos.watch/", "G-6TS0KG8H04", fetchMock)).resolves.toBeUndefined();
  });
});
