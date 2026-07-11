import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { ResolvedCoin } from "../lib/telegram-alerts";
import { DISAMBIGUATION_TTL_SEC } from "../lib/telegram-constants";

// Re-export so existing callers importing this constant from this module keep working.
export { DISAMBIGUATION_TTL_SEC };

export const WIZARD_INTRO_MESSAGE = `<b>Welcome to PharosWatchBot</b>

I send opt-in stablecoin alerts into this chat. Pick a path below — you can change anything later with /help or /list.

Join <a href="https://t.me/pharoswatch">@pharoswatch</a> for Pharos updates and <a href="https://t.me/pharoswatchers">@pharoswatchers</a> for community discussion about Pharos.`;

export const START_MESSAGE = `<b>Welcome to PharosWatchBot</b>

I send opt-in stablecoin alerts into this chat. Start with a quiet preset, then tune thresholds only where you need more detail.

Join <a href="https://t.me/pharoswatch">@pharoswatch</a> for Pharos updates and <a href="https://t.me/pharoswatchers">@pharoswatchers</a> for community discussion about Pharos.

<b>Alert types</b>
- <b>dews</b> — DEWS reaches ALERT, WARNING, or DANGER
- <b>depeg</b> — Depeg triggered, worsened, or resolved
- <b>safety</b> — Safety grade changes
- <b>launch</b> — Pre-launch stablecoin goes live on Pharos

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

export const HELP_MESSAGE = `<b>Commands</b>

<code>/subscribe &lt;types&gt; &lt;targets&gt;</code>
Enable alert types (dews, depeg, safety, launch) for one or more coins or preset watchlists

<code>/subscribe &lt;targets&gt; depeg-step 250</code>
Enable depeg alerts for coins or preset watchlists and alert again when worsening crosses 250 bps

<code>/subscribe &lt;types&gt; all</code>
Enable alert types across all tracked stablecoins

When used with <code>safety</code>, all-stablecoin follows deliver downgrades only and require a score drop of at least 3 points when scores are present.

<code>/presets</code>
Show the preset watchlist catalog and examples

<code>/sample</code>
Preview a sample DEWS alert without changing subscriptions

<code>/unsubscribe &lt;targets&gt;</code>
Remove specific coin subscriptions or preset-expanded coins

<code>/unsubscribe all</code>
Remove all per-coin and all-stablecoin subscriptions

<code>/forget</code>
Delete all your subscriber data

<code>/set &lt;ticker&gt; &lt;setting&gt; &lt;value&gt;</code>
Examples:
<code>/set USDT dews WARNING</code>
<code>/set all depeg off</code>
<code>/set DAI safety downgrade-only</code>
<code>/set USDC depeg-step 250</code>
<code>/set all depeg-step 250</code>

<code>/status &lt;ticker&gt;</code>
Current peg, DEWS band, and safety grade for one coin — no subscription needed

<code>/brief</code>
Latest market brief from the daily digest inputs

<code>/top &lt;view&gt;</code>
Rank current views: depeg, dews, yield, liquidity, chains, or safety

<code>/why &lt;ticker&gt;</code>
Explain the current Safety Score in plain language

<code>/coverage &lt;ticker&gt;</code>
Show which Pharos data surfaces currently cover one coin

<code>/settings</code>
Review and edit chat-level alert settings

<code>/health</code>
Show delivery diagnostics for this chat: queued alerts, quiet hours, snooze, and recent failure class

<code>/mute 22-07</code>
Quiet hours in your <code>/timezone</code> (defaults to UTC; notifications silenced, messages still delivered)

<code>/timezone Europe/Paris</code>
Set chat timezone for quiet hours, or send <code>/timezone</code> alone to pick from common zones

<code>/unsnooze</code>
Clear an active alert snooze immediately

<code>/unmutehours</code>
Disable quiet hours

<code>/list</code>
Show current subscriptions and settings

<code>/cancel</code>
Cancel a pending selection

Preset watchlists expand into normal coin follows at subscribe time. Launch alerts require explicit tickers or coin ids.
Preset aliases accept compact or dashed top-N spelling, e.g. <code>usd-top25</code> or <code>non-usd-top-25</code>.

In groups, use addressed commands like <code>/subscribe@PharosWatchBot dews usd-top25</code>. Settings apply to the current chat, and pending ticker selections can only be completed by the user who started them.`;

// `DISAMBIGUATION_TTL_SEC` is defined in `../lib/telegram-constants` and
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
  TRACKED_STABLECOINS.map((coin) => [
    coin.id,
    {
      id: coin.id,
      symbol: coin.symbol,
      name: coin.name,
    },
  ]),
);
