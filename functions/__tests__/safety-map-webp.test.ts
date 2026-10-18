import { describe, expect, it, vi } from "vitest";
import { onRequest } from "../safety-scores/map.webp";
import { makeKV } from "./helpers/mock-kv";

const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x04, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

function request(method = "GET"): Request {
  return new Request("https://pharos.watch/safety-scores/map.webp", { method });
}

describe("Safety map WebP teaser", () => {
  it("serves the derivative rather than the full PNG, with matching HEAD headers", async () => {
    const kv = makeKV();
    kv.__putBinary("safety-map:latest.webp", WEBP);
    const get = await onRequest({ request: request(), env: { SELECTOR_SNAPSHOTS: kv } });
    const head = await onRequest({ request: request("HEAD"), env: { SELECTOR_SNAPSHOTS: kv } });
    expect(get.status).toBe(200);
    expect(get.headers.get("Content-Type")).toBe("image/webp");
    expect(get.headers.get("Cache-Control")).toBe("public, max-age=60, s-maxage=300, stale-while-revalidate=86400");
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(WEBP);
    expect([...head.headers]).toEqual([...get.headers]);
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  it("keeps absent, empty and unreadable objects distinct", async () => {
    expect((await onRequest({ request: request(), env: {} })).status).toBe(404);
    const kv = makeKV();
    for (const bytes of [null, new Uint8Array(0)]) {
      if (bytes !== null) kv.__putBinary("safety-map:latest.webp", bytes);
      const response = await onRequest({ request: request(), env: { SELECTOR_SNAPSHOTS: kv } });
      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(kv, "get").mockRejectedValue(new Error("KV unavailable"));
    const failed = await onRequest({ request: request(), env: { SELECTOR_SNAPSHOTS: kv } });
    expect(failed.status).toBe(503);
    expect(failed.headers.get("Cache-Control")).toBe("no-store");
    warn.mockRestore();
  });

  it("rejects writes before reading KV", async () => {
    const kv = makeKV();
    const read = vi.spyOn(kv, "get");
    const response = await onRequest({ request: request("POST"), env: { SELECTOR_SNAPSHOTS: kv } });
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, HEAD");
    expect(read).not.toHaveBeenCalled();
  });
});
