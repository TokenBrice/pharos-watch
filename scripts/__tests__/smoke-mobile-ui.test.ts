import { describe, expect, it } from "vitest";
import { withRedirectFixture } from "./smoke-route-identity.test-support";

import {
  assertRouteSummary,
  captureRoute,
} from "../maintenance/smoke-mobile-ui.mjs";

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

