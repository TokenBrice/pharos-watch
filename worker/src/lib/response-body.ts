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

function cancelResponseBodyForAbort(response: Response): void {
  if (!response.body) return;
  void response.body.cancel().catch(() => {
    /* best-effort cancellation only */
  });
}

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
  let intakeBytes = 0;
  const declaredBytes = declaredResponseLength(response);
  try {
    // Fetch response bodies emit bytes; the Workers declaration leaves the
    // stream chunk generic unspecified.
    const body = response.body as ReadableStream<Uint8Array>;
    const { bytes } = await bufferReadableStream(body, {
      maxBytes,
      signal,
      overflowMode,
      abortReason: responseBodyAbortReason,
      createOverflowError: (limit, observedBytes) => new ResponseBodyTooLargeError(limit, observedBytes),
      onChunk: onBodyRead ? (byteLength) => { intakeBytes += byteLength; } : undefined,
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

async function readUnavailableBodyEvidence<TResult>(
  response: Response,
  read: () => Promise<TResult>,
  onBodyRead?: BodyReadObserver,
): Promise<TResult> {
  const declaredBytes = declaredResponseLength(response);
  try {
    const value = await read();
    onBodyRead?.({ intakeBytes: null, declaredBytes, outcome: "accepted" });
    return value;
  } catch (error) {
    onBodyRead?.({ intakeBytes: null, declaredBytes, outcome: "rejected" });
    throw error;
  }
}

export async function readResponseTextWithinLimitWithSignal(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
  onBodyRead?: BodyReadObserver,
): Promise<string> {
  await assertResponseWithinLimit(response, maxBytes, onBodyRead);
  if (response.body) {
    const bytes = await readResponseByteStreamWithSignal(response, maxBytes, signal, "throw", onBodyRead);
    return new TextDecoder().decode(bytes);
  }
  return await readUnavailableBodyEvidence(response, async () => {
    const text = await readResponseBodyWithSignal(response, signal, async () => {
      if (typeof response.text === "function") return await response.text();
      if (typeof response.json === "function") return JSON.stringify(await response.json()) ?? "";
      return "";
    });
    assertTextWithinLimit(text, maxBytes);
    return text;
  }, onBodyRead);
}

export async function readResponseJsonWithinLimitWithSignal<TResult = unknown>(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
  onBodyRead?: BodyReadObserver,
): Promise<TResult> {
  if (response.body || typeof response.json !== "function") {
    const text = await readResponseTextWithinLimitWithSignal(response, maxBytes, signal, onBodyRead);
    const parsed = parseJson(text);
    if (!parsed.ok) throw new SyntaxError(parsed.message);
    return parsed.value as TResult;
  }
  await assertResponseWithinLimit(response, maxBytes, onBodyRead);
  return await readUnavailableBodyEvidence(response, async () => {
    const value = await readResponseBodyWithSignal(response, signal, async () => await response.json() as TResult);
    const serialized = JSON.stringify(value);
    if (serialized != null) assertTextWithinLimit(serialized, maxBytes);
    return value;
  }, onBodyRead);
}

export async function readResponseBytesWithinLimitWithSignal(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
  onBodyRead?: BodyReadObserver,
): Promise<Uint8Array<ArrayBuffer>> {
  await assertResponseWithinLimit(response, maxBytes, onBodyRead);
  if (response.body) {
    return await readResponseByteStreamWithSignal(response, maxBytes, signal, "throw", onBodyRead);
  }
  return await readUnavailableBodyEvidence(response, async () => {
    const bytes = await readResponseBodyWithSignal(
      response, signal, async () => new Uint8Array(await response.arrayBuffer()),
    );
    if (bytes.byteLength > maxBytes) throw new ResponseBodyTooLargeError(maxBytes, bytes.byteLength);
    return bytes;
  }, onBodyRead);
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

export async function readResponseTextBoundedWithSignal(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  if (!response.body) {
    const text = await readResponseBodyWithSignal(response, signal, async () => await response.text());
    return text.slice(0, maxBytes);
  }
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
