import { afterEach, describe, expect, it, vi } from "vitest";

import { buildWorkerLogRecord, logWorkerEvent } from "../structured-log";

describe("structured worker logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses stable top-level fields and bounds errors", () => {
    const record = buildWorkerLogRecord({
      scope: "status",
      level: "warn",
      event: "status_probe_failed",
      route: "status",
      job: "status-self-check",
      provider: "cloudflare",
      source: "status-probe-runs",
      runId: "run-123",
      message: "Probe failed",
      error: new Error("synthetic failure"),
      metadata: {
        path: "/api/status?refresh=live",
      },
    });

    expect(record).toMatchObject({
      scope: "status",
      level: "warn",
      event: "status_probe_failed",
      route: "status",
      job: "status-self-check",
      provider: "cloudflare",
      source: "status-probe-runs",
      runId: "run-123",
      message: "Probe failed",
      errorName: "Error",
      errorMessage: "synthetic failure",
      metadata: {
        path: "/api/status?refresh=live",
      },
    });
    expect(Object.keys(record)).toEqual(expect.arrayContaining(["ts", "scope", "level", "message"]));
  });

  it("emits a single JSON line at the requested console level", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    logWorkerEvent({
      scope: "http",
      level: "warn",
      event: "edge_cache_write_failed",
      route: "/api/status",
      message: "Edge cache write failed",
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const line = warnSpy.mock.calls[0]?.[0];
    expect(typeof line).toBe("string");
    expect(JSON.parse(line as string)).toMatchObject({
      scope: "http",
      level: "warn",
      event: "edge_cache_write_failed",
      route: "/api/status",
      message: "Edge cache write failed",
    });
  });
});
