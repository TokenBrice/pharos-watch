import { describe, expect, it } from "vitest";
import { buildProxyResponse, buildUpstreamHeaders, isHtmlResponse, jsonError, summarizeFetchError } from "../proxy-utils";

describe("summarizeFetchError", () => {
  it("preserves Error and DOMException names while using shared messages", () => {
    expect(summarizeFetchError(new Error("network down"))).toEqual({
      kind: "Error",
      message: "network down",
    });
    expect(summarizeFetchError(new DOMException("request timed out", "TimeoutError"))).toEqual({
      kind: "TimeoutError",
      message: "request timed out",
    });
  });

  it("stringifies non-Error values", () => {
    expect(summarizeFetchError("network down")).toEqual({ kind: "string", message: "network down" });
    expect(summarizeFetchError(null)).toEqual({ kind: "object", message: "null" });
    expect(summarizeFetchError({ message: "network down" })).toEqual({
      kind: "object",
      message: "[object Object]",
    });
    expect(summarizeFetchError({})).toEqual({ kind: "object", message: "[object Object]" });
  });
});

describe("proxy HTTP contracts", () => {
  it("allowlists client headers and gives service credentials precedence", () => {
    const request = new Request("https://pharos.watch/proxy", {
      headers: { Accept: "application/json", Authorization: "Bearer client", Cookie: "private=yes" },
    });
    const headers = buildUpstreamHeaders(request, ["accept", "authorization", "if-none-match"], {
      Authorization: "Bearer service",
    });
    expect(Object.fromEntries(headers)).toEqual({
      accept: "application/json",
      authorization: "Bearer service",
    });
  });

  it("preserves backoff and response status while filtering headers and removing HEAD bodies", async () => {
    const upstream = new Response("temporarily unavailable", {
      status: 503,
      headers: { "Retry-After": "120", "X-Trace": "trace", "X-Private": "secret" },
    });
    const get = buildProxyResponse(upstream.clone(), ["x-trace"]);
    expect(get.status).toBe(503);
    expect(Object.fromEntries(get.headers)).toEqual({ "retry-after": "120", "x-trace": "trace" });
    await expect(get.text()).resolves.toBe("temporarily unavailable");
    const head = buildProxyResponse(upstream, ["x-trace"], { method: "HEAD" });
    expect(head.status).toBe(503);
    expect(head.headers.get("Retry-After")).toBe("120");
    expect(head.body).toBeNull();
  });

  it("uses the default cache policy only when upstream cache policy was not forwarded", () => {
    const response = () => new Response(null, { headers: { "Cache-Control": "public, max-age=60" } });
    expect(buildProxyResponse(response(), ["cache-control"], {
      defaultCacheControl: "no-store",
    }).headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(buildProxyResponse(response(), [], {
      defaultCacheControl: "no-store",
    }).headers.get("Cache-Control")).toBe("no-store");
    expect(buildProxyResponse(response(), []).headers.get("Cache-Control")).toBeNull();
  });

  it("returns JSON errors with no-store unless explicitly overridden", async () => {
    const defaultResponse = jsonError(502, "upstream unavailable");
    expect(defaultResponse.status).toBe(502);
    expect(defaultResponse.headers.get("Cache-Control")).toBe("no-store");
    await expect(defaultResponse.json()).resolves.toEqual({ error: "upstream unavailable" });
    const explicit = jsonError(429, "back off", { "Cache-Control": "private, max-age=5" });
    expect(explicit.status).toBe(429);
    expect(explicit.headers.get("Cache-Control")).toBe("private, max-age=5");
    await expect(explicit.json()).resolves.toEqual({ error: "back off" });
  });

  it("detects mixed-case HTML media types with parameters but not absent or non-HTML types", () => {
    expect(isHtmlResponse(new Response(null, { headers: { "Content-Type": "Text/HTML; charset=UTF-8" } }))).toBe(true);
    expect(isHtmlResponse(new Response(null))).toBe(false);
    expect(isHtmlResponse(new Response(null, { headers: { "Content-Type": "application/json" } }))).toBe(false);
  });
});
