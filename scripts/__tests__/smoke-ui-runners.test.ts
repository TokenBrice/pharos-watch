import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";

import { chunkOverflowRoutes, getOverflowWorkerCount, runSmokeRun, HOMEPAGE_RECENT_EVENTS_SMOKE_PATH } from "../maintenance/smoke-ui.mjs";
import { getTouchScanOutcome, ROUTE_CAPTURE_FN } from "../maintenance/smoke-mobile-ui.mjs";
import { withEnv } from "./helpers/test-state";

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
    win.getComputedStyle = (el?: Element) =>
      ({
        display: el?.getAttribute("data-display") ?? "block",
        visibility: "visible",
        opacity: "1",
        position: el?.getAttribute("data-position") ?? "static",
        overflow: el?.getAttribute("data-overflow") ?? "visible",
        overflowX: el?.getAttribute("data-overflow-x") ?? "visible",
        textOverflow: el?.getAttribute("data-text-overflow") ?? "clip",
        tableLayout: el?.getAttribute("data-table-layout") ?? "auto",
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

  it("catches wide fixed-table cell overflow and hard clipping without ellipsis, while allowing ellipsis", async () => {
    const html = `
      <table id="fixed-visible" class="table-fixed" data-table-layout="fixed" data-rect="0,0,500,80">
        <thead>
          <tr><th data-rect="0,0,120,20">Coin</th><th data-rect="120,0,260,20">Peg</th><th data-rect="260,0,400,20">MCap</th></tr>
        </thead>
        <tbody>
          <tr data-rect="0,20,500,40">
            <td data-rect="0,20,120,40">XAUT</td>
            <td id="wide-overflow" data-rect="120,20,260,40">Reference mark stale</td>
            <td data-rect="260,20,400,40">$2.66B</td>
          </tr>
        </tbody>
      </table>
      <table id="fixed-clip" class="table-fixed" data-table-layout="fixed" data-rect="0,100,500,180">
        <thead>
          <tr><th data-rect="0,100,120,120">Coin</th><th data-rect="120,100,260,120">Peg</th><th data-rect="260,100,400,120">MCap</th></tr>
        </thead>
        <tbody>
          <tr data-rect="0,120,500,140">
            <td data-rect="0,120,120,140">XAUT</td>
            <td id="clipped-no-ellipsis" data-overflow-x="hidden" data-text-overflow="clip" data-rect="120,120,260,140">Reference mark stale</td>
            <td data-rect="260,120,400,140">$2.66B</td>
          </tr>
        </tbody>
      </table>
      <table id="fixed-ellipsis" class="table-fixed" data-table-layout="fixed" data-rect="0,200,500,280">
        <thead>
          <tr><th data-rect="0,200,120,220">Coin</th><th data-rect="120,200,260,220">Peg</th><th data-rect="260,200,400,220">MCap</th></tr>
        </thead>
        <tbody>
          <tr data-rect="0,220,500,240">
            <td data-rect="0,220,120,240">XAUT</td>
            <td id="clipped-ellipsis" data-overflow-x="hidden" data-text-overflow="ellipsis" data-rect="120,220,260,240">Reference mark stale</td>
            <td data-rect="260,220,400,240">$2.66B</td>
          </tr>
        </tbody>
      </table>
      <table id="child-spill" data-rect="0,300,500,380">
        <thead>
          <tr><th data-rect="0,300,120,320">Coin</th><th data-rect="120,300,260,320">Peg</th><th data-rect="260,300,400,320">MCap</th></tr>
        </thead>
        <tbody>
          <tr data-rect="0,320,500,340">
            <td data-rect="0,320,120,340">XAUT</td>
            <td data-rect="120,320,260,340"><span data-rect="120,320,290,340">Reference mark stale</span></td>
            <td data-rect="260,320,400,340">$2.66B</td>
          </tr>
        </tbody>
      </table>`;
    const { dom, win } = makeFixture(html, { stubGeometry: true });
    win.innerWidth = 500;
    for (const id of ["wide-overflow", "clipped-no-ellipsis", "clipped-ellipsis"]) {
      const cell = win.document.getElementById(id)!;
      Object.defineProperty(cell, "clientWidth", { configurable: true, value: 140 });
      Object.defineProperty(cell, "scrollWidth", { configurable: true, value: 165 });
    }

    const summary = await runTableScan(win);
    expect(summary.tableScan.checked).toBe(4);
    expect(summary.tableScan.issues.map((issue: { kind: string; selector: string }) => [issue.kind, issue.selector])).toEqual([
      ["body-cell-text-overflow", "table#fixed-visible"],
      ["body-cell-text-overflow", "table#fixed-clip"],
      ["body-cell-text-overflow", "table#child-spill"],
    ]);
    dom.window.close();
  });

  it("enforces strict touch targets on buttons missing h-11 while respecting explicit allowlists", async () => {
    const html = `
      <button id="small-btn" class="px-2 py-1" data-rect="0,0,64,32">Filter</button>
      <div id="role-btn" role="button" tabindex="0" data-rect="0,40,64,72">Tab</div>
      <button id="allowed-btn" data-mobile-smoke-allow-small-target data-rect="0,80,32,112">Info</button>
    `;
    const { dom, win } = makeFixture(html, { stubGeometry: true });
    win.innerWidth = 390;

    const summary = await ROUTE_CAPTURE_FN({
      scanTableGeometry: false,
      scanTouchTargets: true,
      touchHardFloorPx: 24,
      touchTargetPx: 44,
      deps: { document: win.document, window: win, getComputedStyle: win.getComputedStyle },
    });

    expect(summary.touchScan.allowedSmallTargets).toBe(1);
    expect(summary.touchScan.violations).toHaveLength(2);
    expect(summary.touchScan.violations.every((entry: { strictRequired: boolean }) => entry.strictRequired === true)).toBe(true);
    expect(getTouchScanOutcome(summary.touchScan, { strictTouchTargets: true }).failCount).toBe(2);
    dom.window.close();
  });

  it("flags wide tables clipped by an overflow-x clip/hidden ancestor when no horizontal scroll viewport intervenes", async () => {
    const tableMarkup = (id: string, width: number, top: number) => `
      <table id="${id}" data-rect="0,${top},${width},${top + 80}">
        <thead>
          <tr><th data-rect="0,${top},120,${top + 20}">Coin</th><th data-rect="120,${top},240,${top + 20}">Peg</th><th data-rect="240,${top},360,${top + 20}">MCap</th></tr>
        </thead>
        <tbody>
          <tr data-rect="0,${top + 20},${width},${top + 40}">
            <td data-rect="0,${top + 20},120,${top + 40}">USDC</td>
            <td data-rect="120,${top + 20},240,${top + 40}">$1.00</td>
            <td data-rect="240,${top + 20},360,${top + 40}">$60B</td>
          </tr>
        </tbody>
      </table>`;
    const html = `
      <div id="clip-shell" data-overflow-x="clip" data-rect="0,0,1000,120">
        <div data-overflow-x="visible" data-rect="0,0,1000,120">${tableMarkup("clipped-wide", 1180, 0)}</div>
      </div>
      <div id="scroll-shell" data-overflow-x="clip" data-rect="0,150,1000,270">
        <div id="scroll-viewport" data-overflow-x="auto" data-rect="0,150,1000,270">${tableMarkup("scrolled-wide", 1180, 150)}</div>
      </div>
      <div id="fit-shell" data-overflow-x="hidden" data-rect="0,300,1000,420">
        <div data-overflow-x="visible" data-rect="0,300,1000,420">${tableMarkup("fits-clip", 960, 300)}</div>
      </div>`;
    const { dom, win } = makeFixture(html, { stubGeometry: true });
    win.innerWidth = 1024;
    for (const id of ["clip-shell", "scroll-shell", "scroll-viewport", "fit-shell"]) {
      Object.defineProperty(win.document.getElementById(id)!, "clientWidth", { configurable: true, value: 1000 });
    }
    Object.defineProperty(win.document.getElementById("scroll-viewport")!, "scrollWidth", { configurable: true, value: 1180 });
    Object.defineProperty(win.document.getElementById("clipped-wide")!, "scrollWidth", { configurable: true, value: 1180 });
    Object.defineProperty(win.document.getElementById("scrolled-wide")!, "scrollWidth", { configurable: true, value: 1180 });
    Object.defineProperty(win.document.getElementById("fits-clip")!, "scrollWidth", { configurable: true, value: 960 });

    const summary = await runTableScan(win);
    expect(summary.tableScan.checked).toBe(3);
    expect(summary.tableScan.issues.map((issue: { kind: string; selector: string }) => [issue.kind, issue.selector])).toEqual([
      ["table-clipped-by-ancestor", "table#clipped-wide"],
    ]);
    dom.window.close();
  });
});

describe("getOverflowWorkerCount", () => {
  it("allows env overrides while capping workers to six and route count", () => {
    withEnv("SMOKE_UI_OVERFLOW_WORKERS", "8", () => {
      expect(getOverflowWorkerCount("local", 11)).toBe(6);
      expect(getOverflowWorkerCount("local", 2)).toBe(2);
    });
  });
});

describe("chunkOverflowRoutes", () => {
  it("returns no chunks for empty input or disabled workers", () => {
    expect(chunkOverflowRoutes([], 2)).toEqual([]);
    expect(chunkOverflowRoutes(["/"], 0)).toEqual([]);
  });
});
