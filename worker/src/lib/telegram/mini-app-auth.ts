import { logWorkerEventArgs } from "../structured-log";
import { isRecord } from "@shared/lib/type-guards";
import {
  TELEGRAM_MINI_APP_PAYLOAD_PATTERN,
  TELEGRAM_STARTAPP_PAYLOAD_MAX_LENGTH,
} from "@shared/lib/telegram-mini-app-payloads";
import { bytesToHex } from "../hash";
import { timingSafeCompare } from "../auth";

export type TelegramMiniAppAuthErrorCode =
  | "invalid-auth"
  | "invalid-signature"
  | "stale-auth";

export class TelegramMiniAppAuthError extends Error {
  readonly code: TelegramMiniAppAuthErrorCode;
  readonly authContext: TelegramMiniAppAuthContext | null;

  constructor(code: TelegramMiniAppAuthErrorCode, authContext: TelegramMiniAppAuthContext | null = null) {
    super(code);
    this.name = "TelegramMiniAppAuthError";
    this.code = code;
    this.authContext = authContext;
  }
}

export interface TelegramMiniAppAuthContext {
  userId: string;
  username: string | null;
  firstName: string | null;
  chatType: string | null;
  startParam: string | null;
  authDate: number;
  initDataHash: string;
  canMutatePrivateChat: boolean;
}

interface ValidateTelegramMiniAppInitDataOptions {
  maxAgeSec: number;
  nowSec?: number;
}

const encoder = new TextEncoder();
const HASH_HEX_PATTERN = /^[0-9a-f]{64}$/i;
const KNOWN_MINI_APP_CHAT_TYPES = new Set(["private", "sender", "group", "supergroup", "channel"]);
const warnedNovelMiniAppChatTypes = new Set<string>();

async function hmacSha256(keyBytes: Uint8Array, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(keyBytes), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

function parseUser(rawUser: string | null): { id: string; username: string | null; firstName: string | null } {
  if (!rawUser) throw new TelegramMiniAppAuthError("invalid-auth");
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawUser);
  } catch {
    throw new TelegramMiniAppAuthError("invalid-auth");
  }
  if (!isRecord(parsed)) throw new TelegramMiniAppAuthError("invalid-auth");
  const rawId = parsed.id;
  if ((typeof rawId !== "number" && typeof rawId !== "string") || String(rawId).trim().length === 0) {
    throw new TelegramMiniAppAuthError("invalid-auth");
  }
  return {
    id: String(rawId),
    username: typeof parsed.username === "string" && parsed.username.trim() ? parsed.username : null,
    firstName: typeof parsed.first_name === "string" && parsed.first_name.trim() ? parsed.first_name : null,
  };
}

function isPrivateUserLaunchChatType(chatType: string | null): boolean {
  // Telegram uses "sender" for direct-link Mini App launches from the user's private context.
  return chatType === null || chatType === "private" || chatType === "sender";
}

export function resetTelegramMiniAppChatTypeWarningsForTests(): void {
  warnedNovelMiniAppChatTypes.clear();
}

function warnNovelMiniAppChatType(chatType: string | null): void {
  if (chatType == null || KNOWN_MINI_APP_CHAT_TYPES.has(chatType) || warnedNovelMiniAppChatTypes.has(chatType)) {
    return;
  }
  warnedNovelMiniAppChatTypes.add(chatType);
  logWorkerEventArgs("lib", "warn", `[telegram-mini-app-auth] novel chat_type received: ${chatType}`);
}

export async function validateTelegramMiniAppInitData(
  initData: string,
  botToken: string,
  options: ValidateTelegramMiniAppInitDataOptions,
  botTokenPrevious?: string,
): Promise<TelegramMiniAppAuthContext> {
  const params = new URLSearchParams(initData);
  const providedHash = params.get("hash");
  if (!providedHash) throw new TelegramMiniAppAuthError("invalid-auth");
  if (providedHash.length !== 64 || !HASH_HEX_PATTERN.test(providedHash)) {
    throw new TelegramMiniAppAuthError("invalid-auth");
  }

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("\n");
  const candidateTokens = [botToken, botTokenPrevious?.trim() ? botTokenPrevious : undefined]
    .filter((token): token is string => Boolean(token));
  let signatureValid = false;
  for (const token of candidateTokens) {
    const secret = await hmacSha256(encoder.encode("WebAppData"), token);
    const expectedHash = bytesToHex(await hmacSha256(secret, dataCheckString));
    if (await timingSafeCompare(expectedHash, providedHash)) {
      signatureValid = true;
      break;
    }
  }
  if (!signatureValid) {
    throw new TelegramMiniAppAuthError("invalid-signature");
  }

  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || authDate <= 0) {
    throw new TelegramMiniAppAuthError("invalid-auth");
  }
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  if (authDate > nowSec + 60) {
    throw new TelegramMiniAppAuthError("invalid-auth");
  }
  const user = parseUser(params.get("user"));
  const chatType = params.get("chat_type") || null;
  warnNovelMiniAppChatType(chatType);
  const rawStartParam = params.get("start_param");
  const startParam = rawStartParam != null &&
    rawStartParam.length > 0 &&
    rawStartParam.length <= TELEGRAM_STARTAPP_PAYLOAD_MAX_LENGTH &&
    TELEGRAM_MINI_APP_PAYLOAD_PATTERN.test(rawStartParam)
    ? rawStartParam
    : null;

  const authContext: TelegramMiniAppAuthContext = {
    userId: user.id,
    username: user.username,
    firstName: user.firstName,
    chatType,
    startParam,
    authDate,
    initDataHash: providedHash,
    canMutatePrivateChat: isPrivateUserLaunchChatType(chatType),
  };
  if (nowSec - authDate > options.maxAgeSec) {
    throw new TelegramMiniAppAuthError("stale-auth", authContext);
  }

  return authContext;
}
