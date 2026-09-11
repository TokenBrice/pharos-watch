import { describe, expect, it, vi } from "vitest";
import { withEnv } from "./helpers/test-state";
import { ACCESS_HEADERS, jsonResponse, textResponse } from "./smoke-ops.test-support";

import {
  assertNonceProtectedHtml,
  extractCookiePairs,
  fetchJsonWithRetry,
  fetchOpsUiProxyStatus,
  fetchOpsUiProxyStatusWithRetry,
  getSmokeOpsScope,
  hasOpsUiAccessSessionCookie,
  mergeCookieHeader,
  shouldSkipCanaryOpsUiProxyAssertion,
  shouldRetryDirectOpsJson,
  shouldSkipOpsUiProxyAssertion,
  shouldRetryOpsUiProxyStatus,
} from "../maintenance/smoke-ops.mjs";

describe("getSmokeOpsScope", () => {
  it("defaults to full and accepts canary", () => {
    withEnv("SMOKE_OPS_SCOPE", undefined, () => {
      expect(getSmokeOpsScope()).toBe("full");
    });
    withEnv("SMOKE_OPS_SCOPE", "canary", () => {
      expect(getSmokeOpsScope()).toBe("canary");
    });
    expect(getSmokeOpsScope("canary")).toBe("canary");
    expect(getSmokeOpsScope("FULL")).toBe("full");
  });

  it("rejects unknown scopes", () => {
    expect(() => getSmokeOpsScope("quick")).toThrow('Invalid SMOKE_OPS_SCOPE "quick"');
  });
});

describe("extractCookiePairs", () => {
  it("extracts cookie name-value pairs from a combined Set-Cookie header", () => {
    const response = new Response(null, {
      headers: {
        "set-cookie": [
          "CF_Authorization=ui-session; Expires=Sun, 05 Apr 2026 12:51:17 GMT; Path=/; Secure; SameSite=none",
          "other=value; Path=/; Secure",
        ].join(", "),
      },
    });

    expect(extractCookiePairs(response)).toEqual(["CF_Authorization=ui-session", "other=value"]);
  });
});

describe("mergeCookieHeader", () => {
  it("deduplicates cookies by name and keeps the latest value", () => {
    expect(mergeCookieHeader("CF_Authorization=old", ["other=value", "CF_Authorization=new"])).toBe(
      "CF_Authorization=new; other=value",
    );
  });
});

describe("assertNonceProtectedHtml", () => {
  it("accepts inline scripts that carry the CSP nonce", () => {
    const response = new Response(null, {
      headers: {
        "Content-Security-Policy": "default-src 'self'; script-src 'self' 'nonce-abc123' 'unsafe-eval'",
      },
    });

    expect(() =>
      assertNonceProtectedHtml(
        response,
        '<html><body><script nonce="abc123">self.__next_f=[];</script><script src="/_next/static/chunk.js"></script></body></html>',
        "Ops UI",
      ),
    ).not.toThrow();
  });

  it("rejects inline scripts when the CSP nonce is missing", () => {
    const response = new Response(null, {
      headers: {
        "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-eval'",
      },
    });

    expect(() =>
      assertNonceProtectedHtml(response, "<html><body><script>self.__next_f=[];</script></body></html>", "Ops UI"),
    ).toThrow("Ops UI CSP script-src is missing a nonce");
  });

  it("rejects inline scripts that do not carry the CSP nonce", () => {
    const response = new Response(null, {
      headers: {
        "Content-Security-Policy": "default-src 'self'; script-src 'self' 'nonce-abc123' 'unsafe-eval'",
      },
    });

    expect(() =>
      assertNonceProtectedHtml(
        response,
        '<html><body><script nonce="wrong">self.__next_f=[];</script><script>window.__INLINE__=true;</script></body></html>',
        "Ops UI",
      ),
    ).toThrow("Ops UI has 2 inline script(s) without the CSP nonce");
  });
});

describe("fetchOpsUiProxyStatus", () => {
  it("retries the proxied status request with a bootstrapped Access cookie after a 401", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ error: "Unauthorized" }, 401, { "set-cookie": "CF_Authorization=ui-session; Expires=Sun, 05 Apr 2026 12:51:17 GMT; Path=/; Secure; SameSite=none" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ overallStatus: "degraded" }, 200),
      );

    const result = await fetchOpsUiProxyStatus(
      "https://ops.pharos.watch/api/admin/status",
      ACCESS_HEADERS,
      { fetchImpl: fetchMock },
    );

    expect(result.retriedWithCookie).toBe(true);
    expect(result.cookieHeader).toBe("CF_Authorization=ui-session");
    expect(result.proxiedStatus.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        "CF-Access-Client-Id": "id",
        "CF-Access-Client-Secret": "secret",
      },
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: {
        Accept: "application/json",
        Cookie: "CF_Authorization=ui-session",
      },
    });
  });

  it("does not retry a 401 when only non-Access cookies are present", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({ error: "Unauthorized" }, 401, { "set-cookie": "cf_clearance=bot-cookie; Path=/; Secure" }),
    );

    const result = await fetchOpsUiProxyStatus(
      "https://ops.pharos.watch/api/admin/status",
      ACCESS_HEADERS,
      { fetchImpl: fetchMock },
    );

    expect(result.retriedWithCookie).toBe(false);
    expect(result.cookieHeader).toBe("cf_clearance=bot-cookie");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("fetchOpsUiProxyStatusWithRetry", () => {
  it.each<{ body: string; status: number }>([
    { status: 502, body: "bad gateway" },
    { status: 504, body: "gateway timeout" },
  ])("retries a transient proxied $status once before failing the smoke", async ({ status, body }) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        textResponse(body, status),
      )
      .mockResolvedValueOnce(
        jsonResponse({ overallStatus: "degraded" }, 200),
      );
    const sleepMock = vi.fn().mockResolvedValue(undefined);
    const onRetry = vi.fn();

    const result = await fetchOpsUiProxyStatusWithRetry(
      "https://ops.pharos.watch/api/admin/status",
      ACCESS_HEADERS,
      {
        fetchImpl: fetchMock,
        retryCount: 1,
        retryDelayMs: 2_000,
        sleepImpl: sleepMock,
        onRetry,
      },
    );

    expect(result.proxiedStatus.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledWith(2_000);
    expect(onRetry).toHaveBeenCalledWith({
      attemptNumber: 1,
      retryCount: 1,
      retryDelayMs: 2_000,
      status,
    });
  });

  it("uses the default retry budget when proxied 504s persist", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        textResponse("gateway timeout", 504),
      )
      .mockResolvedValueOnce(
        textResponse("gateway timeout", 504),
      )
      .mockResolvedValueOnce(
        jsonResponse({ overallStatus: "healthy" }, 200),
      );
    const sleepMock = vi.fn().mockResolvedValue(undefined);

    const result = await fetchOpsUiProxyStatusWithRetry(
      "https://ops.pharos.watch/api/admin/status",
      ACCESS_HEADERS,
      {
        fetchImpl: fetchMock,
        sleepImpl: sleepMock,
      },
    );

    expect(result.proxiedStatus.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleepMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenNthCalledWith(1, 2_000);
    expect(sleepMock).toHaveBeenNthCalledWith(2, 2_000);
  });

  it("still returns the last failure when the proxied 504 persists after the retry budget", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        textResponse("gateway timeout", 504),
      )
      .mockResolvedValueOnce(
        textResponse("gateway timeout", 504),
      )
      .mockResolvedValueOnce(
        textResponse("gateway timeout", 504),
      );
    const sleepMock = vi.fn().mockResolvedValue(undefined);

    const result = await fetchOpsUiProxyStatusWithRetry(
      "https://ops.pharos.watch/api/admin/status",
      ACCESS_HEADERS,
      {
        fetchImpl: fetchMock,
        retryDelayMs: 2_000,
        sleepImpl: sleepMock,
      },
    );

    expect(result.proxiedStatus.response.status).toBe(504);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleepMock).toHaveBeenCalledTimes(2);
  });
});

describe("fetchJsonWithRetry", () => {
  it("retries transient direct ops 500 responses before returning success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ error: "warming" }, 500),
      )
      .mockResolvedValueOnce(
        jsonResponse({ dryRun: true }, 200),
      );
    const sleepMock = vi.fn().mockResolvedValue(undefined);
    const onRetry = vi.fn();

    const result = await fetchJsonWithRetry(
      "https://ops-api.pharos.watch/api/backfill-blacklist-current-balances?dryRun=true&stablecoin=USDT&chainId=optimism&limit=1",
      { "CF-Access-Client-Id": "id" },
      {
        fetchImpl: fetchMock,
        requestInit: { method: "POST", body: "{}" },
        retryCount: 1,
        retryDelayMs: 2_000,
        sleepImpl: sleepMock,
        onRetry,
      },
    );

    expect(result.response.status).toBe(200);
    expect(result.body).toEqual({ dryRun: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: "{}",
      headers: { "CF-Access-Client-Id": "id" },
      redirect: "manual",
    });
    expect(sleepMock).toHaveBeenCalledWith(2_000);
    expect(onRetry).toHaveBeenCalledWith({
      attemptNumber: 1,
      retryCount: 1,
      retryDelayMs: 2_000,
      status: 500,
    });
  });

  it("does not retry direct ops authorization failures", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({ error: "Unauthorized" }, 401),
    );
    const sleepMock = vi.fn().mockResolvedValue(undefined);

    const result = await fetchJsonWithRetry(
      "https://ops-api.pharos.watch/api/status",
      { "CF-Access-Client-Id": "id" },
      { fetchImpl: fetchMock, sleepImpl: sleepMock },
    );

    expect(result.response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleepMock).not.toHaveBeenCalled();
  });
});

describe("hasOpsUiAccessSessionCookie", () => {
  it("only treats CF_Authorization as a bootstrapped Access session", () => {
    expect(hasOpsUiAccessSessionCookie("cf_clearance=bot-cookie")).toBe(false);
    expect(hasOpsUiAccessSessionCookie("cf_clearance=bot-cookie; CF_Authorization=ui-session")).toBe(true);
  });
});

describe("shouldSkipOpsUiProxyAssertion", () => {
  it("skips when the proxied request is unauthorized and no UI session cookie was bootstrapped", () => {
    const response = jsonResponse({ error: "Unauthorized" }, 401);

    expect(shouldSkipOpsUiProxyAssertion(response, "cf_clearance=bot-cookie")).toBe(true);
  });

  it("still skips when a proxied 401 persists even after a UI session cookie was bootstrapped", () => {
    const response = jsonResponse({ error: "Unauthorized" }, 401);

    expect(shouldSkipOpsUiProxyAssertion(response, "CF_Authorization=ui-session")).toBe(true);
  });

  it("does not skip non-auth failures once the request cleared Access", () => {
    const response = jsonResponse({ error: "Upstream failed" }, 502);

    expect(shouldSkipOpsUiProxyAssertion(response, "CF_Authorization=ui-session")).toBe(false);
  });
});

describe("shouldSkipCanaryOpsUiProxyAssertion", () => {
  it("skips exhausted transient proxy failures only for canary smokes", () => {
    const response = new Response("gateway timeout", {
      status: 504,
      headers: { "content-type": "text/html" },
    });

    expect(shouldSkipCanaryOpsUiProxyAssertion(response, "CF_Authorization=ui-session", "canary")).toBe(true);
    expect(shouldSkipCanaryOpsUiProxyAssertion(response, "CF_Authorization=ui-session", "full")).toBe(false);
  });
});

describe("shouldRetryOpsUiProxyStatus", () => {
  it("retries only transient gateway warmup failures", () => {
    expect(shouldRetryOpsUiProxyStatus(new Response("bad gateway", { status: 502 }))).toBe(true);
    expect(shouldRetryOpsUiProxyStatus(new Response("gateway timeout", { status: 504 }))).toBe(true);
    expect(
      shouldRetryOpsUiProxyStatus(
        jsonResponse({ error: "Unauthorized" }, 401),
      ),
    ).toBe(false);
    expect(
      shouldRetryOpsUiProxyStatus(
        jsonResponse({ error: "upstream failed" }, 500),
      ),
    ).toBe(false);
  });
});

describe("shouldRetryDirectOpsJson", () => {
  it("retries only transient direct ops server failures", () => {
    expect(shouldRetryDirectOpsJson(new Response("internal error", { status: 500 }))).toBe(true);
    expect(shouldRetryDirectOpsJson(new Response("bad gateway", { status: 502 }))).toBe(true);
    expect(shouldRetryDirectOpsJson(new Response("unavailable", { status: 503 }))).toBe(true);
    expect(shouldRetryDirectOpsJson(new Response("gateway timeout", { status: 504 }))).toBe(true);
    expect(
      shouldRetryDirectOpsJson(
        jsonResponse({ error: "Unauthorized" }, 401),
      ),
    ).toBe(false);
    expect(
      shouldRetryDirectOpsJson(
        jsonResponse({ dryRun: true }, 200),
      ),
    ).toBe(false);
  });
});
