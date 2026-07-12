import { afterEach, describe, expect, it, vi } from "vitest";
import { assertAllFetchRoutesUsed, mockFetch, mockFetchStrict } from "../__shared/mock-fetch";

describe("mockFetch helper", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps ordinary routes reusable while tracking request history", async () => {
    const fetchSpy = mockFetch([
      { match: "api.example.test/prices", body: { ok: true } },
    ]);

    const res = await fetch("https://api.example.test/prices?ids=usdt");
    const repeat = await fetch("https://api.example.test/prices?ids=usdt");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await repeat.json()).toEqual({ ok: true });
    expect(fetchSpy.getHistory()).toEqual([
      { url: "https://api.example.test/prices?ids=usdt", method: "GET", headers: {}, body: null },
      { url: "https://api.example.test/prices?ids=usdt", method: "GET", headers: {}, body: null },
    ]);
    expect(() => fetchSpy.assertAllRoutesUsed()).not.toThrow();
  });

  it("canonicalizes Request and init details in request history", async () => {
    const fetchSpy = mockFetch([{ match: "api.example.test/submit", body: { ok: true } }]);
    const request = new Request("https://api.example.test/submit", {
      method: "POST",
      headers: { "X-Original": "discarded" },
      body: "original body",
    });

    await fetch(request, {
      method: "PATCH",
      headers: [["X-Zebra", "z"], ["A-Alpha", "a"]],
      body: '{"replayed":true}',
    });

    const history = fetchSpy.getHistory();
    expect(history).toEqual([{
      url: "https://api.example.test/submit",
      method: "PATCH",
      headers: { "a-alpha": "a", "content-type": "text/plain;charset=UTF-8", "x-zebra": "z" },
      body: '{"replayed":true}',
    }]);
    expect(Object.keys(history[0]!.headers)).toEqual(["a-alpha", "content-type", "x-zebra"]);
  });

  it("throws on unexpected URLs when requireMatch is enabled", async () => {
    mockFetch([], { requireMatch: true });

    await expect(fetch("https://api.example.test/missing")).rejects.toThrow(
      "mockFetch: no match for URL: https://api.example.test/missing",
    );
  });

  it("supports exact URL matching in strictUrl mode", async () => {
    const fetchSpy = mockFetchStrict([
      { match: "https://api.example.test/prices?ids=usdt", body: { exact: true } },
    ]);

    const res = await fetch("https://api.example.test/prices?ids=usdt");
    expect(await res.json()).toEqual({ exact: true });

    await expect(fetch("https://api.example.test/prices?ids=usdc")).rejects.toThrow(
      "mockFetch: no match for URL: https://api.example.test/prices?ids=usdc",
    );
    expect(fetchSpy.getHistory()).toEqual([
      { url: "https://api.example.test/prices?ids=usdt", method: "GET", headers: {}, body: null },
      { url: "https://api.example.test/prices?ids=usdc", method: "GET", headers: {}, body: null },
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

  it("can create a strict spy without stubbing global fetch", async () => {
    const fetchSpy = mockFetchStrict([
      { match: "https://api.example.test/prices", body: { exact: true } },
    ], { stubGlobal: false });

    const res = await fetchSpy("https://api.example.test/prices");

    expect(await res.json()).toEqual({ exact: true });
    expect(() => assertAllFetchRoutesUsed(fetchSpy)).not.toThrow();
  });

  it("replays scripted responses in order and fails when they are exhausted", async () => {
    const fetchSpy = mockFetch([{
      match: "api.example.test/retry",
      outcomes: [
        { body: { retry: true }, status: 503, headers: { "Retry-After": "1" } },
        { body: { ok: true } },
      ],
    }]);

    const first = await fetch("https://api.example.test/retry");
    const second = await fetch("https://api.example.test/retry");

    expect(first.status).toBe(503);
    expect(first.headers.get("Retry-After")).toBe("1");
    expect(await second.json()).toEqual({ ok: true });
    await expect(fetch("https://api.example.test/retry")).rejects.toThrow(
      "mockFetch: scripted outcomes exhausted for route match: api.example.test/retry (configured 2)",
    );
    expect(() => fetchSpy.assertAllOutcomesUsed()).not.toThrow();
  });

  it("replays network errors", async () => {
    const networkFailure = new TypeError("socket reset");
    const fetchSpy = mockFetch([{
      match: "api.example.test/network",
      outcomes: [networkFailure],
    }]);

    await expect(fetch("https://api.example.test/network")).rejects.toBe(networkFailure);
    expect(() => fetchSpy.assertAllOutcomesUsed()).not.toThrow();
  });

  it("stalls until the request signal aborts", async () => {
    const originalController = new AbortController();
    const effectiveController = new AbortController();
    const fetchSpy = mockFetch([{
      match: "api.example.test/stall",
      outcomes: [{ stall: true }],
    }]);

    const pending = fetch(
      new Request("https://api.example.test/stall", { signal: originalController.signal }),
      { signal: effectiveController.signal },
    );
    effectiveController.abort(new DOMException("test abort", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "test abort" });
    expect(() => fetchSpy.assertAllOutcomesUsed()).not.toThrow();
  });

  it("reports unused scripted outcomes by route", async () => {
    const fetchSpy = mockFetch([{
      match: "api.example.test/unused-outcomes",
      outcomes: [{ body: { first: true } }, { body: { second: true } }],
    }]);

    await fetch("https://api.example.test/unused-outcomes");

    expect(() => fetchSpy.assertAllOutcomesUsed()).toThrow(
      "mockFetch: unused scripted outcome(s): api.example.test/unused-outcomes (1 remaining)",
    );
  });
});
