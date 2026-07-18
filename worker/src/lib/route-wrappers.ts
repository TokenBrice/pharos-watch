import { withAdmin } from "./auth";
import { runIdempotentAdminAction } from "./idempotency";
import { errorResponse, jsonResponse, noStoreResponse, withErrorHandler } from "./api-response";
import { logWorkerEvent } from "./structured-log";
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

export function runAdminRoute(options: RunAdminRouteOptions, handler: () => Promise<Response>): Promise<Response> {
  return withErrorHandler(options.endpoint, async () => {
    const method = options.request?.method?.toUpperCase() ?? "GET";
    if (MUTATING_METHODS.has(method) && options.request?.headers.get(X_PHAROS_ADMIN_HEADER) !== "1") {
      return jsonResponse(
        { error: "Missing required X-Pharos-Admin header; refusing mutation." },
        { status: 403, noStore: true },
      );
    }
    return withAdmin(
      options.request,
      () => {
        if (options.action && options.db && options.shouldUseIdempotency !== false) {
          return runIdempotentAdminAction(options.db, options.action, options.request, handler);
        }
        return handler();
      },
      options.trustedAdmin,
    );
  })().then(noStoreResponse);
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

// Note: `endpoint` is an operational identifier used in error logs;
// `action` is the persisted idempotency key. Direct callers pass distinct values;
// admin-routes.ts passes the same key for both as a deliberate default.
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

/**
 * Wrap a trusted admin mutation body so all uncaught throws are captured and
 * shaped into a uniform JSON response. Route-level wrappers should own auth,
 * idempotency, and no-store policy before calling this helper.
 *
 * Returns the handler's Response on success (including its own controlled
 * error responses like 400/404/500). If the handler throws, logs the error
 * and returns 503 with `{ error: <error.name>, message: "Admin mutation failed" }`
 * — never leaks raw `error.message` (which may contain SQL or other internals).
 */
export async function runTrustedAdminMutation(handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    const name = error instanceof Error ? error.name : "UnknownError";
    logWorkerEvent({
      scope: "admin",
      level: "error",
      event: "admin_mutation_uncaught",
      message: "Admin mutation failed",
      error,
      metadata: { errorName: name },
    });
    return jsonResponse({ error: name, message: "Admin mutation failed" }, { status: 503, noStore: true });
  }
}
