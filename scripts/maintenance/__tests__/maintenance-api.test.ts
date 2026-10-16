import { afterEach, describe, expect, it, vi } from "vitest";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { API_ORIGIN } from "@shared/lib/runtime-origins";
import type { ReportCardsV9CurrentResponse } from "@shared/types/report-cards-v9";
import type {
  PegSummaryResponse,
  StablecoinListResponse,
  StressSignalsAllResponse,
} from "@shared/types/market";
import {
  buildCurrentMap,
  extractFindings,
  fetchJson,
  type Current,
} from "../build-ai-summary-staleness-candidates";
import { buildMaintenanceApiRequest } from "../../lib/maintenance-api";

function makeCurrent(overrides: Partial<Current> = {}): Current {
  return {
    name: "Test Coin",
    symbol: "TEST",
    overallGrade: null,
    overallScore: null,
    pegGrade: null,
    pegScore: null,
    backingGrade: null,
    backingScore: null,
    exitGrade: null,
    exitScore: null,
    controlGrade: null,
    controlScore: null,
    dewsBand: null,
    dewsScore: null,
    depegCount: null,
    weakestPillar: null,
    ...overrides,
  };
}

describe("maintenance API access", () => {
  it("builds an authenticated request to the public API", () => {
    const request = buildMaintenanceApiRequest(API_PATHS.reportCardsV9(), "test-api-key");

    expect(request).toEqual({
      url: `${API_ORIGIN}/api/report-cards/v9`,
      headers: {
        accept: "application/json",
        "X-API-Key": "test-api-key",
      },
    });
    expect(request.headers).not.toHaveProperty("Origin");
  });

  it("rejects live requests without an API credential", () => {
    expect(() => buildMaintenanceApiRequest(API_PATHS.events(), "  ")).toThrow(
      "PHAROS_API_KEY is required",
    );
  });
});

describe("AI summary V9 current-value projection", () => {

  it("does not turn a missing current grade into a not-rated mismatch", () => {
    expect(extractFindings("NR overall grade", makeCurrent())).toEqual([]);
    expect(extractFindings("NR at 42", makeCurrent({ overallGrade: "A", overallScore: 42 }))).toEqual([
      { kind: "overall-grade", claim: "NR at 42", claimed: "NR", current: "A", severity: "high" },
    ]);
  });


  it("joins supply buckets and zero-valued metrics by card ID, ignoring unrelated rows", () => {
    const cards = ["audit-zero", "audit-other"].map((id) => ({
      id, grade: "F", score: 0,
      pillars: { backing: { score: 0 }, exit: { score: 0 }, control: { score: 0 } },
    })) as unknown as ReportCardsV9CurrentResponse["cards"];
    const peg = [
      { id: "audit-other", name: "Other", symbol: "OTHER", pegScore: 90, eventCount: 9 },
      { id: "unrelated", name: "Unrelated", symbol: "NO", pegScore: 99, eventCount: 99 },
      { id: "audit-zero", name: "Zero", symbol: "ZERO", pegScore: 0, eventCount: 0 },
    ] as unknown as PegSummaryResponse["coins"];
    const stress = {
      unrelated: { band: "DANGER", score: 99 },
      "audit-other": { band: "WATCH", score: 25 },
      "audit-zero": { band: "CALM", score: 0 },
    } as unknown as StressSignalsAllResponse["signals"];
    const supply = [
      { id: "unrelated", circulating: { peggedUSD: 999 } },
      { id: "audit-other", circulating: { peggedUSD: 11 } },
      { id: "audit-zero", circulating: { peggedUSD: 100, peggedEUR: 25 } },
    ] as unknown as StablecoinListResponse["peggedAssets"];
    const result = buildCurrentMap(cards, stress, peg, supply);
    expect([...result.keys()]).toEqual(["audit-zero", "audit-other"]);
    expect(result.get("audit-zero")).toEqual(makeCurrent({
      name: "Zero", symbol: "ZERO", overallGrade: "F", overallScore: 0,
      pegGrade: "F", pegScore: 0, backingGrade: "F", backingScore: 0,
      exitGrade: "F", exitScore: 0, controlGrade: "F", controlScore: 0,
      dewsBand: "CALM", dewsScore: 0, depegCount: 0, circulatingUsd: 125,
    }));
    expect(result.get("audit-other")).toMatchObject({
      name: "Other", symbol: "OTHER", pegScore: 90, depegCount: 9,
      dewsBand: "WATCH", dewsScore: 25, circulatingUsd: 11,
    });
  });

  it("falls back to card identity and null optional metrics when joins are missing", () => {
    const cards = [{
      id: "audit-missing", grade: "F", score: 0,
      pillars: { backing: { score: 0 }, exit: { score: 0 }, control: { score: 0 } },
    }] as unknown as ReportCardsV9CurrentResponse["cards"];
    expect(buildCurrentMap(cards, {}, []).get("audit-missing")).toEqual(makeCurrent({
      name: "audit-missing", symbol: "", overallGrade: "F", overallScore: 0,
      backingGrade: "F", backingScore: 0, exitGrade: "F", exitScore: 0,
      controlGrade: "F", controlScore: 0,
      circulatingUsd: null,
    }));
  });
  it("keeps unavailable circulation out of numeric drift but preserves observed-zero drift", () => {
    const cards = [{ id: "audit-supply", grade: "F", score: 0,
      pillars: { backing: { score: 0 }, exit: { score: 0 }, control: { score: 0 } },
    }] as unknown as ReportCardsV9CurrentResponse["cards"];
    for (const circulating of [{}, { peggedUSD: 0 }]) {
      const supply = [{ id: "audit-supply", circulating }] as unknown as StablecoinListResponse["peggedAssets"];
      const current = buildCurrentMap(cards, {}, [], supply).get("audit-supply")!;
      expect(current.circulatingUsd).toBe("peggedUSD" in circulating ? 0 : null);
      const findings = extractFindings("$20M in circulation", current);
      expect(findings.some((finding) => finding.kind === "volatile-dollar-claim")).toBe(true);
      expect(findings.some((finding) => finding.kind === "cross-chain-circulation-drift")).toBe("peggedUSD" in circulating);
    }
  });

});

describe("AI candidate body deadlines", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  const endpoint = { apiPath: "/api/test", fixtureName: "test" };

  it.each([true, false])("aborts a stalled body at exactly 30 seconds (ok=%s)", async (ok) => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      signal = init.signal;
      const body = () => {
        const { promise, reject } = Promise.withResolvers<unknown>();
        signal!.addEventListener("abort", () => reject(new Error("body aborted")), { once: true });
        return promise;
      };
      return { ok, status: ok ? 200 : 503, json: body, text: body };
    }));
    const result = fetchJson(endpoint, "fixture");
    const settled = vi.fn();
    void result.then(settled, settled);
    const rejected = expect(result).rejects.toThrow("body aborted");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(signal?.aborted).toBe(false);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns parsed success and rejects HTTP errors and malformed JSON", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const responses = [
      Response.json({ success: true }),
      new Response("unavailable", { status: 503 }),
      new Response("invalid"),
    ];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      signals.push(init.signal);
      return responses.shift();
    }));
    await expect(fetchJson(endpoint, "fixture")).resolves.toEqual({ success: true });
    await expect(fetchJson(endpoint, "fixture")).rejects.toThrow("GET /api/test -> 503 unavailable");
    await expect(fetchJson(endpoint, "fixture")).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(30_001);
    expect(signals.map((signal) => signal.aborted)).toEqual([false, false, false]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
