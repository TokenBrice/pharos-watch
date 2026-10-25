import { describe, expect, it, vi } from "vitest";
import { BUDGETS, capture, LONG_DWELL_VIEWPORT, MOBILE_ONLY_ROUTES, sessionCls, VIEWPORTS, violations } from "../probe-page-performance.mjs";

describe("production performance probe", () => {
  it("covers scaled desktop widths and a real mobile DPR", () => {
    expect(VIEWPORTS).toEqual([
      { width: 1440, height: 1000, dpr: 1 }, { width: 1920, height: 960, dpr: 2 },
      { width: 2560, height: 1300, dpr: 1.5 }, { width: 3072, height: 1600, dpr: 1.25 },
      { width: 390, height: 844, dpr: 3 },
    ]);
    expect(MOBILE_ONLY_ROUTES).toEqual(["/depeg/", "/safety-scores/", "/stablecoins/"]);
    expect(BUDGETS.clsMobile).toBe(0.10);
    expect(BUDGETS.cls).toBe(0.5);
  });
  it("uses largest CLS session instead of summing a long dwell", () => {
    expect(sessionCls([{ time: 100, value: 0.1 }, { time: 800, value: 0.1 }, { time: 3000, value: 0.15 }])).toBeCloseTo(0.2);
    expect(sessionCls(Array.from({ length: 8 }, (_, i) => ({ time: i * 900, value: 0.1 })))).toBeCloseTo(0.6);
    expect(sessionCls([{ time: 100, value: 0.1 }, { time: 1100, value: 0.2 }])).toBeCloseTo(0.2);
    expect(sessionCls(Array.from({ length: 7 }, (_, i) => ({ time: 100 + i * 900, value: 0.1 })))).toBeCloseTo(0.6);
    expect(sessionCls([])).toBe(0);
  });
  it("keeps unobserved V9 and banner timings nullable without inventing a pass/fresh claim", () => {
    const row = { jsonBytes: 0, requests: 1, v9WaitMs: null, bannerClearMs: null, cls: 0, bannerVisible: false, failedRequests: 0 };
    expect(violations(row)).toEqual([]);
    expect(violations({ ...row, requests: BUDGETS.requests + 1 })).toContain(`requests=${BUDGETS.requests + 1} > ${BUDGETS.requests}`);
    expect(violations({ ...row, bannerVisible: true })[0]).toContain("inspect producer health");
    expect(violations({ ...row, failedRequests: 1 })).toContain("1 JSON requests failed");
    expect(violations({ ...row, viewport: VIEWPORTS[4], cls: 0.12,
      clsConfirmation: { ...row, cls: 0.05, violations: ["1 JSON requests failed"] } })).toEqual(["CLS re-capture: 1 JSON requests failed"]);
  });
  it("keeps long-dwell correctness and timing failures while relaxing only cumulative budgets", () => {
    const row = { dwellMs: 1_800_000, jsonBytes: BUDGETS.jsonBytes + 1, requests: BUDGETS.requests + 1,
      v9WaitMs: BUDGETS.v9WaitMs + 1, bannerClearMs: BUDGETS.bannerClearMs + 1,
      cls: BUDGETS.cls + 0.1, bannerVisible: true, failedRequests: 2 };
    expect(violations(row)).toEqual([
      `v9WaitMs=${row.v9WaitMs} > ${BUDGETS.v9WaitMs}`,
      `bannerClearMs=${row.bannerClearMs} > ${BUDGETS.bannerClearMs}`,
      "detail banner still visible at observation end (not proof of a performance defect; inspect producer health)",
      "2 JSON requests failed",
    ]);
    expect(violations({ ...row, dwellMs: 60_000 })).toHaveLength(6);
    expect(violations({ ...row, bannerVisible: false })).toContain(`cls=${row.cls} > ${BUDGETS.cls}`);
    expect(violations({ ...row, v9WaitMs: null, bannerClearMs: null, cls: 0,
      bannerVisible: false, failedRequests: 0 })).toEqual([]);
  });
  it("runs long dwell in the tall scaled-desktop lane that admits rankings", () => {
    expect(LONG_DWELL_VIEWPORT).toEqual({ width: 3072, height: 1600, dpr: 1.25 });
  });
  it("retains correctness violations in the completed long-dwell capture result", async () => {
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.stubGlobal("window", { __pharosPerf: {
      shifts: [{ time: 100, value: 0.6 }], bannerClearAt: null, bannerSeenAt: 10, bannerVisible: true,
    } });
    const listeners = new Map<string, (event: object) => void>();
    const cdp = {
      on: (name: string, listener: (event: object) => void) => listeners.set(name, listener),
      send: async () => ({ metrics: [{ name: "JSHeapUsedSize", value: 1000 }] }),
    };
    const page = {
      goto: async () => {
        listeners.get("Network.requestWillBeSent")!({
          requestId: "poll", request: { url: "https://pharos.watch/_site-data/stablecoins" }, timestamp: 1,
        });
        listeners.get("Network.responseReceived")!({
          requestId: "poll", response: { mimeType: "application/json", status: 503 }, timestamp: 2,
        });
        listeners.get("Network.dataReceived")!({ requestId: "poll", dataLength: BUDGETS.jsonBytes + 1 });
        listeners.get("Network.loadingFinished")!({ requestId: "poll", timestamp: 3 });
        return { status: () => 200 };
      },
      waitForTimeout: async (ms: number) => { now += ms; },
      evaluate: async (evaluate: () => unknown) => evaluate(),
    };
    const close = vi.fn();
    const browser = { newContext: async () => ({
      addInitScript: async () => {}, newPage: async () => page, newCDPSession: async () => cdp, close,
    }) };
    try {
      const row = await capture(browser, "https://pharos.watch", "/", LONG_DWELL_VIEWPORT, 61_000);
      expect(row.jsonBytes).toBe(BUDGETS.jsonBytes + 1);
      expect(row.violations).toEqual([
        "detail banner still visible at observation end (not proof of a performance defect; inspect producer health)",
        "1 JSON requests failed",
      ]);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      clock.mockRestore();
      vi.unstubAllGlobals();
    }
  });
  it.each([
    { name: "confirms a repeated mobile breach once", mobile: true, cls: 0.12, confirmation: 0.13, banner: false, confirmBanner: false, failsCls: true },
    { name: "accepts a clean mobile confirmation", mobile: true, cls: 0.12, confirmation: 0.05, banner: false, confirmBanner: false, failsCls: false },
    { name: "keeps confirmation producer failures without blaming CLS", mobile: true, cls: 0.12, confirmation: 0.13, banner: false, confirmBanner: true, failsCls: false },
    { name: "accepts the mobile boundary without re-capturing", mobile: true, cls: 0.10, confirmation: null, banner: false, confirmBanner: false, failsCls: false },
    { name: "keeps sub-tripwire desktop CLS without re-capturing", mobile: false, cls: 0.12, confirmation: null, banner: false, confirmBanner: false, failsCls: false },
    { name: "keeps the desktop tripwire without re-capturing", mobile: false, cls: 0.6, confirmation: null, banner: false, confirmBanner: false, failsCls: true },
    { name: "keeps initial producer failures without blaming CLS or re-capturing", mobile: true, cls: 0.6, confirmation: null, banner: true, confirmBanner: false, failsCls: false },
  ])("$name", async ({ mobile, cls, confirmation, banner, confirmBanner, failsCls }) => {
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const close = vi.fn();
    const newContext = vi.fn(async () => {
      const second = newContext.mock.calls.length === 2;
      if (second) expect(close).toHaveBeenCalledTimes(1);
      vi.stubGlobal("window", { __pharosPerf: {
        shifts: [{ time: 100, value: second ? confirmation : cls }],
        bannerClearAt: null, bannerSeenAt: null, bannerVisible: second ? confirmBanner : banner,
      } });
      return {
        addInitScript: async () => {}, close,
        newPage: async () => ({
          goto: async () => ({ status: () => 200 }),
          waitForTimeout: async (ms: number) => { now += ms; },
          evaluate: async (evaluate: () => unknown) => evaluate(),
        }),
        newCDPSession: async () => ({ on: () => {}, send: async () => ({ metrics: [] }) }),
      };
    });
    try {
      const viewport = mobile ? VIEWPORTS[4] : VIEWPORTS[0];
      const row = await capture({ newContext }, "https://pharos.watch", "/", viewport, 30_000);
      expect(newContext).toHaveBeenCalledTimes(confirmation === null ? 1 : 2);
      expect(close).toHaveBeenCalledTimes(newContext.mock.calls.length);
      expect(row.cls).toBe(cls);
      expect(row.clsConfirmation?.cls ?? null).toBe(confirmation);
      expect(row.violations.some((failure: string) => failure.startsWith("cls"))).toBe(failsCls);
      expect(row.violations.some((failure: string) => failure.includes("inspect producer health"))).toBe(banner || confirmBanner);
      if (confirmation !== null && failsCls) expect(row.violations).toContain(`clsMobile=${cls} (re-capture ${confirmation}) > 0.1`);
      expect(row.clsConfirmation?.clsConfirmation).toBeUndefined();
    } finally {
      clock.mockRestore();
      vi.unstubAllGlobals();
    }
  });
  it.each([0, 100])("requires a rendered banner before attributing CLS to producer health (height %s)", async (height) => {
    const perfWindow = { __pharosPerf: { bannerVisible: false } };
    vi.stubGlobal("window", perfWindow);
    vi.stubGlobal("document", { body: {}, querySelectorAll: () => [{
      getAttribute: () => "stale", getBoundingClientRect: () => ({ height }),
    }] });
    vi.stubGlobal("PerformanceObserver", class { observe() {} });
    vi.stubGlobal("setInterval", (observe: () => void) => observe());
    const browser = { newContext: async () => ({
      addInitScript: async (install: () => void) => install(), close: async () => {},
      newPage: async () => ({
        goto: async () => ({ status: () => 200 }), waitForTimeout: async () => {},
        evaluate: async (evaluate: () => unknown) => evaluate(),
      }),
      newCDPSession: async () => ({ on: () => {}, send: async () => ({ metrics: [] }) }),
    }) };
    try {
      const row = await capture(browser, "https://pharos.watch", "/", VIEWPORTS[4], 0);
      expect(row.bannerVisible).toBe(height > 0);
      expect(row.violations.some((failure: string) => failure.includes("inspect producer health"))).toBe(height > 0);
    } finally { vi.unstubAllGlobals(); }
  });
});
