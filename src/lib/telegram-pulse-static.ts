/**
 * Last-known public Telegram pulse figures, baked into the static export so
 * the /pharoswatchbot/ hero can render a real number on first paint instead
 * of a skeleton — the same role the homepage hero snapshot plays for market
 * data. Live data from `useTelegramPulse` always wins once it lands; this is
 * only the bridge (and the honest fallback when telemetry is unreachable).
 *
 * Refresh procedure: paste the current `activeWatchers` value from the public
 * pulse endpoint (the same contract `useTelegramPulse` consumes) and set
 * `asOf` to the snapshot date. `null` keeps the hero quiet until live data
 * arrives — never invent a figure here.
 */
export const TELEGRAM_PULSE_STATIC = {
  activeWatchers: null,
  asOf: null,
} as const satisfies { activeWatchers: number | null; asOf: string | null };
