import { withAdmin } from "./auth";
import { runIdempotentAdminAction } from "./idempotency";
import { errorResponse, jsonResponse, withErrorHandler } from "./api-utils";
import type { JsonResponseOptions } from "./api-response";

import { MUTATING_METHODS, X_PHAROS_ADMIN_HEADER } from "@shared/lib/admin-gate";

export interface AdminRouteContext {
  db: D1Database;
  request: Request;
  trustedAdmin: boolean;
}

export interface AdminUrlRouteContext extends AdminRouteContext {
  url: URL;
}

interface RunAdminRouteOptions {
  endpoint: string;
  request?: Request;
  trustedAdmin?: boolean;
  db?: D1Database;
  action?: string;
  shouldUseIdempotency?: boolean;
}

export function runAdminRoute(
  options: RunAdminRouteOptions,
  handler: () => Promise<Response>,
): Promise<Response> {
  return withErrorHandler(options.endpoint, async () => {
    const method = options.request?.method?.toUpperCase() ?? "GET";
    if (
      MUTATING_METHODS.has(method) &&
      options.request?.headers.get(X_PHAROS_ADMIN_HEADER) !== "1"
    ) {
      return jsonResponse(
        { error: "Missing required X-Pharos-Admin header; refusing mutation." },
        { status: 403, noStore: true },
      );
    }
    return withAdmin(options.request, () => {
      if (options.action && options.db && options.shouldUseIdempotency !== false) {
        return runIdempotentAdminAction(options.db, options.action, options.request, handler);
      }
      return handler();
    }, options.trustedAdmin);
  })();
}

type AdminResponseOptions = Omit<JsonResponseOptions, "noStore">;

export function adminJsonResponse(body: unknown, options?: AdminResponseOptions): Response {
  return jsonResponse(body, { ...(options ?? {}), noStore: true });
}

export function adminErrorResponse(
  status: number,
  message: string,
  options?: Omit<AdminResponseOptions, "status">,
): Response {
  return errorResponse(status, message, { ...(options ?? {}), noStore: true });
}

export function makeAdminRoute<TContext extends AdminRouteContext>(
  endpoint: string,
  handler: (context: TContext) => Promise<Response>,
): (context: TContext) => Promise<Response> {
  return (context: TContext) =>
    runAdminRoute(
      {
        endpoint,
        request: context.request,
        trustedAdmin: context.trustedAdmin,
      },
      () => handler(context),
    );
}

export function makeIdempotentAdminRoute<TContext extends AdminRouteContext>(
  endpoint: string,
  action: string,
  handler: (context: TContext) => Promise<Response>,
): (context: TContext) => Promise<Response> {
  return (context: TContext) =>
    runAdminRoute(
      {
        endpoint,
        request: context.request,
        trustedAdmin: context.trustedAdmin,
        db: context.db,
        action,
      },
      () => handler(context),
    );
}

export function makeConditionalIdempotentAdminRoute<TContext extends AdminRouteContext>(
  endpoint: string,
  action: string,
  shouldUseIdempotency: (context: TContext) => boolean,
  handler: (context: TContext) => Promise<Response>,
): (context: TContext) => Promise<Response> {
  return (context: TContext) =>
    runAdminRoute(
      {
        endpoint,
        request: context.request,
        trustedAdmin: context.trustedAdmin,
        db: context.db,
        action,
        shouldUseIdempotency: shouldUseIdempotency(context),
      },
      () => handler(context),
    );
}
