import type { CoinNoticeKind } from "../../types/stablecoin-lifecycle";
import type { CoinStateKind } from "../coin-state";

/** Chip labels for the coin exceptional-state ladder (`shared/lib/coin-state.ts`). */
export const COIN_STATE_LABELS = {
  frozen: "Frozen",
  delisted: "Delisted",
  quarantined: "Quarantined",
  "pre-launch": "Pre-launch",
  critical: "Critical notice",
  depeg: "Depeg",
  paused: "Paused",
  dews: "DEWS",
  deadline: "Deadline",
} as const satisfies Record<CoinStateKind, string>;

/**
 * Severity tone per state, as a `SEVERITY_TONE_CLASS` key: red for a live
 * break or a curated danger, amber for a stopped operation or a holder
 * deadline, neutral for lifecycle records. A DEWS state renders in its own
 * band ladder (`THREAT_BAND_STYLES`) so it reads the same as every DEWS badge.
 */
export const COIN_STATE_TONES = {
  frozen: "neutral",
  delisted: "neutral",
  quarantined: "neutral",
  "pre-launch": "neutral",
  critical: "danger",
  depeg: "danger",
  paused: "caution",
  dews: "caution",
  deadline: "caution",
} as const satisfies Record<CoinStateKind, "danger" | "caution" | "neutral">;

/** Notice kickers by kind; a notice without a kind is a standing caveat and has none. */
export const COIN_NOTICE_KIND_LABELS = {
  paused: "Paused now",
  deadline: "Deadline",
  depeg: "Peg record",
  history: "Past event",
} as const satisfies Record<CoinNoticeKind, string>;
