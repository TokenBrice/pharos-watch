import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { jsonError, summarizeFetchError } from "./proxy-utils";

export const DEFAULT_PROXY_TIMEOUT_MS = 10_000;

export function resolveWildcardProxyPath(
  path: string | string[] | undefined,
  prefix: string,
): string | null {
  if (Array.isArray(path)) {
    return path.length > 0 ? `${prefix}${path.join("/")}` : null;
  }
  if (typeof path === "string" && path.length > 0) {
    return `${prefix}${path}`;
  }
  return null;
}

export async function fetchUpstreamProxy(request: Request, {
  upstreamUrl,
  method,
  headers,
  body,
  timeoutMs = DEFAULT_PROXY_TIMEOUT_MS,
  timeoutReason,
  logPrefix,
  timeoutMessage,
  fetchFailedMessage,
}: {
  upstreamUrl: string;
  method: string;
  headers: Headers;
  body?: BodyInit | null;
  timeoutMs?: number;
  timeoutReason: DOMException;
  logPrefix: string;
  timeoutMessage: string;
  fetchFailedMessage: string;
}): Promise<
  | { ok: true; response: Response }
  | { ok: false; errorKind: "timeout" | "fetch-error"; response: Response }
> {
  const timeout = createTimeoutSignal({
    timeoutMs,
    timeoutReason,
    parentSignal: request.signal,
  });

  try {
    const response = await fetch(upstreamUrl, {
      method,
      headers,
      body,
      redirect: "manual",
      signal: timeout.signal,
    });
    return { ok: true, response };
  } catch (error) {
    const summary = summarizeFetchError(error);
    console.warn(`[${logPrefix}] upstream fetch failed (${summary.kind}): ${summary.message}`);
    if (timeout.isTimedOut()) {
      return {
        ok: false,
        errorKind: "timeout",
        response: jsonError(504, timeoutMessage),
      };
    }
    return {
      ok: false,
      errorKind: "fetch-error",
      response: jsonError(502, fetchFailedMessage),
    };
  } finally {
    timeout.dispose();
  }
}
