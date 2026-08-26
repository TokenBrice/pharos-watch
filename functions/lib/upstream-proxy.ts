import { bufferReadableStream, parseDeclaredLength } from "@shared/lib/bounded-stream";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { jsonError, summarizeFetchError } from "./proxy-utils";

export const DEFAULT_PROXY_TIMEOUT_MS = 10_000;
export const MAX_PROXY_RESPONSE_BODY_BYTES = 16 * 1024 * 1024;

class ProxyResponseTooLargeError extends Error {
  constructor() {
    super(`Upstream response exceeded ${MAX_PROXY_RESPONSE_BODY_BYTES} bytes`);
    this.name = "ProxyResponseTooLargeError";
  }
}

async function bufferUpstreamResponse(response: Response, signal: AbortSignal): Promise<Response> {
  if (response.body === null) {
    return response;
  }

  const declaredLength = parseDeclaredLength(response.headers.get("Content-Length"));
  if (
    (declaredLength.status === "valid" && declaredLength.value > MAX_PROXY_RESPONSE_BODY_BYTES) ||
    (declaredLength.status === "invalid" && declaredLength.reason === "unsafe")
  ) {
    await response.body.cancel(new ProxyResponseTooLargeError());
    throw new ProxyResponseTooLargeError();
  }

  const { bytes: body } = await bufferReadableStream(response.body, {
    maxBytes: MAX_PROXY_RESPONSE_BODY_BYTES,
    signal,
    createOverflowError: () => new ProxyResponseTooLargeError(),
    overflowCancelReason: (error) => error,
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

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
    return { ok: true, response: await bufferUpstreamResponse(response, timeout.signal) };
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
