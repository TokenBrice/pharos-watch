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
/**
 * Where a family lives in D1 and how the control surfaces address it.
 *
 * Every value is a load-bearing identifier: the column names are real D1
 * columns (asserted against the migrated schema by
 * `worker/src/api/telegram-store/__tests__/alert-type-registry-schema.test.ts`)
 * and `settingCode` is the token embedded in `/settings` callback data and in
 * mini-app coin patches, so it is part of the stored/inflight wire format.
 */
export interface TelegramAlertPersistence {
  /** Per-coin enablement flag on `telegram_subscriptions`. */
  subscriptionColumn: string;
  /** Per-coin "user set this explicitly" flag on `telegram_subscriptions`. */
  overrideColumn: string;
  /** Chat-wide enablement flag on `telegram_subscribers`. */
  globalColumn: string;
  /** Two-letter code addressing the family in `settings:c:<coin>:<code>:<value>`. */
  settingCode: string;
  /** Per-coin tuning column, or `null` for the plain on/off families. */
  settingsColumn: string | null;
}

const TELEGRAM_ALERT_PERSISTENCE_TABLE = {
  dews: {
    subscriptionColumn: "alert_dews",
    overrideColumn: "alert_dews_override",
    globalColumn: "global_alert_dews",
    settingCode: "db",
    settingsColumn: "dews_min_band",
  },
  depeg: {
    subscriptionColumn: "alert_depeg",
    overrideColumn: "alert_depeg_override",
    globalColumn: "global_alert_depeg",
    settingCode: "ds",
    settingsColumn: "depeg_worsening_bps_step",
  },
  safety: {
    subscriptionColumn: "alert_safety",
    overrideColumn: "alert_safety_override",
    globalColumn: "global_alert_safety",
    settingCode: "sm",
    settingsColumn: "safety_mode",
  },
  launch: {
    subscriptionColumn: "alert_launch",
    overrideColumn: "alert_launch_override",
    globalColumn: "global_alert_launch",
    settingCode: "lc",
    settingsColumn: null,
  },
  reserve: {
    subscriptionColumn: "alert_reserve",
    overrideColumn: "alert_reserve_override",
    globalColumn: "global_alert_reserve",
    settingCode: "rs",
    settingsColumn: null,
  },
  freeze: {
    subscriptionColumn: "alert_freeze",
    overrideColumn: "alert_freeze_override",
    globalColumn: "global_alert_freeze",
    settingCode: "fz",
    settingsColumn: null,
  },
} as const satisfies Record<TelegramAlertType, TelegramAlertPersistence>;

/** Per-family persistence descriptors, keyed by alert type. */
export const TELEGRAM_ALERT_PERSISTENCE = TELEGRAM_ALERT_PERSISTENCE_TABLE;

export type TelegramAlertPersistenceTable = typeof TELEGRAM_ALERT_PERSISTENCE_TABLE;
/** Union of every `telegram_subscriptions` enablement column. */
export type TelegramSubscriptionAlertColumn =
  TelegramAlertPersistenceTable[TelegramAlertType]["subscriptionColumn"];
/** Union of every `telegram_subscriptions` override column. */
export type TelegramSubscriptionOverrideColumn =
  TelegramAlertPersistenceTable[TelegramAlertType]["overrideColumn"];
/** Union of every `telegram_subscribers` global column. */
export type TelegramSubscriberGlobalColumn =
  TelegramAlertPersistenceTable[TelegramAlertType]["globalColumn"];
/** Union of the `/settings` family codes. */
export type TelegramAlertSettingCode =
  TelegramAlertPersistenceTable[TelegramAlertType]["settingCode"];

// SQL identifiers come only from the canonical persistence manifest above, never request data.

/** Families that preset subscriptions can activate. Presets stay DEWS/depeg/safety only. */
const PRESET_ALERT_TYPES = ["dews", "depeg", "safety"] as const;

function activeFlagConditions(columns: readonly string[]): string {
  return columns.map((column) => `${column} = 1`).join("\n  OR ");
}

export const ACTIVE_SUBSCRIPTION_FLAGS_SQL = activeFlagConditions(
  TELEGRAM_ALERT_TYPES.map((alertType) => TELEGRAM_ALERT_PERSISTENCE[alertType].subscriptionColumn),
);

export const ACTIVE_PRESET_FLAGS_SQL = activeFlagConditions(
  PRESET_ALERT_TYPES.map((alertType) => TELEGRAM_ALERT_PERSISTENCE[alertType].subscriptionColumn),
);

/** Requires subscriber alias s and active-count aliases sub and preset. */
export const ACTIVE_WATCHER_SQL_CONDITION = `${
  activeFlagConditions(
    TELEGRAM_ALERT_TYPES.map((alertType) => `s.${TELEGRAM_ALERT_PERSISTENCE[alertType].globalColumn}`),
  )
}
  OR COALESCE(sub.active_sub_count, 0) > 0
  OR COALESCE(preset.active_preset_count, 0) > 0`;

export interface TelegramAlertFamily {
  key: TelegramAlertType;
  /** Display heading used for the family on public reference surfaces. */
  label: string;
  /** One-word label used by the compact control surfaces (/settings rows). */
  shortLabel: string;
  /** Short phrase used inside prose lists ("alerts for X, Y, and Z"). */
  publicPhrase: string;
  /** Standalone JSON-LD `featureList` line for the family. */
  featureLine: string;
  /** D1 columns + control-surface code backing the family. */
  persistence: TelegramAlertPersistence;
}

export const TELEGRAM_ALERT_FAMILIES = [
  {
    key: "dews",
    label: "DEWS Threat Level",
    shortLabel: "DEWS",
    publicPhrase: "DEWS threat bands",
    featureLine: "DEWS threat-band alerts (ALERT, WARNING, DANGER)",
    persistence: TELEGRAM_ALERT_PERSISTENCE_TABLE.dews,
  },
  {
    key: "depeg",
    label: "Depeg Events",
    shortLabel: "Depeg",
    publicPhrase: "depeg events",
    featureLine: "Depeg alerts (triggered, worsening milestones, resolved)",
    persistence: TELEGRAM_ALERT_PERSISTENCE_TABLE.depeg,
  },
  {
    key: "safety",
    label: "Safety Grade Changes",
    shortLabel: "Safety",
    publicPhrase: "reasoned safety-grade shifts",
    featureLine: "Safety grade alerts with reason lines for live score drivers",
    persistence: TELEGRAM_ALERT_PERSISTENCE_TABLE.safety,
  },
  {
    key: "launch",
    label: "Launch Promotions",
    shortLabel: "Launch",
    publicPhrase: "launches",
    featureLine: "Pre-launch stablecoin launch alerts",
    persistence: TELEGRAM_ALERT_PERSISTENCE_TABLE.launch,
  },
  {
    key: "reserve",
    label: "Reserve Drift",
    shortLabel: "Reserve",
    publicPhrase: "live reserve-mix drift",
    featureLine: "Live reserve-mix drift alerts for covered stablecoins",
    persistence: TELEGRAM_ALERT_PERSISTENCE_TABLE.reserve,
  },
  {
    key: "freeze",
    label: "Freeze and Blacklist Events",
    shortLabel: "Freeze",
    publicPhrase: "issuer freeze, unfreeze, and destroy events",
    featureLine: "Opt-in issuer freeze, blacklist release, and destroy alerts from the verified tape",
    persistence: TELEGRAM_ALERT_PERSISTENCE_TABLE.freeze,
  },
] as const satisfies readonly TelegramAlertFamily[];

/** Short control-surface label per family, in canonical order. */
export const TELEGRAM_ALERT_FAMILY_SHORT_LABELS = Object.fromEntries(
  TELEGRAM_ALERT_FAMILIES.map((family) => [family.key, family.shortLabel]),
) as Record<TelegramAlertType, string>;

/** `/settings` family code → alert type. */
export const TELEGRAM_ALERT_TYPE_BY_SETTING_CODE = Object.fromEntries(
  TELEGRAM_ALERT_TYPES.map((alertType) => [
    TELEGRAM_ALERT_PERSISTENCE_TABLE[alertType].settingCode,
    alertType,
  ]),
) as Record<string, TelegramAlertType | undefined>;

/** Oxford-comma prose list of the family phrases, e.g. "a, b, and c". */
export const TELEGRAM_ALERT_FAMILY_PHRASE_LIST = TELEGRAM_ALERT_FAMILIES.map(
  (family) => family.publicPhrase,
)
  .map((phrase, index, phrases) => (index === phrases.length - 1 ? `and ${phrase}` : phrase))
  .join(", ");

/** Comma-separated command tokens for `<types>` syntax help, e.g. "dews, depeg, ...". */
export const TELEGRAM_ALERT_FAMILY_COMMAND_TOKENS = TELEGRAM_ALERT_TYPES.join(", ");
