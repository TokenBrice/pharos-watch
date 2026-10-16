import { describe, expect, it } from "vitest";

import { buildWorkerLogRecord } from "../structured-log";

describe("structured worker logging", () => {
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

});
