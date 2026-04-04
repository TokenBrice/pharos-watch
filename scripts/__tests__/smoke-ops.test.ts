import { describe, expect, it, vi } from "vitest";

import {
  extractCookiePairs,
  fetchOpsUiProxyStatus,
  hasOpsUiAccessSessionCookie,
  mergeCookieHeader,
  shouldSkipOpsUiProxyAssertion,
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
