import { describe, expect, it } from "vitest";
import { validateTelegramMiniAppInitData } from "../telegram-mini-app-auth";

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
    .filter(([key]) => key !== "hash" && key !== "signature")
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("\n");
  const secret = await hmacSha256(encoder.encode("WebAppData"), BOT_TOKEN);
  params.set("hash", hex(await hmacSha256(secret, check)));
  return params.toString();
}

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

  it("excludes Telegram signature from the HMAC data check", async () => {
    const initData = await signedInitData({
      auth_date: String(NOW_SEC - 60),
      signature: "telegram-ed25519-signature",
      user: JSON.stringify({ id: 42, username: "alice" }),
    });
    const changedSignature = initData.replace("telegram-ed25519-signature", "changed-transport-signature");

    await expect(validateTelegramMiniAppInitData(changedSignature, BOT_TOKEN, {
      maxAgeSec: 86_400,
      nowSec: NOW_SEC,
    })).resolves.toMatchObject({ userId: "42", username: "alice" });
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

  it("rejects unequal-length hashes without parsing user JSON", async () => {
    const initData = new URLSearchParams({
      auth_date: String(NOW_SEC - 60),
      hash: "abc",
      user: "{bad-json",
    }).toString();

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
