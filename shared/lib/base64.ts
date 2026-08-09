/**
 * Neutral standard-alphabet base64 codec. Depends only on Web Platform APIs
 * (`btoa`/`atob`) available in the browser, Node and the Worker runtime.
 *
 * `bytesToBase64` builds the binary string in 32 KiB chunks: `String.fromCharCode`
 * is variadic, so spreading a multi-megabyte payload in one call blows the
 * argument-list limit. Chunked and single-pass encoding produce byte-identical
 * output, so callers with small fixed-size inputs share this definition too.
 *
 * The base64url variant lives in `base64url.ts` and is built on top of this.
 */

const BINARY_STRING_CHUNK_BYTES = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BINARY_STRING_CHUNK_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BINARY_STRING_CHUNK_BYTES));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
