import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyTelegramLogError,
  logTelegramEvent,
  normalizeTelegramLogErrorClass,
} from "../telegram/log";

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

  it("emits only the canonical low-cardinality shape", () => {
    logTelegramEvent({
      level: "warn",
      message: "pending send failed",
      action: "pending-send",
      module: "telegram-pending",
      errorClass: "rate_limit",
      statusCode: 429,
      retryAfterSec: 30,
      rowCount: 2,
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    const record = parseLast(warnSpy);
    expect(record).toMatchObject({
      scope: "telegram",
      level: "warn",
      message: "pending send failed",
      action: "pending-send",
      module: "telegram-pending",
      errorClass: "rate_limit",
      statusCode: 429,
      retryAfterSec: 30,
      rowCount: 2,
    });
    expect(Number.isFinite(Date.parse(String(record.ts)))).toBe(true);
  });

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

  it("defaults level to error and normalizes error classes to a fixed vocabulary", () => {
    logTelegramEvent({ message: "callback acknowledgement failed" });
    expect(parseLast(errorSpy).level).toBe("error");
    expect(normalizeTelegramLogErrorClass("rate_limit")).toBe("rate_limit");
    expect(normalizeTelegramLogErrorClass("DatabaseError: secret")).toBe("unknown");
    expect(classifyTelegramLogError(new DOMException("cancelled", "AbortError"))).toBe("abort");
    expect(classifyTelegramLogError(new Error("D1 database unavailable"))).toBe("d1");
    expect(classifyTelegramLogError(new Error("opaque"))).toBe("unknown");
  });
});
