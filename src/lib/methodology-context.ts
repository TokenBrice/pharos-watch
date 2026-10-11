import { DEFINITIONS, type Definition, type MethodologyDefinitionKey } from "./definitions";

/**
 * Tooltip projection of the Pharos metric definitions in `./definitions`
 * (the single term source). Kept as a stable API for `MethodologyHint`,
 * `MethodologyLabel`, `<Term>`, and score badges.
 */
export interface MethodologyContextItem {
  title: string;
  summary: string;
  detail?: string;
  methodologyPath: string;
  versionLabel?: string;
  changelogPath?: string;
}

export type MethodologyContextKey = MethodologyDefinitionKey;

function toContextItem(def: Definition & { methodologyPath: string }): MethodologyContextItem {
  return {
    title: def.label,
    summary: def.short,
    ...(def.detail ? { detail: def.detail } : {}),
    methodologyPath: def.methodologyPath,
    ...(def.versionLabel ? { versionLabel: def.versionLabel } : {}),
    ...(def.changelogPath ? { changelogPath: def.changelogPath } : {}),
  };
}

export const METHODOLOGY_CONTEXT = Object.fromEntries(
  (Object.entries(DEFINITIONS) as [string, Definition][])
    .filter((entry): entry is [string, Definition & { methodologyPath: string }] => entry[1].methodologyPath !== undefined)
    .map(([key, def]) => [key, toContextItem(def)]),
) as Record<MethodologyContextKey, MethodologyContextItem>;
