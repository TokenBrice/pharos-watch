import { OPS_UI_ORIGIN, normalizeOrigin, resolveOrigin } from "@shared/lib/runtime-origins";

export const DEFAULT_OPS_UI_ORIGIN = OPS_UI_ORIGIN;
export { normalizeOrigin };

export function resolveOpsUiOrigin(env: { OPS_UI_ORIGIN?: string }): string {
  return resolveOrigin(env.OPS_UI_ORIGIN, DEFAULT_OPS_UI_ORIGIN);
}
