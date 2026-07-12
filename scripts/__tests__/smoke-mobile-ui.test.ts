import { afterEach, describe, expect, it } from "vitest";

import {
  assertRouteSummary,
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
  const ORIGINAL_SKIP = process.env.SMOKE_MOBILE_UI_SKIP_DESKTOP;
  const ORIGINAL_WORKERS = process.env.SMOKE_MOBILE_UI_WORKERS;

  afterEach(() => {
    if (ORIGINAL_SKIP === undefined) {
      delete process.env.SMOKE_MOBILE_UI_SKIP_DESKTOP;
    } else {
      process.env.SMOKE_MOBILE_UI_SKIP_DESKTOP = ORIGINAL_SKIP;
    }

    if (ORIGINAL_WORKERS === undefined) {
      delete process.env.SMOKE_MOBILE_UI_WORKERS;
    } else {
      process.env.SMOKE_MOBILE_UI_WORKERS = ORIGINAL_WORKERS;
    }
  });

  it("skips desktop by default unless explicitly enabled", () => {
    delete process.env.SMOKE_MOBILE_UI_SKIP_DESKTOP;
    expect(parseArgs([]).skipDesktop).toBe(true);
    expect(parseArgs(["--include-desktop"]).skipDesktop).toBe(false);
    expect(parseArgs(["--include-desktop", "--skip-desktop"]).skipDesktop).toBe(true);
  });

  it("respects SMOKE_MOBILE_UI_SKIP_DESKTOP=0", () => {
    process.env.SMOKE_MOBILE_UI_SKIP_DESKTOP = "0";
    expect(parseArgs([]).skipDesktop).toBe(false);
  });

  it("accepts worker overrides from env and argv", () => {
    process.env.SMOKE_MOBILE_UI_WORKERS = "4";
    expect(parseArgs([]).workers).toBe("4");
    expect(parseArgs(["--workers", "3"]).workers).toBe("3");
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

  it("surfaces table geometry issues as route failures", () => {
    const failures = assertRouteSummary(
      {
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

  it("skips geometry for skeleton-only tables and enforces it once real rows render", () => {
    const baseSummary = {
      status: 200,
      textLength: 100,
      hasFrameworkOverlay: false,
      overflowDelta: 0,
      touchScan: { violations: [] },
    };

    // Skeleton-only or empty tbodies are unmeasurable: the scan skips them.
    expect(
      assertRouteSummary({ ...baseSummary, tableScan: { checked: 0, issues: [] } }, { strictTouchTargets: true }),
    ).toEqual([]);

    // With at least one real row the scan runs, and geometry failures block
    // the route — there is no upstream-failure-notice waiver anymore.
    expect(
      assertRouteSummary(
        {
          ...baseSummary,
          tableScan: {
            checked: 1,
            issues: [{ kind: "too-few-visible-columns", detail: "0/5 header columns visible" }],
          },
        },
        { strictTouchTargets: true },
      ).join("\n"),
    ).toContain("table geometry failures=1");
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
