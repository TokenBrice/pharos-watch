import { createHash } from "node:crypto";
import { throwIfAborted } from "./abort";

const UTF8_CHUNK_CODE_UNITS = 64 * 1_024;

function uncompressedByteLimitError(label: string, maximumBytes: number): Error {
  return new Error(`${label} exceeds the uncompressed byte limit; maximum is ${maximumBytes}`);
}

export interface CanonicalJsonGzipResult {
  compressed: Uint8Array;
  contentSha256: string;
  uncompressedBytes: number;
}

export interface CanonicalJsonGzipOptions {
  label: string;
  maximumCompressedBytes: number;
  maximumUncompressedBytes: number;
  signal?: AbortSignal;
}

export interface BoundedGunzipOptions {
  label: string;
  maximumCompressedBytes: number;
  maximumUncompressedBytes: number;
  expectedUncompressedBytes?: number;
  signal?: AbortSignal;
}

function nextChunkEnd(value: string, offset: number): number {
  let end = Math.min(value.length, offset + UTF8_CHUNK_CODE_UNITS);
  if (end < value.length) {
    const last = value.charCodeAt(end - 1);
    const next = value.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  }
  return end;
}

/** Compresses and hashes canonical JSON without materializing its full UTF-8 byte array. */
export async function gzipCanonicalJson(
  canonicalJson: string,
  options: CanonicalJsonGzipOptions,
): Promise<CanonicalJsonGzipResult> {
  const { label, maximumCompressedBytes, maximumUncompressedBytes, signal } = options;
  throwIfAborted(signal);
  if (canonicalJson.length === 0) throw new Error(`${label} cannot be empty`);
  if (!Number.isInteger(maximumCompressedBytes) || maximumCompressedBytes < 0) {
    throw new Error(`${label} compressed byte limit must be a non-negative integer`);
  }
  if (canonicalJson.length > maximumUncompressedBytes) {
    throw uncompressedByteLimitError(label, maximumUncompressedBytes);
  }

  const encoder = new TextEncoder();
  const hash = createHash("sha256");
  let offset = 0;
  let uncompressedBytes = 0;
  const source = new ReadableStream<BufferSource>({
    pull(controller) {
      throwIfAborted(signal);
      if (offset >= canonicalJson.length) {
        controller.close();
        return;
      }
      const end = nextChunkEnd(canonicalJson, offset);
      const chunk = encoder.encode(canonicalJson.slice(offset, end));
      offset = end;
      uncompressedBytes += chunk.byteLength;
      if (uncompressedBytes > maximumUncompressedBytes) {
        throw uncompressedByteLimitError(label, maximumUncompressedBytes);
      }
      hash.update(chunk);
      controller.enqueue(chunk);
    },
  });
  const compressedStream = source.pipeThrough(new CompressionStream("gzip"));
  const reader = compressedStream.getReader();
  const chunks: Uint8Array[] = [];
  let compressedBytes = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      compressedBytes += value.byteLength;
      if (compressedBytes > maximumCompressedBytes) {
        throw new Error(`${label} exceeds the compressed byte limit; maximum is ${maximumCompressedBytes}`);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const compressed = new Uint8Array(compressedBytes);
  let compressedOffset = 0;
  for (const chunk of chunks) {
    compressed.set(chunk, compressedOffset);
    compressedOffset += chunk.byteLength;
  }
  throwIfAborted(signal);
  return {
    compressed,
    contentSha256: hash.digest("hex"),
    uncompressedBytes,
  };
}

/** Decompress gzip bytes while enforcing bounds before and during allocation. */
export async function gunzipBytesBounded(
  compressed: Uint8Array,
  options: BoundedGunzipOptions,
): Promise<Uint8Array> {
  const {
    label,
    maximumCompressedBytes,
    maximumUncompressedBytes,
    expectedUncompressedBytes,
    signal,
  } = options;
  throwIfAborted(signal);
  if (!Number.isInteger(maximumCompressedBytes) || maximumCompressedBytes < 0) {
    throw new Error(`${label} compressed byte limit must be a non-negative integer`);
  }
  if (!Number.isInteger(maximumUncompressedBytes) || maximumUncompressedBytes < 0) {
    throw new Error(`${label} uncompressed byte limit must be a non-negative integer`);
  }
  if (
    expectedUncompressedBytes != null &&
    (!Number.isInteger(expectedUncompressedBytes) || expectedUncompressedBytes < 0)
  ) {
    throw new Error(`${label} expected uncompressed byte length must be a non-negative integer`);
  }
  if (compressed.byteLength > maximumCompressedBytes) {
    throw new Error(`${label} exceeds the compressed byte limit; maximum is ${maximumCompressedBytes}`);
  }
  if (expectedUncompressedBytes != null && expectedUncompressedBytes > maximumUncompressedBytes) {
    throw uncompressedByteLimitError(label, maximumUncompressedBytes);
  }

  const allocationLimit = Math.min(maximumUncompressedBytes, expectedUncompressedBytes ?? Infinity);
  // With a declared length the output buffer is preallocated and filled in
  // place; chunk accumulation plus a final concat would hold ~2x the
  // uncompressed payload at peak, which matters at the Worker memory boundary.
  const preallocated = expectedUncompressedBytes != null ? new Uint8Array(expectedUncompressedBytes) : null;
  const stream = new Response(compressed).body!.pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let uncompressedBytes = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      uncompressedBytes += value.byteLength;
      if (uncompressedBytes > allocationLimit) {
        throw new Error(
          expectedUncompressedBytes != null && allocationLimit === expectedUncompressedBytes
            ? `${label} exceeds its declared uncompressed byte length of ${expectedUncompressedBytes}`
            : `${label} exceeds the uncompressed byte limit; maximum is ${maximumUncompressedBytes}`,
        );
      }
      if (preallocated) {
        preallocated.set(value, uncompressedBytes - value.byteLength);
      } else {
        chunks.push(value);
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (expectedUncompressedBytes != null && uncompressedBytes !== expectedUncompressedBytes) {
    throw new Error(`${label} payload length mismatch`);
  }
  throwIfAborted(signal);
  if (preallocated) return preallocated;
  const output = new Uint8Array(uncompressedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function gunzipTextBounded(
  compressed: Uint8Array,
  options: BoundedGunzipOptions,
): Promise<string> {
  return new TextDecoder().decode(await gunzipBytesBounded(compressed, options));
}
