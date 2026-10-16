import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "@shared/test-utils/mock-fetch";

import {
  accessHeaders,
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

});
