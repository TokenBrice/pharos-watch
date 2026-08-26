export type DeclaredLengthParseResult =
  | { status: "missing" }
  | { status: "valid"; value: number }
  | { status: "invalid"; reason: "malformed" | "negative" | "unsafe" };

export function parseDeclaredLength(raw: string | null | undefined): DeclaredLengthParseResult {
  if (raw == null) return { status: "missing" };

  const normalized = raw.trim();
  if (/^-\d+$/.test(normalized)) {
    return { status: "invalid", reason: "negative" };
  }
  if (!/^\d+$/.test(normalized)) {
    return { status: "invalid", reason: "malformed" };
  }

  const value = Number(normalized);
  return Number.isSafeInteger(value)
    ? { status: "valid", value }
    : { status: "invalid", reason: "unsafe" };
}

export class BoundedStreamOverflowError extends Error {
  readonly maxBytes: number;
  readonly observedBytes: number;

  constructor(maxBytes: number, observedBytes: number) {
    super(`Stream exceeded ${maxBytes} bytes (observed at least ${observedBytes} bytes)`);
    this.name = "BoundedStreamOverflowError";
    this.maxBytes = maxBytes;
    this.observedBytes = observedBytes;
  }
}

function assertValidMaxBytes(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError(`maxBytes must be a non-negative safe integer; received ${maxBytes}`);
  }
}

function defaultAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

async function cancelReaderQuietly(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason?: unknown,
): Promise<void> {
  await reader.cancel(reason).catch(() => undefined);
}

export interface BoundedByteBufferResult {
  bytes: Uint8Array<ArrayBuffer>;
  truncated: boolean;
}

export async function bufferReadableStream(
  stream: ReadableStream<Uint8Array>,
  options: {
    maxBytes: number;
    signal?: AbortSignal;
    overflowMode?: "throw" | "truncate";
    createOverflowError?: (maxBytes: number, observedBytes: number) => unknown;
    overflowCancelReason?: (error: unknown) => unknown;
    abortReason?: (signal: AbortSignal) => unknown;
  },
): Promise<BoundedByteBufferResult> {
  assertValidMaxBytes(options.maxBytes);

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  const overflowMode = options.overflowMode ?? "throw";
  let totalBytes = 0;
  let onAbort: (() => void) | null = null;
  let abortPromise: Promise<never> | null = null;
  const resolveAbortReason = options.abortReason ?? defaultAbortReason;

  if (options.signal) {
    if (options.signal.aborted) {
      const reason = resolveAbortReason(options.signal);
      await cancelReaderQuietly(reader, reason);
      throw reason;
    }
    abortPromise = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        const reason = resolveAbortReason(options.signal!);
        void cancelReaderQuietly(reader, reason);
        reject(reason);
      };
      options.signal!.addEventListener("abort", onAbort, { once: true });
    });
  }

  try {
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = abortPromise
          ? await Promise.race([reader.read(), abortPromise])
          : await reader.read();
      } catch (error) {
        await cancelReaderQuietly(reader, error);
        throw error;
      }
      if (result.done) break;

      const observedBytes = totalBytes + result.value.byteLength;
      if (observedBytes > options.maxBytes) {
        if (overflowMode === "truncate") {
          const remaining = options.maxBytes - totalBytes;
          if (remaining > 0) chunks.push(result.value.slice(0, remaining));
          totalBytes += Math.max(remaining, 0);
          await cancelReaderQuietly(reader);
          return { bytes: combineChunks(chunks, totalBytes), truncated: true };
        }

        const error = options.createOverflowError?.(options.maxBytes, observedBytes)
          ?? new BoundedStreamOverflowError(options.maxBytes, observedBytes);
        const cancelReason = options.overflowCancelReason?.(error);
        await cancelReaderQuietly(reader, cancelReason);
        throw error;
      }

      totalBytes = observedBytes;
      chunks.push(result.value);
      if (overflowMode === "truncate" && totalBytes === options.maxBytes) {
        await cancelReaderQuietly(reader);
        return { bytes: combineChunks(chunks, totalBytes), truncated: true };
      }
    }

    if (options.signal?.aborted) throw resolveAbortReason(options.signal);
    return { bytes: combineChunks(chunks, totalBytes), truncated: false };
  } finally {
    if (options.signal && onAbort) options.signal.removeEventListener("abort", onAbort);
  }
}

function combineChunks(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function createCappedReadableStream(
  source: ReadableStream<Uint8Array>,
  options: {
    maxBytes: number;
    createOverflowError?: (maxBytes: number, observedBytes: number) => unknown;
    onOverflow?: (error: unknown) => void;
    overflowCancelReason?: (error: unknown) => unknown;
  },
): ReadableStream<Uint8Array> {
  assertValidMaxBytes(options.maxBytes);

  const reader = source.getReader();
  let totalBytes = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          return;
        }

        totalBytes += result.value.byteLength;
        if (totalBytes > options.maxBytes) {
          const error = options.createOverflowError?.(options.maxBytes, totalBytes)
            ?? new BoundedStreamOverflowError(options.maxBytes, totalBytes);
          options.onOverflow?.(error);
          await cancelReaderQuietly(reader, options.overflowCancelReason?.(error));
          controller.error(error);
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
