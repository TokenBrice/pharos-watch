import { describe, expect, it } from "vitest";
import {
  cacheControlForDegradedPayload,
  errorResponse,
  jsonFreshDegradedResponse,
  jsonFreshResponse,
  jsonResponse,
  jsonResponseWithHeaders,
  methodNotAllowedResponse,
  noStoreResponse,
  respondWithFreshSnapshot,
  withResponseHeaders,
} from "../api-response";

describe("errorResponse", () => {
  it("returns JSON error with given status", async () => {
    const res = errorResponse(400, "Bad request");
    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const body = await res.json();
    expect(body).toEqual({ error: "Bad request" });
  });

  it("returns 503 for service unavailable", async () => {
    const res = errorResponse(503, "Data not yet available");
    expect(res.status).toBe(503);
  });
});

describe("jsonResponse", () => {
  it("returns JSON with default headers", async () => {
    const res = jsonResponse({ ok: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it("merges custom headers through the explicit headers form", async () => {
    const res = jsonResponseWithHeaders({ ok: true }, { "Cache-Control": "no-store" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });

  it("does not mistake a header record key for an option", async () => {
    // The retired options-sniffing signature read this record as options and
    // dropped every header while setting status 503.
    const res = jsonResponseWithHeaders({ ok: true }, { status: "503", headers: "x", noStore: "1" });
    expect(res.status).toBe(200);
    expect(res.headers.get("status")).toBe("503");
    expect(res.headers.get("headers")).toBe("x");
    expect(res.headers.get("noStore")).toBe("1");
  });

  it("supports status, no-store, and Retry-After options", async () => {
    const res = jsonResponse({ ok: true }, {
      status: 202,
      noStore: true,
      retryAfterSec: 3,
    });

    expect(res.status).toBe(202);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Retry-After")).toBe("3");
  });
});

describe("response header helpers", () => {
  it("adds or replaces response headers without changing status", async () => {
    const res = withResponseHeaders(jsonResponse({ ok: true }, { status: 202, headers: { "X-Test": "old" } }), {
      "X-Test": "new",
      "X-Extra": "1",
    });

    expect(res.status).toBe(202);
    expect(res.headers.get("X-Test")).toBe("new");
    expect(res.headers.get("X-Extra")).toBe("1");
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("adds no-store only when it is missing", () => {
    const cached = jsonResponse({ ok: true });
    expect(noStoreResponse(cached).headers.get("Cache-Control")).toBe("no-store");

    const alreadyNoStore = jsonResponse({ ok: true }, { noStore: true });
    expect(noStoreResponse(alreadyNoStore)).toBe(alreadyNoStore);
  });

  it("returns 405 responses with an Allow header", async () => {
    const res = methodNotAllowedResponse("Use GET", ["GET", "HEAD"]);

    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, HEAD");
    await expect(res.json()).resolves.toEqual({ error: "Use GET" });
  });
});

describe("jsonFreshResponse", () => {
  it("returns plain JSON when freshness metadata is not provided", async () => {
    const res = jsonFreshResponse({ ok: true }, {
      cacheControl: "public, max-age=60",
      headers: { "X-Test": "1" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(res.headers.get("X-Test")).toBe("1");
    expect(res.headers.get("X-Data-Age")).toBeNull();
  });
});

describe("cacheControlForDegradedPayload", () => {
  it("switches degraded payloads to no-store", () => {
    expect(cacheControlForDegradedPayload({ _meta: { degraded: false } })).toBe("public, s-maxage=300, max-age=60");
    expect(cacheControlForDegradedPayload({ _meta: { degraded: true } })).toBe("no-store");
  });
});

describe("jsonFreshDegradedResponse", () => {
  it.each([
    { degraded: false, cacheControl: "public, s-maxage=300, max-age=60" },
    { degraded: true, cacheControl: "no-store" },
  ])("returns freshness headers with $cacheControl caching", async ({ degraded, cacheControl }) => {
    const updatedAt = Math.floor(Date.now() / 1_000) - 5;
    const payload = { ok: true, _meta: { degraded } };

    const res = jsonFreshDegradedResponse(payload, updatedAt, 60);

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(cacheControl);
    expect(Number(res.headers.get("X-Data-Age"))).toBeGreaterThanOrEqual(0);
    await expect(res.json()).resolves.toEqual(payload);
  });
});

describe("respondWithFreshSnapshot", () => {
  class SnapshotUnavailableError extends Error {}

  it("returns a freshness-decorated snapshot response", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const res = await respondWithFreshSnapshot({
      load: async () => ({ updatedAt: nowSec - 5, value: 1 }),
      cacheControl: "public, max-age=60",
      maxAgeSec: 60,
      unavailableError: SnapshotUnavailableError,
      unavailableMessage: "Snapshot unavailable",
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(Number(res.headers.get("X-Data-Age"))).toBeGreaterThanOrEqual(0);
    await expect(res.json()).resolves.toEqual({ updatedAt: nowSec - 5, value: 1 });
  });

  it("returns configured 503 responses for unavailable snapshots", async () => {
    const res = await respondWithFreshSnapshot({
      load: async () => {
        throw new SnapshotUnavailableError("missing");
      },
      cacheControl: "public, max-age=60",
      maxAgeSec: 60,
      unavailableError: SnapshotUnavailableError,
      unavailableMessage: "Snapshot unavailable",
    });

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "Snapshot unavailable" });
  });

  it("returns 503 when a snapshot has not been populated", async () => {
    const res = await respondWithFreshSnapshot({
      load: async () => ({ updatedAt: 0 }),
      cacheControl: "public, max-age=60",
      maxAgeSec: 60,
      unavailableError: SnapshotUnavailableError,
      unavailableMessage: "Snapshot unavailable",
    });

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "Data not yet available" });
  });

  it("rethrows unexpected snapshot loading errors", async () => {
    await expect(respondWithFreshSnapshot({
      load: async () => {
        throw new Error("boom");
      },
      cacheControl: "public, max-age=60",
      maxAgeSec: 60,
      unavailableError: SnapshotUnavailableError,
      unavailableMessage: "Snapshot unavailable",
    })).rejects.toThrow("boom");
  });
});
