import { cloneRedemptionBackstopConfig, type RedemptionBackstopConfig } from "./shared";

export interface RedemptionBackstopRegistryEntry {
  id: string;
  config: RedemptionBackstopConfig;
  overrideReason?: string;
  sourceFilePath?: string;
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

/**
 * Re-point a family's entries at the config objects held by its own registry.
 *
 * A family that calls `applyTrackedReviewedDocs` after `defineBackstopRegistry`
 * backfills docs onto the registry's clones, not onto the source configs the
 * entries were built from. Rebinding lets the exported entry array carry those
 * backfills to the manifest. Entry order, override reasons, and source file
 * paths are untouched; duplicate ids resolve to the winning config, which is
 * what the manifest would have read off the registry anyway.
 */
export function rebindEntriesToRegistry(
  entries: readonly RedemptionBackstopRegistryEntry[],
  configs: Record<string, RedemptionBackstopConfig>,
): RedemptionBackstopRegistryEntry[] {
  return entries.map((entry) => ({ ...entry, config: configs[entry.id] ?? entry.config }));
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
