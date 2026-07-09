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

  it("sanitizes SQL/PII out of error message and stack before logging", () => {
    const err = new Error("D1_ERROR: SELECT secret FROM users where email = alice@example.com");
    err.stack = "Error: SELECT secret FROM users\n  at fetch (https://api.example.com/v1/x)";
    const record = buildWorkerLogRecord({
      scope: "lib",
      message: "db read failed",
      error: err,
    });
    expect(record.errorMessage).not.toMatch(/SELECT/i);
    expect(record.errorMessage).not.toContain("alice@example.com");
    expect(record.errorMessage).toContain("[sql]");
    expect(record.errorStack).not.toContain("https://api.example.com");
    expect(record.errorStack).toContain("[url]");
  });

  it("recursively redacts secrets from nested metadata and Error fields", () => {
    const nestedError = new Error("Bearer top.secret.token failed at https://api.example.com/x?token=query-secret");
    const record = buildWorkerLogRecord({
      scope: "lib",
      message: "provider metadata failed",
      metadata: {
        authorization: "Authorization=super-secret-value",
        nested: [{ token: "token=another-secret" }, nestedError],
        providerUrl: "https://example.com/path?api_key=query-secret",
      },
    });

    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("super-secret-value");
    expect(serialized).not.toContain("another-secret");
    expect(serialized).not.toContain("top.secret.token");
    expect(serialized).not.toContain("query-secret");
    expect(serialized).toContain("[redacted]");
    expect(serialized).toContain("[url]");
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
