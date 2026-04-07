import { describe, expect, it, vi } from "vitest";

import {
  extractCookiePairs,
  fetchOpsUiProxyStatus,
  fetchOpsUiProxyStatusWithRetry,
  hasOpsUiAccessSessionCookie,
  mergeCookieHeader,
  shouldSkipOpsUiProxyAssertion,
  shouldRetryOpsUiProxyStatus,
} from "../smoke-ops.mjs";

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

    expect(extractCookiePairs(response)).toEqual([
      "CF_Authorization=ui-session",
      "other=value",
    ]);
  });
});

describe("mergeCookieHeader", () => {
  it("deduplicates cookies by name and keeps the latest value", () => {
    expect(mergeCookieHeader(
      "CF_Authorization=old",
      ["other=value", "CF_Authorization=new"],
    )).toBe("CF_Authorization=new; other=value");
  });
});

describe("fetchOpsUiProxyStatus", () => {
  it("retries the proxied status request with a bootstrapped Access cookie after a 401", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: {
          "content-type": "application/json",
          "set-cookie": "CF_Authorization=ui-session; Expires=Sun, 05 Apr 2026 12:51:17 GMT; Path=/; Secure; SameSite=none",
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ overallStatus: "degraded" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));

    const result = await fetchOpsUiProxyStatus(
      "https://ops.pharos.watch/api/admin/status",
      {
        "CF-Access-Client-Id": "id",
        "CF-Access-Client-Secret": "secret",
      },
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
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: {
          "content-type": "application/json",
          "set-cookie": "cf_clearance=bot-cookie; Path=/; Secure",
        },
      }));

    const result = await fetchOpsUiProxyStatus(
      "https://ops.pharos.watch/api/admin/status",
      {
        "CF-Access-Client-Id": "id",
        "CF-Access-Client-Secret": "secret",
      },
      { fetchImpl: fetchMock },
    );

    expect(result.retriedWithCookie).toBe(false);
    expect(result.cookieHeader).toBe("cf_clearance=bot-cookie");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("fetchOpsUiProxyStatusWithRetry", () => {
  it("retries a transient proxied 504 once before failing the smoke", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("gateway timeout", {
        status: 504,
        headers: { "content-type": "text/plain" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ overallStatus: "degraded" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    const sleepMock = vi.fn().mockResolvedValue(undefined);
    const onRetry = vi.fn();

    const result = await fetchOpsUiProxyStatusWithRetry(
      "https://ops.pharos.watch/api/admin/status",
      {
        "CF-Access-Client-Id": "id",
        "CF-Access-Client-Secret": "secret",
      },
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
      status: 504,
    });
  });

  it("uses the default retry budget when proxied 504s persist", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("gateway timeout", {
        status: 504,
        headers: { "content-type": "text/plain" },
      }))
      .mockResolvedValueOnce(new Response("gateway timeout", {
        status: 504,
        headers: { "content-type": "text/plain" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ overallStatus: "healthy" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    const sleepMock = vi.fn().mockResolvedValue(undefined);

    const result = await fetchOpsUiProxyStatusWithRetry(
      "https://ops.pharos.watch/api/admin/status",
      {
        "CF-Access-Client-Id": "id",
        "CF-Access-Client-Secret": "secret",
      },
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
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("gateway timeout", {
        status: 504,
        headers: { "content-type": "text/plain" },
      }))
      .mockResolvedValueOnce(new Response("gateway timeout", {
        status: 504,
        headers: { "content-type": "text/plain" },
      }))
      .mockResolvedValueOnce(new Response("gateway timeout", {
        status: 504,
        headers: { "content-type": "text/plain" },
      }));
    const sleepMock = vi.fn().mockResolvedValue(undefined);

    const result = await fetchOpsUiProxyStatusWithRetry(
      "https://ops.pharos.watch/api/admin/status",
      {
        "CF-Access-Client-Id": "id",
        "CF-Access-Client-Secret": "secret",
      },
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

describe("hasOpsUiAccessSessionCookie", () => {
  it("only treats CF_Authorization as a bootstrapped Access session", () => {
    expect(hasOpsUiAccessSessionCookie("cf_clearance=bot-cookie")).toBe(false);
    expect(hasOpsUiAccessSessionCookie("cf_clearance=bot-cookie; CF_Authorization=ui-session")).toBe(true);
  });
});

describe("shouldSkipOpsUiProxyAssertion", () => {
  it("skips when the proxied request is unauthorized and no UI session cookie was bootstrapped", () => {
    const response = new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });

    expect(shouldSkipOpsUiProxyAssertion(response, "cf_clearance=bot-cookie")).toBe(true);
  });

  it("still skips when a proxied 401 persists even after a UI session cookie was bootstrapped", () => {
    const response = new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });

    expect(shouldSkipOpsUiProxyAssertion(response, "CF_Authorization=ui-session")).toBe(true);
  });

  it("does not skip non-auth failures once the request cleared Access", () => {
    const response = new Response(JSON.stringify({ error: "Upstream failed" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });

    expect(shouldSkipOpsUiProxyAssertion(response, "CF_Authorization=ui-session")).toBe(false);
  });
});

describe("shouldRetryOpsUiProxyStatus", () => {
  it("retries only transient gateway timeouts", () => {
    expect(shouldRetryOpsUiProxyStatus(new Response("gateway timeout", { status: 504 }))).toBe(true);
    expect(shouldRetryOpsUiProxyStatus(new Response(JSON.stringify({ error: "upstream failed" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    }))).toBe(false);
  });
});
