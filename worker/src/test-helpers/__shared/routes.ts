import type { FullRouteContext } from "../../routes/shared";

const INERT_EXEC_CTX = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

/**
 * Binds the fixed half of a route context (the D1 double, the execution context)
 * so suites only name what each case varies: a URL, a request, or both.
 */
export function routeContextFactory(defaults: { db: D1Database; execCtx?: ExecutionContext }) {
  return (
    overrides: Partial<FullRouteContext> & ({ url: URL } | { request: Request }),
  ): FullRouteContext => {
    const url = overrides.url ?? new URL((overrides.request as Request).url);
    return {
      db: defaults.db,
      execCtx: defaults.execCtx ?? INERT_EXEC_CTX,
      request: new Request(url.toString()),
      trustedAdmin: false,
      ...overrides,
      url,
    };
  };
}
