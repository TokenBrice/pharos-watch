import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  apiFetch,
  apiFetchWithMeta,
  SchemaValidationError,
  STRICT_CONTRACT_PATHS,
} from "../api";

describe("api contract validation policy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
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

  it("keeps permissive behavior on non-strict endpoint schema mismatch", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = { something: "unexpected" };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(raw), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await apiFetch("/api/daily-digest", z.object({ digest: z.string() }));

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

  it("contains all required strict paths", () => {
    expect(STRICT_CONTRACT_PATHS.has("/api/stablecoins")).toBe(true);
    expect(STRICT_CONTRACT_PATHS.has("/api/peg-summary")).toBe(true);
    expect(STRICT_CONTRACT_PATHS.has("/api/report-cards")).toBe(true);
    expect(STRICT_CONTRACT_PATHS.has("/api/dex-liquidity")).toBe(true);
    expect(STRICT_CONTRACT_PATHS.has("/api/stress-signals")).toBe(true);
    expect(STRICT_CONTRACT_PATHS.has("/api/mint-burn-flows")).toBe(true);
  });
});
