import type { TelegramLiveAlertType } from "../types/status/telegram";

/**
 * Public sample messages, one per alert family, rendered verbatim as
 * "shown exactly as the bot sends them" example bubbles on /pharoswatchbot.
 * `message` is the plain-text render of `formatConsolidatedMessage` and
 * `buttons` the first-chunk keyboard labels from `buildAlertReplyMarkup`
 * (`worker/src/telegram/common/alerts-formatting.ts`); the formatter test
 * `telegram-alerts.test.ts` asserts both stay identical to formatter output.
 */
export interface TelegramPublicAlertSample {
  message: string;
  buttons: readonly (readonly string[])[];
}

const STANDARD_ALERT_BUTTONS = (symbol: string, stepDownLabel?: string) => [
  [`Snooze ${symbol} 24h`, "Pause all 4h"],
  stepDownLabel ? [stepDownLabel, `Manage ${symbol}`] : [`Manage ${symbol}`],
] as const;

export const TELEGRAM_PUBLIC_ALERT_SAMPLES: Record<TelegramLiveAlertType, TelegramPublicAlertSample> = {
  dews: {
    message: `🟠 USDT DEWS stress rose to WARNING (58/100, was ALERT)
Main drivers (0-100): Pool Balance Drift 71, Supply Velocity 64

Via USD Top 25 · stress alerts

View on Pharos: pharos.watch/stablecoin/usdt-tether`,
    buttons: STANDARD_ALERT_BUTTONS("USDT", "USDT: Warning+"),
  },
  depeg: {
    message: `▼ USDC lost its peg: $0.9880, 1.2% below $1.00

Via USD Top 25 · depeg alerts

View on Pharos: pharos.watch/stablecoin/usdc-circle`,
    buttons: STANDARD_ALERT_BUTTONS("USDC"),
  },
  safety: {
    message: `USDR Safety grade downgraded to D (was B)
Why: Exit score fell from 72 to 35. Exit measures how easily holders can redeem or sell near peg.
Overall score 44 (was 70)

Via your watchlist · Safety alerts

View on Pharos: pharos.watch/stablecoin/usdr-tangible`,
    buttons: STANDARD_ALERT_BUTTONS("USDR"),
  },
  reserve: {
    message: `USDC reserves no longer match their reviewed profile
Live reserve score 62/100 vs reviewed 84/100 (-22 pts). Advisory only; Safety Score unchanged.

Via your watchlist · reserve alerts

View on Pharos: pharos.watch/stablecoin/usdc-circle#reserves`,
    buttons: STANDARD_ALERT_BUTTONS("USDC"),
  },
  freeze: {
    message: `USDC issuer froze an address on Ethereum holding $1,000,000
Event at 09:12 UTC · Recorded by Pharos FreezeWatch

Via your watchlist · freeze alerts

View on Pharos: pharos.watch/stablecoin/usdc-circle`,
    buttons: STANDARD_ALERT_BUTTONS("USDC"),
  },
};
