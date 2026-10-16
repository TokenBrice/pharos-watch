import { describe, expect, it, vi } from "vitest";
import { ACCESS_HEADERS, jsonResponse, textResponse } from "./smoke-ops.test-support";

import {
  fetchJsonWithRetry,
  fetchOpsUiProxyStatus,
  fetchOpsUiProxyStatusWithRetry,
} from "../maintenance/smoke-ops.mjs";

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
      "https://ops-api.pharos.watch/api/remediate-blacklist-amount-gaps?dryRun=true&stablecoin=USDT&chainId=optimism&limit=1",
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
