import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetTelegramMiniAppChatTypeWarningsForTests,
  validateTelegramMiniAppInitData,
} from "../telegram-mini-app-auth";

const BOT_TOKEN = "123456:test-token";
const NOW_SEC = 1_800_000_000;
const encoder = new TextEncoder();

async function hmacSha256(keyBytes: Uint8Array, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signedInitData(fields: Record<string, string>): Promise<string> {
  const params = new URLSearchParams(fields);
  const check = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("\n");
  const secret = await hmacSha256(encoder.encode("WebAppData"), BOT_TOKEN);
  params.set("hash", hex(await hmacSha256(secret, check)));
  return params.toString();
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

    await expect(validateTelegramMiniAppInitData(initData, BOT_TOKEN, {
      maxAgeSec: 86_400,
      nowSec: NOW_SEC,
    })).resolves.toMatchObject({
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

    await expect(validateTelegramMiniAppInitData(initData, BOT_TOKEN, {
      maxAgeSec: 86_400,
      nowSec: NOW_SEC,
    })).resolves.toMatchObject({
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

    await expect(validateTelegramMiniAppInitData(initData, BOT_TOKEN, {
      maxAgeSec: 86_400,
      nowSec: NOW_SEC,
    })).resolves.toMatchObject({
      chatType: "business",
      canMutatePrivateChat: false,
    });
    await validateTelegramMiniAppInitData(initData, BOT_TOKEN, {
      maxAgeSec: 86_400,
      nowSec: NOW_SEC,
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[telegram-mini-app-auth] novel chat_type received: business"));
  });

  it("rejects tampered fields", async () => {
    const initData = await signedInitData({
      auth_date: String(NOW_SEC - 60),
      user: JSON.stringify({ id: 42, username: "alice" }),
    });
    await expect(validateTelegramMiniAppInitData(initData.replace("alice", "mallory"), BOT_TOKEN, {
      maxAgeSec: 86_400,
      nowSec: NOW_SEC,
    })).rejects.toMatchObject({ code: "invalid-signature" });
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

    await expect(validateTelegramMiniAppInitData(initData, BOT_TOKEN, {
      maxAgeSec: 86_400,
      nowSec: NOW_SEC,
    })).resolves.toMatchObject({ userId: "42", username: "alice" });
    await expect(validateTelegramMiniAppInitData(changedSignature, BOT_TOKEN, {
      maxAgeSec: 86_400,
      nowSec: NOW_SEC,
    })).rejects.toMatchObject({ code: "invalid-signature" });
  });

  it("rejects missing hash", async () => {
    const initData = new URLSearchParams({
      auth_date: String(NOW_SEC - 60),
      user: JSON.stringify({ id: 42 }),
    }).toString();

    await expect(validateTelegramMiniAppInitData(initData, BOT_TOKEN, {
      maxAgeSec: 86_400,
      nowSec: NOW_SEC,
    })).rejects.toMatchObject({ code: "invalid-auth" });
  });

  it("rejects missing auth_date after signature validation", async () => {
    const initData = await signedInitData({
      user: JSON.stringify({ id: 42 }),
    });

    await expect(validateTelegramMiniAppInitData(initData, BOT_TOKEN, {
      maxAgeSec: 86_400,
      nowSec: NOW_SEC,
    })).rejects.toMatchObject({ code: "invalid-auth" });
  });

  it("rejects malformed hash without HMAC compute", async () => {
    const initData = new URLSearchParams({
      auth_date: String(NOW_SEC - 60),
      hash: "abc",
      user: "{bad-json",
    }).toString();

    await expect(validateTelegramMiniAppInitData(initData, BOT_TOKEN, {
      maxAgeSec: 86_400,
      nowSec: NOW_SEC,
    })).rejects.toMatchObject({ code: "invalid-auth" });
  });

  it("rejects non-hex hashes of the correct length", async () => {
    const initData = new URLSearchParams({
      auth_date: String(NOW_SEC - 60),
      hash: "z".repeat(64),
      user: JSON.stringify({ id: 42 }),
    }).toString();

    await expect(validateTelegramMiniAppInitData(initData, BOT_TOKEN, {
      maxAgeSec: 86_400,
      nowSec: NOW_SEC,
    })).rejects.toMatchObject({ code: "invalid-auth" });
  });

  it("rejects future-dated auth_date as clock-skew guard", async () => {
    const initData = await signedInitData({
      auth_date: String(NOW_SEC + 120),
      chat_type: "private",
      user: JSON.stringify({ id: 42 }),
    });

    await expect(validateTelegramMiniAppInitData(initData, BOT_TOKEN, {
      maxAgeSec: 86_400,
      nowSec: NOW_SEC,
    })).rejects.toMatchObject({ code: "invalid-auth" });
  });

  it("ignores start_param with non-allowed charset", async () => {
    const initData = await signedInitData({
      auth_date: String(NOW_SEC - 60),
      chat_type: "private",
      start_param: "bad value!",
      user: JSON.stringify({ id: 42 }),
    });

    await expect(validateTelegramMiniAppInitData(initData, BOT_TOKEN, {
      maxAgeSec: 86_400,
      nowSec: NOW_SEC,
    })).resolves.toMatchObject({ startParam: null });
  });

  it("accepts Mini App start_param values longer than bot start payloads", async () => {
    const initData = await signedInitData({
      auth_date: String(NOW_SEC - 60),
      chat_type: "private",
      start_param: "a".repeat(65),
      user: JSON.stringify({ id: 42 }),
    });

    await expect(validateTelegramMiniAppInitData(initData, BOT_TOKEN, {
      maxAgeSec: 86_400,
      nowSec: NOW_SEC,
    })).resolves.toMatchObject({ startParam: "a".repeat(65) });
  });

  it("ignores start_param beyond the Mini App payload cap", async () => {
    const initData = await signedInitData({
      auth_date: String(NOW_SEC - 60),
      chat_type: "private",
      start_param: "a".repeat(513),
      user: JSON.stringify({ id: 42 }),
    });

    await expect(validateTelegramMiniAppInitData(initData, BOT_TOKEN, {
      maxAgeSec: 86_400,
      nowSec: NOW_SEC,
    })).resolves.toMatchObject({ startParam: null });
  });

  it("accepts initData signed by previous bot token when supplied", async () => {
    const PREVIOUS_TOKEN = "previous-bot-token";
    const params = new URLSearchParams({
      auth_date: String(NOW_SEC - 60),
      chat_type: "private",
      user: JSON.stringify({ id: 42 }),
    });
    const check = [...params.entries()]
      .map(([key, value]) => `${key}=${value}`)
      .sort()
      .join("\n");
    const secret = await hmacSha256(encoder.encode("WebAppData"), PREVIOUS_TOKEN);
    params.set("hash", hex(await hmacSha256(secret, check)));
    const initData = params.toString();

    await expect(validateTelegramMiniAppInitData(initData, BOT_TOKEN, {
      maxAgeSec: 86_400,
      nowSec: NOW_SEC,
    }, PREVIOUS_TOKEN)).resolves.toMatchObject({ userId: "42" });

    await expect(validateTelegramMiniAppInitData(initData, BOT_TOKEN, {
      maxAgeSec: 86_400,
      nowSec: NOW_SEC,
    })).rejects.toMatchObject({ code: "invalid-signature" });
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
    await expect(validateTelegramMiniAppInitData(initData, BOT_TOKEN, {
      maxAgeSec: 86_400,
      nowSec: NOW_SEC,
    })).rejects.toMatchObject({ code: "invalid-signature" });
  });
});
