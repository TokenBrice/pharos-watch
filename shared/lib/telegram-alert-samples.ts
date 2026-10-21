import type { TelegramLiveAlertType } from "../types/status/telegram";

/**
 * Public sample messages, one per alert family, rendered verbatim as
 * "shown exactly as the bot sends them" example bubbles on /pharoswatchbot.
 * Except for reserve (a daily roll-up sample, see below), `message` is the
 * plain-text render of `formatConsolidatedMessage` and
 * `buttons` the first-chunk keyboard labels from `buildAlertReplyMarkup`
 * (`worker/src/telegram/common/alerts-formatting.ts`); the formatter test
 * `telegram-alerts.test.ts` asserts both stay identical to formatter output.
 */
export interface TelegramPublicAlertSample {
  message: string;
  buttons: readonly (readonly string[])[];
}

const STANDARD_ALERT_BUTTONS = (symbol: string) => [
  [`Mute ${symbol} 24h`, "Pause all 4h"],
  ["Fewer like this", "Manage Alerts"],
] as const;

export const TELEGRAM_PUBLIC_ALERT_SAMPLES: Record<TelegramLiveAlertType, TelegramPublicAlertSample> = {
  dews: {
    message: `🟠 USDT early-warning stress rose to WARNING (58/100, was ALERT)
Main drivers: Pool Balance Drift 71, Supply Velocity 64

Via USD Top 25 · stress alerts

View on Pharos: pharos.watch/stablecoin/usdt-tether`,
    buttons: STANDARD_ALERT_BUTTONS("USDT"),
  },
  depeg: {
    message: `▼ USDC lost its peg: $0.9880, 1.2% below $1.00

Via USD Top 25 · depeg alerts

View on Pharos: pharos.watch/stablecoin/usdc-circle`,
    buttons: STANDARD_ALERT_BUTTONS("USDC"),
  },
  safety: {
    message: `USDR Safety grade downgraded to D (was B)
Why: Exit score fell from 72 to 35. Exit measures how easily holders can redeem or sell near $1.
Overall score 44 (was 70)

Via your watchlist · Safety alerts

View on Pharos: pharos.watch/stablecoin/usdr-tangible`,
    buttons: STANDARD_ALERT_BUTTONS("USDR"),
  },
  // Reserve drift is never sent live: it arrives as a line of the daily
  // Changes roll-up (`formatRollupMessage` in
  // `worker/src/cron/telegram/rollup/rollup-content.ts`, contract-tested in
  // `rollup-content.test.ts`), whose only button is Manage Alerts.
  reserve: {
    message: `Daily changes: 2 changes on your coins, led by PYUSD Safety grade downgraded B → C+

Safety grades
PYUSD Safety grade downgraded B → C+

Reserves
USDC reserves no longer match their reviewed profile

Changes not sent live, once a day · /settings

View on Pharos: pharos.watch`,
    buttons: [["Manage Alerts"]],
  },
  freeze: {
    message: `USDC issuer froze an address on Ethereum holding $1,000,000
Recorded by Pharos FreezeWatch

Via your watchlist · freeze alerts

View on Pharos: pharos.watch/stablecoin/usdc-circle`,
    buttons: STANDARD_ALERT_BUTTONS("USDC"),
  },
};
