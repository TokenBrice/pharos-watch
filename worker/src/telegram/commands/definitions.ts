import { TELEGRAM_BOT_USERNAME, type TelegramCommandName } from "@shared/lib/telegram-bot-registration";

export type TelegramCanonicalCommand = `/${TelegramCommandName}` | "/sample";

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

const CANONICAL_COMMAND_POLICIES: Record<TelegramCanonicalCommand, Readonly<TelegramCommandPolicy>> = {
  "/start": READ_COMMAND_POLICY,
  "/help": READ_COMMAND_POLICY,
  "/sample": READ_COMMAND_POLICY,
  "/list": READ_COMMAND_POLICY,
  "/status": READ_COMMAND_POLICY,
  "/subscribe": MUTATING_COMMAND_POLICY,
  "/unsubscribe": MUTATING_COMMAND_POLICY,
  "/settings": READ_COMMAND_POLICY,
  "/pause": MUTATING_COMMAND_POLICY,
  // `/forget` only prompts in private chats and explains bot removal in groups;
  // actual deletion happens on the private-only `forget:yes` callback.
  "/forget": READ_COMMAND_POLICY,
};

export const TELEGRAM_COMMAND_ALIASES = {
  "/unsnooze": { target: "/pause", args: "off" },
  "/health": { target: "/list" },
  "/subscriptions": { target: "/list" },
  "/why": { target: "/status" },
  "/coverage": { target: "/status" },
} as const satisfies Record<string, { target: TelegramCanonicalCommand; args?: string }>;

const GROUP_SETTINGS_CMD = `/settings@${TELEGRAM_BOT_USERNAME}`;
const GROUP_SUBSCRIBE_CMD = `/subscribe@${TELEGRAM_BOT_USERNAME}`;
const GROUP_PRESETS_SUMMARY =
  "usd-top10/25/50, non-usd-top10/25/50, eur-top10, gold-top5, mcap-ge-1b, mcap-ge-100m";

const SETTINGS_MOVED = {
  private: "That setting moved to Manage Alerts.",
  group: `Use ${GROUP_SETTINGS_CMD} to change this chat's alerts.`,
};

// Redirect order and policy order are both retained from their original tables.
export const RETIRED_COMMAND_REPLIES = {
  "/set": { ...SETTINGS_MOVED, policyOrder: 0 },
  "/mute": { ...SETTINGS_MOVED, policyOrder: 1 },
  "/unmutehours": { ...SETTINGS_MOVED, policyOrder: 2 },
  "/timezone": { ...SETTINGS_MOVED, policyOrder: 3 },
  "/presets": {
    policyOrder: 5,
    private: "Follow a preset with /subscribe usd-top25, or browse presets in Manage Alerts.",
    group: `Follow a preset with ${GROUP_SUBSCRIBE_CMD} <preset>.\nPresets: ${GROUP_PRESETS_SUMMARY}`,
  },
  "/top": {
    policyOrder: 6,
    private: "Rankings and the daily brief live on pharos.watch and in @pharoswatch.",
    group: "Rankings and the daily brief live on pharos.watch and in @pharoswatch.",
  },
  "/brief": {
    policyOrder: 7,
    private: "Rankings and the daily brief live on pharos.watch and in @pharoswatch.",
    group: "Rankings and the daily brief live on pharos.watch and in @pharoswatch.",
  },
  "/market": {
    policyOrder: 8,
    private: "Rankings and the daily brief live on pharos.watch and in @pharoswatch.",
    group: "Rankings and the daily brief live on pharos.watch and in @pharoswatch.",
  },
  "/recap": {
    policyOrder: 9,
    private: "Daily recaps were retired. Your alerts are unchanged.",
    group: "Daily recaps were retired. Your alerts are unchanged.",
  },
  "/cancel": { policyOrder: 4, private: "Nothing to cancel.", group: "Nothing to cancel." },
  "/export": {
    policyOrder: 10,
    private: "Watchlist export and import were retired. Add coins in Manage Alerts.",
    group: `Watchlist export and import were retired. Follow coins with ${GROUP_SUBSCRIBE_CMD} <tickers>.`,
  },
  "/import": {
    policyOrder: 11,
    private: "Watchlist export and import were retired. Add coins in Manage Alerts.",
    group: `Watchlist export and import were retired. Follow coins with ${GROUP_SUBSCRIBE_CMD} <tickers>.`,
  },
  "/add": {
    policyOrder: 12,
    private: "Use /subscribe followed by tickers, e.g. /subscribe USDC.",
    group: `Use ${GROUP_SUBSCRIBE_CMD} followed by tickers, e.g. ${GROUP_SUBSCRIBE_CMD} USDC.`,
  },
} as const;

export const TELEGRAM_COMMAND_POLICIES: Readonly<Record<string, Readonly<TelegramCommandPolicy>>> = {
  ...CANONICAL_COMMAND_POLICIES,
  ...Object.fromEntries(Object.entries(TELEGRAM_COMMAND_ALIASES)
    .map(([alias, { target }]) => [alias, CANONICAL_COMMAND_POLICIES[target]])),
  ...Object.fromEntries(Object.entries(RETIRED_COMMAND_REPLIES)
    .sort(([, a], [, b]) => a.policyOrder - b.policyOrder)
    .map(([command]) => [command, READ_COMMAND_POLICY])),
};

export { READ_COMMAND_POLICY, START_MUTATION_POLICY };
