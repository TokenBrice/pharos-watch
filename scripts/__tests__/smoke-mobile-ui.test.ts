import { describe, expect, it } from "vitest";
import { withRedirectFixture } from "./smoke-route-identity.test-support";
import { withEnv } from "./helpers/test-state";

import {
  assertRouteSummary,
  captureRoute,
  DEFAULT_MOBILE_UI_ROUTES,
  DEFAULT_MOBILE_UI_VIEWPORTS,
  getMobileWorkerCount,
  getConsoleScanOutcome,
  getTableScanOutcome,
  getTouchScanOutcome,
  isAllowedSmallTouchTarget,
  isMeasurableTableRow,
  parseArgs,
  parseRouteList,
  parseViewportList,
} from "../maintenance/smoke-mobile-ui.mjs";

describe("parseRouteList", () => {
  it("defaults to the focused mobile route set", () => {
    expect(parseRouteList("")).toEqual(DEFAULT_MOBILE_UI_ROUTES);
    expect(DEFAULT_MOBILE_UI_ROUTES).toContain("/liquidity/");
    expect(DEFAULT_MOBILE_UI_ROUTES).toContain("/flows/");
    expect(DEFAULT_MOBILE_UI_ROUTES).toContain("/cemetery/");
    expect(DEFAULT_MOBILE_UI_ROUTES).toContain("/coverage/");
    expect(DEFAULT_MOBILE_UI_ROUTES).toContain("/pharoswatchbot/");
  });

  it("normalizes route input and removes duplicates", () => {
    expect(parseRouteList(" stablecoins/,/screener/,screener/, / ")).toEqual(["/stablecoins/", "/screener/", "/"]);
  });
});

describe("parseViewportList", () => {
  it("defaults to the mobile audit viewports", () => {
    expect(parseViewportList("")).toEqual(DEFAULT_MOBILE_UI_VIEWPORTS);
    expect(DEFAULT_MOBILE_UI_VIEWPORTS.map((viewport) => `${viewport.width}x${viewport.height}`)).toContain("414x896");
  });

  it("parses comma-separated viewport tokens", () => {
    expect(parseViewportList("360x740, 390x844")).toEqual([
      { label: "360x740", width: 360, height: 740 },
      { label: "390x844", width: 390, height: 844 },
    ]);
  });

  it("falls back when viewport input is invalid", () => {
    expect(parseViewportList("wide,390-by-844")).toEqual(DEFAULT_MOBILE_UI_VIEWPORTS);
  });
});

describe("parseArgs", () => {
  it("skips desktop by default unless explicitly enabled", () => {
    withEnv("SMOKE_MOBILE_UI_SKIP_DESKTOP", undefined, () => {
      expect(parseArgs([]).skipDesktop).toBe(true);
      expect(parseArgs(["--include-desktop"]).skipDesktop).toBe(false);
      expect(parseArgs(["--include-desktop", "--skip-desktop"]).skipDesktop).toBe(true);
    });
  });

  it("respects SMOKE_MOBILE_UI_SKIP_DESKTOP=0", () => {
    withEnv("SMOKE_MOBILE_UI_SKIP_DESKTOP", "0", () => {
      expect(parseArgs([]).skipDesktop).toBe(false);
    });
  });

  it("accepts worker overrides from env and argv", () => {
    withEnv("SMOKE_MOBILE_UI_WORKERS", "4", () => {
      expect(parseArgs([]).workers).toBe("4");
      expect(parseArgs(["--workers", "3"]).workers).toBe("3");
    });
  });
});

describe("getMobileWorkerCount", () => {
  it("defaults to one worker when there are no mobile tasks", () => {
    expect(getMobileWorkerCount(0, "6")).toBe(1);
  });

  it("clamps worker count by task count and max cap", () => {
    expect(getMobileWorkerCount(1, "3")).toBe(1);
    expect(getMobileWorkerCount(12, "99")).toBe(6);
  });

  it("falls back to the default worker count on invalid input", () => {
    expect(getMobileWorkerCount(12, "")).toBe(2);
    expect(getMobileWorkerCount(12, "abc")).toBe(2);
    expect(getMobileWorkerCount(12, "0")).toBe(2);
  });
});

describe("console and table scan outcomes", () => {
  it("classifies browser console errors and warnings separately", () => {
    expect(
      getConsoleScanOutcome([
        { type: "warning", text: "chart warning" },
        { type: "error", text: "runtime error" },
      ]),
    ).toEqual({
      errors: [{ type: "error", text: "runtime error" }],
      warnings: [{ type: "warning", text: "chart warning" }],
    });
  });


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

  it("does not fail route summaries solely because local console messages were observed", () => {
    const failures = assertRouteSummary(
      {
        routeUrl: "https://pharos.watch/yield/",
        finalUrl: "https://pharos.watch/yield/",
        status: 200,
        textLength: 100,
        hasFrameworkOverlay: false,
        overflowDelta: 0,
        tableScan: { checked: 0, issues: [] },
        touchScan: { violations: [] },
        consoleMessages: [{ type: "error", text: "Unhandled exception" }],
      },
      {
        strictTouchTargets: false,
      },
    );

    expect(failures).toEqual([]);
  });
});

describe("mobile route identity", () => {
  const healthy = {
    routeUrl: "https://pharos.watch/cemetery/",
    finalUrl: "https://pharos.watch/cemetery/",
    status: 200,
    textLength: 100,
    hasFrameworkOverlay: false,
    overflowDelta: 0,
    tableScan: { checked: 0, issues: [] },
    touchScan: { violations: [] },
  };

  it("accepts canonical slash normalization but rejects healthy wrong routes and origins", () => {
    expect(assertRouteSummary({ ...healthy, finalUrl: "https://pharos.watch/cemetery" }, { strictTouchTargets: true }))
      .toEqual([]);
    for (const finalUrl of ["https://pharos.watch/", "https://example.com/cemetery/"]) {
      expect(assertRouteSummary({ ...healthy, finalUrl }, { strictTouchTargets: true }))
        .toEqual([expect.stringContaining("unexpected destination")]);
    }
  });

  it("accepts only the documented coin-preserving yield fallback", () => {
    const routeUrl = "https://pharos.watch/stablecoin/usdc-circle/yield/";
    expect(assertRouteSummary({
      ...healthy, routeUrl,
      finalUrl: "https://pharos.watch/yield/?compare=usdc-circle&from=detail-fallback&workbenchFallback=usdc-circle",
    }, { strictTouchTargets: true })).toEqual([]);
    expect(assertRouteSummary({
      ...healthy, routeUrl, finalUrl: "https://pharos.watch/yield/",
    }, { strictTouchTargets: true })).toHaveLength(1);
  });

  it("captures and rejects a local cemetery redirect to a healthy homepage", async () => {
    await withRedirectFixture("/cemetery/", "/", async (url) => {
      let finalUrl = "";
      const page = {
        goto: async (requested: string) => {
          const response = await fetch(requested);
          finalUrl = response.url;
          await response.text();
          return { status: () => response.status };
        },
        url: () => finalUrl,
        waitForLoadState: async () => {},
        evaluate: async () => healthy,
      };
      const summary = await captureRoute(page, {
        route: "/cemetery/", url, waitMs: 0, timeoutMs: 1000,
        scanTableGeometry: false, scanTouchTargets: false,
        viewport: { width: 390, height: 844 },
      });
      expect(summary.finalUrl).toBe(`${url}/`);
      expect(assertRouteSummary(summary, { strictTouchTargets: true }))
        .toEqual([expect.stringContaining("unexpected destination")]);
    });
  });
});

describe("isMeasurableTableRow", () => {
  const skeletonRow = {
    querySelector: (selector: string) => (selector === '[data-slot="skeleton"]' ? {} : null),
  };
  const dataRow = { querySelector: () => null };

  it("treats skeleton placeholder rows as unmeasurable", () => {
    expect(isMeasurableTableRow(skeletonRow)).toBe(false);
  });

  it("treats real data rows as measurable", () => {
    expect(isMeasurableTableRow(dataRow)).toBe(true);
  });

});

describe("isAllowedSmallTouchTarget", () => {
  it("allows explicit, visualization, inline text link, and disabled exceptions", () => {
    expect(isAllowedSmallTouchTarget({ explicitAllow: true })).toBe(true);
    expect(isAllowedSmallTouchTarget({ inVisualization: true })).toBe(true);
    expect(isAllowedSmallTouchTarget({ isInlineTextLink: true })).toBe(true);
    expect(isAllowedSmallTouchTarget({ isVisuallyHidden: true })).toBe(true);
    expect(isAllowedSmallTouchTarget({ isFixedStatusStrip: true })).toBe(true);
    expect(isAllowedSmallTouchTarget({ disabled: true })).toBe(true);
  });

  it("does not allow ordinary small controls", () => {
    expect(isAllowedSmallTouchTarget({ tagName: "button", width: 32, height: 32 })).toBe(false);
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
