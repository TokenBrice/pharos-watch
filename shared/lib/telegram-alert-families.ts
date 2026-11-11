import {
  TELEGRAM_ALERT_TYPES,
  TELEGRAM_LIVE_ALERT_TYPES,
  TELEGRAM_DEWS_BANDS,
  TELEGRAM_SAFETY_MODES,
  type TelegramAlertType,
  type TelegramLiveAlertType,
  type TelegramDewsBand,
  type TelegramSafetyMode,
} from "../types/status/telegram";

/** Durable settings callback codes; null/default is deliberately not callback Off ("0"). */
export const DEWS_BAND_CODES = { A: TELEGRAM_DEWS_BANDS[0], W: TELEGRAM_DEWS_BANDS[1], D: TELEGRAM_DEWS_BANDS[2] } as const;
export type DewsBandCode = keyof typeof DEWS_BAND_CODES;
export const SAFETY_MODE_CODES = { a: TELEGRAM_SAFETY_MODES[0], d: TELEGRAM_SAFETY_MODES[1], u: TELEGRAM_SAFETY_MODES[2] } as const;
export type SafetyModeCode = keyof typeof SAFETY_MODE_CODES;
export const DEWS_BAND_CODE_BY_VALUE = Object.fromEntries(
  Object.entries(DEWS_BAND_CODES).map(([code, value]) => [value, code]),
) as Record<TelegramDewsBand, DewsBandCode>;
export const SAFETY_MODE_CODE_BY_VALUE = Object.fromEntries(
  Object.entries(SAFETY_MODE_CODES).map(([code, value]) => [value, code]),
) as Record<TelegramSafetyMode, SafetyModeCode>;

export function isDewsBandCode(value: string): value is DewsBandCode {
  return Object.prototype.hasOwnProperty.call(DEWS_BAND_CODES, value);
}

export function isSafetyModeCode(value: string): value is SafetyModeCode {
  return Object.prototype.hasOwnProperty.call(SAFETY_MODE_CODES, value);
}

/**
 * Canonical public manifest for the Telegram alert families (TGB-028).
 *
 * `TELEGRAM_LIVE_ALERT_TYPES` (shared/types/status/telegram.ts) owns membership and
 * order; this manifest owns family capabilities, persistence and public wording. Bot
 * profile registration, the /pharoswatchbot landing page, its metadata and
 * JSON-LD all derive their family copy from here so a new or renamed family
 * cannot silently drift between the runtime and the public surfaces.
 */
/**
 * Where a family lives in D1 and how the control surfaces address it.
 *
 * Every value is a load-bearing identifier: the column names are real D1
 * columns (asserted against the migrated schema by
 * `worker/src/telegram/store/__tests__/alert-type-registry-schema.test.ts`)
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

export interface TelegramAlertFamily {
  key: TelegramLiveAlertType;
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

const TELEGRAM_ALERT_FAMILY_REGISTRY = {
  dews: {
    persistence: {
      subscriptionColumn: "alert_dews",
      overrideColumn: "alert_dews_override",
      globalColumn: "global_alert_dews",
      settingCode: "db",
      settingsColumn: "dews_min_band",
    },
    preset: true,
    eventIdsKey: "dewsIds",
    rollupOrder: 1,
    public: {
      label: "DEWS Threat Level",
      shortLabel: "DEWS",
      publicPhrase: "DEWS threat bands",
      featureLine: "DEWS threat-band alerts (ALERT, WARNING, DANGER)",
    },
    miniAppLabel: "Early warning",
    miniAppDescription: "Stress rises on the DEWS radar",
  },
  depeg: {
    persistence: {
      subscriptionColumn: "alert_depeg",
      overrideColumn: "alert_depeg_override",
      globalColumn: "global_alert_depeg",
      settingCode: "ds",
      settingsColumn: "depeg_worsening_bps_step",
    },
    preset: true,
    eventIdsKey: "depegIds",
    rollupOrder: null,
    public: {
      label: "Depeg Events",
      shortLabel: "Depeg",
      publicPhrase: "depeg events",
      featureLine: "Depeg alerts (triggered, worsening milestones, resolved)",
    },
    miniAppLabel: "Depeg",
    miniAppDescription: "Price moves away from the peg",
  },
  safety: {
    persistence: {
      subscriptionColumn: "alert_safety",
      overrideColumn: "alert_safety_override",
      globalColumn: "global_alert_safety",
      settingCode: "sm",
      settingsColumn: "safety_mode",
    },
    preset: true,
    eventIdsKey: "safetyIds",
    rollupOrder: 0,
    public: {
      label: "Safety Grade Changes",
      shortLabel: "Safety",
      publicPhrase: "severe safety-grade downgrades",
      featureLine: "Severe safety-grade downgrade alerts (two or more notches, or into D/F, held 6 hours) with reason lines",
    },
    miniAppLabel: "Safety Score",
    miniAppDescription: "Severe grade drops live, other moves daily",
  },
  launch: {
    persistence: {
      subscriptionColumn: "alert_launch",
      overrideColumn: "alert_launch_override",
      globalColumn: "global_alert_launch",
      settingCode: "lc",
      settingsColumn: null,
    },
    preset: false,
    eventIdsKey: null,
    rollupOrder: null,
    public: null,
    miniAppLabel: "Launch",
    miniAppDescription: "Retired",
  },
  reserve: {
    persistence: {
      subscriptionColumn: "alert_reserve",
      overrideColumn: "alert_reserve_override",
      globalColumn: "global_alert_reserve",
      settingCode: "rs",
      settingsColumn: null,
    },
    preset: false,
    eventIdsKey: "reserveIds",
    rollupOrder: 3,
    public: {
      label: "Reserve Drift",
      shortLabel: "Reserve",
      publicPhrase: "live reserve-mix drift",
      featureLine: "Live reserve-mix drift alerts for covered stablecoins",
    },
    miniAppLabel: "Reserve changes",
    miniAppDescription: "Reserve mix shifts",
  },
  freeze: {
    persistence: {
      subscriptionColumn: "alert_freeze",
      overrideColumn: "alert_freeze_override",
      globalColumn: "global_alert_freeze",
      settingCode: "fz",
      settingsColumn: null,
    },
    preset: false,
    eventIdsKey: null,
    rollupOrder: 2,
    public: {
      label: "Freeze and Blacklist Events",
      shortLabel: "Freeze",
      publicPhrase: "issuer freeze, unfreeze, and destroy events",
      featureLine: "Opt-in issuer destroy alerts and freeze or release alerts of $1M or more from the verified tape",
    },
    miniAppLabel: "Freezes",
    miniAppDescription: "Large issuer freezes and token destroys",
  },
} as const satisfies Record<TelegramAlertType, {
  persistence: TelegramAlertPersistence;
  preset: boolean;
  eventIdsKey: string | null;
  rollupOrder: number | null;
  public: Omit<TelegramAlertFamily, "key" | "persistence"> | null;
  miniAppLabel: string;
  miniAppDescription: string;
}>;

/** Per-family persistence descriptors, keyed by alert type. */
export const TELEGRAM_ALERT_PERSISTENCE = Object.fromEntries(
  TELEGRAM_ALERT_TYPES.map((type) => [type, TELEGRAM_ALERT_FAMILY_REGISTRY[type].persistence]),
) as { [K in TelegramAlertType]: typeof TELEGRAM_ALERT_FAMILY_REGISTRY[K]["persistence"] };
export type TelegramAlertPersistenceTable = typeof TELEGRAM_ALERT_PERSISTENCE;
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
export type TelegramPresetAlertType = {
  [K in TelegramAlertType]: typeof TELEGRAM_ALERT_FAMILY_REGISTRY[K]["preset"] extends true ? K : never;
}[TelegramAlertType];
export const TELEGRAM_PRESET_ALERT_TYPES = TELEGRAM_ALERT_TYPES.filter(
  (type): type is TelegramPresetAlertType => TELEGRAM_ALERT_FAMILY_REGISTRY[type].preset,
);

export type TelegramAlertJobType = {
  [K in TelegramAlertType]: typeof TELEGRAM_ALERT_FAMILY_REGISTRY[K]["eventIdsKey"] extends string ? K : never;
}[TelegramAlertType];
export const TELEGRAM_ALERT_JOB_FAMILIES = TELEGRAM_ALERT_TYPES.filter(
  (type): type is TelegramAlertJobType => TELEGRAM_ALERT_FAMILY_REGISTRY[type].eventIdsKey != null,
).map((family) => ({
  family,
  idsKey: TELEGRAM_ALERT_FAMILY_REGISTRY[family].eventIdsKey,
  presetFamily: TELEGRAM_ALERT_FAMILY_REGISTRY[family].preset ? family as TelegramPresetAlertType : null,
}));

type TelegramRollupAlertType = {
  [K in TelegramAlertType]: typeof TELEGRAM_ALERT_FAMILY_REGISTRY[K]["rollupOrder"] extends number ? K : never;
}[TelegramAlertType];
export const TELEGRAM_ROLLUP_ALERT_TYPES = TELEGRAM_ALERT_TYPES.filter(
  (type): type is TelegramRollupAlertType => TELEGRAM_ALERT_FAMILY_REGISTRY[type].rollupOrder != null,
).sort((a, b) => TELEGRAM_ALERT_FAMILY_REGISTRY[a].rollupOrder - TELEGRAM_ALERT_FAMILY_REGISTRY[b].rollupOrder);

type TelegramTunedAlertType = {
  [K in TelegramAlertType]: typeof TELEGRAM_ALERT_FAMILY_REGISTRY[K]["persistence"]["settingsColumn"] extends string ? K : never;
}[TelegramAlertType];
export const TELEGRAM_TUNED_ALERT_TYPES = TELEGRAM_ALERT_TYPES.filter(
  (type): type is TelegramTunedAlertType => TELEGRAM_ALERT_PERSISTENCE[type].settingsColumn != null,
);

function activeFlagConditions(columns: readonly string[]): string {
  return columns.map((column) => `${column} = 1`).join("\n  OR ");
}

export const ACTIVE_SUBSCRIPTION_FLAGS_SQL = activeFlagConditions(
  TELEGRAM_ALERT_TYPES.map((alertType) => TELEGRAM_ALERT_PERSISTENCE[alertType].subscriptionColumn),
);

export const ACTIVE_PRESET_FLAGS_SQL = activeFlagConditions(
  TELEGRAM_PRESET_ALERT_TYPES.map((alertType) => TELEGRAM_ALERT_PERSISTENCE[alertType].subscriptionColumn),
);

/** Per-chat lifecycle opt-ins; requires subscriber s and family rollups sub/preset. */
const LIFECYCLE_OPT_IN_PREDICATES_SQL = TELEGRAM_ALERT_TYPES.map((alertType) => ({
  alertType,
  predicate: [
    `COALESCE(sub.${alertType}_enabled, 0) = 1`,
    ...((TELEGRAM_PRESET_ALERT_TYPES as readonly TelegramAlertType[]).includes(alertType)
      ? [`COALESCE(preset.${alertType}_enabled, 0) = 1`]
      : []),
    `s.${TELEGRAM_ALERT_PERSISTENCE[alertType].globalColumn} = 1`,
  ].join(" OR "),
}));

export const TELEGRAM_LIFECYCLE_OPT_IN_PROJECTIONS_SQL = [
  ...LIFECYCLE_OPT_IN_PREDICATES_SQL.map(({ alertType, predicate }) =>
    `SUM(CASE WHEN ${predicate} THEN 1 ELSE 0 END) AS active_${alertType}_opt_ins`,
  ),
  `SUM(CASE WHEN ${LIFECYCLE_OPT_IN_PREDICATES_SQL
    .map(({ predicate }) => `(${predicate})`).join(" AND ")} THEN 1 ELSE 0 END) AS active_all_types_opt_ins`,
].join(",\n           ");

export interface ActiveFamilyAggregateQueryOptions {
  /** Extra status-only projections such as total row counts or preference totals. */
  additionalColumns?: readonly string[];
  /** Include one `MAX` projection per family for family-specific totals. */
  includeFamilyFlags?: boolean;
  /** Filter inactive rows first, allowing the active count to use `COUNT(*)`. */
  activeRowsOnly?: boolean;
}

function buildActiveFamilyAggregateQuery(
  table: string,
  alertTypes: readonly TelegramAlertType[],
  activeFlagsSql: string,
  activeCountAlias: string,
  options: ActiveFamilyAggregateQueryOptions,
): string {
  const activeCount = options.activeRowsOnly
    ? `COUNT(*) AS ${activeCountAlias}`
    : `SUM(CASE WHEN ${activeFlagsSql} THEN 1 ELSE 0 END) AS ${activeCountAlias}`;
  const columns = [
    ...(options.additionalColumns ?? []),
    activeCount,
    ...(options.includeFamilyFlags
      ? alertTypes.map((alertType) => {
          const column = TELEGRAM_ALERT_PERSISTENCE[alertType].subscriptionColumn;
          return `MAX(CASE WHEN ${column} = 1 THEN 1 ELSE 0 END) AS ${alertType}_enabled`;
        })
      : []),
  ];
  return `SELECT chat_id,
        ${columns.join(",\n        ")}
   FROM ${table}${options.activeRowsOnly ? `\n  WHERE ${activeFlagsSql}` : ""}
  GROUP BY chat_id`;
}

/** Canonical per-chat active direct-subscription aggregate. */
export function buildActiveSubscriptionAggregateSql(
  options: ActiveFamilyAggregateQueryOptions = {},
): string {
  return buildActiveFamilyAggregateQuery(
    "telegram_subscriptions",
    TELEGRAM_ALERT_TYPES,
    ACTIVE_SUBSCRIPTION_FLAGS_SQL,
    "active_sub_count",
    options,
  );
}

/** Canonical per-chat active preset-subscription aggregate. */
export function buildActivePresetAggregateSql(
  options: ActiveFamilyAggregateQueryOptions = {},
): string {
  return buildActiveFamilyAggregateQuery(
    "telegram_preset_subscriptions",
    TELEGRAM_PRESET_ALERT_TYPES,
    ACTIVE_PRESET_FLAGS_SQL,
    "active_preset_count",
    options,
  );
}

/** Requires subscriber alias s and active-count aliases sub and preset. */
export const ACTIVE_WATCHER_SQL_CONDITION = `${
  activeFlagConditions(
    TELEGRAM_ALERT_TYPES.map((alertType) => `s.${TELEGRAM_ALERT_PERSISTENCE[alertType].globalColumn}`),
  )
}
  OR COALESCE(sub.active_sub_count, 0) > 0
  OR COALESCE(preset.active_preset_count, 0) > 0`;

export const TELEGRAM_ALERT_FAMILIES = TELEGRAM_LIVE_ALERT_TYPES.map((key) => ({
  key,
  ...TELEGRAM_ALERT_FAMILY_REGISTRY[key].public,
  persistence: TELEGRAM_ALERT_PERSISTENCE[key],
}));

/** Mini App copy remains distinct from the bot's compact family labels. */
export const TELEGRAM_MINI_APP_ALERT_LABELS = Object.fromEntries(
  TELEGRAM_ALERT_TYPES.map((type) => [type, TELEGRAM_ALERT_FAMILY_REGISTRY[type].miniAppLabel]),
) as Record<TelegramAlertType, string>;
export const TELEGRAM_MINI_APP_ALERT_DESCRIPTIONS = Object.fromEntries(
  TELEGRAM_ALERT_TYPES.map((type) => [type, TELEGRAM_ALERT_FAMILY_REGISTRY[type].miniAppDescription]),
) as Record<TelegramAlertType, string>;

/** Short control-surface label per family; retired families keep a label for legacy rows. */
export const TELEGRAM_ALERT_FAMILY_SHORT_LABELS = {
  ...Object.fromEntries(TELEGRAM_ALERT_FAMILIES.map((family) => [family.key, family.shortLabel])),
  launch: TELEGRAM_ALERT_FAMILY_REGISTRY.launch.miniAppLabel,
} as Record<TelegramAlertType, string>;

/** `/settings` family code → alert type. */
export const TELEGRAM_ALERT_TYPE_BY_SETTING_CODE = Object.fromEntries(
  TELEGRAM_ALERT_TYPES.map((alertType) => [
    TELEGRAM_ALERT_PERSISTENCE[alertType].settingCode,
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
export const TELEGRAM_ALERT_FAMILY_COMMAND_TOKENS = TELEGRAM_LIVE_ALERT_TYPES.join(", ");

/** Reply when a user asks for the retired launch family (e.g. `/subscribe launch`). */
export const TELEGRAM_LAUNCH_RETIRED_MESSAGE =
  "Launch alerts are retired. New stablecoins Pharos starts tracking are listed in the @pharoswatch channel digest, and upcoming launches are on pharos.watch/upcoming.";
