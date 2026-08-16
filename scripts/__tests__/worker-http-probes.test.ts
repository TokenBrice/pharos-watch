import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "../../worker/src/test-helpers/__shared/mock-fetch";

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
    const fetchSpy = mockFetch([{
      match: (request) => ["/api/health", "/api/status", "/api/status-history"].includes(new URL(request.url).pathname),
      respond: (request) => {
        const path = new URL(request.url).pathname;
        const response = Response.json({ path }, { status: path === "/api/status-history" ? 206 : 200 });
        if (path === "/api/status-history") Object.defineProperty(response, "ok", { value: false });
        return response;
      },
    }], { requireMatch: true });

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
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy.mock.calls[0]?.[1]).toEqual({
      method: "GET",
      headers: {
        "CF-Access-Client-Id": "client-id",
        "CF-Access-Client-Secret": "client-secret",
      },
    });
  });

  it("returns bounded text payloads and network errors without throwing", async () => {
    mockFetch([{
      match: "https://api.example.test/api/health",
      body: "not-json",
      status: 502,
    }], { requireMatch: true });
    await expect(fetchJsonProbe(args, "/api/health")).resolves.toMatchObject({
      status: 502,
      ok: false,
      payload: "not-json",
    });

    mockFetch([{
      match: "https://api.example.test/api/health",
      outcomes: [new Error("offline")],
    }], { requireMatch: true });
    await expect(fetchJsonProbe(args, "/api/health")).resolves.toMatchObject({
      status: 0,
      ok: false,
      error: "offline",
    });
  });
});
