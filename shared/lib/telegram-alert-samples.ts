import type { TelegramAlertType } from "../types/status/telegram";

/**
 * Public sample messages, one per alert family, rendered verbatim as
 * "shown exactly as the bot sends them" example bubbles on /pharoswatchbot.
 * Keep these literals aligned with `formatConsolidatedMessage` in
 * `worker/src/telegram/common/alerts-formatting.ts` when changing formatter output.
 */
export const TELEGRAM_PUBLIC_ALERT_SAMPLES: Record<TelegramAlertType, { message: string }> = {
  dews: {
    message: `DEWS
🟡 USDT stress rose to ALERT (score 42, was WATCH)
Main drivers: Pool Balance Drift 61, Supply Velocity 48

View on Pharos: pharos.watch/stablecoin/usdt-tether`,
  },
  depeg: {
    message: `Depeg Detected
▼ USDC — below peg by 1.2% (120 bps)
Price: $0.9880 (peg: $1.00)

View on Pharos: pharos.watch/stablecoin/usdc-circle`,
  },
  safety: {
    message: `Safety Grade Change
USDR Safety grade downgraded to F (was B)
Score: 70 → 39
Reason: Active depeg peak 7546 bps capped the pre-variant Safety Score at F (39).

View on Pharos: pharos.watch/stablecoin/usdr-tangible`,
  },
  launch: {
    message: `Stablecoin Launched
✦ USDPT — US Dollar Payment Token has launched and is now tracked by Pharos

View on Pharos: pharos.watch/stablecoin/usdpt-western-union`,
  },
  reserve: {
    message: `Reserve Drift
USDC — Circle USD Coin live reserve mix has drifted from its curated profile

View on Pharos: pharos.watch/stablecoin/usdc-circle`,
  },
  freeze: {
    message: `Issuer Freeze Event
USDC — address frozen on Ethereum
Amount at event: $1,000,000
Source: Pharos FreezeWatch: pharos.watch/freezewatch/

View on Pharos: pharos.watch/stablecoin/usdc-circle`,
  },
};
