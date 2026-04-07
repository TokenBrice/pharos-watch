import { withAdmin } from "./auth";
import { runIdempotentAdminAction } from "./idempotency";
import { withErrorHandler } from "./api-utils";

interface RouteWrapperContext {
  db: D1Database;
  request: Request;
  trustedAdmin: boolean;
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
  return withErrorHandler(options.endpoint, async () =>
    withAdmin(options.request, () => {
      if (options.action && options.db && options.shouldUseIdempotency !== false) {
        return runIdempotentAdminAction(options.db, options.action, options.request, handler);
      }
      return handler();
    }, options.trustedAdmin),
  )();
}

export function makeAdminRoute<TContext extends RouteWrapperContext>(
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

export function makeIdempotentAdminRoute<TContext extends RouteWrapperContext>(
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

export function makeConditionalIdempotentAdminRoute<TContext extends RouteWrapperContext>(
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
