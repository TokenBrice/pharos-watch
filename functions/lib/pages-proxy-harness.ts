import { DEFAULT_PROXY_TIMEOUT_MS, fetchUpstreamProxy } from "./upstream-proxy";
import { jsonError } from "./proxy-utils";

export interface PagesProxyContext<Env, Params = { path?: string | string[] }> {
  request: Request;
  env: Env;
  params: Params;
  waitUntil?: (promise: Promise<unknown>) => void;
}

export interface PagesProxyUpstreamRequest {
  upstreamUrl: string;
  method: string;
  headers: Headers;
  body?: BodyInit | null;
  timeoutMs: number;
  timeoutReason: DOMException;
  timeoutMessage: string;
  fetchFailedMessage: string;
}

export interface CreateProxyRequestOptions {
  request: Request;
  origin: string;
  path: string;
  search?: string;
  method?: string;
  headers?: Headers;
  body?: BodyInit | null;
  timeoutMs?: number;
  label: string;
}

export function createProxyRequest({
  request,
  origin,
  path,
  search = "",
  method = request.method,
  headers = new Headers(),
  body,
  timeoutMs = DEFAULT_PROXY_TIMEOUT_MS,
  label,
}: CreateProxyRequestOptions): PagesProxyUpstreamRequest {
  const timeoutMessage = `${label} upstream timed out`;
  return {
    upstreamUrl: new URL(`${path}${search}`, origin).toString(),
    method,
    headers,
    body,
    timeoutMs,
    timeoutReason: new DOMException(timeoutMessage, "TimeoutError"),
    timeoutMessage,
    fetchFailedMessage: `${label} upstream fetch failed`,
  };
}

export function rejectInvalidProxyEnvironment({
  issues,
  fatalCodes,
  logPrefix,
  publicMessage,
}: {
  issues: readonly { code: string; message: string }[];
  fatalCodes: readonly string[];
  logPrefix: string;
  publicMessage: string;
}): Response | null {
  for (const issue of issues) {
    console.warn(`[${logPrefix}] ${issue.message}`);
  }
  return issues.some((issue) => fatalCodes.includes(issue.code))
    ? jsonError(500, publicMessage)
    : null;
}

export type PagesProxyFetchErrorKind = "timeout" | "fetch-error";

export interface PagesProxyHarness<Env, Params> {
  logPrefix: string;
  finalizeResponse?: (
    context: PagesProxyContext<Env, Params>,
    response: Response,
  ) => Response;
  rejectRequest?: (context: PagesProxyContext<Env, Params>) => Response | null;
  validateEnv?: (context: PagesProxyContext<Env, Params>) => Response | null;
  resolveUpstreamPath: (context: PagesProxyContext<Env, Params>) => string | null;
  rejectUpstreamPath?: (
    context: PagesProxyContext<Env, Params>,
    upstreamPath: string,
  ) => Response | null;
  rejectMethod?: (
    context: PagesProxyContext<Env, Params>,
    upstreamPath: string,
  ) => Response | null;
  beforeFetch?: (
    context: PagesProxyContext<Env, Params>,
    upstreamPath: string,
  ) => Promise<Response | null> | Response | null;
  buildUpstreamRequest: (
    context: PagesProxyContext<Env, Params>,
    upstreamPath: string,
  ) => PagesProxyUpstreamRequest | Response;
  onFetchError?: (
    context: PagesProxyContext<Env, Params>,
    upstreamPath: string,
    errorKind: PagesProxyFetchErrorKind,
    response: Response,
  ) => Promise<Response> | Response;
  buildResponse: (
    context: PagesProxyContext<Env, Params>,
    upstreamPath: string,
    upstreamResponse: Response,
  ) => Promise<Response> | Response;
}

export async function runPagesProxy<Env, Params>(
  context: PagesProxyContext<Env, Params>,
  harness: PagesProxyHarness<Env, Params>,
): Promise<Response> {
  const finalize = (response: Response): Response =>
    harness.finalizeResponse?.(context, response) ?? response;

  const requestError = harness.rejectRequest?.(context);
  if (requestError) {
    return finalize(requestError);
  }

  const envError = harness.validateEnv?.(context);
  if (envError) {
    return finalize(envError);
  }

  const upstreamPath = harness.resolveUpstreamPath(context);
  if (!upstreamPath) {
    return finalize(harness.rejectUpstreamPath?.(context, "") ?? new Response(null, { status: 404 }));
  }

  const pathError = harness.rejectUpstreamPath?.(context, upstreamPath);
  if (pathError) {
    return finalize(pathError);
  }

  const methodError = harness.rejectMethod?.(context, upstreamPath);
  if (methodError) {
    return finalize(methodError);
  }

  const earlyResponse = await harness.beforeFetch?.(context, upstreamPath);
  if (earlyResponse) {
    return finalize(earlyResponse);
  }

  const upstreamRequest = harness.buildUpstreamRequest(context, upstreamPath);
  if (upstreamRequest instanceof Response) {
    return finalize(upstreamRequest);
  }

  const upstreamResult = await fetchUpstreamProxy(context.request, {
    upstreamUrl: upstreamRequest.upstreamUrl,
    method: upstreamRequest.method,
    headers: upstreamRequest.headers,
    body: upstreamRequest.body,
    timeoutMs: upstreamRequest.timeoutMs,
    timeoutReason: upstreamRequest.timeoutReason,
    logPrefix: harness.logPrefix,
    timeoutMessage: upstreamRequest.timeoutMessage,
    fetchFailedMessage: upstreamRequest.fetchFailedMessage,
  });
  if (!upstreamResult.ok) {
    const response = harness.onFetchError
      ? await harness.onFetchError(context, upstreamPath, upstreamResult.errorKind, upstreamResult.response)
      : upstreamResult.response;
    return finalize(response);
  }

  return finalize(await harness.buildResponse(context, upstreamPath, upstreamResult.response));
}
