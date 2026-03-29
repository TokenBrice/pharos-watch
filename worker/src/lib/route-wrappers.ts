import { withAdmin } from "./auth";
import { runIdempotentAdminAction } from "./idempotency";
import { withErrorHandler } from "./api-utils";

interface RouteWrapperContext {
  db: D1Database;
  request: Request;
  trustedAdmin: boolean;
}

export function makeAdminRoute<TContext extends RouteWrapperContext>(
  endpoint: string,
  handler: (context: TContext) => Promise<Response>,
): (context: TContext) => Promise<Response> {
  return withErrorHandler(endpoint, (context: TContext) =>
    withAdmin(context.request, () => handler(context), context.trustedAdmin),
  );
}

export function makeIdempotentAdminRoute<TContext extends RouteWrapperContext>(
  endpoint: string,
  action: string,
  handler: (context: TContext) => Promise<Response>,
): (context: TContext) => Promise<Response> {
  return withErrorHandler(endpoint, (context: TContext) =>
    withAdmin(
      context.request,
      () => runIdempotentAdminAction(context.db, action, context.request, () => handler(context)),
      context.trustedAdmin,
    ),
  );
}

export function makeConditionalIdempotentAdminRoute<TContext extends RouteWrapperContext>(
  endpoint: string,
  action: string,
  shouldUseIdempotency: (context: TContext) => boolean,
  handler: (context: TContext) => Promise<Response>,
): (context: TContext) => Promise<Response> {
  return withErrorHandler(endpoint, (context: TContext) =>
    withAdmin(context.request, () => {
      if (!shouldUseIdempotency(context)) {
        return handler(context);
      }
      return runIdempotentAdminAction(context.db, action, context.request, () => handler(context));
    }, context.trustedAdmin),
  );
}
