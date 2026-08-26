import { bufferReadableStream, parseDeclaredLength } from "@shared/lib/bounded-stream";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { abortReason } from "./abort";
import { rethrowIfAborted } from "./abort";
import { parseJson } from "./json-parse";

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

const responseBodyAbortReason = (signal: AbortSignal): unknown =>
  abortReason(signal, () => new DOMException("The operation was aborted.", "AbortError"));

function cancelResponseBodyForAbort(response: Response): void {
  if (!response.body) return;
  void response.body.cancel().catch(() => {
    /* best-effort cancellation only */
  });
}

class ResponseBodyTooLargeError extends Error {
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
  const declared = parseDeclaredLength(raw);
  return declared.status === "valid" ? declared.value : null;
}

function assertTextWithinLimit(text: string, maxBytes: number): void {
  const observedBytes = new TextEncoder().encode(text).byteLength;
  if (observedBytes > maxBytes) {
    throw new ResponseBodyTooLargeError(maxBytes, observedBytes);
  }
}

async function readResponseTextStreamWithSignal(
  response: Response,
  maxBytes: number,
  signal: AbortSignal | undefined,
  overflowMode: "throw" | "truncate",
): Promise<string> {
  if (!response.body) return "";

  const { bytes } = await bufferReadableStream(response.body, {
    maxBytes,
    signal,
    overflowMode,
    abortReason: responseBodyAbortReason,
    createOverflowError: (limit, observedBytes) => new ResponseBodyTooLargeError(limit, observedBytes),
  });
  return new TextDecoder().decode(bytes);
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
    if (typeof response.text !== "function") {
      if (typeof response.json !== "function") return "";
      const value = await readResponseBodyWithSignal(response, signal, async () => await response.json());
      const text = JSON.stringify(value) ?? "";
      assertTextWithinLimit(text, maxBytes);
      return text;
    }
    const text = await readResponseBodyWithSignal(response, signal, async () => await response.text());
    assertTextWithinLimit(text, maxBytes);
    return text;
  }

  return await readResponseTextStreamWithSignal(response, maxBytes, signal, "throw");
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
    throw responseBodyAbortReason(signal);
  }

  let onAbort: (() => void) | null = null;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      cancelResponseBodyForAbort(response);
      reject(responseBodyAbortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([read(), abortPromise]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
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
  return await readResponseTextStreamWithSignal(response, maxBytes, signal, "truncate");
}

export async function readResponseTextWithTimeout(
  response: Response,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const timeout = createTimeoutSignal({
    timeoutMs,
    timeoutReason: new DOMException(`response body timed out after ${timeoutMs}ms`, "TimeoutError"),
    parentSignal: signal,
  });
  try {
    return await readResponseTextWithSignal(response, timeout.signal);
  } finally {
    timeout.dispose();
  }
}

export async function readResponseSnippetWithTimeout(
  response: Response,
  options: { timeoutMs: number; maxBytes: number; maxChars: number },
  signal?: AbortSignal,
): Promise<string | undefined> {
  const timeout = createTimeoutSignal({
    timeoutMs: options.timeoutMs,
    timeoutReason: new DOMException(`response body timed out after ${options.timeoutMs}ms`, "TimeoutError"),
    parentSignal: signal,
  });
  try {
    const value = await readResponseTextBoundedWithSignal(response, options.maxBytes, timeout.signal);
    const snippet = value.replace(/\s+/g, " ").trim().slice(0, options.maxChars);
    return snippet.length > 0 ? snippet : undefined;
  } catch (error) {
    rethrowIfAborted(error, signal);
    return undefined;
  } finally {
    timeout.dispose();
  }
}
