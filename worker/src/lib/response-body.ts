import { bufferReadableStream, parseDeclaredLength } from "@shared/lib/bounded-stream";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { abortReason } from "./abort";
import { rethrowIfAborted } from "./abort";
import { parseJson } from "./json-parse";

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


class ResponseBodyTooLargeError extends Error {
  readonly maxBytes: number;
  readonly observedBytes: number;
  readonly code = "resource-budget-exceeded";

  constructor(maxBytes: number, observedBytes: number) {
    super(`Response body exceeded ${maxBytes} bytes (observed at least ${observedBytes} bytes)`);
    this.name = "ResponseBodyTooLargeError";
    this.maxBytes = maxBytes;
    this.observedBytes = observedBytes;
  }
}

/**
 * Classifies a capped body read that rejected. Callers that must publish a
 * machine-readable source reason (rather than a generic transport failure) use
 * this to name the overflow class without string matching.
 */
export function isResponseBodyTooLargeError(error: unknown): error is ResponseBodyTooLargeError {
  if (error instanceof ResponseBodyTooLargeError) return true;
  return (
    typeof error === "object"
    && error !== null
    && "name" in error
    && error.name === "ResponseBodyTooLargeError"
  );
}

function declaredResponseLength(response: Response): number | null {
  const declared = parseDeclaredLength(response.headers.get("Content-Length"));
  return declared.status === "valid" ? declared.value : null;
}

export type BodyReadObserver = (evidence: {
  intakeBytes: number | null;
  declaredBytes: number | null;
  outcome: "accepted" | "rejected";
}) => void;

async function readResponseByteStreamWithSignal(
  response: Response,
  maxBytes: number,
  signal: AbortSignal | undefined,
  overflowMode: "throw" | "truncate",
  onBodyRead?: BodyReadObserver,
): Promise<Uint8Array<ArrayBuffer>> {
  let intakeBytes: number | null = response.body === null ? null : 0;
  const declaredBytes = declaredResponseLength(response);
  try {
    if (response.body === null) {
      if (signal?.aborted) throw responseBodyAbortReason(signal);
      onBodyRead?.({ intakeBytes, declaredBytes, outcome: "accepted" });
      return new Uint8Array(0);
    }
    // Fetch response bodies emit bytes; the Workers declaration leaves the
    // stream chunk generic unspecified.
    const body = response.body as ReadableStream<Uint8Array>;
    const { bytes } = await bufferReadableStream(body, {
      maxBytes,
      signal,
      overflowMode,
      abortReason: responseBodyAbortReason,
      createOverflowError: (limit, observedBytes) => new ResponseBodyTooLargeError(limit, observedBytes),
      onChunk: onBodyRead ? (byteLength) => { intakeBytes = (intakeBytes ?? 0) + byteLength; } : undefined,
    });
    onBodyRead?.({ intakeBytes, declaredBytes, outcome: "accepted" });
    return bytes;
  } catch (error) {
    onBodyRead?.({ intakeBytes, declaredBytes, outcome: "rejected" });
    throw error;
  }
}

async function assertResponseWithinLimit(
  response: Response,
  maxBytes: number,
  onBodyRead?: BodyReadObserver,
): Promise<void> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError(`maxBytes must be a non-negative safe integer; received ${maxBytes}`);
  }
  const declaredBytes = declaredResponseLength(response);
  if (declaredBytes != null && declaredBytes > maxBytes) {
    onBodyRead?.({ intakeBytes: 0, declaredBytes, outcome: "rejected" });
    await cancelResponseBodyQuietly(response);
    throw new ResponseBodyTooLargeError(maxBytes, declaredBytes);
  }
}


export async function readResponseTextWithinLimitWithSignal(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
  onBodyRead?: BodyReadObserver,
): Promise<string> {
  const bytes = await readResponseBytesWithinLimitWithSignal(response, maxBytes, signal, onBodyRead);
  return new TextDecoder().decode(bytes);
}

export async function readResponseJsonWithinLimitWithSignal<TResult = unknown>(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
  onBodyRead?: BodyReadObserver,
): Promise<TResult> {
  // Native null-body JSON has no transport intake and always rejects parsing.
  const observe = response.body === null && onBodyRead
    ? (evidence: Parameters<BodyReadObserver>[0]) => onBodyRead({ ...evidence, outcome: "rejected" })
    : onBodyRead;
  const text = await readResponseTextWithinLimitWithSignal(response, maxBytes, signal, observe);
  const parsed = parseJson(text);
  if (!parsed.ok) throw new SyntaxError(parsed.message);
  return parsed.value as TResult;
}

export async function readResponseBytesWithinLimitWithSignal(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
  onBodyRead?: BodyReadObserver,
): Promise<Uint8Array<ArrayBuffer>> {
  await assertResponseWithinLimit(response, maxBytes, onBodyRead);
  return await readResponseByteStreamWithSignal(response, maxBytes, signal, "throw", onBodyRead);
}


export async function readResponseTextBoundedWithSignal(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  const bytes = await readResponseByteStreamWithSignal(response, maxBytes, signal, "truncate");
  return new TextDecoder().decode(bytes);
}

export async function readResponseTextWithinLimitWithTimeout(
  response: Response,
  options: { timeoutMs: number; maxBytes: number },
  signal?: AbortSignal,
): Promise<string> {
  const timeout = createTimeoutSignal({
    timeoutMs: options.timeoutMs,
    timeoutReason: new DOMException(`response body timed out after ${options.timeoutMs}ms`, "TimeoutError"),
    parentSignal: signal,
  });
  try {
    return await readResponseTextWithinLimitWithSignal(response, options.maxBytes, timeout.signal);
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
