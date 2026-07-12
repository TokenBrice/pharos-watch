export async function drainResponseBody(response: Response): Promise<void> {
  if (response.bodyUsed || !response.body) {
    return;
  }

  try {
    await response.arrayBuffer();
  } catch {
    try {
      await response.body.cancel();
    } catch {
      /* expected: body already consumed or stream cancelled */
    }
  }
}

export async function cancelResponseBodyQuietly(response: Response | null | undefined): Promise<void> {
  if (!response?.body || response.bodyUsed) {
    return;
  }

  try {
    await response.body.cancel();
  } catch {
    /* best-effort cancellation only */
  }
}

export async function cancelUnsuccessfulResponseBodyQuietly(response: Response | null | undefined): Promise<void> {
  if (!response || response.ok) {
    return;
  }

  await cancelResponseBodyQuietly(response);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function cancelResponseBodyForAbort(response: Response): void {
  if (!response.body) return;
  void response.body.cancel().catch(() => {
    /* best-effort cancellation only */
  });
}

export class ResponseBodyTooLargeError extends Error {
  readonly maxBytes: number;
  readonly observedBytes: number;

  constructor(maxBytes: number, observedBytes: number) {
    super(`Response body exceeded ${maxBytes} bytes (observed at least ${observedBytes} bytes)`);
    this.name = "ResponseBodyTooLargeError";
    this.maxBytes = maxBytes;
    this.observedBytes = observedBytes;
  }
}

function declaredResponseLength(response: Response): number | null {
  const getHeader = response.headers?.get;
  const raw = typeof getHeader === "function"
    ? getHeader.call(response.headers, "Content-Length")
    : null;
  if (raw == null || !/^\d+$/.test(raw.trim())) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function assertTextWithinLimit(text: string, maxBytes: number): void {
  const observedBytes = new TextEncoder().encode(text).byteLength;
  if (observedBytes > maxBytes) {
    throw new ResponseBodyTooLargeError(maxBytes, observedBytes);
  }
}

export async function readResponseTextWithinLimitWithSignal(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError(`maxBytes must be a non-negative safe integer; received ${maxBytes}`);
  }

  const declaredBytes = declaredResponseLength(response);
  if (declaredBytes != null && declaredBytes > maxBytes) {
    await cancelResponseBodyQuietly(response);
    throw new ResponseBodyTooLargeError(maxBytes, declaredBytes);
  }
  if (!response.body) {
    if (typeof response.text !== "function") return "";
    const text = await readResponseBodyWithSignal(response, signal, async () => await response.text());
    assertTextWithinLimit(text, maxBytes);
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  let onAbort: (() => void) | null = null;
  let abortPromise: Promise<never> | null = null;

  if (signal) {
    if (signal.aborted) {
      await reader.cancel(abortReason(signal)).catch(() => undefined);
      throw abortReason(signal);
    }
    abortPromise = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        void reader.cancel(abortReason(signal)).catch(() => undefined);
        reject(abortReason(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  try {
    for (;;) {
      const result = abortPromise
        ? await Promise.race([reader.read(), abortPromise])
        : await reader.read();
      if (result.done) break;

      const chunk = result.value instanceof Uint8Array ? result.value : new Uint8Array(result.value);
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseBodyTooLargeError(maxBytes, totalBytes);
      }
      text += decoder.decode(chunk, { stream: true });
    }

    if (signal?.aborted) throw abortReason(signal);
    text += decoder.decode();
    return text;
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export async function readResponseJsonWithinLimitWithSignal<TResult = unknown>(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<TResult> {
  if (response.body || typeof response.json !== "function") {
    const text = await readResponseTextWithinLimitWithSignal(response, maxBytes, signal);
    const parsed = parseJson(text);
    if (!parsed.ok) throw new SyntaxError(parsed.message);
    return parsed.value as TResult;
  }

  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError(`maxBytes must be a non-negative safe integer; received ${maxBytes}`);
  }

  const declaredBytes = declaredResponseLength(response);
  if (declaredBytes != null && declaredBytes > maxBytes) {
    await cancelResponseBodyQuietly(response);
    throw new ResponseBodyTooLargeError(maxBytes, declaredBytes);
  }

  const value = await readResponseBodyWithSignal(
    response,
    signal,
    async () => await response.json() as TResult,
  );
  const serialized = JSON.stringify(value);
  if (serialized != null) assertTextWithinLimit(serialized, maxBytes);
  return value;
}

async function readResponseBodyWithSignal<TResult>(
  response: Response,
  signal: AbortSignal | undefined,
  read: () => Promise<TResult>,
): Promise<TResult> {
  if (!signal) return await read();
  if (signal.aborted) {
    cancelResponseBodyForAbort(response);
    throw abortReason(signal);
  }

  let onAbort: (() => void) | null = null;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      cancelResponseBodyForAbort(response);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([read(), abortPromise]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export async function readResponseJsonWithSignal<TResult = unknown>(
  response: Response,
  signal?: AbortSignal,
): Promise<TResult> {
  return await readResponseBodyWithSignal(response, signal, async () => await response.json() as TResult);
}

export async function readResponseTextWithSignal(
  response: Response,
  signal?: AbortSignal,
): Promise<string> {
  return await readResponseBodyWithSignal(response, signal, async () => await response.text());
}

export async function readResponseTextBoundedWithSignal(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  let onAbort: (() => void) | null = null;
  let abortPromise: Promise<never> | null = null;

  if (signal) {
    if (signal.aborted) {
      await reader.cancel(abortReason(signal)).catch(() => undefined);
      throw abortReason(signal);
    }
    abortPromise = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        void reader.cancel(abortReason(signal)).catch(() => undefined);
        reject(abortReason(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  try {
    for (;;) {
      if (signal?.aborted) {
        throw abortReason(signal);
      }
      const result = abortPromise
        ? await Promise.race([reader.read(), abortPromise])
        : await reader.read();
      const { done, value } = result;
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      const remaining = maxBytes - total;
      if (remaining <= 0) {
        await reader.cancel();
        break;
      }
      const slice = chunk.byteLength > remaining ? chunk.slice(0, remaining) : chunk;
      total += slice.byteLength;
      text += decoder.decode(slice, { stream: total < maxBytes });
      if (chunk.byteLength > remaining || total >= maxBytes) {
        await reader.cancel();
        break;
      }
    }
    if (signal?.aborted) {
      throw abortReason(signal);
    }
    text += decoder.decode();
    return text;
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}
import { parseJson } from "./json-parse";
