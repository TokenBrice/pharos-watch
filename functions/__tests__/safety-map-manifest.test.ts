import { afterEach, describe, expect, it, vi } from "vitest";
import type { KVNamespace } from "@shared/types/cloudflare-runtime";
import type { SafetyMapContext } from "../lib/safety-map";
import { makeKV } from "./helpers/mock-kv";
import { onRequest } from "../safety-scores/map.json.ts";

function context(request: Request, env: { SELECTOR_SNAPSHOTS?: KVNamespace }): SafetyMapContext {
  return { request, env };
}

describe("GET /safety-scores/map.json", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([16_384, 16_385])("bounds valid multibyte JSON at %i bytes", async (bytes) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const kv = makeKV();
    const manifest = { padding: "é".repeat(8_000) + "x".repeat(bytes - 16_014) };
    const json = JSON.stringify(manifest);
    expect(new TextEncoder().encode(json).byteLength).toBe(bytes);
    await kv.put("safety-map:latest.json", json);
    const response = await onRequest(context(
      new Request("https://pharos.watch/safety-scores/map.json"),
      { SELECTOR_SNAPSHOTS: kv },
    ));
    expect(response.status).toBe(bytes === 16_384 ? 200 : 503);
    if (bytes === 16_384) expect(await response.json()).toEqual(manifest);
    else expect(await response.json()).toEqual({ error: "Safety map manifest is invalid" });
  });

  it("mirrors published GET headers and status for HEAD without a body", async () => {
    const kv = makeKV();
    await kv.put("safety-map:latest.json", '{"date":"2026-08-21"}');
    const get = await onRequest(context(new Request("https://pharos.watch/safety-scores/map.json"), { SELECTOR_SNAPSHOTS: kv }));
    const head = await onRequest(context(new Request("https://pharos.watch/safety-scores/map.json", { method: "HEAD" }), { SELECTOR_SNAPSHOTS: kv }));
    expect(get.status).toBe(200);
    expect(head.status).toBe(get.status);
    expect([...head.headers]).toEqual([...get.headers]);
    expect(head.body).toBeNull();
  });

  it("rejects unsupported methods with Allow", async () => {
    const response = await onRequest(context(new Request("https://pharos.watch/safety-scores/map.json", { method: "POST" }), {}));
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, HEAD");
  });

  it("returns unavailable when the binding is absent", async () => {
    const response = await onRequest(context(new Request("https://pharos.watch/safety-scores/map.json"), {}));
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it("serves the published commit marker without cache retention", async () => {
    const kv = makeKV();
    const manifest = {
      date: "2026-08-21",
      asOfSec: 1_777_000_000,
      renderedAtSec: 1_777_001_000,
      edition: "daily",
      bytes: { png: 1_234_567 },
    };
    await kv.put("safety-map:latest.json", JSON.stringify(manifest));

    const response = await onRequest(context(
      new Request("https://pharos.watch/safety-scores/map.json"),
      { SELECTOR_SNAPSHOTS: kv },
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual(manifest);
  });

  it("returns a bodyless HEAD response and 404s when unpublished", async () => {
    const response = await onRequest(context(
      new Request("https://pharos.watch/safety-scores/map.json", { method: "HEAD" }),
      { SELECTOR_SNAPSHOTS: makeKV() },
    ));

    expect(response.status).toBe(404);
    expect(response.body).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("fails closed on malformed or unavailable KV data", async () => {
    const malformed = makeKV();
    await malformed.put("safety-map:latest.json", "not-json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const malformedResponse = await onRequest(context(
      new Request("https://pharos.watch/safety-scores/map.json"),
      { SELECTOR_SNAPSHOTS: malformed },
    ));
    expect(malformedResponse.status).toBe(503);

    const unavailable = makeKV();
    unavailable.__setReadHandler(() => { throw new Error("offline"); });
    const unavailableResponse = await onRequest(context(
      new Request("https://pharos.watch/safety-scores/map.json"),
      { SELECTOR_SNAPSHOTS: unavailable },
    ));
    expect(unavailableResponse.status).toBe(503);
    warn.mockRestore();
  });
});
