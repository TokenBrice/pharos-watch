export type TelegramMiniAppAuthErrorCode =
  | "invalid-auth"
  | "invalid-signature"
  | "stale-auth";

export class TelegramMiniAppAuthError extends Error {
  readonly code: TelegramMiniAppAuthErrorCode;

  constructor(code: TelegramMiniAppAuthErrorCode) {
    super(code);
    this.name = "TelegramMiniAppAuthError";
    this.code = code;
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
const START_PARAM_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const HASH_HEX_PATTERN = /^[0-9a-f]{64}$/i;
const KNOWN_MINI_APP_CHAT_TYPES = new Set(["private", "sender", "group", "supergroup", "channel"]);
const warnedNovelMiniAppChatTypes = new Set<string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function hmacSha256(keyBytes: Uint8Array, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
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
  console.warn(`[telegram-mini-app-auth] novel chat_type received: ${chatType}`);
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
    .filter(([key]) => key !== "hash" && key !== "signature")
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("\n");
  const candidateTokens = [botToken, botTokenPrevious?.trim() ? botTokenPrevious : undefined]
    .filter((token): token is string => Boolean(token));
  let signatureValid = false;
  for (const token of candidateTokens) {
    const secret = await hmacSha256(encoder.encode("WebAppData"), token);
    const expectedHash = hex(await hmacSha256(secret, dataCheckString));
    if (constantTimeEqual(expectedHash, providedHash)) {
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
  if (nowSec - authDate > options.maxAgeSec) {
    throw new TelegramMiniAppAuthError("stale-auth");
  }

  const user = parseUser(params.get("user"));
  const chatType = params.get("chat_type") || null;
  warnNovelMiniAppChatType(chatType);
  const rawStartParam = params.get("start_param");
  const startParam = rawStartParam === null || rawStartParam === "" ? null : rawStartParam;
  if (startParam !== null && !START_PARAM_PATTERN.test(startParam)) {
    throw new TelegramMiniAppAuthError("invalid-auth");
  }

  return {
    userId: user.id,
    username: user.username,
    firstName: user.firstName,
    chatType,
    startParam,
    authDate,
    initDataHash: providedHash,
    canMutatePrivateChat: isPrivateUserLaunchChatType(chatType),
  };
}
