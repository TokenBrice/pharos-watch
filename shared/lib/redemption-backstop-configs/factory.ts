import type { RedemptionBackstopConfig } from "./shared";

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
    if (hasExistingConfig && entry.overrideReason) {
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
      ...(overrides.docs ? { docs: overrides.docs.map(cloneRedemptionDocSource) } : {}),
      ...(overrides.notes ? { notes: [...overrides.notes] } : {}),
    },
    overrideReason: reason,
    ...(options?.sourceFilePath ? { sourceFilePath: options.sourceFilePath } : {}),
  };
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

function cloneRedemptionBackstopConfig(config: RedemptionBackstopConfig): RedemptionBackstopConfig {
  return {
    ...config,
    capacityModel: { ...config.capacityModel },
    costModel: { ...config.costModel },
    ...(config.docs ? { docs: config.docs.map(cloneRedemptionDocSource) } : {}),
    ...(config.notes ? { notes: [...config.notes] } : {}),
  };
}

function cloneRedemptionDocSource(doc: NonNullable<RedemptionBackstopConfig["docs"]>[number]) {
  return {
    label: doc.label,
    url: doc.url,
    ...(doc.supports ? { supports: [...doc.supports] } : {}),
  };
}
