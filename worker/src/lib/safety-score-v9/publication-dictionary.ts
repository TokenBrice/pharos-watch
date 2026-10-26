import { createHash } from "node:crypto";
import { stableJsonStringifyChunksV1, stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { SAFETY_SCORE_V9_PUBLICATION_MAX_READ_UNCOMPRESSED_BYTES as READ_RAW_LIMIT, SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_UNCOMPRESSED_BYTES as WRITE_RAW_LIMIT } from "@shared/lib/safety-score-v9-publication-limits";
import { throwIfAborted } from "../abort";

// A canonical JSON string-table line, newline, then canonical JSON tokens with
// repeated strings replaced by NUL + decimal index + NUL. Literal NUL bytes
// cannot occur in canonical JSON, so strings/keys/arrays need no escaping.
export const PUBLICATION_DICTIONARY_MAX_ENTRIES = 4_096;
export const PUBLICATION_DICTIONARY_MAX_ENTRY_BYTES = 65_536;
export const PUBLICATION_DICTIONARY_MAX_TABLE_BYTES = 1_048_576;
// Packed framing has its own finite inflate allowance; decoded canonical bytes
// retain separate canonical read and write ceilings during rollout.
export const PUBLICATION_DICTIONARY_MAX_READ_PACKED_BYTES = READ_RAW_LIMIT + PUBLICATION_DICTIONARY_MAX_TABLE_BYTES + 1;
export const PUBLICATION_DICTIONARY_MAX_WRITE_PACKED_BYTES = WRITE_RAW_LIMIT + PUBLICATION_DICTIONARY_MAX_TABLE_BYTES + 1;
const encoder = new TextEncoder();

/** Split canonical JSON without reparsing its graph or retaining its token list. */
function* tokens(chunks: Iterable<string>): Generator<{ text: string; string: boolean }> {
  let pending = "";
  let inString = false;
  let escaped = false;
  for (const chunk of chunks) {
    let start = 0;
    for (let index = 0; index < chunk.length; index++) {
      const code = chunk.charCodeAt(index);
      if (inString) {
        if (escaped) escaped = false;
        else if (code === 92) escaped = true;
        else if (code === 34) {
          yield { text: pending + chunk.slice(start, index + 1), string: true };
          pending = "";
          start = index + 1;
          inString = false;
        }
      } else if (code === 34) {
        if (index > start) yield { text: chunk.slice(start, index), string: false };
        start = index;
        inString = true;
      }
    }
    if (inString) pending += chunk.slice(start);
    else if (start < chunk.length) yield { text: chunk.slice(start), string: false };
    if (pending.length > WRITE_RAW_LIMIT) throw new Error("Publication dictionary token exceeds raw limit");
  }
  if (inString) throw new Error("Malformed publication dictionary string token");
}

function* coalesce(parts: Iterable<string>): Generator<string> {
  let partsBuffer: string[] = [];
  let length = 0;
  for (const part of parts) {
    partsBuffer.push(part);
    length += part.length;
    if (length >= 64 * 1_024) {
      yield partsBuffer.join("");
      partsBuffer = [];
      length = 0;
    }
  }
  if (length) yield partsBuffer.join("");
}

export function encodePublicationDictionary(value: unknown, signal?: AbortSignal): {
  chunks: Iterable<string>; contentSha256: string; uncompressedBytes: number;
} {
  const hash = createHash("sha256");
  let uncompressedBytes = 0;
  const counts = new Map<string, number>();
  function* measured(): Generator<string> {
    for (const chunk of stableJsonStringifyChunksV1(value)) {
      throwIfAborted(signal);
      if (chunk.length > WRITE_RAW_LIMIT - uncompressedBytes) throw new Error(`Safety Score v9 publication exceeds the uncompressed byte limit; maximum is ${WRITE_RAW_LIMIT}`);
      const bytes = encoder.encode(chunk);
      uncompressedBytes += bytes.byteLength;
      if (uncompressedBytes > WRITE_RAW_LIMIT) throw new Error(`Safety Score v9 publication exceeds the uncompressed byte limit; maximum is ${WRITE_RAW_LIMIT}`);
      hash.update(bytes);
      yield chunk;
    }
  }
  for (const token of tokens(measured())) {
    if (token.string && token.text.length >= 34 && token.text.length <= PUBLICATION_DICTIONARY_MAX_ENTRY_BYTES) {
      counts.set(token.text, (counts.get(token.text) ?? 0) + 1);
    }
  }
  const dictionary: string[] = [];
  const references = new Map<string, string>();
  let tableBytes = 2;
  for (const [slice, count] of [...counts].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    if (count < 2 || dictionary.length >= PUBLICATION_DICTIONARY_MAX_ENTRIES) continue;
    const bytes = encoder.encode(slice).byteLength;
    if (bytes > PUBLICATION_DICTIONARY_MAX_ENTRY_BYTES || tableBytes + bytes + 1 > PUBLICATION_DICTIONARY_MAX_TABLE_BYTES) continue;
    // Tokens are V8 slices that pin their whole stringifier chunk; retain an
    // exact flat copy so the table does not keep the canonical JSON alive.
    const token = JSON.parse(JSON.stringify(slice)) as string;
    references.set(token, `\u0000${dictionary.length}\u0000`);
    dictionary.push(token);
    tableBytes += bytes + 1;
  }
  // Table entries are already exact canonical JSON string tokens.
  function* packed(): Generator<string> {
    yield `[${dictionary.join(",")}]\n`;
    for (const token of tokens(stableJsonStringifyChunksV1(value))) {
      throwIfAborted(signal);
      yield token.string ? references.get(token.text) ?? token.text : token.text;
    }
  }
  return { chunks: coalesce(packed()), contentSha256: hash.digest("hex"), uncompressedBytes };
}

/** Restore into the declared raw buffer; no reference may expand past it. */
export function decodePublicationDictionary(packed: Uint8Array, expectedBytes: number, signal?: AbortSignal): Uint8Array {
  throwIfAborted(signal);
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > READ_RAW_LIMIT) throw new Error("Invalid publication dictionary raw length");
  if (packed.byteLength > PUBLICATION_DICTIONARY_MAX_READ_PACKED_BYTES) throw new Error("Publication dictionary exceeds packed byte limit");
  const newline = packed.indexOf(10);
  if (newline < 0 || newline > PUBLICATION_DICTIONARY_MAX_TABLE_BYTES) throw new Error("Malformed publication dictionary table");
  const tableText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(packed.subarray(0, newline));
  const table: unknown = JSON.parse(tableText);
  if (!Array.isArray(table) || table.length > PUBLICATION_DICTIONARY_MAX_ENTRIES) throw new Error("Invalid publication dictionary entry count");
  if (!table.every((entry): entry is string => typeof entry === "string")) throw new Error("Invalid publication dictionary entry");
  if (stableJsonStringifyV1(table) !== tableText) throw new Error("Publication dictionary table is not canonical");
  const dictionary: Uint8Array[] = [];
  let previousToken: string | undefined;
  for (const entry of table) {
    const token = JSON.stringify(entry);
    const bytes = encoder.encode(token);
    if (token.length < 34 || bytes.byteLength > PUBLICATION_DICTIONARY_MAX_ENTRY_BYTES ||
        (previousToken !== undefined && token <= previousToken)) throw new Error("Invalid publication dictionary entry length or order");
    previousToken = token;
    dictionary.push(bytes);
  }
  const output = new Uint8Array(expectedBytes);
  let offset = 0;
  let start = newline + 1;
  function append(bytes: Uint8Array): void {
    if (bytes.byteLength > expectedBytes - offset) throw new Error("Publication dictionary exceeds declared raw byte length");
    output.set(bytes, offset);
    offset += bytes.byteLength;
  }
  // Copy unchanged byte spans directly. Only raw NUL-delimited references have
  // transport meaning; existing escaped NULs and marker-shaped arrays do not.
  for (let index = start; index < packed.length; index++) {
    if ((index & 65_535) === 0) throwIfAborted(signal);
    if (packed[index] !== 0) continue;
    append(packed.subarray(start, index));
    const referenceStart = ++index;
    let referenceIndex = 0;
    for (; index < packed.length && packed[index] !== 0; index++) {
      const code = packed[index]!;
      if (index - referenceStart >= 4 || code < 48 || code > 57) throw new Error("Malformed publication dictionary reference");
      referenceIndex = referenceIndex * 10 + code - 48;
    }
    if (index === packed.length || index === referenceStart ||
        (packed[referenceStart] === 48 && index - referenceStart !== 1)) throw new Error("Malformed publication dictionary reference");
    const reference = dictionary[referenceIndex];
    if (!reference) throw new Error("Publication dictionary reference out of range");
    append(reference);
    start = index + 1;
  }
  append(packed.subarray(start));
  if (offset !== expectedBytes) throw new Error("Publication dictionary raw byte length mismatch");
  return output;
}
