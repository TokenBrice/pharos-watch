import { describe, expect, it } from "vitest";
import { createCronResult, serializeCronMetadata } from "../cron-result";

describe("serializeCronMetadata", () => {
  it("serializes structured metadata as a CronResult-compatible string", () => {
    const metadata = serializeCronMetadata({
      reason: "cache-fresh",
      rowsWritten: 0,
      flags: ["cooldown"],
      nested: { ok: true },
    });

    expect(metadata).toBe(
      '{"reason":"cache-fresh","rowsWritten":0,"flags":["cooldown"],"nested":{"ok":true}}',
    );
  });

  it("omits metadata when no object is supplied", () => {
    expect(serializeCronMetadata(null)).toBeUndefined();
    expect(serializeCronMetadata(undefined)).toBeUndefined();
  });
});

describe("createCronResult", () => {
  it("preserves status and item count while stringifying metadata", () => {
    const result = createCronResult({
      status: "degraded",
      itemCount: 3,
      metadata: {
        reason: "upstream",
        retries: 2,
      },
    });

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(3);
    expect(result.metadata).toBe(JSON.stringify({ reason: "upstream", retries: 2 }));
  });
});
