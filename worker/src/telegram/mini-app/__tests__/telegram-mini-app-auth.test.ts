import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetTelegramMiniAppChatTypeWarningsForTests,
  validateTelegramMiniAppInitData,
} from "../mini-app-auth";
import { BOT_TOKEN, NOW_SEC, signedInitData } from "./telegram-mini-app.test-support.ts";

/** Validation inside the 24h session window at the fixture clock. */
function validate(initData: string, previousBotToken?: string) {
  return validateTelegramMiniAppInitData(initData, BOT_TOKEN, { maxAgeSec: 86_400, nowSec: NOW_SEC }, previousBotToken);
}

afterEach(() => {
  resetTelegramMiniAppChatTypeWarningsForTests();
  vi.restoreAllMocks();
});

describe("validateTelegramMiniAppInitData", () => {
  it("accepts valid initData", async () => {
    const initData = await signedInitData({
      auth_date: String(NOW_SEC - 60),
      chat_type: "private",
      start_param: "settings",
      user: JSON.stringify({ id: 42, username: "alice", first_name: "Alice" }),
    });

    await expect(validate(initData)).resolves.toMatchObject({
      userId: "42",
      username: "alice",
      firstName: "Alice",
      chatType: "private",
      startParam: "settings",
      canMutatePrivateChat: true,
    });
  });

  it("treats Telegram direct-link sender launches as private-user launches", async () => {
    const initData = await signedInitData({
      auth_date: String(NOW_SEC - 60),
      chat_type: "sender",
      user: JSON.stringify({ id: 42, username: "alice" }),
    });

    await expect(validate(initData)).resolves.toMatchObject({
      userId: "42",
      chatType: "sender",
      canMutatePrivateChat: true,
    });
  });

  it("logs a one-shot warning for novel non-null chat types", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const initData = await signedInitData({
      auth_date: String(NOW_SEC - 60),
      chat_type: "business",
      user: JSON.stringify({ id: 42, username: "alice" }),
    });

    await expect(validate(initData)).resolves.toMatchObject({
      chatType: "business",
      canMutatePrivateChat: false,
    });
    await validate(initData);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[telegram-mini-app-auth] novel chat_type received: business"));
  });

  it("rejects tampered fields", async () => {
    const initData = await signedInitData({
      auth_date: String(NOW_SEC - 60),
      user: JSON.stringify({ id: 42, username: "alice" }),
    });
    await expect(validate(initData.replace("alice", "mallory"))).rejects.toMatchObject({ code: "invalid-signature" });
  });

  it("includes Telegram `signature` in the bot HMAC data check", async () => {
    // For bot-token validation, Telegram signs all received fields except
    // `hash`. The `signature` exclusion applies only to third-party Ed25519
    // validation, so mutating it must invalidate the bot HMAC.
    const initData = await signedInitData({
      auth_date: String(NOW_SEC - 60),
      signature: "telegram-ed25519-signature",
      user: JSON.stringify({ id: 42, username: "alice" }),
    });
    const changedSignature = initData.replace("telegram-ed25519-signature", "changed-transport-signature");

    await expect(validate(initData)).resolves.toMatchObject({ userId: "42", username: "alice" });
    await expect(validate(changedSignature)).rejects.toMatchObject({ code: "invalid-signature" });
  });

  it("rejects missing hash", async () => {
    const initData = new URLSearchParams({
      auth_date: String(NOW_SEC - 60),
      user: JSON.stringify({ id: 42 }),
    }).toString();

    await expect(validate(initData)).rejects.toMatchObject({ code: "invalid-auth" });
  });

  it("rejects missing auth_date after signature validation", async () => {
    const initData = await signedInitData({
      user: JSON.stringify({ id: 42 }),
    });

    await expect(validate(initData)).rejects.toMatchObject({ code: "invalid-auth" });
  });

  it("rejects malformed hash without HMAC compute", async () => {
    const initData = new URLSearchParams({
      auth_date: String(NOW_SEC - 60),
      hash: "abc",
      user: "{bad-json",
    }).toString();

    await expect(validate(initData)).rejects.toMatchObject({ code: "invalid-auth" });
  });

  it("rejects non-hex hashes of the correct length", async () => {
    const initData = new URLSearchParams({
      auth_date: String(NOW_SEC - 60),
      hash: "z".repeat(64),
      user: JSON.stringify({ id: 42 }),
    }).toString();

    await expect(validate(initData)).rejects.toMatchObject({ code: "invalid-auth" });
  });

  it("rejects future-dated auth_date as clock-skew guard", async () => {
    const initData = await signedInitData({
      auth_date: String(NOW_SEC + 120),
      chat_type: "private",
      user: JSON.stringify({ id: 42 }),
    });

    await expect(validate(initData)).rejects.toMatchObject({ code: "invalid-auth" });
  });

  it("ignores start_param with non-allowed charset", async () => {
    const initData = await signedInitData({
      auth_date: String(NOW_SEC - 60),
      chat_type: "private",
      start_param: "bad value!",
      user: JSON.stringify({ id: 42 }),
    });

    await expect(validate(initData)).resolves.toMatchObject({ startParam: null });
  });

  it("accepts Mini App start_param values longer than bot start payloads", async () => {
    const initData = await signedInitData({
      auth_date: String(NOW_SEC - 60),
      chat_type: "private",
      start_param: "a".repeat(65),
      user: JSON.stringify({ id: 42 }),
    });

    await expect(validate(initData)).resolves.toMatchObject({ startParam: "a".repeat(65) });
  });

  it("ignores start_param beyond the Mini App payload cap", async () => {
    const initData = await signedInitData({
      auth_date: String(NOW_SEC - 60),
      chat_type: "private",
      start_param: "a".repeat(513),
      user: JSON.stringify({ id: 42 }),
    });

    await expect(validate(initData)).resolves.toMatchObject({ startParam: null });
  });

  it("accepts initData signed by previous bot token when supplied", async () => {
    const PREVIOUS_TOKEN = "previous-bot-token";
    const initData = await signedInitData({
      auth_date: String(NOW_SEC - 60),
      chat_type: "private",
      user: JSON.stringify({ id: 42 }),
    }, PREVIOUS_TOKEN);

    await expect(validate(initData, PREVIOUS_TOKEN)).resolves.toMatchObject({ userId: "42" });

    await expect(validate(initData)).rejects.toMatchObject({ code: "invalid-signature" });
  });

  it("rejects stale auth_date", async () => {
    const initData = await signedInitData({
      auth_date: String(NOW_SEC - 901),
      user: JSON.stringify({ id: 42 }),
    });
    await expect(validateTelegramMiniAppInitData(initData, BOT_TOKEN, {
      maxAgeSec: 900,
      nowSec: NOW_SEC,
    })).rejects.toMatchObject({ code: "stale-auth" });
  });

  it("does not parse user JSON before signature validation", async () => {
    const initData = new URLSearchParams({
      auth_date: String(NOW_SEC - 60),
      hash: "0".repeat(64),
      user: "{bad-json",
    }).toString();
    await expect(validate(initData)).rejects.toMatchObject({ code: "invalid-signature" });
  });

  it("blocks mutations when signed chat object is non-private or malformed JSON", async () => {
    for (const [fields, expected] of [
      [{ chat: JSON.stringify({ id: -1001, type: "supergroup" }) }, { canMutatePrivateChat: false, chatType: "supergroup" }],
      [{ chat_type: "private", chat: JSON.stringify({ id: -1001, type: "group" }) }, { canMutatePrivateChat: false, chatType: "group" }],
      [{ chat: "{bad-json" }, { canMutatePrivateChat: false, chatType: "unknown-chat" }],
      [{ chat: JSON.stringify({ id: -1001 }) }, { canMutatePrivateChat: false, chatType: "unknown-chat" }],
      [{ chat: JSON.stringify({ id: 42, type: "private" }) }, { canMutatePrivateChat: true, chatType: "private" }],
    ] as const) {
      const initData = await signedInitData({ auth_date: String(NOW_SEC - 60), user: JSON.stringify({ id: 42 }), ...fields });
      await expect(validate(initData)).resolves.toMatchObject(expected);
    }
  });
});
