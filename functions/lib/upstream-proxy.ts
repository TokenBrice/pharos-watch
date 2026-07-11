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

  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROXY_RESPONSE_BODY_BYTES) {
    await response.body.cancel(new ProxyResponseTooLargeError());
    throw new ProxyResponseTooLargeError();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const cancelForAbort = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", cancelForAbort, { once: true });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_PROXY_RESPONSE_BODY_BYTES) {
        const error = new ProxyResponseTooLargeError();
        await reader.cancel(error).catch(() => undefined);
        throw error;
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancelForAbort);
  }

  if (signal.aborted) {
    throw signal.reason;
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

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
