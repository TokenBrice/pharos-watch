import { describe, expect, it, vi } from "vitest";
import type { SafetyMapContext, SafetyMapEnv } from "../lib/safety-map";
import { makeKV, type TestKVNamespace } from "./helpers/mock-kv";
import { onRequest } from "../safety-scores/map.png.ts";

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);

function mapRequest(search = "", method = "GET"): Request {
  return new Request(`https://pharos.watch/safety-scores/map.png${search}`, { method });
}

function mapContext(request: Request, env: SafetyMapEnv): SafetyMapContext {
  return { request, env };
}

function seededKv(entries: Record<string, Uint8Array> = {}): TestKVNamespace {
  const kv = makeKV();
  for (const [key, bytes] of Object.entries(entries)) {
    kv.__putBinary(key, bytes);
  }
  return kv;
}

describe("GET /safety-scores/map.png", () => {
  it("serves the published poster with a short edge TTL and a long grace window", async () => {
    const kv = seededKv({ "safety-map:latest.png": PNG_MAGIC });

    const response = await onRequest(mapContext(mapRequest(), { SELECTOR_SNAPSHOTS: kv }));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=60, s-maxage=300, stale-while-revalidate=86400",
    );
    expect(response.headers.get("Cache-Control")).toContain("stale-while-revalidate");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_MAGIC);
  });

  it("serves a dated archive immutably from the prefixed key", async () => {
    const kv = seededKv({ "safety-map:2026-08-21.png": PNG_MAGIC });

    const response = await onRequest(
      mapContext(mapRequest("?date=2026-08-21"), { SELECTOR_SNAPSHOTS: kv }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, s-maxage=31536000, immutable",
    );
  });

  it("404s with no-store when the object is missing, so the kill switch trips the digest", async () => {
    const response = await onRequest(mapContext(mapRequest(), { SELECTOR_SNAPSHOTS: seededKv() }));

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
  });

  it("404s with no-store when a dated archive was never published", async () => {
    const kv = seededKv({ "safety-map:latest.png": PNG_MAGIC });

    const response = await onRequest(
      mapContext(mapRequest("?date=2020-01-01"), { SELECTOR_SNAPSHOTS: kv }),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("treats a zero-byte object as unpublished rather than serving an empty image", async () => {
    const kv = seededKv({ "safety-map:latest.png": new Uint8Array(0) });

    const response = await onRequest(mapContext(mapRequest(), { SELECTOR_SNAPSHOTS: kv }));

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("404s with no-store when the namespace is not bound", async () => {
    const response = await onRequest(mapContext(mapRequest(), {}));

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it.each([
    ["2026-8-21", "unpadded month"],
    ["2026-08-21.png", "key suffix supplied by the caller"],
    ["../latest", "traversal attempt"],
    ["", "empty value"],
    ["2026-08-21 ", "trailing whitespace"],
  ])("rejects a malformed date (%s) without touching KV", async (date) => {
    const kv = seededKv({ "safety-map:latest.png": PNG_MAGIC });
    const getSpy = vi.spyOn(kv, "get");

    const response = await onRequest(
      mapContext(
        mapRequest(`?date=${encodeURIComponent(date)}`),
        { SELECTOR_SNAPSHOTS: kv },
      ),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(getSpy).not.toHaveBeenCalled();
  });

  it("never enumerates the namespace", async () => {
    const kv = seededKv({ "safety-map:latest.png": PNG_MAGIC });
    const listSpy = vi.spyOn(kv, "list");

    await onRequest(mapContext(mapRequest(), { SELECTOR_SNAPSHOTS: kv }));

    expect(listSpy).not.toHaveBeenCalled();
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "rejects %s with an Allow header",
    async (method) => {
      const kv = seededKv({ "safety-map:latest.png": PNG_MAGIC });

      const response = await onRequest(
        mapContext(mapRequest("", method), { SELECTOR_SNAPSHOTS: kv }),
      );

      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET, HEAD");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    },
  );

  // Social platforms routinely probe an image URL with HEAD before fetching it,
  // so HEAD answers exactly as GET does, minus the body.
  describe("HEAD", () => {
    it("mirrors the GET headers for the published poster without a body", async () => {
      const kv = seededKv({ "safety-map:latest.png": PNG_MAGIC });

      const response = await onRequest(
        mapContext(mapRequest("", "HEAD"), { SELECTOR_SNAPSHOTS: kv }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("image/png");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("Cache-Control")).toBe(
        "public, max-age=60, s-maxage=300, stale-while-revalidate=86400",
      );
      expect(response.headers.get("Content-Length")).toBe(String(PNG_MAGIC.byteLength));
      expect(response.body).toBeNull();
      expect((await response.arrayBuffer()).byteLength).toBe(0);
    });

    it("404s with no-store when the object is absent", async () => {
      const response = await onRequest(
        mapContext(mapRequest("", "HEAD"), { SELECTOR_SNAPSHOTS: seededKv() }),
      );

      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.body).toBeNull();
    });

    it("400s with no-store on a malformed date", async () => {
      const kv = seededKv({ "safety-map:latest.png": PNG_MAGIC });
      const getSpy = vi.spyOn(kv, "get");

      const response = await onRequest(
        mapContext(mapRequest("?date=2026-8-21", "HEAD"), { SELECTOR_SNAPSHOTS: kv }),
      );

      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.body).toBeNull();
      expect(getSpy).not.toHaveBeenCalled();
    });
  });

  it("reports a KV read failure as a transient 503 instead of throwing", async () => {
    const kv = seededKv();
    kv.__setReadHandler(() => {
      throw new Error("kv unavailable");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await onRequest(mapContext(mapRequest(), { SELECTOR_SNAPSHOTS: kv }));

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
