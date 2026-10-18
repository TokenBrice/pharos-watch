import { afterEach, describe, expect, it, vi } from "vitest";
import {
  errorResponse,
  jsonFreshDegradedResponse,
  jsonFreshResponse,
  jsonResponse,
  jsonResponseWithHeaders,
  methodNotAllowedResponse,
  noStoreResponse,
  withResponseHeaders,
  conditionalGetResponse,
  scopeResponseEtag,
  withRepresentationEtag,
} from "../api-response";
import { addCorsHeaders } from "../../handlers/http/cors";

describe("conditional GET representations", () => {
  const now = 1_800_000_000;
  afterEach(() => vi.restoreAllMocks());
  function representation(generation = "generation-1", overlay = "current", attemptedAt = now - 5) {
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    return scopeResponseEtag(withRepresentationEtag(new Response('{"cards":[]}', {
      headers: {
        "Cache-Control": overlay === "held" ? "no-store" : "public, s-maxage=60, max-age=10",
        Date: new Date((now - 5) * 1000).toUTCString(),
        Age: "5",
        "Content-Length": "12",
        "X-Safety-Score-Status": overlay,
        "X-Data-Updated-At": String(now - 30),
        "X-Data-Freshness-Budget": "120",
        "X-Data-Assessed-At": String(now - 5),
      },
    }), { version: 1, generation, overlay, attemptedAt }), "/api/report-cards/v9", false);
  }

  it("returns empty 304 for unchanged generations with weak/list matching and preserves CORS and clocks", async () => {
    const first = representation();
    const etag = first.headers.get("ETag")!;
    const response = addCorsHeaders(conditionalGetResponse(new Request("https://site-api.pharos.watch/api/report-cards/v9", {
      headers: { "If-None-Match": `"another", ${etag.replace(/^W\//, "")}` },
    }), first), "https://pharos.watch");
    expect(response.status).toBe(304);
    expect(response.body).toBeNull();
    await expect(response.text()).resolves.toBe("");
    expect(response.headers.get("ETag")).toBe(etag);
    expect(response.headers.get("Age")).toBe("5");
    expect(response.headers.get("Date")).toBe(new Date((now - 5) * 1000).toUTCString());
    expect(response.headers.get("X-Data-Updated-At")).toBe(String(now - 30));
    expect(response.headers.get("X-Data-Assessed-At")).toBe(String(now - 5));
    expect(response.headers.get("X-Data-Freshness-Budget")).toBe("120");
    expect(response.headers.get("Cache-Control")).toBe("public, s-maxage=60, max-age=10");
    expect(response.headers.get("Content-Length")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://pharos.watch");
    expect(response.headers.get("Access-Control-Expose-Headers")).toContain("ETag");
  });

  it("returns 200 with a new validator for changed generation or mutable health", () => {
    const etag = representation().headers.get("ETag")!;
    for (const changed of [representation("generation-2"), representation("generation-1", "current", now - 1)]) {
      const response = conditionalGetResponse(new Request("https://site-api.pharos.watch/api/report-cards/v9", {
        headers: { "If-None-Match": etag },
      }), changed);
      expect(response.status).toBe(200);
      expect(response.headers.get("ETag")).not.toBe(etag);
    }
  });

  it("returns held 200/no-store without inherited reusable validators", () => {
    const etag = representation().headers.get("ETag")!;
    const held = representation("generation-1", "held");
    held.headers.set("ETag", etag);
    held.headers.set("Last-Modified", new Date(now * 1000).toUTCString());
    const response = conditionalGetResponse(new Request("https://site-api.pharos.watch/api/report-cards/v9", {
      headers: { "If-None-Match": etag },
    }), held);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("ETag")).toBeNull();
    expect(response.headers.get("Last-Modified")).toBeNull();
  });

  it.each(["http-date", "http-age", "producer-budget"])("never resurrects expired %s", (kind) => {
    const response = representation();
    const etag = response.headers.get("ETag")!;
    if (kind === "http-date") response.headers.set("Date", new Date((now - 60) * 1000).toUTCString());
    if (kind === "http-age") response.headers.set("Age", "60");
    if (kind === "producer-budget") response.headers.set("X-Data-Freshness-Budget", "30");
    expect(conditionalGetResponse(new Request("https://site-api.pharos.watch/api/report-cards/v9", {
      headers: { "If-None-Match": etag },
    }), response).status).toBe(200);
  });

  it("does not collide full, projected or coin-specific representations", () => {
    const base = representation();
    const tags = ["/api/feed", "/api/feed?projection=summary", "/api/feed-coin?stablecoin=usdt", "/api/feed-coin?stablecoin=usdc"]
      .map((path) => scopeResponseEtag(base.clone(), path, true).headers.get("ETag"));
    expect(new Set(tags).size).toBe(4);
  });

  it("uses a unique stored response publication when no complete producer identity exists", () => {
    const first = scopeResponseEtag(new Response("first", { headers: { "Cache-Control": "public, max-age=60" } }), "/api/feed", true);
    const second = scopeResponseEtag(new Response("second", { headers: { "Cache-Control": "public, max-age=60" } }), "/api/feed", true);
    expect(first.headers.get("ETag")).not.toBe(second.headers.get("ETag"));
    const response = conditionalGetResponse(new Request("https://site-api.pharos.watch/api/feed", {
      headers: { "If-None-Match": first.headers.get("ETag")! },
    }), first);
    expect(response.status).toBe(304);
  });
});

describe("errorResponse", () => {
  it("returns JSON error with given status", async () => {
    const res = errorResponse(400, "Bad request");
    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const body = await res.json();
    expect(body).toEqual({ error: "Bad request" });
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

describe("jsonFreshDegradedResponse", () => {
  afterEach(() => vi.useRealTimers());
  it.each([
    { degraded: false, cacheControl: "public, s-maxage=300, max-age=60" },
    { degraded: true, cacheControl: "no-store" },
  ])("returns freshness headers with $cacheControl caching", async ({ degraded, cacheControl }) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const updatedAt = Math.floor(Date.now() / 1_000) - 5;
    const payload = { ok: true, _meta: { degraded } };

    const res = jsonFreshDegradedResponse(payload, updatedAt, 60);

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(cacheControl);
    expect(res.headers.get("X-Data-Age")).toBe("5");
    await expect(res.json()).resolves.toEqual(payload);
  });
});
