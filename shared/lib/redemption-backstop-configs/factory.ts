import {
  cloneRedemptionBackstopConfig,
  type RedemptionBackstopConfig,
  withTrackedReviewedDocs,
} from "./shared";

export interface RedemptionBackstopRegistryEntry {
  id: string;
  config: RedemptionBackstopConfig;
  overrideReason?: string;
  sourceFilePath?: string;
}

export interface RedemptionBackstopReviewedDocsPatch {
  stablecoinIds: readonly string[];
  reviewedAt?: string;
}

export interface FinalizedRedemptionBackstopRegistry {
  entries: readonly RedemptionBackstopRegistryEntry[];
  configs: Record<string, RedemptionBackstopConfig>;
}

export function defineBackstopRegistry(
  entries: readonly RedemptionBackstopRegistryEntry[],
): Record<string, RedemptionBackstopConfig> {
  const configs: Record<string, RedemptionBackstopConfig> = {};

  for (const entry of entries) {
    const hasExistingConfig = Object.prototype.hasOwnProperty.call(configs, entry.id);
    if (hasExistingConfig && !entry.overrideReason) {
      throw new Error(`Redemption backstop config "${entry.id}" is duplicated without an override reason.`);
    }

    configs[entry.id] = cloneRedemptionBackstopConfig(entry.config);
  }

  return configs;
}

/** Finish reviewed-doc defaults before exposing either entries or their registry. */
export function finalizeBackstopRegistry(
  entries: readonly RedemptionBackstopRegistryEntry[],
  reviewedDocsPatches: readonly RedemptionBackstopReviewedDocsPatch[] = [],
): FinalizedRedemptionBackstopRegistry {
  const reviewedAtById = new Map<string, string | undefined>();
  for (const patch of reviewedDocsPatches) {
    for (const stablecoinId of patch.stablecoinIds) reviewedAtById.set(stablecoinId, patch.reviewedAt);
  }

  const configs = defineBackstopRegistry(entries.map((entry) => ({
    ...entry,
    config: reviewedAtById.has(entry.id)
      ? withTrackedReviewedDocs(entry.config, entry.id, reviewedAtById.get(entry.id))
      : entry.config,
  })));

  for (const stablecoinId of reviewedAtById.keys()) {
    if (!configs[stablecoinId]) {
      throw new Error(
        `Missing redemption backstop config for stablecoin id "${stablecoinId}" while applying tracked reviewed docs`,
      );
    }
  }

  return {
    configs,
    entries: entries.map((entry) => ({ ...entry, config: configs[entry.id] ?? entry.config })),
  };
}

/**
 * Fan out one base config to an array of RedemptionBackstopRegistryEntry values.
 * Use this inside defineBackstopRegistry to register multiple ids sharing the same config.
 * For plain-object merges outside the registry, use expandIds() in shared.ts instead.
 */
export function defineBatch(
  ids: readonly string[],
  config: RedemptionBackstopConfig,
  options?: { sourceFilePath?: string },
): RedemptionBackstopRegistryEntry[] {
  return ids.map((id) => ({
    id,
    config,
    ...(options?.sourceFilePath ? { sourceFilePath: options.sourceFilePath } : {}),
  }));
}

/** Build a plain config map from explicit per-id family rows. */
export function defineConfigFamily<Row extends { id: string }>(
  rows: readonly Row[],
  build: (row: Row) => RedemptionBackstopConfig,
): Record<string, RedemptionBackstopConfig> {
  return Object.fromEntries(rows.map((row) => [row.id, cloneRedemptionBackstopConfig(build(row))]));
}

/**
 * Build registry entries from a `Record<id, config>`, optionally attaching a
 * `sourceFilePath` and an override reason. Supply `overrideReason` to apply one
 * reason to every entry (uniform override of a shared default), or
 * `overrideReasonForIds` to attach a reason only to the ids it returns a string
 * for (the rest stay un-flagged). Omit `sourceFilePath` when the entries live in
 * the manifest module's own file and should inherit its path.
 */
export function defineRecordEntries(
  configs: Record<string, RedemptionBackstopConfig>,
  options: {
    overrideReason?: string;
    overrideReasonForIds?: (id: string) => string | undefined;
    sourceFilePath?: string;
  } = {},
): RedemptionBackstopRegistryEntry[] {
  return Object.entries(configs).map(([id, config]) => {
    const overrideReason = options.overrideReason ?? options.overrideReasonForIds?.(id);
    return {
      id,
      config,
      ...(options.sourceFilePath ? { sourceFilePath: options.sourceFilePath } : {}),
      ...(overrideReason ? { overrideReason } : {}),
    };
  });
}
