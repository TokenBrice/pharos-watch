import { WORKER_TRACKED_STABLECOINS } from "@shared/lib/stablecoins/worker-runtime-registry";
import { TELEGRAM_ALERT_FAMILIES } from "@shared/lib/telegram-alert-families";
import type { TelegramAlertType } from "@shared/types/status/telegram";
import { TELEGRAM_COMMAND_REFERENCE } from "@shared/lib/telegram-bot-registration";
import type { ResolvedCoin } from "../lib/telegram/alerts";
import { DISAMBIGUATION_TTL_SEC } from "../lib/telegram/constants";
import { escapeHtml } from "../lib/telegram/html";

// Re-export so existing callers importing this constant from this module keep working.
export { DISAMBIGUATION_TTL_SEC };

export const WIZARD_INTRO_MESSAGE = `<b>Welcome to PharosWatchBot</b>

I send opt-in stablecoin alerts into this chat. Pick a path below — you can change anything later with /help or /list.

Join <a href="https://t.me/pharoswatch">@pharoswatch</a> for Pharos updates and <a href="https://t.me/pharoswatchers">@pharoswatchers</a> for community discussion about Pharos.`;

// Per-family one-line meaning for the START onboarding copy. Keyed by the
// canonical family manifest so a new family fails compilation until it has
// onboarding copy here.
const START_ALERT_TYPE_LINES: Record<TelegramAlertType, string> = {
  dews: "DEWS reaches ALERT, WARNING, or DANGER",
  depeg: "Depeg triggered, worsened, or resolved",
  safety: "Safety grade changes",
  launch: "Pre-launch stablecoin goes live on Pharos",
  reserve: "Live reserve-mix drift begins diverging from the curated profile",
  freeze: "Issuer freeze, unfreeze, or destroy event on the verified tape",
};

export const START_MESSAGE = `<b>Welcome to PharosWatchBot</b>

I send opt-in stablecoin alerts into this chat. Start with a quiet preset, then tune thresholds only where you need more detail.

Join <a href="https://t.me/pharoswatch">@pharoswatch</a> for Pharos updates and <a href="https://t.me/pharoswatchers">@pharoswatchers</a> for community discussion about Pharos.

<b>Alert types</b>
${TELEGRAM_ALERT_FAMILIES.map((family) => `- <b>${family.key}</b> — ${START_ALERT_TYPE_LINES[family.key]}`).join("\n")}

<b>Quick start</b>
Recommended first setup:
<code>/subscribe dews,depeg usd-top25</code>

Other useful setups:
<code>/subscribe safety mcap-ge-1b</code>  ← larger coins, safety downgrades
<code>/subscribe dews,depeg USDC BOLD</code>  ← explicit coins
<code>/subscribe usd-top-50 depeg-step 250</code>  ← worsening milestones
<code>/subscribe launch USDPT</code>  ← pre-launch watch
<code>/subscribe safety all</code>  ← downgrades across all tracked coins (3-point drop when scored)

<b>Tune noise</b>
<code>/set USDC depeg-step 250</code>
<code>/set all depeg-step 250</code>
<code>/mute 22-07</code>  ← quiet hours (use /timezone first, defaults to UTC)
<code>/settings</code>  ← review chat-level alert settings

<b>Also useful</b>
<code>/status USDC</code> — one-shot peg + DEWS + safety snapshot
<code>/sample</code> — preview a sample DEWS alert
<code>/brief</code> — latest market brief from the Pharos digest
<code>/top depeg</code> — ranked live risk views
<code>/why USDC</code> — short safety-grade explanation
<code>/coverage USDC</code> — show Pharos data coverage for one coin
<code>/set all dews on</code> — global alerts across every tracked coin
<code>/health</code> — delivery diagnostics for this chat
<code>/forget</code> — delete all your subscriber data
Inline buttons on each alert let you snooze 1h / 4h / 24h.

<b>Groups</b>
Add the bot to a group and use addressed commands such as <code>/subscribe@PharosWatchBot dews usd-top25</code>. Subscriptions apply to that chat.

Use /help for commands and /presets for preset watchlists.`;

// /help lists every command except /start and /help themselves, in the
// subscription-first order the message has always used. Rows (syntax + one
// line) come from the shared command reference; this file owns only order,
// framing, and the preset/group footnotes.
const HELP_COMMAND_SEQUENCE = [
  "subscribe",
  "presets",
  "sample",
  "unsubscribe",
  "forget",
  "set",
  "status",
  "brief",
  "recap",
  "top",
  "why",
  "coverage",
  "settings",
  "health",
  "mute",
  "pause",
  "timezone",
  "unsnooze",
  "unmutehours",
  "list",
  "cancel",
  "export",
  "import",
] as const satisfies readonly (keyof typeof TELEGRAM_COMMAND_REFERENCE)[];

const HELP_COMMAND_ROWS = HELP_COMMAND_SEQUENCE.flatMap((command) =>
  TELEGRAM_COMMAND_REFERENCE[command].variants.map(
    (variant) => `<code>${escapeHtml(variant.syntax)}</code>\n${escapeHtml(variant.help)}`,
  ),
).join("\n\n");

export const HELP_MESSAGE = `<b>Commands</b>

${HELP_COMMAND_ROWS}

Preset watchlists follow dynamic coin sets and support DEWS, depeg, and safety only. Launch, reserve, and freeze alerts require explicit tickers, coin ids, or <code>all</code>.
Preset aliases accept compact or dashed top-N spelling, e.g. <code>usd-top25</code> or <code>non-usd-top-25</code>.

In groups, use addressed commands like <code>/subscribe@PharosWatchBot dews usd-top25</code>. Settings apply to the current chat, and pending ticker selections can only be completed by the user who started them.`;

// `DISAMBIGUATION_TTL_SEC` is defined in `../lib/telegram/constants` and
// re-exported from the top of this module.

export type PendingActionType = "subscribe" | "unsubscribe" | "set" | "confirm-bulk" | "forget-confirm";

/**
 * Stored payload for a "confirm-bulk" pending action. Captures everything
 * needed to execute the deferred subscribe/unsubscribe once the user taps
 * Confirm on the inline keyboard.
 */
export type ConfirmBulkPayload =
  | {
      kind: "subscribe";
      alertTypes: string[];
      presetIds: string[];
      depegWorseningBpsStep?: 100 | 250 | 500 | null;
      coinIds: string[];
      subscribeAll: boolean;
    }
  | {
      kind: "unsubscribe";
      presetIds: string[];
      coinIds: string[];
      unsubscribeAll: boolean;
    }
  | {
      kind: "watchlist-import-v2";
      registryVersion: string;
      directEntries: string[];
      presetEntries: string[];
      expectedPreferenceGeneration: number;
      generationLease: number;
      preview: {
        directAdds: string[];
        directRemoves: string[];
        directChanges: string[];
        directChangeBefore: string[];
        presetAdds: string[];
        presetRemoves: string[];
        presetChanges: string[];
        presetChangeBefore: string[];
      };
    };

/**
 * Setup wizard state machine. Persisted in `telegram_pending_disambiguation`
 * with `action_type = "setup-step"` so it shares the 5-min TTL and cleanup
 * cron used by the disambiguation flow.
 */
export type SetupWizardStep =
  | "branch"
  | "custom-types"
  | "custom-target"
  | "awaiting-ticker"
  | "confirm-recommended"
  | "confirm-custom";

export type SetupWizardTarget =
  | { kind: "preset"; presetId: string }
  | { kind: "all" }
  | { kind: "ticker"; coinId: string; symbol: string };

export interface SetupWizardState {
  step: SetupWizardStep;
  alertTypes: string[];
  target: SetupWizardTarget | null;
  initiatorUserId: string | null;
  adoptionToken?: string | null;
}

export const SETUP_PENDING_ACTION_TYPE = "setup-step";

export type ParsedSetCommand =
  | { ticker: string; setting: "dews"; enabled: boolean; minBand: "WARNING" | "DANGER" | null }
  | { ticker: string; setting: "safety"; enabled: boolean; mode: "downgrade-only" | "upgrade-only" | null }
  | { ticker: string; setting: "launch"; enabled: boolean }
  | { ticker: string; setting: "reserve"; enabled: boolean }
  | { ticker: string; setting: "freeze"; enabled: boolean }
  | { ticker: string; setting: "depeg"; enabled: boolean }
  | { ticker: string; setting: "depeg-step"; enabled: true; step: 100 | 250 | 500 | null };

export interface PresetSubscriptionRow {
  preset_id: string;
  alert_dews: number;
  alert_depeg: number;
  alert_safety: number;
  depeg_worsening_bps_step: number | null;
}

export interface TelegramWebhookUpdate {
  update_id?: number;
  message?: {
    chat?: {
      id?: number;
      username?: string;
      type?: "private" | "group" | "supergroup" | "channel" | string;
    };
    from?: {
      id?: number;
      username?: string;
    };
    text?: string;
    migrate_to_chat_id?: number;
    migrate_from_chat_id?: number;
  };
  callback_query?: {
    id: string;
    data?: string;
    from?: { id?: number; username?: string };
    message?: { chat?: { id?: number; type?: string }; message_id?: number };
  };
  inline_query?: {
    id?: string;
    query?: string;
    from?: { id?: number; username?: string };
    offset?: string;
  };
  chosen_inline_result?: {
    result_id?: string;
    from?: { id?: number; username?: string };
  };
}

export interface PendingDisambiguationRow {
  action_type?: string | null;
  action_payload?: string | null;
  alert_types: string;
  resolved_ids: string;
  ambiguous_ticker: string;
  candidates: string;
  remaining_tickers: string;
  expires_at: number;
  initiator_user_id?: string | null;
}

export interface SubscribeActionPayload {
  alertTypes: string[];
  presetIds?: string[];
  depegWorseningBpsStep?: 100 | 250 | 500 | null;
}

export interface UnsubscribeActionPayload {
  presetIds?: string[];
}

export interface SubscriberRow {
  alert_dews: number;
  alert_depeg: number;
  alert_safety: number;
  alert_launch: number;
  alert_reserve?: number | null;
  alert_freeze?: number | null;
  global_alert_dews?: number | null;
  global_alert_depeg?: number | null;
  global_alert_safety?: number | null;
  global_alert_launch?: number | null;
  global_alert_reserve?: number | null;
  global_alert_freeze?: number | null;
  global_depeg_worsening_bps_step?: number | null;
  quiet_hours_enabled: number | null;
  quiet_hours_start_utc: number | null;
  quiet_hours_end_utc: number | null;
  timezone?: string | null;
  alert_snooze_until_ts?: number | null;
  consecutive_block_count?: number | null;
  consecutive_block_first_at?: number | null;
  preference_generation?: number | null;
}

export interface SubscriptionRow {
  stablecoin_id: string;
  alert_dews: number;
  alert_depeg: number;
  alert_safety: number;
  alert_launch: number;
  alert_reserve?: number | null;
  alert_freeze?: number | null;
  dews_min_band: string | null;
  safety_mode: string | null;
  depeg_worsening_bps_step: number | null;
  alert_snooze_until_ts?: number | null;
  alert_dews_override?: number | null;
  alert_depeg_override?: number | null;
  alert_safety_override?: number | null;
  alert_launch_override?: number | null;
  alert_reserve_override?: number | null;
  alert_freeze_override?: number | null;
}

export type CoinResolution =
  | { kind: "complete"; coins: ResolvedCoin[] }
  | {
      kind: "ambiguous";
      ticker: string;
      candidates: ResolvedCoin[];
      coins: ResolvedCoin[];
      remainingTickers: string[];
    }
  | {
      kind: "not_found";
      ticker: string;
      suggestion?: ResolvedCoin;
    };

export type PendingAction =
  | {
      actionType: "subscribe";
      alertTypes: Set<string>;
      presetIds: string[];
      depegWorseningBpsStep?: 100 | 250 | 500 | null;
      resolvedCoins: ResolvedCoin[];
      initiatorUserId: string | null;
      ambiguousTicker: string;
      candidates: ResolvedCoin[];
      remainingTickers: string[];
    }
  | {
      actionType: "unsubscribe";
      presetIds: string[];
      resolvedCoins: ResolvedCoin[];
      initiatorUserId: string | null;
      ambiguousTicker: string;
      candidates: ResolvedCoin[];
      remainingTickers: string[];
    }
  | {
      actionType: "set";
      command: ParsedSetCommand;
      resolvedCoins: ResolvedCoin[];
      initiatorUserId: string | null;
      ambiguousTicker: string;
      candidates: ResolvedCoin[];
      remainingTickers: string[];
    }
  | {
      actionType: "confirm-bulk";
      payload: ConfirmBulkPayload;
      initiatorUserId: string | null;
    }
  | {
      actionType: "forget-confirm";
      initiatorUserId: string | null;
    };

/**
 * Typed sentinel returned by `parsePendingDisambiguation` when the loaded row is
 * a setup-wizard step (`action_type = "setup-step"`). Setup rows live in the
 * same `telegram_pending_disambiguation` table but are not disambiguation
 * actions; returning this discriminated sentinel (instead of `null`) forces
 * callers to handle setup rows explicitly rather than silently treating a live
 * setup session as "no pending action".
 */
export interface PendingSetupSentinel {
  actionType: typeof SETUP_PENDING_ACTION_TYPE;
}

/**
 * Returns true when the acting user may proceed with a pending-owner-gated
 * action: either no initiator is recorded (public), or the initiator matches
 * the actor.
 */
export function canActOnPendingOwner(initiatorUserId: string | null, actorUserId: string | null): boolean {
  return initiatorUserId == null || initiatorUserId === actorUserId;
}

export const STABLECOIN_BY_ID = new Map<string, ResolvedCoin>(
  WORKER_TRACKED_STABLECOINS.map((coin) => [
    coin.id,
    {
      id: coin.id,
      symbol: coin.symbol,
      name: coin.name,
    },
  ]),
);
