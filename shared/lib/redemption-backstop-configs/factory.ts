import { cloneRedemptionBackstopConfig, cloneRedemptionDocSource, type RedemptionBackstopConfig } from "./shared";

export interface RedemptionBackstopRegistryEntry {
  id: string;
  config: RedemptionBackstopConfig;
  overrideReason?: string;
  sourceFilePath?: string;
}

const REGISTRY_OVERRIDE_REASONS = new WeakMap<Record<string, RedemptionBackstopConfig>, Map<string, string>>();
const REGISTRY_SOURCE_FILE_PATHS = new WeakMap<Record<string, RedemptionBackstopConfig>, Map<string, string>>();

export function defineBackstopRegistry(
  entries: readonly RedemptionBackstopRegistryEntry[],
): Record<string, RedemptionBackstopConfig> {
  const configs: Record<string, RedemptionBackstopConfig> = {};
  const overrideReasons = new Map<string, string>();
  const sourceFilePaths = new Map<string, string>();

  for (const entry of entries) {
    const hasExistingConfig = Object.prototype.hasOwnProperty.call(configs, entry.id);
    if (hasExistingConfig && !entry.overrideReason) {
      throw new Error(`Redemption backstop config "${entry.id}" is duplicated without an override reason.`);
    }

    configs[entry.id] = cloneRedemptionBackstopConfig(entry.config);
    if (entry.overrideReason) {
      overrideReasons.set(entry.id, entry.overrideReason);
    }
    if (entry.sourceFilePath) {
      sourceFilePaths.set(entry.id, entry.sourceFilePath);
    }
  }

  REGISTRY_OVERRIDE_REASONS.set(configs, overrideReasons);
  REGISTRY_SOURCE_FILE_PATHS.set(configs, sourceFilePaths);
  return configs;
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

export function defineOverride(
  id: string,
  base: RedemptionBackstopConfig,
  overrides: Partial<RedemptionBackstopConfig>,
  reason: string,
  options?: { sourceFilePath?: string },
): RedemptionBackstopRegistryEntry {
  if (!reason.trim()) {
    throw new Error(`Redemption backstop config override for "${id}" requires a reason.`);
  }

  return {
    id,
    config: {
      ...cloneRedemptionBackstopConfig(base),
      ...overrides,
      ...(overrides.capacityModel ? { capacityModel: { ...overrides.capacityModel } } : {}),
      ...(overrides.costModel ? { costModel: { ...overrides.costModel } } : {}),
      ...(overrides.v9ComposedDexExit
        ? {
            v9ComposedDexExit: {
              ...overrides.v9ComposedDexExit,
              docs: overrides.v9ComposedDexExit.docs.map(cloneRedemptionDocSource),
            },
          }
        : {}),
      ...(overrides.docs ? { docs: overrides.docs.map(cloneRedemptionDocSource) } : {}),
      ...(overrides.notes ? { notes: [...overrides.notes] } : {}),
    },
    overrideReason: reason,
    ...(options?.sourceFilePath ? { sourceFilePath: options.sourceFilePath } : {}),
  };
}

/**
 * Build registry entries from a `Record<id, config>`, attaching a `sourceFilePath`
 * and an override reason. Supply `overrideReason` to apply one reason to every
 * entry (uniform override of a shared default), or `overrideReasonForIds` to attach
 * a reason only to the ids it returns a string for (the rest stay un-flagged).
 */
export function defineRecordEntries(
  configs: Record<string, RedemptionBackstopConfig>,
  options: {
    overrideReason?: string;
    overrideReasonForIds?: (id: string) => string | undefined;
    sourceFilePath: string;
  },
): RedemptionBackstopRegistryEntry[] {
  return Object.entries(configs).map(([id, config]) => {
    const overrideReason = options.overrideReason ?? options.overrideReasonForIds?.(id);
    return {
      id,
      config,
      sourceFilePath: options.sourceFilePath,
      ...(overrideReason ? { overrideReason } : {}),
    };
  });
}

export function getBackstopRegistryOverrideReasons(
  configs: Record<string, RedemptionBackstopConfig>,
): ReadonlyMap<string, string> {
  return REGISTRY_OVERRIDE_REASONS.get(configs) ?? new Map();
}

export function getBackstopRegistrySourceFilePaths(
  configs: Record<string, RedemptionBackstopConfig>,
): ReadonlyMap<string, string> {
  return REGISTRY_SOURCE_FILE_PATHS.get(configs) ?? new Map();
}
