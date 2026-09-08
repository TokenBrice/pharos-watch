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
  extractSummaryFindings,
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
  it("uses the current report-card pillars and peg-summary identity", () => {
    const cards = [{
      id: "usdt-tether",
      grade: "B+",
      score: 75,
      pillars: {
        backing: { score: 85 },
        exit: { score: 55 },
        control: { score: 45 },
      },
    }] as unknown as ReportCardsV9CurrentResponse["cards"];
    const stress = {
      "usdt-tether": { band: "WATCH", score: 23 },
    } as unknown as StressSignalsAllResponse["signals"];
    const peg = [{
      id: "usdt-tether",
      name: "Wrong fallback name",
      symbol: "WRONG",
      pegScore: 92,
      eventCount: 8,
    }] as unknown as PegSummaryResponse["coins"];

    expect(buildCurrentMap(cards, stress, peg).get("usdt-tether")).toEqual({
      name: "Tether",
      symbol: "USDT",
      overallGrade: "B+",
      overallScore: 75,
      pegGrade: "A+",
      pegScore: 92,
      backingGrade: "A",
      backingScore: 85,
      exitGrade: "C",
      exitScore: 55,
      controlGrade: "D",
      controlScore: 45,
      dewsBand: "WATCH",
      dewsScore: 23,
      depegCount: 8,
    });
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
    }));
  });

  it("prioritizes base-letter and modifier grade changes differently for overall and pillars", () => {
    for (const [currentGrade, overallSeverity, pillarSeverity] of [
      ["A", "medium", "low"], ["B", "high", "medium"],
    ] as const) {
      const current = makeCurrent({ overallGrade: currentGrade, backingGrade: currentGrade });
      expect(extractFindings("A- safety grade.", current)).toEqual([
        expect.objectContaining({ kind: "overall-grade", claimed: "A-", current: currentGrade, severity: overallSeverity }),
      ]);
      expect(extractFindings("backing grade of A-.", current)).toEqual([
        expect.objectContaining({ kind: "backing-grade", claimed: "A-", current: currentGrade, severity: pillarSeverity }),
      ]);
    }
  });

  it("applies absolute score thresholds with matching and missing-value controls", () => {
    for (const [currentScore, severity] of [
      [80, null], [82.99, null], [77, "low"], [85, "medium"], [null, null],
    ] as const) {
      const current = makeCurrent({
        overallScore: currentScore, backingScore: currentScore, pegScore: currentScore,
      });
      for (const [text, kind] of [
        ["A safety grade at 80", "overall-score"],
        ["backing score is 80", "backing-score"],
        ["peg score of 80", "peg-score"],
      ]) {
        expect(extractFindings(text, current)).toEqual(severity ? [
          expect.objectContaining({ kind, claimed: "80", current: String(currentScore), severity }),
        ] : []);
      }
    }
  });

  it("compares DEWS bands case-insensitively and parses word-form depeg counts including zero", () => {
    const current = makeCurrent({ dewsBand: "WATCH", dewsScore: 10, depegCount: 0 });
    expect(extractFindings("DEWS reads Watch. Zero depeg events.", current)).toEqual([]);
    expect(extractFindings("DEWS at 15 in the Calm band. Four depeg events.", current)).toEqual([
      expect.objectContaining({ kind: "dews-band", claimed: "calm", current: "WATCH", severity: "high" }),
      expect.objectContaining({ kind: "dews-score", claimed: "15", current: "10", severity: "medium" }),
      expect.objectContaining({ kind: "depeg-count", claimed: "4", current: "0", severity: "medium" }),
    ]);
  });

  it("queues circulation drift at ten and fifty percent but never compares TVL to supply", () => {
    const current = makeCurrent({ circulatingUsd: 1000 });
    for (const [amount, severity] of [[901, null], [900, "medium"], [1500, "high"]] as const) {
      const findings = extractFindings(`$${amount} in circulation`, current);
      expect(findings).toEqual([
        expect.objectContaining({ kind: "volatile-dollar-claim", claimed: String(amount), severity: "medium" }),
        ...(severity ? [expect.objectContaining({
          kind: "cross-chain-circulation-drift", claimed: String(amount), current: "1000", severity,
        })] : []),
      ]);
    }
    expect(extractFindings("$500 TVL", current)).toEqual([
      expect.objectContaining({ kind: "volatile-dollar-claim", claimed: "500", severity: "medium" }),
    ]);
  });

  it("ignores lowercase articles, preserves signed grades, and deduplicates equivalent claims", () => {
    const current = makeCurrent({ overallGrade: "B", backingGrade: "B" });
    expect(extractFindings("It has a safety grade and a backing strategy.", current)).toEqual([]);
    expect(extractFindings("A- safety grade. Safety grade of A-. A- safety grade.", current)).toEqual([
      expect.objectContaining({ kind: "overall-grade", claimed: "A-", current: "B", severity: "high" }),
    ]);
    expect(extractFindings("B safety grade.", current)).toEqual([]);
    expect(extractFindings("A- safety grade.", makeCurrent())).toEqual([]);
  });

  it("compares V9 pillar claims and flags retired V8 dimension vocabulary", () => {
    const current = makeCurrent({
      overallGrade: "B+",
      overallScore: 75,
      pegGrade: "A+",
      pegScore: 92,
      backingGrade: "A",
      backingScore: 85,
      exitGrade: "C",
      exitScore: 55,
      controlGrade: "D",
      controlScore: 45,
      dewsBand: "WATCH",
      dewsScore: 23,
      depegCount: 8,
    });

    const findings = extractFindings(
      "It has an A safety grade at 90, backing grade of B, exit grade of A, " +
        "economic control grade of C, dependency risk grade of D. Its old Safety Score liquidity score of 72 is stale.",
      current,
    );

    expect(findings.map((finding) => finding.kind)).toEqual(expect.arrayContaining([
      "overall-grade",
      "overall-score",
      "backing-grade",
      "exit-grade",
      "control-grade",
      "legacy-dependency-grade",
      "legacy-liquidity-score",
    ]));
    expect(findings.filter((finding) => finding.kind.startsWith("legacy-"))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ current: "retired in Safety Score v9", severity: "medium" }),
      ]),
    );
  });

  it.each([
    "Its DEX liquidity score is 80.",
    "Its liquidity score is 80.",
    "Its DEX liquidity grade of A remains strong.",
    "Its liquidity grade of A remains strong.",
    "Safety Score v8 had other pillars. Its DEX liquidity score is 80.",
  ])("does not declare a current or ambiguous liquidity claim retired: %s", (text) => {
    const findings = extractFindings(text, makeCurrent());
    expect(findings).toEqual([expect.objectContaining({ current: expect.stringContaining("manual dated/source review"), severity: "low" })]);
    expect(findings.some((finding) => finding.current.includes("retired"))).toBe(false);
  });

  it.each(["Safety Score v8 liquidity score is 80.", "Its old Safety Score liquidity grade of A was strong."])(
    "keeps explicit legacy liquidity claims actionable: %s", (text) => {
      expect(extractFindings(text, makeCurrent())).toEqual([
        expect.objectContaining({ current: "retired in Safety Score v9", severity: "medium" }),
      ]);
    },
  );

  it("queues volatile adoption, cross-chain drift, holder scope, and financing comparisons", () => {
    const current = makeCurrent({
      name: "Flying Tulip USD",
      symbol: "ftUSD",
      circulatingUsd: 1_075_731,
    });
    const oldFtUsd = "Flying Tulip raised $225M and the stablecoin has roughly $730K in circulation from 20 holders, a ratio of venture capital to actual usage.";

    const findings = extractFindings(oldFtUsd, current);
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "volatile-dollar-claim", severity: "medium" }),
      expect.objectContaining({ kind: "cross-chain-circulation-drift", severity: "medium" }),
      expect.objectContaining({ kind: "holder-address-scope", severity: "medium" }),
      expect.objectContaining({ kind: "financing-to-product-scale", severity: "high" }),
    ]));

    expect(
      extractFindings("Deposited assets are owned by the strategy, holders receive no priority claim.", current),
    ).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "holder-address-scope" }),
    ]));
    expect(
      extractFindings("The ERC-20 holder's claim runs through KMS Labs first.", current),
    ).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "holder-address-scope" }),
    ]));
  });

  it("auto-closes tokenised value drift but queues source-registration changes", () => {
    const current = makeCurrent({
      overallGrade: "B+",
      overallScore: 75,
    });
    const tokenised = {
      text: "The current safety grade is {{grade}}.",
      claimTokens: [{
        token: "grade" as const,
        placeholder: "{{grade}}" as const,
        source: "report-card.grade" as const,
        factsAsOf: "2026-09-01",
      }],
    };

    expect(extractSummaryFindings(tokenised, current)).toEqual([]);
    expect(extractSummaryFindings({
      ...tokenised,
      claimTokens: [{
        ...tokenised.claimTokens[0],
        source: "stablecoin.circulating-usd" as unknown as "report-card.grade",
      }],
    }, current)).toEqual([
      expect.objectContaining({ kind: "claim-token-evidence", claimed: "wrong-registration" }),
      expect.objectContaining({ kind: "claim-token-evidence", claimed: "unregistered-placeholder" }),
    ]);
    expect(extractSummaryFindings({
      ...tokenised,
      text: "The current safety grade is {{grade}}, but dependency risk grade of D remains.",
    }, current)).toEqual([
      expect.objectContaining({ kind: "legacy-dependency-grade" }),
    ]);
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
