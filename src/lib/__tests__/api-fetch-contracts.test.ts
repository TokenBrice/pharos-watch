import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { StablecoinChartResponseSchema, StablecoinReservesResponseSchema } from "@shared/types";
import { ReportCardsResponseSchema } from "@shared/types/report-cards";
import { PHAROS_WEB_ACCEPT_MARKER } from "@shared/lib/request-source-marker";
import {
  apiRequest,
  apiFetch,
  apiFetchWithMeta,
  ApiFetchError,
  buildRequestUrl,
  DEFAULT_API_REQUEST_TIMEOUT_MS,
  fetchStablecoinReserves,
  resolveApiBase,
  SchemaValidationError,
} from "../api";

describe("api contract validation policy", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("throws SchemaValidationError on strict endpoint schema mismatch", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await expect(
      apiFetch("/api/stablecoins", z.object({ peggedAssets: z.array(z.object({ id: z.string() })) }))
    ).rejects.toBeInstanceOf(SchemaValidationError);
  });

  it("returns parsed data on strict endpoint when schema matches", async () => {
    const body = { summary: null, coins: [] };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await apiFetch(
      "/api/peg-summary",
      z.object({ summary: z.null(), coins: z.array(z.unknown()) })
    );

    expect(result).toEqual(body);
  });

  it("returns raw successful payloads when no schema is provided", async () => {
    const body = { ok: true, count: 2 };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(apiFetch("/api/custom")).resolves.toEqual(body);
  });

  it("throws on schema mismatch by default whenever a schema is provided", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ something: "unexpected" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await expect(
      apiFetch("/api/daily-digest", z.object({ digest: z.string() }))
    ).rejects.toBeInstanceOf(SchemaValidationError);
  });

  it("keeps permissive behavior only when warn mode is explicit", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = { something: "unexpected" };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(raw), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await apiFetch(
      "/api/daily-digest",
      z.object({ digest: z.string() }),
      undefined,
      "warn",
    );

    expect(result).toEqual(raw);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("throws on strict endpoint mismatch in apiFetchWithMeta", async () => {
    const bodyWithMeta = {
      _meta: { updatedAt: 100, ageSeconds: 10, status: "fresh" },
      wrong: true,
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(bodyWithMeta), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await expect(
      apiFetchWithMeta("/api/stablecoins", z.object({ peggedAssets: z.array(z.unknown()) }))
    ).rejects.toBeInstanceOf(SchemaValidationError);
  });

  it("returns meta + parsed data on strict endpoint when valid", async () => {
    const bodyWithMeta = {
      _meta: { updatedAt: 200, ageSeconds: 20, status: "degraded" },
      summary: null,
      coins: [],
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(bodyWithMeta), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await apiFetchWithMeta(
      "/api/peg-summary",
      z.object({ summary: z.null(), coins: z.array(z.unknown()) })
    );

    expect(result.data).toEqual({ summary: null, coins: [] });
    expect(result.meta).toEqual({ updatedAt: 200, ageSeconds: 20, status: "degraded" });
  });

  it("preserves optional report-card live reserve telemetry in the shared schema", () => {
    const parsed = ReportCardsResponseSchema.parse({
      cards: [],
      dependencyGraph: { edges: [{ from: "usdc-circle", to: "usde-ethena", weight: 0.9, type: "collateral" }] },
      methodology: {
        version: "7.13",
        weights: { pegStability: 0, liquidity: 0.3, resilience: 0.2, decentralization: 0.15, dependencyRisk: 0.25 },
        pegMultiplierExponent: 0.4,
        thresholds: [{ grade: "A+", min: 87 }],
      },
      updatedAt: 1771977600,
      collateralDriftCoins: [{ id: "jupusd-jupiter", liveScore: 80, curatedScore: 65, delta: 15 }],
      liveToFallbackCoins: ["usdaf-asymmetry"],
    });

    expect(parsed.collateralDriftCoins).toEqual([{ id: "jupusd-jupiter", liveScore: 80, curatedScore: 65, delta: 15 }]);
    expect(parsed.liveToFallbackCoins).toEqual(["usdaf-asymmetry"]);
  });

  it("validates stablecoin chart points before chart consumers use them", () => {
    expect(StablecoinChartResponseSchema.parse([
      { date: 1771977600, totalCirculatingUSD: { peggedUSD: 1, peggedEUR: 2 } },
    ])).toEqual([
      { date: 1771977600, totalCirculatingUSD: { peggedUSD: 1, peggedEUR: 2 } },
    ]);

    expect(() => StablecoinChartResponseSchema.parse([
      { date: "1771977600", totalCirculatingUSD: { peggedUSD: 1 } },
    ])).toThrow();
  });

  it("parses valid stablecoin reserve payloads with open metadata details", () => {
    const parsed = StablecoinReservesResponseSchema.parse({
      stablecoinId: "iusd-infinifi",
      mode: "live",
      reserves: [{ name: "Test Farm", pct: 100, risk: "low" }],
      estimated: false,
      liveAt: 1_761_235_200,
      source: "infinifi",
      displayUrl: "https://example.com/reserves",
      evidenceUrls: ["https://example.com/proof"],
      displayBadge: { kind: "live", label: "Live" },
      metadata: {
        freshnessMode: "not-applicable",
        yieldBasisCollateralPct: 89.7,
        adapterSpecificField: { retained: true },
        details: {
          nestedAdapterTelemetry: { retained: true },
        },
        redemption: {
          capacityUsd: 1000,
          routeStatus: "open",
          adapterSpecificRedemptionField: "retained",
        },
      },
      provenance: {
        evidenceClass: "independent",
        sourceModel: "dynamic-mix",
        freshnessMode: "not-applicable",
        scoringEligible: true,
      },
      sync: {
        enabled: true,
        status: "ok",
        stale: false,
        bootstrap: false,
        lastAttemptedAt: 1_761_235_200,
        lastSuccessAt: 1_761_235_200,
      },
    });

    expect(parsed.metadata?.details).toEqual({
      nestedAdapterTelemetry: { retained: true },
    });
    expect(parsed.metadata?.adapterSpecificField).toEqual({ retained: true });
    expect(parsed.metadata?.redemption?.adapterSpecificRedemptionField).toBe("retained");
  });

  it("resolves production API base from known hostnames when env is empty", () => {
    expect(resolveApiBase("pharos.watch", "")).toBe("https://api.pharos.watch");
    expect(resolveApiBase("c0e7dcc0.stablecoin-dashboard.pages.dev", "")).toBe("https://api.pharos.watch");
  });

  it("keeps localhost-style hosts on relative /api paths when env is empty", () => {
    expect(resolveApiBase("localhost", "")).toBe("");
    expect(resolveApiBase("127.0.0.1", "")).toBe("");
  });

  it("prefers explicit env API base over hostname inference", () => {
    expect(resolveApiBase("pharos.watch", "https://custom.example")).toBe("https://custom.example");
  });

  it("routes browser data requests through same-origin site-data on the site and ops hosts", () => {
    vi.stubGlobal("window", { location: { hostname: "pharos.watch" } });
    expect(buildRequestUrl("/api/stablecoins")).toBe("/_site-data/stablecoins");
    expect(buildRequestUrl("/api/public-status-history")).toBe("/_site-data/public-status-history");
    expect(buildRequestUrl("/api/telegram-pulse")).toBe("/_site-data/telegram-pulse");

    vi.stubGlobal("window", { location: { hostname: "ops.pharos.watch" } });
    expect(buildRequestUrl("/api/stablecoins")).toBe("/_site-data/stablecoins");
    expect(buildRequestUrl("/api/public-status-history")).toBe("/_site-data/public-status-history");
    expect(buildRequestUrl("/api/telegram-pulse")).toBe("/_site-data/telegram-pulse");
  });

  it("keeps admin and explicit-base requests off the site-data proxy", () => {
    vi.stubGlobal("window", { location: { hostname: "pharos.watch" } });
    expect(buildRequestUrl("/api/admin/status")).toBe("/api/admin/status");
    expect(resolveApiBase("pharos.watch", "https://custom.example")).toBe("https://custom.example");
  });

  it("adds the Pharos browser Accept marker for browser-side public API requests", async () => {
    vi.stubGlobal("window", { location: { hostname: "pharos.watch" } });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await apiFetch("/api/stablecoins", z.object({ ok: z.boolean() }), undefined, "warn");

    const [, init] = fetchSpy.mock.calls[0] ?? [];
    const headers = new Headers((init as RequestInit | undefined)?.headers);
    expect(headers.get("Accept")).toContain(PHAROS_WEB_ACCEPT_MARKER);
  });

  it("propagates caller-provided AbortSignal through the shared request helper", async () => {
    vi.stubGlobal("window", { location: { hostname: "pharos.watch" } });
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason ?? new DOMException("caller aborted", "AbortError"));
        });
      })
    ));
    const controller = new AbortController();

    const requestPromise = apiRequest("/api/stablecoins", { signal: controller.signal });
    const rejection = expect(requestPromise).rejects.toMatchObject({
      name: "AbortError",
      message: "caller aborted",
    });
    controller.abort(new DOMException("caller aborted", "AbortError"));
    await vi.runAllTimersAsync();

    await rejection;
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("applies the default shared API timeout when callers do not provide one", async () => {
    vi.stubGlobal("window", { location: { hostname: "pharos.watch" } });
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason ?? new DOMException("timed out", "TimeoutError"));
        });
      })
    ));

    const requestPromise = apiRequest("/api/stablecoins");
    const rejection = expect(requestPromise).rejects.toMatchObject({
      name: "TimeoutError",
      message: `API request timed out after ${DEFAULT_API_REQUEST_TIMEOUT_MS}ms`,
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_API_REQUEST_TIMEOUT_MS);

    await rejection;
  });

  it("allows callers to override the shared timeout through apiFetch options", async () => {
    vi.stubGlobal("window", { location: { hostname: "pharos.watch" } });
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason ?? new DOMException("timed out", "TimeoutError"));
        });
      })
    ));

    const requestPromise = apiFetch("/api/stablecoins", undefined, undefined, undefined, { timeoutMs: 250 });
    const rejection = expect(requestPromise).rejects.toMatchObject({
      name: "TimeoutError",
      message: "API request timed out after 250ms",
    });
    await vi.advanceTimersByTimeAsync(250);

    await rejection;
  });

  it("throws ApiFetchError with status on non-OK responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "nope" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      })
    );

    await expect(apiFetch("/api/stablecoins")).rejects.toBeInstanceOf(ApiFetchError);
  });

  it("returns null for 404 when nullOn404 is true", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("Not found", { status: 404 }));
    const result = await apiFetch("/api/stablecoin-reserves/test", undefined, undefined, undefined, { nullOn404: true });
    expect(result).toBeNull();
  });

  it("fetchStablecoinReserves inherits the shared null-on-404 behavior", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("Not found", { status: 404 }));
    const result = await fetchStablecoinReserves("usdc-circle");
    expect(result).toBeNull();
  });

  it("fetchStablecoinReserves validates successful reserve responses", async () => {
    const body = {
      stablecoinId: "iusd-infinifi",
      mode: "live",
      reserves: [{ name: "Test Farm", pct: 100, risk: "low" }],
      estimated: false,
      provenance: {
        evidenceClass: "independent",
        sourceModel: "dynamic-mix",
        scoringEligible: true,
      },
    };
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(fetchStablecoinReserves("iusd-infinifi")).resolves.toEqual(body);
  });

  it("fetchStablecoinReserves throws SchemaValidationError on malformed 200 payloads", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        stablecoinId: "iusd-infinifi",
        mode: "live",
        reserves: [{ name: "Test Farm", pct: "100", risk: "low" }],
        estimated: false,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(fetchStablecoinReserves("iusd-infinifi")).rejects.toBeInstanceOf(SchemaValidationError);
  });

  it("still throws on 404 when nullOn404 is not set", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("Not found", { status: 404 }));
    await expect(apiFetch("/api/stablecoin-reserves/test")).rejects.toThrow(ApiFetchError);
  });

  it("captures Warning header in apiFetchWithMeta", async () => {
    // age 11000s with maxAge 900s → ratio 12.2 → stale (> FRESHNESS_RATIOS.DEGRADED)
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Data-Age": "11000",
          "Warning": '110 - "Response is stale (11000s old, max 900s)"',
        },
      })
    );

    const result = await apiFetchWithMeta("/api/daily-digest", z.object({ ok: z.boolean() }), undefined, 900, "warn");
    expect(result.meta?.warning).toContain("Response is stale");
    expect(result.meta?.status).toBe("stale");
  });

  it("creates degraded meta from a freshness warning even without age metadata", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          Warning: '110 - "Response is degraded"',
        },
      }),
    );

    const result = await apiFetchWithMeta(
      "/api/daily-digest",
      z.object({ ok: z.boolean() }),
      undefined,
      900,
      "warn",
    );

    expect(result.meta).toMatchObject({
      ageSeconds: 0,
      status: "degraded",
      warning: '110 - "Response is degraded"',
    });
  });

  it("downgrades fresh _meta to degraded when a Warning header is present", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({
        _meta: {
          updatedAt: 200,
          ageSeconds: 20,
          status: "fresh",
          dependencies: {
            reportCards: {
              updatedAt: 100,
              ageSeconds: 120,
              status: "stale",
              reason: "stale cache",
            },
          },
        },
        ok: true,
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          Warning: '110 - "Response is degraded (20s old, max 600s)"',
        },
      })
    );

    const result = await apiFetchWithMeta(
      "/api/chains",
      z.object({ ok: z.boolean() }),
      undefined,
      600,
      "warn",
    );

    expect(result.meta).toEqual({
      updatedAt: 200,
      ageSeconds: 20,
      status: "degraded",
      warning: '110 - "Response is degraded (20s old, max 600s)"',
      dependencies: {
        reportCards: {
          updatedAt: 100,
          ageSeconds: 120,
          status: "stale",
          reason: "stale cache",
        },
      },
    });
  });

  it("keeps fresh _meta fresh for non-freshness advisory warnings", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({
        _meta: { updatedAt: 200, ageSeconds: 20, status: "fresh" },
        ok: true,
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          Warning: '199 - "Latest sync-dex-liquidity run shows medium quality drift"',
        },
      })
    );

    const result = await apiFetchWithMeta(
      "/api/dex-liquidity",
      z.object({ ok: z.boolean() }),
      undefined,
      3600,
      "warn",
    );

    expect(result.meta).toEqual({
      updatedAt: 200,
      ageSeconds: 20,
      status: "fresh",
      warning: '199 - "Latest sync-dex-liquidity run shows medium quality drift"',
    });
  });

  it("uses the caller-provided maxAgeSec when deriving freshness from X-Data-Age", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Data-Age": "1122",
        },
      })
    );

    const result = await apiFetchWithMeta(
      "/api/dex-liquidity",
      z.object({ ok: z.boolean() }),
      undefined,
      1800,
    );
    expect(result.meta?.status).toBe("fresh");
    expect(result.meta?.ageSeconds).toBe(1122);
  });
});
