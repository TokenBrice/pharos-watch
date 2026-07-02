import { OPS_UI_ORIGIN, normalizeOrigin, resolveOrigin } from "@shared/lib/runtime-origins";

const DEFAULT_OPS_UI_ORIGIN = OPS_UI_ORIGIN;

export function resolveOpsUiOrigin(env: { OPS_UI_ORIGIN?: string }): string {
  return resolveOrigin(env.OPS_UI_ORIGIN, DEFAULT_OPS_UI_ORIGIN);
}

export function rejectIfNotOpsUiOrigin(
  request: Request,
  env: { OPS_UI_ORIGIN?: string },
  notFound: () => Response,
): Response | null {
  return new URL(request.url).origin === resolveOpsUiOrigin(env) ? null : notFound();
}

export function hasMatchingOpsUiOriginHeader(
  request: Request,
  env: { OPS_UI_ORIGIN?: string },
): boolean {
  const requestOrigin = request.headers.get("Origin")?.trim();
  if (!requestOrigin) {
    return false;
  }
  return normalizeOrigin(requestOrigin) === normalizeOrigin(resolveOpsUiOrigin(env));
}
