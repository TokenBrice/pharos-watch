#!/usr/bin/env tsx
/// <reference types="@cloudflare/workers-types" />
/**
 * Manual recovery tool for forcing Telegram Bot API state outside the
 * Worker's 15-minute reconciliation loop. Replaces three shell scripts that
 * duplicated command/profile/webhook payloads by hand.
 *
 * Canonical source for every payload is
 * worker/src/lib/telegram-webhook-registration.ts. Normal deploys reconcile
 * automatically; this script exists for the cases where reconciliation is
 * unavailable or needs to be forced immediately.
 *
 * Usage:
 *   tsx scripts/maintenance/register-telegram.ts --action commands --bot-token ...
 *   tsx scripts/maintenance/register-telegram.ts --action profile  --bot-token ...
 *   tsx scripts/maintenance/register-telegram.ts --action webhook  --bot-token ... --webhook-secret ...
 *   tsx scripts/maintenance/register-telegram.ts --action all      --bot-token ... --webhook-secret ...
 *   tsx scripts/maintenance/register-telegram.ts --check --bot-token ...   # dry run, print payloads
 *
 * Command scope (only meaningful for --action commands):
 *   --scope default              setMyCommands default scope
 *   --scope all_private_chats    setMyCommands all_private_chats (PRIVATE_COMMANDS)
 *   --scope all_group_chats      setMyCommands all_group_chats  (GROUP_COMMANDS)
 *   --scope chat --chat-id <id>  setMyCommands chat scope for a single chat
 *   (omit --scope to register both all_private_chats and all_group_chats, as
 *    the original register-telegram-commands.sh did)
 *
 * Env fallbacks: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, WEBHOOK_BASE_URL.
 */
import process from "node:process";
import {
  TELEGRAM_ALLOWED_UPDATES,
  TELEGRAM_BOT_COMMANDS,
  TELEGRAM_BOT_DESCRIPTION,
  TELEGRAM_BOT_GROUP_COMMANDS,
  TELEGRAM_BOT_NAME,
  TELEGRAM_BOT_SHORT_DESCRIPTION,
} from "../../worker/src/lib/telegram-webhook-registration";
import { parseCliOptions } from "../lib/smoke-runtime.mjs";

interface CliHandlerContext {
  arg: string;
  argv: string[];
  index: number;
  readValue: () => string;
}
type CliHandler = (ctx: CliHandlerContext) => "value" | number | void;

type Action = "commands" | "profile" | "webhook" | "all";
type CommandScopeKind = "default" | "all_private_chats" | "all_group_chats" | "chat";

interface CliOptions {
  action: Action;
  botToken: string | null;
  webhookSecret: string | null;
  webhookBaseUrl: string;
  scope: CommandScopeKind | null;
  chatId: string | null;
  check: boolean;
}

function parseOptions(argv: string[]): CliOptions {
  const options: CliOptions = {
    action: "commands",
    botToken: process.env.TELEGRAM_BOT_TOKEN?.trim() || null,
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET?.trim() || null,
    webhookBaseUrl: process.env.WEBHOOK_BASE_URL?.trim() || "https://api.pharos.watch",
    scope: null,
    chatId: null,
    check: false,
  };

  const handlers: Record<string, CliHandler> = {
    "--action": ({ readValue }) => {
      const value = readValue();
      if (value !== "commands" && value !== "profile" && value !== "webhook" && value !== "all") {
        throw new Error(`--action must be one of commands|profile|webhook|all (got: ${value})`);
      }
      options.action = value;
      return "value";
    },
    "--bot-token": ({ readValue }) => {
      options.botToken = readValue();
      return "value";
    },
    "--webhook-secret": ({ readValue }) => {
      options.webhookSecret = readValue();
      return "value";
    },
    "--webhook-base-url": ({ readValue }) => {
      options.webhookBaseUrl = readValue();
      return "value";
    },
    "--scope": ({ readValue }) => {
      const value = readValue();
      if (
        value !== "default"
        && value !== "all_private_chats"
        && value !== "all_group_chats"
        && value !== "chat"
      ) {
        throw new Error(
          `--scope must be one of default|all_private_chats|all_group_chats|chat (got: ${value})`,
        );
      }
      options.scope = value;
      return "value";
    },
    "--chat-id": ({ readValue }) => {
      options.chatId = readValue();
      return "value";
    },
    "--check": () => {
      options.check = true;
    },
  };
  parseCliOptions(argv, handlers);

  if (options.scope === "chat" && !options.chatId) {
    throw new Error("--scope chat requires --chat-id <id>");
  }
  return options;
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
  const numericChatId = Number.parseInt(chatId ?? "", 10);
  if (!Number.isFinite(numericChatId)) {
    throw new Error(`--chat-id must be a number (got: ${chatId ?? ""})`);
  }
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

async function runCommands(options: CliOptions): Promise<void> {
  const payloads = buildCommandPayloads(options.scope, options.chatId);
  for (const payload of payloads) {
    if (options.check) {
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

async function runProfile(options: CliOptions): Promise<void> {
  const calls = buildProfileCalls();
  for (const call of calls) {
    if (options.check) {
      console.log(`DRY-RUN ${call.method}:`);
      console.log(JSON.stringify(call.payload, null, 2));
      continue;
    }
    await callBotApi(options.botToken!, call.method, call.payload);
    console.log(`OK: ${call.method}`);
  }
}

async function runWebhook(options: CliOptions): Promise<void> {
  if (!options.webhookSecret) {
    throw new Error("--action webhook requires --webhook-secret or TELEGRAM_WEBHOOK_SECRET");
  }
  const payload = buildWebhookPayload(options.webhookBaseUrl, options.webhookSecret);
  if (options.check) {
    console.log("DRY-RUN setWebhook:");
    console.log(JSON.stringify({ ...payload, secret_token: "***" }, null, 2));
    return;
  }
  console.log(`Registering webhook: ${payload.url}`);
  const response = await callBotApi(options.botToken!, "setWebhook", payload);
  console.log(`OK: ${response.description ?? "registered"}`);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (!options.botToken) {
    throw new Error("--bot-token or TELEGRAM_BOT_TOKEN is required");
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

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
});
