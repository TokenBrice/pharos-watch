export type DexArchiveMode = "off" | "shadow" | "delete";
export type DexArchiveFamily = "measured-execution" | "liquidity";

export interface ResolvedDexArchiveMode {
  configuredMode: string;
  effectiveMode: DexArchiveMode;
  configError: string | null;
}

const VALID_MODES = new Set<DexArchiveMode>(["off", "shadow", "delete"]);

export function resolveDexArchiveMode(value: string | undefined): ResolvedDexArchiveMode {
  const normalized = value?.trim().toLowerCase() || "off";
  const configuredMode = VALID_MODES.has(normalized as DexArchiveMode) ? normalized : "invalid";
  if (VALID_MODES.has(configuredMode as DexArchiveMode)) {
    return {
      configuredMode,
      effectiveMode: configuredMode as DexArchiveMode,
      configError: null,
    };
  }
  return {
    configuredMode,
    effectiveMode: "off",
    configError: "invalid archive mode; expected off, shadow, or delete",
  };
}

/**
 * Release A is deliberately incapable of archive I/O. Later releases replace
 * this foundation gate family-by-family after their shadow evidence is ready.
 */
export function enforceDexArchiveFoundationMode(
  resolved: ResolvedDexArchiveMode,
): ResolvedDexArchiveMode {
  if (resolved.effectiveMode === "off") return resolved;
  return {
    ...resolved,
    effectiveMode: "off",
    configError: `archive mode "${resolved.configuredMode}" is not active in the foundation release`,
  };
}
