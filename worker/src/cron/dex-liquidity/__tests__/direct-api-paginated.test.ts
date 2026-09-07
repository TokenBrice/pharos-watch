import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "@shared/test-utils/mock-fetch";

function nonOkStreamingResponse(status = 503): { response: Response; cancel: ReturnType<typeof vi.fn> } {
  const cancel = vi.fn(async () => undefined);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("upstream error"));
    },
    cancel,
  });
  return { response: new Response(stream, { status }), cancel };
}

describe("runPaginatedDirectApiFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("collects rows from multiple pages and stops on short page", async () => {
    const { runPaginatedDirectApiFetch } = await import("../direct-api-paginated");
    mockFetch([{
      match: "api.example.com",
      outcomes: [
        { body: { items: ["a", "b"] } },
        { body: { items: ["c"] } },
      ],
    }], { requireMatch: true });

    const result = await runPaginatedDirectApiFetch<string>({
      source: "test",
      buildUrl: (page) => `https://api.example.com?page=${page}`,
      pageSize: 2,
      parsePage: (body) => {
        const b = body as Record<string, unknown>;
        return Array.isArray(b.items) ? b.items : null;
      },
      mapRow: (raw) => (typeof raw === "string" ? raw : null),
    });

    expect(result.rows).toEqual(["a", "b", "c"]);
    expect(result.errors).toEqual([]);
    expect(result.successfulPages).toBe(2);
  });

  it("returns first page rows and an error on HTTP failure mid-pagination", async () => {
    const { runPaginatedDirectApiFetch } = await import("../direct-api-paginated");
    const failure = nonOkStreamingResponse(503);
    mockFetch([{
      match: "api.example.com",
      outcomes: [
        { body: { items: ["a", "b"] } },
        { response: failure.response },
      ],
    }], { requireMatch: true });

    const result = await runPaginatedDirectApiFetch<string>({
      source: "test",
      buildUrl: (page) => `https://api.example.com?page=${page}`,
      pageSize: 2,
      parsePage: (body) => {
        const b = body as Record<string, unknown>;
        return Array.isArray(b.items) ? b.items : null;
      },
      mapRow: (raw) => (typeof raw === "string" ? raw : null),
    });

    expect(result.rows).toEqual(["a", "b"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("returned 503");
    expect(result.successfulPages).toBe(1);
    expect(failure.cancel).toHaveBeenCalledTimes(1);
  });

  it("reports error and breaks on JSON parse failure", async () => {
    const { runPaginatedDirectApiFetch } = await import("../direct-api-paginated");
    mockFetch([{
      match: "api.example.com",
      outcomes: [{ body: "{bad-json" }],
    }], { requireMatch: true });

    const result = await runPaginatedDirectApiFetch<string>({
      source: "test",
      buildUrl: (page) => `https://api.example.com?page=${page}`,
      pageSize: 10,
      parsePage: (body) => {
        const b = body as Record<string, unknown>;
        return Array.isArray(b.items) ? b.items : null;
      },
      mapRow: (raw) => (typeof raw === "string" ? raw : null),
    });

    expect(result.rows).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("invalid JSON");
    expect(result.successfulPages).toBe(0);
  });

  it("skips malformed rows while preserving valid ones", async () => {
    const { runPaginatedDirectApiFetch } = await import("../direct-api-paginated");
    mockFetch([{
      match: "api.example.com",
      body: { items: ["valid", 42, "also-valid"] },
    }], { requireMatch: true });

    const result = await runPaginatedDirectApiFetch<string>({
      source: "test",
      buildUrl: (page) => `https://api.example.com?page=${page}`,
      pageSize: 10,
      parsePage: (body) => {
        const b = body as Record<string, unknown>;
        return Array.isArray(b.items) ? b.items : null;
      },
      mapRow: (raw) => (typeof raw === "string" ? raw : null),
    });

    expect(result.rows).toEqual(["valid", "also-valid"]);
    expect(result.errors).toEqual([]);
    expect(result.successfulPages).toBe(1);
  });

  it("stops at maxPages cap", async () => {
    const { runPaginatedDirectApiFetch } = await import("../direct-api-paginated");
    const fetchSpy = mockFetch([{
      match: "api.example.com",
      body: { items: ["a", "b"] },
    }], { requireMatch: true });

    const result = await runPaginatedDirectApiFetch<string>({
      source: "test",
      buildUrl: (page) => `https://api.example.com?page=${page}`,
      pageSize: 2,
      maxPages: 3,
      parsePage: (body) => {
        const b = body as Record<string, unknown>;
        return Array.isArray(b.items) ? b.items : null;
      },
      mapRow: (raw) => (typeof raw === "string" ? raw : null),
    });

    expect(result.successfulPages).toBe(3);
    expect(result.rows).toHaveLength(6);
    expect(result.completed).toBe(false);
    expect(result.nextPage).toBe(4);
    expect(result.errors).toEqual(["test pagination cap reached at page 3; resumeFromPage=4"]);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("reports error when parsePage returns null (invalid root shape)", async () => {
    const { runPaginatedDirectApiFetch } = await import("../direct-api-paginated");
    mockFetch([{
      match: "api.example.com",
      body: { unexpected: "shape" },
    }], { requireMatch: true });

    const result = await runPaginatedDirectApiFetch<string>({
      source: "test",
      buildUrl: (page) => `https://api.example.com?page=${page}`,
      pageSize: 10,
      parsePage: (body) => {
        const b = body as Record<string, unknown>;
        return Array.isArray(b.items) ? b.items : null;
      },
      mapRow: (raw) => (typeof raw === "string" ? raw : null),
    });

    expect(result.rows).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("invalid root shape");
    expect(result.successfulPages).toBe(0);
  });

  it("reports error on network fetch failure", async () => {
    const { runPaginatedDirectApiFetch } = await import("../direct-api-paginated");
    mockFetch([{
      match: "api.example.com",
      outcomes: [new Error("network timeout")],
    }], { requireMatch: true });

    const result = await runPaginatedDirectApiFetch<string>({
      source: "test",
      buildUrl: (page) => `https://api.example.com?page=${page}`,
      pageSize: 10,
      parsePage: () => [],
      mapRow: (raw) => (typeof raw === "string" ? raw : null),
    });

    expect(result.rows).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("request failed");
    expect(result.errors[0]).toContain("network timeout");
    expect(result.successfulPages).toBe(0);
  });

  it("stops on empty page without error", async () => {
    const { runPaginatedDirectApiFetch } = await import("../direct-api-paginated");
    mockFetch([{
      match: "api.example.com",
      outcomes: [
        { body: { items: ["a", "b"] } },
        { body: { items: [] } },
      ],
    }], { requireMatch: true });

    const result = await runPaginatedDirectApiFetch<string>({
      source: "test",
      buildUrl: (page) => `https://api.example.com?page=${page}`,
      pageSize: 2,
      parsePage: (body) => {
        const b = body as Record<string, unknown>;
        return Array.isArray(b.items) ? b.items : null;
      },
      mapRow: (raw) => (typeof raw === "string" ? raw : null),
    });

    expect(result.rows).toEqual(["a", "b"]);
    expect(result.errors).toEqual([]);
    expect(result.successfulPages).toBe(2);
  });

  it("builds page-dependent POST requests while retaining shared headers and signals", async () => {
    const { runPaginatedDirectApiFetch } = await import("../direct-api-paginated");
    const fetchSpy = mockFetch([{
      match: "api.example.com",
      body: { items: ["a"] },
    }], { requireMatch: true });

    const result = await runPaginatedDirectApiFetch<string>({
      source: "test",
      buildRequest: (page) => ({
        url: "https://api.example.com/graphql",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ page }),
        },
      }),
      pageSize: 10,
      parsePage: (body) => {
        const b = body as Record<string, unknown>;
        return Array.isArray(b.items) ? b.items : null;
      },
      mapRow: (raw) => (typeof raw === "string" ? raw : null),
    });

    expect(result.rows).toEqual(["a"]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": expect.any(String),
      },
      body: '{"page":1}',
      signal: expect.any(AbortSignal),
    });
  });
});
