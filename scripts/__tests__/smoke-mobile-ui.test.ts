import { describe, expect, it } from "vitest";
import { withRedirectFixture } from "./smoke-route-identity.test-support";

import {
  assertRouteSummary,
  attachRuntimeMessageListeners,
  captureRoute,
  exerciseProfileFeedbackDialog,
  getConsoleScanOutcome,
  isProfileFeedbackInteractionRoute,
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


describe("mobile hydration signals", () => {
  const healthy = {
    routeUrl: "https://pharos.watch/stablecoin/usdt-tether/",
    finalUrl: "https://pharos.watch/stablecoin/usdt-tether/",
    status: 200, textLength: 100, hasFrameworkOverlay: false, overflowDelta: 0,
    tableScan: { checked: 0, issues: [] }, touchScan: { violations: [] },
  };

  function fakePage() {
    const handlers = new Map<string, Set<(arg: unknown) => void>>();
    return {
      on: (event: string, handler: (arg: unknown) => void) => {
        handlers.set(event, (handlers.get(event) ?? new Set()).add(handler));
      },
      off: (event: string, handler: (arg: unknown) => void) => { handlers.get(event)?.delete(handler); },
      emit: (event: string, arg: unknown) => handlers.get(event)?.forEach((handler) => handler(arg)),
      count: (event: string) => handlers.get(event)?.size ?? 0,
    };
  }
  const consoleMessage = (type: string, text: string) => ({ type: () => type, text: () => text });

  it("fails on fatal hydration console and page errors even though the HTML is readable", () => {
    const page = fakePage();
    const sink: Array<{ type: string; text: string; fatal: boolean }> = [];
    attachRuntimeMessageListeners(page, sink);
    page.emit("console", consoleMessage("error", "Hydration failed because the server rendered HTML didn't match"));
    page.emit("pageerror", new Error("Minified React error #418"));
    const failures = assertRouteSummary(healthy, { consoleMessages: sink, strictTouchTargets: true });
    expect(failures).toEqual([expect.stringContaining("fatal runtime errors=2")]);
  });

  it("keeps ordinary warnings and API 503 messages advisory", () => {
    const page = fakePage();
    const sink: Array<{ type: string; text: string; fatal: boolean }> = [];
    attachRuntimeMessageListeners(page, sink);
    page.emit("console", consoleMessage("warning", "deprecated API"));
    page.emit("console", consoleMessage("error", "API request returned 503"));
    page.emit("pageerror", new Error("ordinary uncaught"));
    expect(assertRouteSummary(healthy, { consoleMessages: sink, strictTouchTargets: true })).toEqual([]);
    expect(getConsoleScanOutcome(sink).errors).toHaveLength(2);
  });

  it("classifies the complete text before truncating the displayed copy", () => {
    const page = fakePage();
    const sink: Array<{ type: string; text: string; fatal: boolean }> = [];
    attachRuntimeMessageListeners(page, sink);
    page.emit("console", consoleMessage("error", `${"x".repeat(400)} ChunkLoadError: Loading chunk 7 failed`));
    expect(sink[0].text).toHaveLength(240);
    expect(sink[0].fatal).toBe(true);
    expect(assertRouteSummary(healthy, { consoleMessages: sink, strictTouchTargets: true })).toHaveLength(1);
  });

  it("detaches both listeners", () => {
    const page = fakePage();
    const detach = attachRuntimeMessageListeners(page, []);
    expect(page.count("console")).toBe(1);
    expect(page.count("pageerror")).toBe(1);
    detach();
    expect(page.count("console")).toBe(0);
    expect(page.count("pageerror")).toBe(0);
  });
});

describe("representative profile interaction", () => {
  function interactionPage({ opens = true, closes = true, missing = false } = {}) {
    const calls: string[] = [];
    return {
      calls,
      getByRole: (role: string, options: { name: string; exact?: boolean }) => ({
        click: async () => {
          calls.push(`click:${role}:${options.name}:${options.exact}`);
          if (missing) throw new Error("locator not found");
        },
        waitFor: async ({ state }: { state: string }) => {
          calls.push(`wait:${role}:${options.name}:${state}`);
          if ((state === "visible" && !opens) || (state === "hidden" && !closes)) throw new Error("timeout");
        },
      }),
      keyboard: { press: async (key: string) => { calls.push(`press:${key}`); } },
    };
  }

  it("applies only to the representative profile route", () => {
    expect(isProfileFeedbackInteractionRoute("/stablecoin/usdt-tether/")).toBe(true);
    expect(isProfileFeedbackInteractionRoute("/stablecoin/usdt-tether")).toBe(true);
    for (const route of ["/", "/stablecoin/usdc-circle/", "/depeg/"]) {
      expect(isProfileFeedbackInteractionRoute(route)).toBe(false);
    }
  });

  it("opens the Send Feedback dialog and requires Escape to close it without submitting", async () => {
    const page = interactionPage();
    await exerciseProfileFeedbackDialog(page);
    expect(page.calls).toEqual([
      "click:button:Report issue:true",
      "wait:dialog:Send Feedback:visible",
      "press:Escape",
      "wait:dialog:Send Feedback:hidden",
    ]);
  });

  it.each([{ missing: true }, { opens: false }, { closes: false }])("fails a missing or nonresponsive dialog (%j)", async (state) => {
    await expect(exerciseProfileFeedbackDialog(interactionPage(state))).rejects.toThrow();
  });

  it("runs the interaction before geometry capture only for the profile route", async () => {
    const order: string[] = [];
    const page = {
      ...interactionPage(),
      goto: async () => ({ status: () => 200 }),
      url: () => "https://pharos.watch/",
      waitForLoadState: async () => {},
      evaluate: async () => { order.push("evaluate"); return {}; },
    };
    const wrapped = {
      ...page,
      getByRole: (role: string, options: { name: string; exact?: boolean }) => {
        order.push("interaction");
        return page.getByRole(role, options);
      },
    };
    const base = { url: "https://pharos.watch", waitMs: 0, timeoutMs: 1000, scanTableGeometry: false, scanTouchTargets: false, viewport: { width: 390, height: 844 } };
    await captureRoute(wrapped, { ...base, route: "/stablecoin/usdt-tether/" });
    expect(order[0]).toBe("interaction");
    expect(order.at(-1)).toBe("evaluate");
    order.length = 0;
    await captureRoute(wrapped, { ...base, route: "/depeg/" });
    expect(order).toEqual(["evaluate"]);
  });
});
