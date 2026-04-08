import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { PHAROS_WEB_ACCEPT_MARKER } from "@shared/lib/request-source-marker";
import {
  apiFetch,
  apiFetchWithMeta,
  ApiFetchError,
  buildRequestUrl,
  resolveApiBase,
  SchemaValidationError,
} from "../api";

describe("api contract validation policy", () => {
  afterEach(() => {
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
