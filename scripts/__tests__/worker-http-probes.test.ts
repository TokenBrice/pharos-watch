import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "@shared/test-utils/mock-fetch";

import {
  accessHeaders,
  collectWorkerHttpProbes,
  fetchJsonProbe,
} from "../lib/worker-http-probes.mts";

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
        ok: true,
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
    const text = "not-json:".repeat(150);
    mockFetch([{
      match: "https://api.example.test/api/health",
      body: text,
      status: 502,
    }], { requireMatch: true });
    await expect(fetchJsonProbe(args, "/api/health")).resolves.toMatchObject({
      status: 502,
      ok: false,
      payload: text.slice(0, 1000),
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

  it("normalizes unsuccessful JSON and empty responses", async () => {
    mockFetch([{
      match: "https://api.example.test/api/health",
      respond: () => Response.json({ error: "unavailable" }, { status: 503 }),
    }], { requireMatch: true });
    await expect(fetchJsonProbe(args, "/api/health")).resolves.toMatchObject({
      status: 503, ok: false, payload: { error: "unavailable" },
    });
    mockFetch([{
      match: "https://api.example.test/api/health",
      respond: () => new Response(null, { status: 204 }),
    }], { requireMatch: true });
    await expect(fetchJsonProbe(args, "/api/health")).resolves.toMatchObject({
      status: 204, ok: true, payload: null,
    });
  });

  it("makes no requests when all probes are disabled", async () => {
    const fetchSpy = mockFetch([], { requireMatch: true });
    await expect(collectWorkerHttpProbes(args, {
      includeHealth: false, includeStatus: false, includeStatusHistory: false,
    })).resolves.toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("requests only status history and defaults its origin to the public API", async () => {
    const fetchSpy = mockFetch([{
      match: "https://api.example.test/api/status-history",
      body: { events: [] },
    }], { requireMatch: true });
    const probes = await collectWorkerHttpProbes({ apiUrl: args.apiUrl }, {
      includeHealth: false, includeStatus: false, includeStatusHistory: true,
    });
    expect(Object.keys(probes)).toEqual(["statusHistory"]);
    expect(probes.statusHistory).toMatchObject({
      url: "https://api.example.test/api/status-history", status: 200, ok: true, payload: { events: [] },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
