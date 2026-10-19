import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordWorkerRequestAttribution: vi.fn(async () => {}),
  recordApiKeyRequestAttribution: vi.fn(async () => {}),
  isApiKeyRequestAttributionDisabled: vi.fn(() => false),
  isRequestSourceAttributionDisabled: vi.fn(() => false),
}));

vi.mock("../../../lib/request-source-attribution", () => mocks);

import { createRequestSourceRecorder } from "../request-source";

type RecorderOptions = Parameters<typeof createRequestSourceRecorder>[0];
const db = {} as D1Database;

function recorderOptions(overrides: Partial<RecorderOptions> = {}): RecorderOptions {
  return {
    request: new Request("https://api.pharos.watch/api/stablecoins", {
      headers: { Origin: "https://example.com" },
    }),
    db,
    execCtx: { waitUntil: vi.fn() } as unknown as ExecutionContext,
    isAdmin: false,
    isSiteProxy: false,
    apiKeyId: null,
    apiKeyTrafficClass: null,
    requestLane: "public-api",
    pathname: "/api/stablecoins",
    ...overrides,
  };
}

describe("createRequestSourceRecorder", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each<[string, Partial<RecorderOptions>]>([
    ["admin", { isAdmin: true }],
    ["unassigned lane", { requestLane: null }],
    ["uncredentialed site-api", { requestLane: "site-api" }],
    ["disabled site-api", { requestLane: "site-api", isSiteProxy: true, attributionDisabled: true }],
    ["webhook", { pathname: "/api/telegram-webhook" }],
  ])("does not schedule attribution for %s requests", (_label, overrides) => {
    const options = recorderOptions(overrides);
    createRequestSourceRecorder(options)();
    expect(options.execCtx.waitUntil).not.toHaveBeenCalled();
    expect(mocks.recordWorkerRequestAttribution).not.toHaveBeenCalled();
    expect(mocks.recordApiKeyRequestAttribution).not.toHaveBeenCalled();
  });

  it.each([
    [false, false, 1, 1],
    [true, false, 0, 1],
    [false, true, 1, 0],
    [true, true, 0, 0],
  ] as const)("applies route-disabled=%s and key-disabled=%s independently", (attributionDisabled, apiKeyAttributionDisabled, routeWrites, keyWrites) => {
    const options = recorderOptions({ apiKeyId: 7, apiKeyTrafficClass: "external", attributionDisabled, apiKeyAttributionDisabled });
    createRequestSourceRecorder(options)();
    expect(options.execCtx.waitUntil).toHaveBeenCalledTimes(routeWrites || keyWrites ? 1 : 0);
    expect(mocks.recordWorkerRequestAttribution).toHaveBeenCalledTimes(routeWrites);
    expect(mocks.recordApiKeyRequestAttribution).toHaveBeenCalledTimes(keyWrites);
    if (routeWrites) expect(mocks.recordWorkerRequestAttribution).toHaveBeenCalledWith(db,
      { routeKey: "stablecoins", routePath: "/api/stablecoins" }, "public-api", "external", "keyed");
    if (keyWrites) expect(mocks.recordApiKeyRequestAttribution).toHaveBeenCalledWith(db, 7);
  });

  it.each<[string, Partial<RecorderOptions>, string, string]>([
    ["credentialed proxy", { requestLane: "site-api", isSiteProxy: true }, "site-api", "site"],
    ["browser fallback", {}, "public-api", "external"],
  ])("classifies %s traffic", (_label, overrides, lane, source) => {
    const options = recorderOptions(overrides);
    createRequestSourceRecorder(options)();
    expect(options.execCtx.waitUntil).toHaveBeenCalledOnce();
    expect(mocks.recordWorkerRequestAttribution).toHaveBeenCalledWith(db,
      { routeKey: "stablecoins", routePath: "/api/stablecoins" }, lane, source,
      lane === "site-api" ? "not-applicable" : "unkeyed");
    expect(mocks.recordApiKeyRequestAttribution).not.toHaveBeenCalled();
  });

  it("retains normalized unknown public routes and their unkeyed dimension", () => {
    const options = recorderOptions({ pathname: "/api/unregistered" });
    createRequestSourceRecorder(options)();
    expect(mocks.recordWorkerRequestAttribution).toHaveBeenCalledWith(db,
      { routeKey: "unknown-public-api", routePath: "/api/*" }, "public-api", "external", "unkeyed");
  });

});
