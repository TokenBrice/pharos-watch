import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logTelegramEvent } from "../telegram/log";

describe("logTelegramEvent", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  function parseLast(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
    const last = spy.mock.calls.at(-1)?.[0];
    expect(typeof last).toBe("string");
    return JSON.parse(last as string) as Record<string, unknown>;
  }

  it("drops identifier, secret, URL, callback, and nested metadata keys at runtime", () => {
    logTelegramEvent({
      message: "delivery failed",
      chatId: "123456789",
      userId: 987654321,
      oldChatId: "-1001234567890",
      updateId: 456789123,
      callbackData: "confirm:delete:123456789",
      botToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi",
      initData: "query_id=secret",
      expectedUrl: "https://example.com/?token=secret",
      sourceEventId: "source-uuid",
      targetRef: "unkeyed-hash",
      nested: { chatId: "123456789" },
      presetIds: ["usd-top10"],
    } as never);

    const record = parseLast(errorSpy);
    for (const key of [
      "chatId",
      "userId",
      "oldChatId",
      "updateId",
      "callbackData",
      "botToken",
      "initData",
      "expectedUrl",
      "sourceEventId",
      "targetRef",
      "nested",
      "presetIds",
    ]) {
      expect(record).not.toHaveProperty(key);
    }
    expect(JSON.stringify(record)).not.toContain("123456789");
    expect(JSON.stringify(record)).not.toContain("query_id=secret");
  });

  it("scrubs secrets, URLs, and identifier-like numbers from allowed string fields", () => {
    logTelegramEvent({
      message: "bot 123456789 failed token=abc uuid 550e8400-e29b-41d4-a716-446655440000 hex deadbeef01234567 opaque AbCdEfGhIjKlMnOpQrStUv9x",
      action: "token=abc",
      reason: "chat 987654321 unavailable at https://example.com/?secret=x",
    });

    const serialized = JSON.stringify(parseLast(errorSpy));
    expect(serialized).not.toContain("123456789");
    expect(serialized).not.toContain("987654321");
    expect(serialized).not.toContain("token=abc");
    expect(serialized).not.toContain("example.com");
    expect(serialized).not.toContain("550e8400-e29b-41d4-a716-446655440000");
    expect(serialized).not.toContain("deadbeef01234567");
    expect(serialized).not.toContain("AbCdEfGhIjKlMnOpQrStUv9x");
    expect(serialized).toContain("[redacted-id]");
    expect(serialized).toContain("[redacted-secret]");
    expect(serialized).toContain("[redacted-url]");
  });

  it("drops non-finite, object, array, and unknown error-class values", () => {
    logTelegramEvent({
      message: "test",
      statusCode: Number.NaN,
      reason: { secret: "value" },
      rowCount: [1],
      errorClass: "Error: token=secret",
    } as never);

    const record = parseLast(errorSpy);
    expect(record.statusCode).toBeUndefined();
    expect(record.reason).toBeUndefined();
    expect(record.rowCount).toBeUndefined();
    expect(record.errorClass).toBe("unknown");
  });

});
