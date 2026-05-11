import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logTelegramEvent } from "../telegram-log";

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
    const calls = spy.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const last = calls[calls.length - 1]?.[0];
    expect(typeof last).toBe("string");
    return JSON.parse(last as string) as Record<string, unknown>;
  }

  it("emits a single-line JSON record with the canonical shape", () => {
    logTelegramEvent({
      level: "warn",
      message: "snooze write failed",
      chatId: "12345",
      userId: "999",
      action: "snooze",
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();

    const record = parseLast(warnSpy);
    expect(record.scope).toBe("telegram");
    expect(record.level).toBe("warn");
    expect(record.message).toBe("snooze write failed");
    expect(record.chatId).toBe("12345");
    expect(record.userId).toBe("999");
    expect(record.action).toBe("snooze");
    expect(typeof record.ts).toBe("string");
    // ts should be parseable as an ISO timestamp
    expect(Number.isFinite(Date.parse(String(record.ts)))).toBe(true);
  });

  it("defaults level to error when not specified", () => {
    logTelegramEvent({ message: "callback_query failed" });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();

    const record = parseLast(errorSpy);
    expect(record.level).toBe("error");
    expect(record.scope).toBe("telegram");
    expect(record.message).toBe("callback_query failed");
    expect(record.chatId).toBeUndefined();
    expect(record.userId).toBeUndefined();
    expect(record.action).toBeUndefined();
  });

  it("coerces numeric chatId/userId to strings and skips empty values", () => {
    logTelegramEvent({
      level: "info",
      message: "test",
      chatId: 42,
      userId: 0,
      action: "",
    });

    const record = parseLast(infoSpy);
    expect(record.chatId).toBe("42");
    expect(record.userId).toBe("0");
    expect(record.action).toBeUndefined();
  });

  it("preserves additional context fields", () => {
    logTelegramEvent({
      message: "block strike registration failed",
      chatId: "777",
      action: "register-block-strike",
      err: "DB connection lost",
      attempts: 3,
    });

    const record = parseLast(errorSpy);
    expect(record.err).toBe("DB connection lost");
    expect(record.attempts).toBe(3);
  });

  it("omits null/undefined chat and user identifiers", () => {
    logTelegramEvent({
      level: "warn",
      message: "no chat context",
      chatId: null,
      userId: undefined,
    });

    const record = parseLast(warnSpy);
    expect(record.chatId).toBeUndefined();
    expect(record.userId).toBeUndefined();
  });
});
