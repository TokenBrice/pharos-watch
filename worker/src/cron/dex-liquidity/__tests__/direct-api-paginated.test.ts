import { afterEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("runPaginatedDirectApiFetch", () => {
  afterEach(() => {
    mockFetch.mockReset();
    vi.resetModules();
  });

  it("collects rows from multiple pages and stops on short page", async () => {
    const { runPaginatedDirectApiFetch } = await import("../direct-api-paginated");
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ items: ["a", "b"] }))
      .mockResolvedValueOnce(jsonResponse({ items: ["c"] }));

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
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ items: ["a", "b"] }))
      .mockResolvedValueOnce(new Response("error", { status: 503 }));

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
  });

  it("reports error and breaks on JSON parse failure", async () => {
    const { runPaginatedDirectApiFetch } = await import("../direct-api-paginated");
    mockFetch.mockResolvedValueOnce(new Response("{bad-json", { status: 200 }));

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
    mockFetch.mockResolvedValueOnce(jsonResponse({ items: ["valid", 42, "also-valid"] }));

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
    mockFetch.mockImplementation(() =>
      Promise.resolve(jsonResponse({ items: ["a", "b"] })),
    );

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
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("reports error when parsePage returns null (invalid root shape)", async () => {
    const { runPaginatedDirectApiFetch } = await import("../direct-api-paginated");
    mockFetch.mockResolvedValueOnce(jsonResponse({ unexpected: "shape" }));

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
    mockFetch.mockRejectedValueOnce(new Error("network timeout"));

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
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ items: ["a", "b"] }))
      .mockResolvedValueOnce(jsonResponse({ items: [] }));

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
});
