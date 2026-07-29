import { afterEach, describe, expect, it, vi } from "vitest";

import {
  accessHeaders,
  collectWorkerHttpProbes,
  fetchJsonProbe,
} from "../lib/worker-http-probes.mjs";

const args = {
  apiUrl: "https://api.example.test",
  adminApiUrl: "https://ops.example.test",
  cfAccessClientId: "client-id",
  cfAccessClientSecret: "client-secret",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("worker HTTP probes", () => {
  it("adds Access headers only when both service-token credentials are present", () => {
    expect(accessHeaders(args)).toEqual({
      "CF-Access-Client-Id": "client-id",
      "CF-Access-Client-Secret": "client-secret",
    });
    expect(accessHeaders({ ...args, cfAccessClientSecret: "" })).toEqual({});
  });

  it("collects the requested public and admin probes with normalized JSON payloads", async () => {
    const fetch = vi.fn(async (url: URL) => ({
      status: url.pathname === "/api/status-history" ? 206 : 200,
      ok: url.pathname !== "/api/status-history",
      text: async () => JSON.stringify({ path: url.pathname }),
    }));
    vi.stubGlobal("fetch", fetch);

    await expect(collectWorkerHttpProbes(args, {
      includeStatus: true,
      includeStatusHistory: true,
    })).resolves.toMatchObject({
      health: { url: "https://api.example.test/api/health", status: 200, ok: true, payload: { path: "/api/health" } },
      status: { url: "https://ops.example.test/api/status", status: 200, ok: true, payload: { path: "/api/status" } },
      statusHistory: {
        url: "https://ops.example.test/api/status-history",
        status: 206,
        ok: false,
        payload: { path: "/api/status-history" },
      },
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[0]?.[1]).toEqual({
      method: "GET",
      headers: {
        "CF-Access-Client-Id": "client-id",
        "CF-Access-Client-Secret": "client-secret",
      },
    });
  });

  it("returns bounded text payloads and network errors without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      status: 502,
      ok: false,
      text: async () => "not-json",
    })));
    await expect(fetchJsonProbe(args, "/api/health")).resolves.toMatchObject({
      status: 502,
      ok: false,
      payload: "not-json",
    });

    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline");
    }));
    await expect(fetchJsonProbe(args, "/api/health")).resolves.toMatchObject({
      status: 0,
      ok: false,
      error: "offline",
    });
  });
});
