import { ACTIVE_STABLECOINS, PRE_LAUNCH_STABLECOINS } from "@shared/lib/stablecoins";
import type { ResolvedCoin } from "../lib/telegram-alerts";

export const START_MESSAGE = `<b>Welcome to PharosWatchBot</b>

I send opt-in alerts for the stablecoins you follow, preset watchlists, or all tracked stablecoins by alert type.

Join <a href="https://t.me/pharoswatch">@pharoswatch</a> for Pharos updates and <a href="https://t.me/pharoswatchers">@pharoswatchers</a> for community discussion about Pharos.

<b>Alert types</b>
- <b>dews</b> — DEWS reaches ALERT, WARNING, or DANGER
- <b>depeg</b> — Depeg triggered, worsened, or resolved
- <b>safety</b> — Safety grade changes
- <b>launch</b> — Pre-launch stablecoin goes live on Pharos

<b>Quick start</b>
<code>/subscribe dews depeg USDC BOLD</code>
<code>/subscribe dews usd-top25</code>
<code>/subscribe safety mcap-ge-1b</code>
<code>/subscribe launch USDPT</code>  ← pre-launch watch
<code>/subscribe safety all</code>
<code>/set USDC depeg-step 250</code>
<code>/mute 22-07</code>  ← quiet hours in UTC

<b>Also useful</b>
<code>/status USDC</code> — one-shot peg + DEWS + safety snapshot
<code>/set all dews on</code> — global alerts across every tracked coin
Inline buttons on each alert let you snooze 1h / 4h / 24h.

Use /help for commands and /presets for preset watchlists.`;

export const HELP_MESSAGE = `<b>Commands</b>

<code>/subscribe &lt;types&gt; &lt;targets&gt;</code>
Enable alert types (dews, depeg, safety, launch) for one or more coins or preset watchlists

<code>/subscribe &lt;types&gt; all</code>
Enable alert types across all tracked stablecoins

<code>/presets</code>
Show the preset watchlist catalog and examples

<code>/unsubscribe &lt;targets&gt;</code>
Remove specific coin subscriptions or preset-expanded coins

<code>/unsubscribe all</code>
Remove all per-coin and all-stablecoin subscriptions

<code>/set &lt;ticker&gt; &lt;setting&gt; &lt;value&gt;</code>
Examples:
<code>/set USDT dews WARNING</code>
<code>/set all depeg off</code>
<code>/set DAI safety downgrade-only</code>
<code>/set USDC depeg-step 250</code>

<code>/mute 22-07</code>
Quiet hours in UTC (notifications silenced, messages still delivered)

<code>/unmutehours</code>
Disable quiet hours

<code>/list</code>
Show current subscriptions and settings

<code>/cancel</code>
Cancel a pending selection

Preset watchlists expand into normal coin follows at subscribe time. Launch alerts require explicit tickers or coin ids.`;

export const DISAMBIGUATION_TTL_SEC = 5 * 60;

export type PendingActionType = "subscribe" | "unsubscribe" | "set";

export type ParsedSetCommand =
  | { ticker: string; setting: "dews"; enabled: boolean; minBand: "WARNING" | "DANGER" | null }
  | { ticker: string; setting: "safety"; enabled: boolean; mode: "downgrade-only" | "upgrade-only" | null }
  | { ticker: string; setting: "depeg"; enabled: boolean }
  | { ticker: string; setting: "depeg-step"; enabled: true; step: 100 | 250 | 500 | null };

export interface TelegramWebhookUpdate {
  update_id?: number;
  message?: {
    chat?: {
      id?: number;
      username?: string;
    };
    text?: string;
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
}

export interface SubscribeActionPayload {
  alertTypes: string[];
  presetIds?: string[];
}

export interface UnsubscribeActionPayload {
  presetIds?: string[];
}

export interface SubscriberRow {
  alert_dews: number;
  alert_depeg: number;
  alert_safety: number;
  alert_launch: number;
  global_alert_dews?: number | null;
  global_alert_depeg?: number | null;
  global_alert_safety?: number | null;
  global_alert_launch?: number | null;
  quiet_hours_enabled: number | null;
  quiet_hours_start_utc: number | null;
  quiet_hours_end_utc: number | null;
  alert_snooze_until_ts?: number | null;
}

export interface SubscriptionRow {
  stablecoin_id: string;
  alert_dews: number;
  alert_depeg: number;
  alert_safety: number;
  alert_launch: number;
  dews_min_band: string | null;
  safety_mode: string | null;
  depeg_worsening_bps_step: number | null;
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
      resolvedCoins: ResolvedCoin[];
      ambiguousTicker: string;
      candidates: ResolvedCoin[];
      remainingTickers: string[];
    }
  | {
      actionType: "unsubscribe";
      presetIds: string[];
      resolvedCoins: ResolvedCoin[];
      ambiguousTicker: string;
      candidates: ResolvedCoin[];
      remainingTickers: string[];
    }
  | {
      actionType: "set";
      command: ParsedSetCommand;
      resolvedCoins: ResolvedCoin[];
      ambiguousTicker: string;
      candidates: ResolvedCoin[];
      remainingTickers: string[];
    };

export const STABLECOIN_BY_ID = new Map<string, ResolvedCoin>(
  [...ACTIVE_STABLECOINS, ...PRE_LAUNCH_STABLECOINS].map((coin) => [
    coin.id,
    {
      id: coin.id,
      symbol: coin.symbol,
      name: coin.name,
    },
  ]),
);
