import {
  TELEGRAM_MINI_APP_PAYLOAD_PATTERN,
  TELEGRAM_START_PAYLOAD_MAX_LENGTH,
} from "@shared/lib/telegram-mini-app-payloads";

/** Pure command and `/start` deep-link parsing; no I/O. */

export function parseCommand(text: string): { command: string; args: string; botMention: string | null } {
  const separatorIdx = text.search(/\s/);
  const commandToken = separatorIdx === -1 ? text : text.slice(0, separatorIdx);
  const mentionIdx = commandToken.indexOf("@");
  const rawCommand = mentionIdx === -1 ? commandToken : commandToken.slice(0, mentionIdx);
  const rawMention = mentionIdx === -1 ? "" : commandToken.slice(mentionIdx + 1);
  const command = rawCommand.toLowerCase();
  const botMention = rawMention ? rawMention.toLowerCase() : null;
  const args = separatorIdx === -1 ? "" : text.slice(separatorIdx + 1).trim();
  return { command, args, botMention };
}

export type ParsedStartPayload =
  | { kind: "none" }
  | { kind: "setup" }
  | { kind: "sample" }
  | { kind: "app" }
  | { kind: "subscribe"; args: string }
  | { kind: "status"; coinId: string }
  | { kind: "why"; coinId: string }
  | { kind: "coverage"; coinId: string };

/**
 * Parse a Telegram `/start <payload>` deep-link payload into a typed action.
 * Payload schemes (all lowercase, no spaces):
 * - `sub_<types>_<targets>` (e.g. `sub_dews-depeg_usd-top25`) → subscribe
 * - `status_<id>` / `why_<id>` / `coverage_<id>` → read-only insights
 * - `setup` → setup wizard placeholder
 * - `sample` → synthetic `/sample` preview (private-chat-only)
 * - `app` / `home` → Mini App launch nudge (see registry in
 *   `@shared/lib/telegram-mini-app-payloads`)
 * Unknown or malformed payloads return `{ kind: "none" }`.
 *
 * Charset/length constraints are sourced from
 * `@shared/lib/telegram-mini-app-payloads` so the worker `?start=` parser and
 * the Mini App `?startapp=` parser stay aligned.
 */
export function parseStartPayload(args: string): ParsedStartPayload {
  const payload = args.trim();
  if (!payload) return { kind: "none" };
  if (payload.length > TELEGRAM_START_PAYLOAD_MAX_LENGTH) return { kind: "none" };
  if (!TELEGRAM_MINI_APP_PAYLOAD_PATTERN.test(payload)) return { kind: "none" };

  const lower = payload.toLowerCase();
  if (lower === "setup") return { kind: "setup" };
  if (lower === "sample") return { kind: "sample" };
  if (lower === "app" || lower === "home") return { kind: "app" };

  const firstSep = lower.indexOf("_");
  if (firstSep === -1) return { kind: "none" };
  const prefix = lower.slice(0, firstSep);
  const rest = lower.slice(firstSep + 1);
  if (!rest) return { kind: "none" };

  if (prefix === "sub") {
    const typesSep = rest.indexOf("_");
    if (typesSep === -1) return { kind: "none" };
    const types = rest.slice(0, typesSep);
    const targets = rest.slice(typesSep + 1);
    if (!types || !targets) return { kind: "none" };
    const subscribeArgs = `${types.split("-").join(" ")} ${targets}`.trim();
    return { kind: "subscribe", args: subscribeArgs };
  }

  if (prefix === "status" || prefix === "why" || prefix === "coverage") {
    return { kind: prefix, coinId: rest };
  }

  return { kind: "none" };
}
