import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordWorkerRequestAttribution: vi.fn(() => Promise.resolve()),
  recordApiKeyRequestAttribution: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../lib/request-source-attribution", () => ({
  recordWorkerRequestAttribution: mocks.recordWorkerRequestAttribution,
  recordApiKeyRequestAttribution: mocks.recordApiKeyRequestAttribution,
}));

import { createRequestSourceRecorder } from "../request-source";

function makeExecCtx() {
  return {
    waitUntil: vi.fn(),
  } as unknown as ExecutionContext & { waitUntil: ReturnType<typeof vi.fn> };
}

describe("createRequestSourceRecorder", () => {
  const db = {} as D1Database;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.recordWorkerRequestAttribution.mockResolvedValue(undefined);
    mocks.recordApiKeyRequestAttribution.mockResolvedValue(undefined);
  });

  it("returns a no-op recorder for admin requests", () => {
    const execCtx = makeExecCtx();
    const recorder = createRequestSourceRecorder({
      request: new Request("https://api.pharos.watch/api/stablecoins"),
      db,
      execCtx,
      isAdmin: true,
      isSiteProxy: false,
      apiKeyId: null,
      apiKeyTrafficClass: null,
      requestLane: "public-api",
      pathname: "/api/stablecoins",
    });

    recorder();

    expect(execCtx.waitUntil).not.toHaveBeenCalled();
    expect(mocks.recordWorkerRequestAttribution).not.toHaveBeenCalled();
    expect(mocks.recordApiKeyRequestAttribution).not.toHaveBeenCalled();
  });

  it("returns a no-op recorder when no request lane is assigned", () => {
    const execCtx = makeExecCtx();
    const recorder = createRequestSourceRecorder({
      request: new Request("https://api.pharos.watch/api/stablecoins"),
      db,
      execCtx,
      isAdmin: false,
      isSiteProxy: false,
      apiKeyId: null,
      apiKeyTrafficClass: null,
      requestLane: null,
      pathname: "/api/stablecoins",
    });

    recorder();

    expect(execCtx.waitUntil).not.toHaveBeenCalled();
    expect(mocks.recordWorkerRequestAttribution).not.toHaveBeenCalled();
    expect(mocks.recordApiKeyRequestAttribution).not.toHaveBeenCalled();
  });

  it("returns a no-op recorder for site-api traffic without the site proxy credential", () => {
    const execCtx = makeExecCtx();
    const recorder = createRequestSourceRecorder({
      request: new Request("https://ops-api.pharos.watch/api/stablecoins"),
      db,
      execCtx,
      isAdmin: false,
      isSiteProxy: false,
      apiKeyId: null,
      apiKeyTrafficClass: null,
      requestLane: "site-api",
      pathname: "/api/stablecoins",
    });

    recorder();

    expect(execCtx.waitUntil).not.toHaveBeenCalled();
    expect(mocks.recordWorkerRequestAttribution).not.toHaveBeenCalled();
    expect(mocks.recordApiKeyRequestAttribution).not.toHaveBeenCalled();
  });

  it("records site-api traffic as site when the request came through the site proxy", () => {
    const execCtx = makeExecCtx();
    const recorder = createRequestSourceRecorder({
      request: new Request("https://ops-api.pharos.watch/api/stablecoins"),
      db,
      execCtx,
      isAdmin: false,
      isSiteProxy: true,
      apiKeyId: null,
      apiKeyTrafficClass: null,
      requestLane: "site-api",
      pathname: "/api/stablecoins",
    });

    recorder();

    expect(execCtx.waitUntil).toHaveBeenCalledOnce();
    expect(mocks.recordWorkerRequestAttribution).toHaveBeenCalledWith(
      db,
      { routeKey: "stablecoins", routePath: "/api/stablecoins" },
      "site-api",
      "site",
    );
    expect(mocks.recordApiKeyRequestAttribution).not.toHaveBeenCalled();
  });

  it("uses the API-key traffic class for public-api requests when present", () => {
    const execCtx = makeExecCtx();
    const recorder = createRequestSourceRecorder({
      request: new Request("https://api.pharos.watch/api/stablecoins", {
        headers: { Origin: "https://example.com" },
      }),
      db,
      execCtx,
      isAdmin: false,
      isSiteProxy: false,
      apiKeyId: 7,
      apiKeyTrafficClass: "site",
      requestLane: "public-api",
      pathname: "/api/stablecoins",
    });

    recorder();

    expect(execCtx.waitUntil).toHaveBeenCalledOnce();
    expect(mocks.recordWorkerRequestAttribution).toHaveBeenCalledWith(
      db,
      { routeKey: "stablecoins", routePath: "/api/stablecoins" },
      "public-api",
      "site",
    );
    expect(mocks.recordApiKeyRequestAttribution).toHaveBeenCalledWith(db, 7);
  });

  it("falls back to browser classification for public-api requests without an API-key class", () => {
    const execCtx = makeExecCtx();
    const recorder = createRequestSourceRecorder({
      request: new Request("https://api.pharos.watch/api/stablecoins", {
        headers: { Origin: "https://example.com" },
      }),
      db,
      execCtx,
      isAdmin: false,
      isSiteProxy: false,
      apiKeyId: null,
      apiKeyTrafficClass: null,
      requestLane: "public-api",
      pathname: "/api/stablecoins",
    });

    recorder();

    expect(execCtx.waitUntil).toHaveBeenCalledOnce();
    expect(mocks.recordWorkerRequestAttribution).toHaveBeenCalledWith(
      db,
      { routeKey: "stablecoins", routePath: "/api/stablecoins" },
      "public-api",
      "external",
    );
    expect(mocks.recordApiKeyRequestAttribution).not.toHaveBeenCalled();
  });
});
