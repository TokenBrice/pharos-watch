import type { PagesProxyContext } from "../../lib/pages-proxy-harness";

export type PagesProxyParams = { path?: string | string[] };

export interface MakePagesProxyContextOptions<Env> {
  request: Request;
  env: Env;
  /** Route prefix the `[[path]]` catch-all is mounted at, e.g. `/api/admin`. */
  mountPath: string;
  /** Explicit params; defaults to the catch-all split of the path below `mountPath`. */
  params?: PagesProxyParams;
  waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * Reproduces how Cloudflare Pages fills `params` for a `[[path]]` catch-all:
 * no trailing segment yields no `path`, one segment yields a string, and
 * several segments yield the split array.
 */
function derivePagesProxyParams(request: Request, mountPath: string): PagesProxyParams {
  const { pathname } = new URL(request.url);
  const prefix = mountPath.endsWith("/") ? mountPath : `${mountPath}/`;
  if (!pathname.startsWith(prefix)) return {};
  const segments = pathname.slice(prefix.length).split("/").filter(Boolean);
  if (segments.length === 0) return {};
  return { path: segments.length === 1 ? segments[0] : segments };
}

/**
 * Builds the Pages-Functions context bag (`{ request, env, params, waitUntil }`)
 * that `functions/**` entrypoints receive. Every field stays overridable, so a
 * test can still hand-write params that deliberately disagree with the URL.
 */
export function makePagesProxyContext<Env>(
  options: MakePagesProxyContextOptions<Env>,
): PagesProxyContext<Env> {
  const { request, env, mountPath, params, waitUntil } = options;
  const context: PagesProxyContext<Env> = {
    request,
    env,
    params: params ?? derivePagesProxyParams(request, mountPath),
  };
  if (waitUntil) {
    context.waitUntil = waitUntil;
  }
  return context;
}
