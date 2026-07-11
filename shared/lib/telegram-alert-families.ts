import { TELEGRAM_ALERT_TYPES, type TelegramAlertType } from "../types/status/telegram";

/**
 * Canonical public manifest for the Telegram alert families (TGB-028).
 *
 * `TELEGRAM_ALERT_TYPES` (shared/types/status/telegram.ts) owns membership and
 * order; this manifest owns the reviewed public wording for each family. Bot
 * profile registration, the /pharoswatchbot landing page, its metadata and
 * JSON-LD all derive their family copy from here so a new or renamed family
 * cannot silently drift between the runtime and the public surfaces.
 */
export interface TelegramAlertFamily {
  key: TelegramAlertType;
  /** Display heading used for the family on public reference surfaces. */
  label: string;
  /** Short phrase used inside prose lists ("alerts for X, Y, and Z"). */
  publicPhrase: string;
  /** Standalone JSON-LD `featureList` line for the family. */
  featureLine: string;
}

export const TELEGRAM_ALERT_FAMILIES: readonly TelegramAlertFamily[] = [
  {
    key: "dews",
    label: "DEWS Threat Level",
    publicPhrase: "DEWS threat bands",
    featureLine: "DEWS threat-band alerts (ALERT, WARNING, DANGER)",
  },
  {
    key: "depeg",
    label: "Depeg Events",
    publicPhrase: "depeg events",
    featureLine: "Depeg alerts (triggered, worsening milestones, resolved)",
  },
  {
    key: "safety",
    label: "Safety Grade Changes",
    publicPhrase: "reasoned safety-grade shifts",
    featureLine: "Safety grade alerts with reason lines for live score drivers",
  },
  {
    key: "launch",
    label: "Launch Promotions",
    publicPhrase: "launches",
    featureLine: "Pre-launch stablecoin launch alerts",
  },
  {
    key: "reserve",
    label: "Reserve Drift",
    publicPhrase: "live reserve-mix drift",
    featureLine: "Live reserve-mix drift alerts for covered stablecoins",
  },
  {
    key: "freeze",
    label: "Freeze and Blacklist Events",
    publicPhrase: "issuer freeze, unfreeze, and destroy events",
    featureLine: "Opt-in issuer freeze, blacklist release, and destroy alerts from the verified tape",
  },
];

/** Oxford-comma prose list of the family phrases, e.g. "a, b, and c". */
export const TELEGRAM_ALERT_FAMILY_PHRASE_LIST = TELEGRAM_ALERT_FAMILIES.map(
  (family) => family.publicPhrase,
)
  .map((phrase, index, phrases) => (index === phrases.length - 1 ? `and ${phrase}` : phrase))
  .join(", ");

/** Comma-separated command tokens for `<types>` syntax help, e.g. "dews, depeg, ...". */
export const TELEGRAM_ALERT_FAMILY_COMMAND_TOKENS = TELEGRAM_ALERT_TYPES.join(", ");
