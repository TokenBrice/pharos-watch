import { describe, expect, it, vi } from "vitest";
import type { KVNamespace } from "@cloudflare/workers-types";
import type { SafetyMapContext } from "../lib/safety-map";
import { makeKV } from "./helpers/mock-kv";
import { onRequest } from "../safety-scores/map.json.ts";

function context(request: Request, env: { SELECTOR_SNAPSHOTS?: KVNamespace }): SafetyMapContext {
  return { request, env };
}

describe("GET /safety-scores/map.json", () => {
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
