import { TELEGRAM_BOT_USERNAME } from "@shared/lib/telegram-bot-registration";
import { escapeHtml } from "../lib/telegram";
import { formatAdministratorMentions, getCachedChatAdministrators } from "../lib/telegram-chat-member";
import {
  CHAT_COMMAND_FLOOD_LIMIT,
  CHAT_COMMAND_FLOOD_WINDOW_SEC,
  GROUP_ADMIN_DIAGNOSTIC_COOLDOWN_SEC,
  GROUP_CHAT_COMMAND_FLOOD_LIMIT,
} from "../lib/telegram-constants";
import { classifyTelegramLogError, logTelegramEvent } from "../lib/telegram-log";
import { recordTelegramUsageEvent } from "../lib/telegram-usage-analytics";
import { isGroupAdminActor, isGroupChatType } from "./telegram-webhook-auth";
import { parseStartPayload } from "./telegram-webhook-parsing";
import type { ReplyFn } from "./telegram-webhook-pending-gate";
import {
  acquireTelegramCommandCooldown,
  recordTelegramChatCommandFlood,
  releaseTelegramCommandCooldown,
  unixNow,
  type TelegramChatCommandFloodResult,
} from "./telegram-webhook-store";

export type TelegramGroupAdminGating = "soft" | "hard";
export const TELEGRAM_GROUP_ADMIN_GATING: { mode: TelegramGroupAdminGating } = { mode: "hard" };

const GROUP_ADMIN_GATED_COMMANDS = new Set([
  "/subscribe", "/unsubscribe", "/set", "/mute", "/pause", "/forget",
  "/unmutehours", "/unsnooze", "/import",
]);
const PHAROS_BOT_USERNAMES = new Set([TELEGRAM_BOT_USERNAME.toLowerCase()]);
const COMMAND_COOLDOWNS_SEC: Record<string, number> = {
  "/brief": 30,
  "/top": 20,
  "/why": 20,
  "/status": 20,
  "/coverage": 20,
};
const CANONICAL_COMMAND_KEYS: Record<string, string> = { "/market": "/brief" };

type FloodScope = "actor" | "chat";

export function logTelegramWebhookWarning(message: string, action: string, err: unknown): void {
  logTelegramEvent({
    level: "warn",
    message,
    action,
    errorClass: classifyTelegramLogError(err),
  });
}

function floodScopesForUpdate(
  chatId: string,
  chatType: string,
  actorUserId: string | null,
): Array<{ key: string; scope: FloodScope; limit: number }> {
  if (isGroupChatType(chatType) && actorUserId) {
    return [
      { key: `${chatId}:actor:${actorUserId}`, scope: "actor", limit: CHAT_COMMAND_FLOOD_LIMIT },
      { key: chatId, scope: "chat", limit: GROUP_CHAT_COMMAND_FLOOD_LIMIT },
    ];
  }
  return [{ key: chatId, scope: "chat", limit: CHAT_COMMAND_FLOOD_LIMIT }];
}

export async function enforceIngressFlood(
  db: D1Database,
  input: {
    chatId: string;
    chatType: string;
    actorUserId: string | null;
    nowSec: number;
    actionDetail: string;
    noticeMessage: string;
    reply: ReplyFn;
  },
): Promise<boolean> {
  let blocked: { flood: TelegramChatCommandFloodResult; scope: FloodScope } | null = null;
  for (const floodScope of floodScopesForUpdate(input.chatId, input.chatType, input.actorUserId)) {
    try {
      const flood = await recordTelegramChatCommandFlood(db, {
        chatId: floodScope.key,
        nowSec: input.nowSec,
        windowSec: CHAT_COMMAND_FLOOD_WINDOW_SEC,
        limit: floodScope.limit,
      });
      if (!flood.allowed) {
        blocked = { flood, scope: floodScope.scope };
        break;
      }
    } catch (err) {
      logTelegramWebhookWarning("chat command flood check failed", "command-flood", err);
    }
  }
  if (!blocked) return true;

  if (blocked.flood.firstExceeded) {
    try {
      await input.reply(input.noticeMessage);
    } catch (err) {
      logTelegramWebhookWarning("chat command flood notice reply failed", "command-flood", err);
    }
  }
  try {
    await recordTelegramUsageEvent(db, {
      eventType: "command",
      actionDetail: input.actionDetail,
      outcome: "rate_limited",
      failureClass: blocked.scope === "actor" ? "actor-flood" : "chat-flood",
    });
  } catch (err) {
    logTelegramWebhookWarning("chat command flood usage record failed", "command-flood", err);
  }
  return false;
}

export async function releaseCommandCooldownBestEffort(
  db: D1Database,
  input: { chatId: string; commandKey: string; action: string; command: string },
): Promise<void> {
  try {
    await releaseTelegramCommandCooldown(db, { chatId: input.chatId, commandKey: input.commandKey });
  } catch (err) {
    logTelegramWebhookWarning("command cooldown release failed", input.action, err);
  }
}

export async function enforceCommandCooldown(
  db: D1Database,
  chatId: string,
  command: string,
  args: string,
  reply: (message: string) => Promise<void>,
): Promise<
  | { allowed: true; commandKey: string | null }
  | { allowed: false; commandKey: string | null; outcome: "rate_limited" | "failure"; failureClass: string | null }
> {
  const commandKey = effectiveCooldownCommandKey(command, args);
  const cooldownSec = resolveCommandCooldownSec(commandKey, args);
  if (cooldownSec == null) return { allowed: true, commandKey: null };
  let cooldown;
  try {
    cooldown = await acquireTelegramCommandCooldown(db, {
      chatId,
      commandKey,
      nowSec: unixNow(),
      cooldownSec,
    });
  } catch (err) {
    logTelegramWebhookWarning("command cooldown check failed", "command-cooldown", err);
    await reply("Command traffic is busy. Please try again shortly.");
    return { allowed: false, commandKey, outcome: "failure", failureClass: "cooldown-store-error" };
  }
  if (cooldown.allowed) return { allowed: true, commandKey };
  await reply(formatCommandCooldownMessage(commandKey, cooldown.retryAfterSec));
  return { allowed: false, commandKey, outcome: "rate_limited", failureClass: null };
}

function effectiveCooldownCommandKey(command: string, args: string): string {
  const commandKey = CANONICAL_COMMAND_KEYS[command] ?? command;
  if (commandKey !== "/start") return commandKey;
  const payload = parseStartPayload(args);
  if (payload.kind === "status") return "/status";
  if (payload.kind === "why") return "/why";
  if (payload.kind === "coverage") return "/coverage";
  return commandKey;
}

export function resolveCallbackCooldownCommandKey(data: string): string | null {
  const action = data.split(":")[0] ?? "";
  if (action === "status") return "/status";
  if (action === "why") return "/why";
  if (action === "coverage") return "/coverage";
  return null;
}

export function callbackActionDetail(data: string): string {
  return `callback:${data.split(":")[0] || "unknown"}`;
}

export function callbackMutatesChatState(data: string): boolean {
  const [action, subAction] = data.split(":");
  if (action === "status" || action === "why" || action === "coverage" || action === "help") return false;
  if (action === "settings" && (subAction === "home" || subAction === "o")) return false;
  return action !== "manage";
}

function resolveCommandCooldownSec(command: string, args: string): number | null {
  const cooldownSec = COMMAND_COOLDOWNS_SEC[command];
  if (cooldownSec == null) return null;
  if ((command === "/top" || command === "/why" || command === "/coverage" || command === "/status") && !args.trim()) {
    return null;
  }
  return cooldownSec;
}

function formatCommandCooldownMessage(command: string, retryAfterSec: number): string {
  const retryAfter = Math.max(1, Math.ceil(retryAfterSec));
  return `That command is doing heavier Pharos reads. Please try ${escapeHtml(command)} again in ${retryAfter} ${retryAfter === 1 ? "second" : "seconds"}.`;
}

export async function recordCommandUsage(
  db: D1Database,
  command: string,
  startedAtMs: number,
  outcome: string,
  failureClass: string | null = null,
): Promise<void> {
  await recordTelegramUsageEvent(db, {
    eventType: "command",
    actionDetail: command,
    outcome,
    latencyMs: Math.max(0, Date.now() - startedAtMs),
    failureClass,
  });
}

export async function maybeGateNonAdminGroupActor(
  db: D1Database,
  botToken: string,
  chatId: string,
  actorUserId: string | null,
  command: string,
  reply: (message: string) => Promise<void>,
): Promise<boolean> {
  if (actorUserId != null && await isGroupAdminActor(botToken, chatId, actorUserId)) return true;

  let cooldown;
  try {
    cooldown = await acquireTelegramCommandCooldown(db, {
      chatId,
      commandKey: "group-admin-diagnostics",
      nowSec: unixNow(),
      cooldownSec: GROUP_ADMIN_DIAGNOSTIC_COOLDOWN_SEC,
    });
  } catch (err) {
    logTelegramWebhookWarning("group admin diagnostic cooldown check failed", "group-admin-diagnostics", err);
    await reply("Group permission checks are busy. Please try again shortly.");
    return false;
  }
  if (!cooldown.allowed) {
    await reply(`I just checked group permissions for this chat. Please try again in ${cooldown.retryAfterSec} seconds.`);
    await recordTelegramUsageEvent(db, {
      eventType: "group_admin_denial",
      actionDetail: command,
      outcome: "rate_limited",
    });
    return false;
  }

  const admins = await getCachedChatAdministrators(db, botToken, chatId);
  const adminLine = admins ? formatAdminHint(admins) : "";
  await reply(escapeHtml(`Only group admins can ${command}.${adminLine}`));
  await recordTelegramUsageEvent(db, {
    eventType: "group_admin_denial",
    actionDetail: command,
    outcome: TELEGRAM_GROUP_ADMIN_GATING.mode === "hard" ? "denied" : "warned",
  });
  return TELEGRAM_GROUP_ADMIN_GATING.mode !== "hard";
}

export function commandRequiresGroupAdmin(command: string, args: string): boolean {
  if (GROUP_ADMIN_GATED_COMMANDS.has(command)) return true;
  return command === "/timezone" && args.trim().length > 0;
}

function formatAdminHint(admins: Awaited<ReturnType<typeof getCachedChatAdministrators>>): string {
  if (!admins || admins.length === 0) return "";
  const adminLabels = formatAdministratorMentions(admins).split(", ").filter(Boolean);
  if (adminLabels.length === 0) return "";
  const shown = adminLabels.slice(0, 3);
  const overflow = adminLabels.length > shown.length ? ` and ${adminLabels.length - shown.length} more` : "";
  return ` Ask ${shown.join(", ")}${overflow}.`;
}

export function isAddressedToPharosBot(botMention: string | null): boolean {
  return botMention != null && PHAROS_BOT_USERNAMES.has(botMention);
}
