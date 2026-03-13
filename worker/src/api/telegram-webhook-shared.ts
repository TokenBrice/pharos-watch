import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import type { ResolvedCoin } from "../lib/telegram-alerts";

export const START_MESSAGE = `<b>Welcome to PharosWatchBot</b>

I send opt-in alerts for the stablecoins you follow, or for all tracked stablecoins by alert type.

<b>Alert types</b>
- <b>dews</b> — DEWS reaches ALERT, WARNING, or DANGER
- <b>depeg</b> — Depeg triggered, worsened, or resolved
- <b>safety</b> — Safety grade changes

<b>Quick start</b>
<code>/subscribe dews depeg USDC BOLD</code>
<code>/subscribe safety all</code>
<code>/set USDC depeg-step 250</code>
<code>/mute 22-07</code>

Use /help for commands.`;

export const HELP_MESSAGE = `<b>Commands</b>

<code>/subscribe &lt;types&gt; &lt;tickers&gt;</code>
Enable alert types for one or more coins

<code>/subscribe &lt;types&gt; all</code>
Enable alert types across all tracked stablecoins

<code>/unsubscribe &lt;tickers&gt;</code>
Remove specific coin subscriptions

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
Cancel a pending selection`;

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

export interface SubscriberRow {
  alert_dews: number;
  alert_depeg: number;
  alert_safety: number;
  global_alert_dews?: number | null;
  global_alert_depeg?: number | null;
  global_alert_safety?: number | null;
  quiet_hours_enabled: number | null;
  quiet_hours_start_utc: number | null;
  quiet_hours_end_utc: number | null;
}

export interface SubscriptionRow {
  stablecoin_id: string;
  alert_dews: number;
  alert_depeg: number;
  alert_safety: number;
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
      resolvedCoins: ResolvedCoin[];
      ambiguousTicker: string;
      candidates: ResolvedCoin[];
      remainingTickers: string[];
    }
  | {
      actionType: "unsubscribe";
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
  TRACKED_STABLECOINS.map((coin) => [
    coin.id,
    {
      id: coin.id,
      symbol: coin.symbol,
      name: coin.name,
    },
  ]),
);
