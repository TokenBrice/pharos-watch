import { describe, expect, it, vi } from "vitest";
import { BUDGETS, capture, LONG_DWELL_VIEWPORT, sessionCls, VIEWPORTS, violations } from "../probe-page-performance.mjs";

describe("production performance probe", () => {
  it("covers scaled desktop widths and a real mobile DPR", () => {
    expect(VIEWPORTS).toEqual([
      { width: 1440, height: 1000, dpr: 1 }, { width: 1920, height: 960, dpr: 2 },
      { width: 2560, height: 1300, dpr: 1.5 }, { width: 3072, height: 1600, dpr: 1.25 },
      { width: 390, height: 844, dpr: 3 },
    ]);
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
  });
  it("keeps long-dwell correctness and timing failures while relaxing only cumulative budgets", () => {
    const row = { dwellMs: 1_800_000, jsonBytes: BUDGETS.jsonBytes + 1, requests: BUDGETS.requests + 1,
      v9WaitMs: BUDGETS.v9WaitMs + 1, bannerClearMs: BUDGETS.bannerClearMs + 1,
      cls: BUDGETS.cls + 0.1, bannerVisible: true, failedRequests: 2 };
    expect(violations(row)).toEqual([
      `v9WaitMs=${row.v9WaitMs} > ${BUDGETS.v9WaitMs}`,
      `bannerClearMs=${row.bannerClearMs} > ${BUDGETS.bannerClearMs}`,
      `cls=${row.cls} > ${BUDGETS.cls}`,
      "detail banner still visible at observation end (not proof of a performance defect; inspect producer health)",
      "2 JSON requests failed",
    ]);
    expect(violations({ ...row, dwellMs: 60_000 })).toHaveLength(7);
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
        "cls=0.6 > 0.5",
        "detail banner still visible at observation end (not proof of a performance defect; inspect producer health)",
        "1 JSON requests failed",
      ]);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      clock.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
