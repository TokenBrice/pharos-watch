#!/usr/bin/env tsx
/// <reference types="@cloudflare/workers-types" />
/**
 * Manual recovery tool for forcing Telegram Bot API state outside the
 * Worker's 15-minute reconciliation loop. Replaces three shell scripts that
 * duplicated command/profile/webhook payloads by hand.
 *
 * Canonical command/profile/update payloads live in
 * shared/lib/telegram-bot-registration.ts. Normal deploys reconcile
 * automatically through the Worker; this script exists for the cases where
 * reconciliation is unavailable or needs to be forced immediately.
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=... tsx scripts/maintenance/register-telegram.ts --action commands
 *   TELEGRAM_BOT_TOKEN=... tsx scripts/maintenance/register-telegram.ts --action profile
 *   TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... tsx scripts/maintenance/register-telegram.ts --action webhook
 *   TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... tsx scripts/maintenance/register-telegram.ts --action all
 *   TELEGRAM_BOT_TOKEN=... tsx scripts/maintenance/register-telegram.ts --check   # dry run, print payloads
 *
 * Command scope (only meaningful for --action commands):
 *   --scope default              setMyCommands default scope
 *   --scope all_private_chats    setMyCommands all_private_chats (PRIVATE_COMMANDS)
 *   --scope all_group_chats      setMyCommands all_group_chats  (GROUP_COMMANDS)
 *   --scope chat --chat-id <id>  setMyCommands chat scope for a single chat
 *   (omit --scope to register both all_private_chats and all_group_chats, as
 *    the original register-telegram-commands.sh did)
 *
 * Secrets must be provided through TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET.
 * Optional non-secret env: WEBHOOK_BASE_URL.
 */
import process from "node:process";
import {
  TELEGRAM_ALLOWED_UPDATES,
  TELEGRAM_BOT_COMMANDS,
  TELEGRAM_BOT_DESCRIPTION,
  TELEGRAM_BOT_GROUP_COMMANDS,
  TELEGRAM_BOT_NAME,
  TELEGRAM_BOT_SHORT_DESCRIPTION,
} from "@shared/lib/telegram-bot-registration";
import { API_ORIGIN } from "@shared/lib/runtime-origins";
import {
  assertCliUsage,
  parseCliInteger,
  parseStrictCliArgs,
  runCliEntrypoint,
  writeCliHelpIfRequested,
} from "../lib/cli-args.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const USAGE = `Usage: npx tsx scripts/maintenance/register-telegram.ts [options]

Options:
  --action <commands|profile|webhook|all>  Registration action (default: commands)
  --scope <scope>                          Command scope
  --chat-id <id>                           Chat id when --scope chat is selected
  --webhook-base-url <url>                 Override WEBHOOK_BASE_URL
  --dry-run                                Print redacted payloads without Bot API calls
  --check                                  Legacy alias for --dry-run
  -h, --help                               Show this help`;

type Action = "commands" | "profile" | "webhook" | "all";
type CommandScopeKind = "default" | "all_private_chats" | "all_group_chats" | "chat";

export interface TelegramRegistrationCliOptions {
  action: Action;
  botToken: string | null;
  webhookSecret: string | null;
  webhookBaseUrl: string;
  scope: CommandScopeKind | null;
  chatId: string | null;
  dryRun: boolean;
  help: boolean;
}

export function parseTelegramRegistrationArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): TelegramRegistrationCliOptions {
  const { values } = parseStrictCliArgs(argv, {
    allowNegativeValues: ["chat-id"],
    conflicts: [["check", "dry-run"]],
    options: {
      action: { type: "string" },
      "chat-id": { type: "string" },
      check: { type: "boolean" },
      "dry-run": { type: "boolean" },
      scope: { type: "string" },
      "webhook-base-url": { type: "string" },
    },
  });
  const rawAction = values.action ?? "commands";
  const rawScope = values.scope ?? null;
  const help = values.help === true;
  if (!help) {
    assertCliUsage(
      rawAction === "commands" || rawAction === "profile" || rawAction === "webhook" || rawAction === "all",
      `--action must be one of commands|profile|webhook|all (got: ${rawAction})`,
    );
    assertCliUsage(
      rawScope === null || rawScope === "default" || rawScope === "all_private_chats"
        || rawScope === "all_group_chats" || rawScope === "chat",
      `--scope must be one of default|all_private_chats|all_group_chats|chat (got: ${rawScope})`,
    );
    assertCliUsage(
      rawScope !== "chat" || typeof values["chat-id"] === "string",
      "--scope chat requires --chat-id <id>",
    );
    assertCliUsage(
      values["chat-id"] === undefined || rawScope === "chat",
      "--chat-id requires --scope chat",
    );
    assertCliUsage(
      rawScope === null || rawAction === "commands" || rawAction === "all",
      "--scope is only valid with --action commands or --action all",
    );
    assertCliUsage(
      values["webhook-base-url"] === undefined || rawAction === "webhook" || rawAction === "all",
      "--webhook-base-url is only valid with --action webhook or --action all",
    );
    if (typeof values["chat-id"] === "string") {
      parseCliInteger(values["chat-id"], {
        name: "--chat-id",
        min: Number.MIN_SAFE_INTEGER,
        max: Number.MAX_SAFE_INTEGER,
      });
    }
  }

  return {
    action: rawAction as Action,
    botToken: env.TELEGRAM_BOT_TOKEN?.trim() || null,
    webhookSecret: env.TELEGRAM_WEBHOOK_SECRET?.trim() || null,
    webhookBaseUrl: typeof values["webhook-base-url"] === "string"
      ? values["webhook-base-url"]
      : env.WEBHOOK_BASE_URL?.trim() || API_ORIGIN,
    scope: rawScope as CommandScopeKind | null,
    chatId: typeof values["chat-id"] === "string" ? values["chat-id"] : null,
    dryRun: values.check === true || values["dry-run"] === true,
    help,
  };
}

interface CommandPayload {
  commands: ReadonlyArray<{ command: string; description: string }>;
  scope: { type: string; chat_id?: number };
}

function buildCommandPayloads(
  scope: CommandScopeKind | null,
  chatId: string | null,
): CommandPayload[] {
  if (scope === null) {
    return [
      { commands: TELEGRAM_BOT_COMMANDS, scope: { type: "all_private_chats" } },
      { commands: TELEGRAM_BOT_GROUP_COMMANDS, scope: { type: "all_group_chats" } },
    ];
  }
  if (scope === "all_private_chats") {
    return [{ commands: TELEGRAM_BOT_COMMANDS, scope: { type: "all_private_chats" } }];
  }
  if (scope === "all_group_chats") {
    return [{ commands: TELEGRAM_BOT_GROUP_COMMANDS, scope: { type: "all_group_chats" } }];
  }
  if (scope === "default") {
    return [{ commands: TELEGRAM_BOT_COMMANDS, scope: { type: "default" } }];
  }
  // scope === "chat"
  const numericChatId = parseCliInteger(chatId, {
    name: "--chat-id",
    min: Number.MIN_SAFE_INTEGER,
    max: Number.MAX_SAFE_INTEGER,
  });
  return [
    { commands: TELEGRAM_BOT_COMMANDS, scope: { type: "chat", chat_id: numericChatId } },
  ];
}

interface ProfileCall {
  method: "setMyName" | "setMyShortDescription" | "setMyDescription";
  payload: Record<string, string>;
}

function buildProfileCalls(): ProfileCall[] {
  return [
    { method: "setMyName", payload: { name: TELEGRAM_BOT_NAME } },
    {
      method: "setMyShortDescription",
      payload: { short_description: TELEGRAM_BOT_SHORT_DESCRIPTION },
    },
    { method: "setMyDescription", payload: { description: TELEGRAM_BOT_DESCRIPTION } },
  ];
}

interface WebhookPayload {
  url: string;
  secret_token: string;
  allowed_updates: string[];
}

function buildWebhookPayload(baseUrl: string, secret: string): WebhookPayload {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/telegram-webhook`;
  if (!url.startsWith("https://")) {
    throw new Error(`webhook URL must use https:// (got: ${url})`);
  }
  return {
    url,
    secret_token: secret,
    allowed_updates: [...TELEGRAM_ALLOWED_UPDATES],
  };
}

interface BotApiResponse {
  ok?: boolean;
  description?: string;
  error_code?: number;
}

function isNotModifiedDescription(description: string | undefined): boolean {
  return Boolean(description && /is not modified/i.test(description));
}

async function callBotApi(
  botToken: string,
  method: string,
  payload: unknown,
): Promise<BotApiResponse> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let parsed: BotApiResponse | null = null;
  try {
    parsed = JSON.parse(text) as BotApiResponse;
  } catch {
    parsed = null;
  }
  if (parsed?.ok === true) return parsed;
  if (parsed && isNotModifiedDescription(parsed.description)) {
    console.log(`OK: ${method} (unchanged)`);
    return parsed;
  }
  if (!response.ok) {
    throw new Error(`${method} HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  throw new Error(`${method} rejected: ${(parsed?.description ?? text).slice(0, 300)}`);
}

async function runCommands(options: TelegramRegistrationCliOptions): Promise<void> {
  const payloads = buildCommandPayloads(options.scope, options.chatId);
  for (const payload of payloads) {
    if (options.dryRun) {
      console.log(`DRY-RUN setMyCommands scope=${payload.scope.type}:`);
      console.log(JSON.stringify(payload, null, 2));
      continue;
    }
    await callBotApi(options.botToken!, "setMyCommands", payload);
    console.log(`OK: setMyCommands scope=${payload.scope.type}`);
    for (const cmd of payload.commands) {
      console.log(`  /${cmd.command} — ${cmd.description}`);
    }
  }
}

async function runProfile(options: TelegramRegistrationCliOptions): Promise<void> {
  const calls = buildProfileCalls();
  for (const call of calls) {
    if (options.dryRun) {
      console.log(`DRY-RUN ${call.method}:`);
      console.log(JSON.stringify(call.payload, null, 2));
      continue;
    }
    await callBotApi(options.botToken!, call.method, call.payload);
    console.log(`OK: ${call.method}`);
  }
}

async function runWebhook(options: TelegramRegistrationCliOptions): Promise<void> {
  if (!options.webhookSecret) {
    throw new Error("--action webhook requires TELEGRAM_WEBHOOK_SECRET");
  }
  const payload = buildWebhookPayload(options.webhookBaseUrl, options.webhookSecret);
  if (options.dryRun) {
    console.log("DRY-RUN setWebhook:");
    console.log(JSON.stringify({ ...payload, secret_token: "***" }, null, 2));
    return;
  }
  console.log(`Registering webhook: ${payload.url}`);
  const response = await callBotApi(options.botToken!, "setWebhook", payload);
  console.log(`OK: ${response.description ?? "registered"}`);
}

export async function runTelegramRegistration(argv = process.argv.slice(2)): Promise<void> {
  const options = parseTelegramRegistrationArgs(argv);
  if (writeCliHelpIfRequested(options, USAGE)) return;
  if (!options.dryRun && !options.botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }

  const actions: Action[] = options.action === "all"
    ? ["commands", "profile", "webhook"]
    : [options.action];

  for (const action of actions) {
    if (action === "commands") await runCommands(options);
    else if (action === "profile") await runProfile(options);
    else if (action === "webhook") await runWebhook(options);
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  void runCliEntrypoint(() => runTelegramRegistration(), {
    label: "register-telegram",
    usage: USAGE,
  });
}
