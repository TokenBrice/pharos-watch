import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";

import { runSmokeRun, HOMEPAGE_RECENT_EVENTS_SMOKE_PATH } from "../maintenance/smoke-ui.mjs";
import { ROUTE_CAPTURE_FN } from "../maintenance/smoke-mobile-ui.mjs";

function makeFixture(html: string, { stubGeometry = false } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: "https://example.com" });
  const win = dom.window;

  // The homepage capture calls these only on its unrevealed-table path; keep
  // them inert so the empty-table control exercises the loop without jsdom's
  // "not implemented" navigation stubs.
  win.scrollTo = () => undefined;
  win.setTimeout = ((handler: () => void) => {
    handler();
    return 0;
  }) as typeof win.setTimeout;

  if (stubGeometry) {
    // jsdom reports zero-size rects and empty computed styles; give the table
    // scan real geometry so visibility/overlap/intersection checks are meaningful.
    win.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
      const raw = this.getAttribute("data-rect");
      if (!raw) {
        return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } as DOMRect;
      }
      const [left, top, right, bottom] = raw.split(",").map(Number);
      return {
        left,
        top,
        right,
        bottom,
        width: right - left,
        height: bottom - top,
      } as DOMRect;
    };
    win.getComputedStyle = () =>
      ({
        display: "block",
        visibility: "visible",
        opacity: "1",
        position: "static",
        overflow: "visible",
        overflowX: "visible",
        marginLeft: "0px",
        marginRight: "0px",
      }) as CSSStyleDeclaration;
  }

  const page = {
    // The homepage runner passes its capture callback and an argument object;
    // the callback reads document/window/fetch/setTimeout from that object's
    // `deps` field, so it can run from Node against the jsdom fixture.
    async evaluate<T, R>(fn: (arg: T) => R, arg: T): Promise<R> {
      return fn(arg);
    },
    async goto() {
      return null;
    },
    async waitForTimeout() {
      return null;
    },
    async setViewportSize() {
      return null;
    },
  };

  return { dom, page, win };
}

const HOME_CONFIG = {
  baseUrl: "https://example.com",
  expectedGaId: null,
  mobileHeight: 844,
  mobileWidth: 390,
  overflowRetryExtraWaitMs: 2000,
  overflowSampleIntervalMs: 350,
  overflowSettleSamples: 4,
  overflowWaitMs: 2000,
  routes: [],
  skipOverflow: false,
  styleReadyTimeoutMs: 4000,
  uiRetryCount: 0,
  uiRetryDelayMs: 0,
  waitTimeoutMs: 40,
};

const ROW_HTML = `<table><tbody><tr><td>USDT Tether</td></tr></tbody></table>`;

function homepageDeps(win: Window) {
  return { document: win.document, window: win, fetch: win.fetch, setTimeout: win.setTimeout };
}

function makeEventsFetch(win: Window, body: string) {
  const requestedUrls: string[] = [];
  win.fetch = (async (input: RequestInfo | URL) => {
    requestedUrls.push(String(input));
    return {
      ok: true,
      status: 200,
      async text() {
        return body;
      },
    };
  }) as unknown as typeof fetch;
  return requestedUrls;
}

describe("smoke-ui homepage runner", () => {
  it("captures a valid recent-events payload with count and ok state", async () => {
    const { dom, page, win } = makeFixture(ROW_HTML);
    const requestedUrls = makeEventsFetch(win, JSON.stringify({ events: [{ id: "a" }, { id: "b" }] }));

    const result = await runSmokeRun(page as never, HOME_CONFIG as never, homepageDeps(win) as never);

    expect(requestedUrls).toEqual([HOMEPAGE_RECENT_EVENTS_SMOKE_PATH]);
    expect(result.homepage?.timedOut).toBe(false);
    expect(result.homepage?.rows).toBe(1);
    expect(result.homepage?.recentEvents).toMatchObject({
      ok: true,
      status: 200,
      count: 2,
      error: null,
    });
    dom.window.close();
  });

  it("reports invalid JSON as a failed events contract", async () => {
    const { dom, page, win } = makeFixture(ROW_HTML);
    makeEventsFetch(win, "not-json{");

    const result = await runSmokeRun(page as never, HOME_CONFIG as never, homepageDeps(win) as never);

    expect(result.homepage?.recentEvents).toMatchObject({
      ok: false,
      status: 200,
      count: null,
      error: "invalid JSON",
    });
    dom.window.close();
  });

  it("reports a payload missing the events array as a failed contract", async () => {
    const { dom, page, win } = makeFixture(ROW_HTML);
    makeEventsFetch(win, JSON.stringify({ other: true }));

    const result = await runSmokeRun(page as never, HOME_CONFIG as never, homepageDeps(win) as never);

    expect(result.homepage?.recentEvents).toMatchObject({
      ok: false,
      status: 200,
      count: null,
      error: "missing events[]",
    });
    dom.window.close();
  });

  it("waits for a real row instead of reporting one that never appears", async () => {
    const { dom, page, win } = makeFixture(`<table><tbody></tbody></table>`);
    makeEventsFetch(win, JSON.stringify({ events: [] }));

    const result = await runSmokeRun(page as never, HOME_CONFIG as never, homepageDeps(win) as never);

    expect(result.homepage?.timedOut).toBe(true);
    expect(result.homepage?.rows).toBe(0);
    dom.window.close();
  });
});

describe("smoke-mobile-ui table scan", () => {
  const SKELETON_ROW = `<tr data-slot="skeleton"><td data-rect="0,0,100,20"></td></tr>`;

  const overlappingTable = (bodyRows: string) => `
    <div class="sr-only">
      <table data-rect="0,0,500,120">
        <thead>
          <tr><th data-rect="0,0,90,20">Hidden A</th><th data-rect="80,0,170,20">Hidden B</th><th data-rect="160,0,250,20">Hidden C</th></tr>
        </thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>
    <table id="visible" data-rect="0,0,500,120">
      <thead>
        <tr><th data-rect="0,0,90,20">Market cap</th><th data-rect="80,0,170,20">Peg</th><th data-rect="160,0,250,20">Reserves</th></tr>
      </thead>
      <tbody>${bodyRows}</tbody>
    </table>`;

  const runTableScan = (win: Window) =>
    ROUTE_CAPTURE_FN({
      scanTableGeometry: true,
      scanTouchTargets: false,
      touchHardFloorPx: 24,
      touchTargetPx: 44,
      deps: { document: win.document, window: win, getComputedStyle: win.getComputedStyle },
    });

  it("treats a skeleton-only table as unmeasurable and skips it", async () => {
    const { dom, win } = makeFixture(overlappingTable(SKELETON_ROW), { stubGeometry: true });
    win.innerWidth = 390;

    const summary = await runTableScan(win);

    expect(summary.tableScan.checked).toBe(0);
    expect(summary.tableScan.issues).toEqual([]);
    dom.window.close();
  });

  it("detects overlapping headers once real rows replace the skeleton, excluding sr-only tables", async () => {
    const { dom, win } = makeFixture(overlappingTable(SKELETON_ROW), { stubGeometry: true });
    win.innerWidth = 390;

    // Replace the skeleton-only tbody of both tables with a real data row: the
    // visible table becomes measurable while the sr-only wrapper stays excluded.
    for (const tbody of Array.from(win.document.querySelectorAll("tbody"))) {
      tbody.innerHTML = `<tr data-rect="0,20,500,40"><td data-rect="0,20,90,40">USDT</td><td data-rect="80,20,170,40">1.00</td><td data-rect="160,20,250,40">over</td></tr>`;
    }

    const summary = await runTableScan(win);

    expect(summary.tableScan.checked).toBe(1);
    expect(summary.tableScan.issues).toHaveLength(1);
    expect(summary.tableScan.issues[0].kind).toBe("header-overlap");
    expect(summary.tableScan.issues[0].selector).toContain("visible");
    dom.window.close();
  });
});
