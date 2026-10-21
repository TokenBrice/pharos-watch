import { TELEGRAM_BOT_USERNAME } from "@shared/lib/telegram-bot-registration";
import { escapeHtml } from "../delivery/telegram";
import { CHAT_COMMAND_FLOOD_LIMIT, CHAT_COMMAND_FLOOD_WINDOW_SEC } from "../common/constants";
import { classifyTelegramLogError, logTelegramEvent } from "../common/log";
import { recordTelegramUsageEvent } from "../store/usage-analytics";
import {
  GROUP_ADMIN_UNVERIFIED_MESSAGE,
  formatAdministratorMentions,
  getCachedChatAdministrators,
  resolveGroupAdminStatus,
} from "./telegram-webhook-auth";
import { parseStartPayload } from "./telegram-webhook-parsing";
import { recordTelegramChatCommandFlood } from "../store/processed-updates";

export type ReplyFn = (message: string) => Promise<void>;

export type TelegramGroupAdminGating = "soft" | "hard";
export const TELEGRAM_GROUP_ADMIN_GATING: { mode: TelegramGroupAdminGating } = { mode: "hard" };

/**
 * `requiresGroupAdmin` gates dispatch in groups. `mutation` records whether the
 * command changes chat state; mutating `/start` deep links authorize inside the
 * handler instead of here.
 */
export interface TelegramCommandPolicy {
  requiresGroupAdmin: boolean;
  mutation: "none" | "required";
}

const READ_COMMAND_POLICY: Readonly<TelegramCommandPolicy> = { requiresGroupAdmin: false, mutation: "none" };
const MUTATING_COMMAND_POLICY: Readonly<TelegramCommandPolicy> = { requiresGroupAdmin: true, mutation: "required" };
const START_MUTATION_POLICY: Readonly<TelegramCommandPolicy> = { requiresGroupAdmin: false, mutation: "required" };

// Explicit coverage is checked against COMMAND_HANDLERS, including retired
// commands and aliases (commands/legacy.ts). An alias that forwards to a
// mutating command keeps the mutating policy.
export const TELEGRAM_COMMAND_POLICIES: Readonly<Record<string, Readonly<TelegramCommandPolicy>>> = {
  "/start": READ_COMMAND_POLICY,
  "/help": READ_COMMAND_POLICY,
  "/sample": READ_COMMAND_POLICY,
  "/list": READ_COMMAND_POLICY,
  "/status": READ_COMMAND_POLICY,
  "/subscribe": MUTATING_COMMAND_POLICY,
  "/unsubscribe": MUTATING_COMMAND_POLICY,
  "/settings": READ_COMMAND_POLICY,
  "/pause": MUTATING_COMMAND_POLICY,
  "/forget": MUTATING_COMMAND_POLICY,
  // Legacy aliases.
  "/unsnooze": MUTATING_COMMAND_POLICY,
  "/health": READ_COMMAND_POLICY,
  "/subscriptions": READ_COMMAND_POLICY,
  "/why": READ_COMMAND_POLICY,
  "/coverage": READ_COMMAND_POLICY,
  // Retired commands answer with a pointer and change nothing.
  "/set": READ_COMMAND_POLICY,
  "/mute": READ_COMMAND_POLICY,
  "/unmutehours": READ_COMMAND_POLICY,
  "/timezone": READ_COMMAND_POLICY,
  "/cancel": READ_COMMAND_POLICY,
  "/presets": READ_COMMAND_POLICY,
  "/top": READ_COMMAND_POLICY,
  "/brief": READ_COMMAND_POLICY,
  "/market": READ_COMMAND_POLICY,
  "/recap": READ_COMMAND_POLICY,
  "/export": READ_COMMAND_POLICY,
  "/import": READ_COMMAND_POLICY,
  "/add": READ_COMMAND_POLICY,
};

export function classifyTelegramCommand(command: string, args: string): Readonly<TelegramCommandPolicy> {
  if (command === "/start" && isMutatingTelegramStartPayload(args)) return START_MUTATION_POLICY;
  return TELEGRAM_COMMAND_POLICIES[command] ?? READ_COMMAND_POLICY;
}
const PHAROS_BOT_USERNAMES = new Set([TELEGRAM_BOT_USERNAME.toLowerCase()]);

function isMutatingTelegramStartPayload(args: string): boolean {
  const payload = parseStartPayload(args);
  switch (payload.kind) {
    case "none":
    case "setup":
    case "subscribe":
      return true;
    case "sample":
    case "app":
    case "status":
    case "why":
    case "coverage":
      return false;
    default: {
      const unhandled: never = payload;
      throw new Error(`Unclassified /start payload: ${JSON.stringify(unhandled)}`);
    }
  }
}

export function logTelegramWebhookWarning(message: string, action: string, err: unknown): void {
  logTelegramEvent({
    level: "warn",
    message,
    action,
    errorClass: classifyTelegramLogError(err),
  });
}

/**
 * One fixed-window counter per chat across commands, callbacks and pending
 * text replies. A failed counter read fails closed with a busy reply.
 */
export async function enforceIngressFlood(
  db: D1Database,
  input: {
    chatId: string;
    nowSec: number;
    actionDetail: string;
    noticeMessage: string;
    reply: ReplyFn;
  },
): Promise<boolean> {
  let flood;
  try {
    flood = await recordTelegramChatCommandFlood(db, {
      chatId: input.chatId,
      nowSec: input.nowSec,
      windowSec: CHAT_COMMAND_FLOOD_WINDOW_SEC,
      limit: CHAT_COMMAND_FLOOD_LIMIT,
    });
  } catch (err) {
    logTelegramWebhookWarning("chat command flood check failed", "command-flood", err);
    try {
      await input.reply("Command traffic is busy. Please try again shortly.");
    } catch (replyErr) {
      logTelegramWebhookWarning("chat command flood unavailable reply failed", "command-flood", replyErr);
    }
    return false;
  }
  if (flood.allowed) return true;

  if (flood.firstExceeded) {
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
      failureClass: "chat-flood",
    });
  } catch (err) {
    logTelegramWebhookWarning("chat command flood usage record failed", "command-flood", err);
  }
  return false;
}

export function callbackActionDetail(data: string): string {
  return `callback:${data.split(":")[0] || "unknown"}`;
}

const MUTATING_CALLBACK_SUBACTIONS: Readonly<Record<string, readonly string[]>> = {
  pick: ["su", "un"],
  bulk: ["sa", "ua"],
  forget: ["yes"],
  setup: ["top25", "undo"],
};
// Retired keyboards (tz, coverage, manage, unsub, select, why, confirm,
// cancel) only answer with a legacy reply.
const READ_ONLY_CALLBACK_ACTIONS = new Set([
  "status", "help", "why", "coverage", "manage", "unsub", "select", "tz", "confirm", "cancel",
]);

/** Used to refuse channel-originated mutations before any handler runs. */
export function callbackMutatesChatState(data: string): boolean {
  const [action = "", subAction = ""] = data.split(":");
  const mutatingSubActions = MUTATING_CALLBACK_SUBACTIONS[action];
  if (mutatingSubActions) return mutatingSubActions.includes(subAction);
  if (READ_ONLY_CALLBACK_ACTIONS.has(action)) return false;
  if (action === "settings") return subAction !== "home" && subAction !== "o";
  return true;
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

/**
 * Admin gate for group-wide mutations. An anonymous admin posts as the group
 * itself (`sender_chat` is the group), which only admins can do. A failed
 * admin lookup asks the actor to retry instead of claiming they are not an
 * admin.
 */
export async function maybeGateNonAdminGroupActor(
  db: D1Database,
  botToken: string,
  chatId: string,
  actorUserId: string | null,
  command: string,
  reply: ReplyFn,
  options: { postedAsGroup?: boolean } = {},
): Promise<boolean> {
  if (options.postedAsGroup) return true;
  const status = await resolveGroupAdminStatus(botToken, chatId, actorUserId);
  if (status === "admin") return true;
  if (status === "unknown") {
    await reply(GROUP_ADMIN_UNVERIFIED_MESSAGE);
    await recordTelegramUsageEvent(db, {
      eventType: "group_admin_denial",
      actionDetail: command,
      outcome: "failure",
      failureClass: "admin-lookup-failed",
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
