import { describe, expect, it, vi } from "vitest";

import {
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
} from "../smoke-ops.mjs";

function withEnv(name: string, value: string | undefined, fn: () => void) {
  const original = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }

  try {
    fn();
  } finally {
    if (original === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = original;
    }
  }
}

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

describe("fetchOpsUiProxyStatus", () => {
  it("retries the proxied status request with a bootstrapped Access cookie after a 401", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: {
            "content-type": "application/json",
            "set-cookie":
              "CF_Authorization=ui-session; Expires=Sun, 05 Apr 2026 12:51:17 GMT; Path=/; Secure; SameSite=none",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ overallStatus: "degraded" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

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
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: {
          "content-type": "application/json",
          "set-cookie": "cf_clearance=bot-cookie; Path=/; Secure",
        },
      }),
    );

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
  it.each<{ body: string; status: number }>([
    { status: 502, body: "bad gateway" },
    { status: 504, body: "gateway timeout" },
  ])("retries a transient proxied $status once before failing the smoke", async ({ status, body }) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(body, {
          status,
          headers: { "content-type": "text/plain" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ overallStatus: "degraded" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
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
      status,
    });
  });

  it("uses the default retry budget when proxied 504s persist", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("gateway timeout", {
          status: 504,
          headers: { "content-type": "text/plain" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("gateway timeout", {
          status: 504,
          headers: { "content-type": "text/plain" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ overallStatus: "healthy" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
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
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("gateway timeout", {
          status: 504,
          headers: { "content-type": "text/plain" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("gateway timeout", {
          status: 504,
          headers: { "content-type": "text/plain" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("gateway timeout", {
          status: 504,
          headers: { "content-type": "text/plain" },
        }),
      );
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

describe("fetchJsonWithRetry", () => {
  it("retries transient direct ops 500 responses before returning success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "warming" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ dryRun: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
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
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
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
        new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      ),
    ).toBe(false);
    expect(
      shouldRetryOpsUiProxyStatus(
        new Response(JSON.stringify({ error: "upstream failed" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
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
        new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      ),
    ).toBe(false);
    expect(
      shouldRetryDirectOpsJson(
        new Response(JSON.stringify({ dryRun: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    ).toBe(false);
  });
});
