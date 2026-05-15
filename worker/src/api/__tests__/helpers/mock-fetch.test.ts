import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "../../../test-helpers/__shared/mock-fetch";

describe("mockFetch helper", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("tracks request history and route usage", async () => {
    const fetchSpy = mockFetch([
      { match: "api.example.test/prices", body: { ok: true } },
    ]);

    const res = await fetch("https://api.example.test/prices?ids=usdt");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fetchSpy.getHistory()).toEqual([{ url: "https://api.example.test/prices?ids=usdt" }]);
    expect(() => fetchSpy.assertAllRoutesUsed()).not.toThrow();
  });

  it("throws on unexpected URLs when requireMatch is enabled", async () => {
    mockFetch([], { requireMatch: true });

    await expect(fetch("https://api.example.test/missing")).rejects.toThrow(
      "mockFetch: no match for URL: https://api.example.test/missing",
    );
  });

  it("supports exact URL matching in strictUrl mode", async () => {
    const fetchSpy = mockFetch([
      { match: "https://api.example.test/prices?ids=usdt", body: { exact: true } },
    ], { strictUrl: true, requireMatch: true });

    const res = await fetch("https://api.example.test/prices?ids=usdt");
    expect(await res.json()).toEqual({ exact: true });

    await expect(fetch("https://api.example.test/prices?ids=usdc")).rejects.toThrow(
      "mockFetch: no match for URL: https://api.example.test/prices?ids=usdc",
    );
    expect(fetchSpy.getHistory()).toEqual([
      { url: "https://api.example.test/prices?ids=usdt" },
      { url: "https://api.example.test/prices?ids=usdc" },
    ]);
  });

  it("reports unused configured routes", () => {
    const fetchSpy = mockFetch([
      { match: "api.example.test/unused", body: {} },
    ]);

    expect(() => fetchSpy.assertAllRoutesUsed()).toThrow(
      "mockFetch: unused route match(es): api.example.test/unused",
    );
  });
});
