export const DEFAULT_OPS_UI_ORIGIN = "https://ops.pharos.watch";

/** Normalizes a string to a proper URL origin (protocol + host, no path). */
export function normalizeOrigin(input: string): string {
  const normalized = input.includes("://") ? input : `https://${input}`;
  return new URL(normalized).origin;
}

export function resolveOpsUiOrigin(env: { OPS_UI_ORIGIN?: string }): string {
  return normalizeOrigin(env.OPS_UI_ORIGIN?.trim() || DEFAULT_OPS_UI_ORIGIN);
}
