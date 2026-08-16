import { describe, expect, it } from "vitest";
import { mockD1 } from "../__shared/mock-d1";
import { createWorkerEnv } from "../__shared/worker-env";

describe("createWorkerEnv", () => {
  it("creates complete isolated defaults and applies typed overrides", async () => {
    const first = createWorkerEnv();
    const db = mockD1([{ match: "SELECT 1", rows: [{ value: 1 }] }]);
    const second = createWorkerEnv({ DB: db, CORS_ORIGIN: "https://example.test" });

    expect(first.CORS_ORIGIN).toBe("https://pharos.watch");
    expect(second.CORS_ORIGIN).toBe("https://example.test");
    expect(second.DB).toBe(db);
    expect(first.TELEGRAM_WEBHOOK_PREAUTH_RATE_LIMIT).not.toBe(
      second.TELEGRAM_WEBHOOK_PREAUTH_RATE_LIMIT,
    );
    await expect(first.TELEGRAM_WEBHOOK_PREAUTH_RATE_LIMIT.limit({ key: "test" })).resolves.toEqual({
      success: true,
    });
    await expect(first.DB.prepare("SELECT * FROM unexpected").all()).rejects.toThrow(
      "mockD1: no match for SQL: SELECT * FROM unexpected",
    );
  });
});
