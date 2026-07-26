import { isRecord } from "@shared/lib/type-guards";

export const DEX_ARCHIVE_SCHEMA_VERSION = 1;
export const DEX_ARCHIVE_CODEC = "pharos-dex-archive-json-gzip-v1";
export const DEX_ARCHIVE_MAX_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;

export type DexArchiveObjectFamily =
  | "measured-quote-generation"
  | "measured-target-generation"
  | "liquidity-generation";
export type DexArchiveCell = string | number | boolean | null;

export interface DexArchiveTable {
  name: string;
  columns: string[];
  rows: DexArchiveCell[][];
}

export interface DexArchivePublication {
  surface: string;
  state: string;
  startedAt: number;
  validatedAt: number | null;
  publishedAt: number | null;
}

export interface DexArchiveArtifactInput {
  family: DexArchiveObjectFamily;
  generationId: string;
  sourceSlotStartedAt: number;
  publication: DexArchivePublication;
  producerVersion: string | null;
  dependencyGenerationIds: string[];
  tables: DexArchiveTable[];
  rowCount: number;
  dependencyRowCount: number;
}

export interface DexArchiveArtifact extends DexArchiveArtifactInput {
  schemaVersion: 1;
  codec: typeof DEX_ARCHIVE_CODEC;
  uncompressedBytes: number;
}

export interface EncodedDexArchiveArtifact {
  artifact: DexArchiveArtifact;
  canonicalBytes: Uint8Array;
  gzipBytes: Uint8Array;
  sha256: string;
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer`);
  }
}

function validateArtifactInput(input: DexArchiveArtifactInput): void {
  if (!input.generationId) throw new TypeError("DEX archive generationId is required");
  assertNonNegativeInteger(input.sourceSlotStartedAt, "DEX archive sourceSlotStartedAt");
  assertNonNegativeInteger(input.rowCount, "DEX archive rowCount");
  assertNonNegativeInteger(input.dependencyRowCount, "DEX archive dependencyRowCount");
  for (const table of input.tables) {
    if (!table.name) throw new TypeError("DEX archive table name is required");
    const uniqueColumns = new Set(table.columns);
    if (uniqueColumns.size !== table.columns.length || table.columns.some((column) => !column)) {
      throw new TypeError(`DEX archive table ${table.name} has invalid columns`);
    }
    for (const row of table.rows) {
      if (row.length !== table.columns.length) {
        throw new TypeError(`DEX archive table ${table.name} row width does not match columns`);
      }
      for (const cell of row) {
        if (typeof cell === "number" && !Number.isFinite(cell)) {
          throw new TypeError(`DEX archive table ${table.name} contains a non-finite number`);
        }
      }
    }
  }
}

function buildArtifact(input: DexArchiveArtifactInput, uncompressedBytes: number): DexArchiveArtifact {
  return {
    schemaVersion: DEX_ARCHIVE_SCHEMA_VERSION,
    codec: DEX_ARCHIVE_CODEC,
    family: input.family,
    generationId: input.generationId,
    sourceSlotStartedAt: input.sourceSlotStartedAt,
    publication: input.publication,
    producerVersion: input.producerVersion,
    dependencyGenerationIds: [...input.dependencyGenerationIds],
    tables: input.tables.map((table) => ({
      name: table.name,
      columns: [...table.columns],
      rows: table.rows.map((row) => [...row]),
    })),
    rowCount: input.rowCount,
    dependencyRowCount: input.dependencyRowCount,
    uncompressedBytes,
  };
}

export function buildCanonicalDexArchiveArtifact(input: DexArchiveArtifactInput): {
  artifact: DexArchiveArtifact;
  canonicalBytes: Uint8Array;
} {
  validateArtifactInput(input);
  const encoder = new TextEncoder();
  let uncompressedBytes = 0;
  let artifact = buildArtifact(input, uncompressedBytes);
  let canonicalBytes = encoder.encode(JSON.stringify(artifact));
  for (let iteration = 0; iteration < 4; iteration += 1) {
    uncompressedBytes = canonicalBytes.byteLength;
    artifact = buildArtifact(input, uncompressedBytes);
    canonicalBytes = encoder.encode(JSON.stringify(artifact));
    if (canonicalBytes.byteLength === uncompressedBytes) break;
  }
  if (canonicalBytes.byteLength !== artifact.uncompressedBytes) {
    throw new Error("DEX archive canonical byte length did not stabilize");
  }
  if (canonicalBytes.byteLength > DEX_ARCHIVE_MAX_UNCOMPRESSED_BYTES) {
    throw new RangeError(
      `DEX archive artifact exceeds ${DEX_ARCHIVE_MAX_UNCOMPRESSED_BYTES} uncompressed bytes`,
    );
  }
  return { artifact, canonicalBytes };
}

async function transformBytes(
  bytes: Uint8Array,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const transformed = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(transformed).arrayBuffer());
}

export async function gzipDexArchiveBytes(bytes: Uint8Array): Promise<Uint8Array> {
  return transformBytes(bytes, new CompressionStream("gzip"));
}

export async function gunzipDexArchiveBytes(bytes: Uint8Array): Promise<Uint8Array> {
  return transformBytes(bytes, new DecompressionStream("gzip"));
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function encodeDexArchiveArtifact(
  input: DexArchiveArtifactInput,
): Promise<EncodedDexArchiveArtifact> {
  const { artifact, canonicalBytes } = buildCanonicalDexArchiveArtifact(input);
  const [gzipBytes, sha256] = await Promise.all([
    gzipDexArchiveBytes(canonicalBytes),
    sha256Hex(canonicalBytes),
  ]);
  return { artifact, canonicalBytes, gzipBytes, sha256 };
}

export async function verifyDexArchiveArtifact(
  gzipBytes: Uint8Array,
  expected: {
    family: DexArchiveObjectFamily;
    generationId: string;
    sha256: string;
    uncompressedBytes: number;
    rowCount: number;
    dependencyRowCount: number;
  },
): Promise<DexArchiveArtifact> {
  const canonicalBytes = await gunzipDexArchiveBytes(gzipBytes);
  if (canonicalBytes.byteLength > DEX_ARCHIVE_MAX_UNCOMPRESSED_BYTES) {
    throw new RangeError("DEX archive verification exceeded the uncompressed byte cap");
  }
  if (canonicalBytes.byteLength !== expected.uncompressedBytes) {
    throw new Error("DEX archive uncompressed byte count mismatch");
  }
  if ((await sha256Hex(canonicalBytes)) !== expected.sha256) {
    throw new Error("DEX archive SHA-256 mismatch");
  }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(canonicalBytes));
  if (!isRecord(parsed)) throw new TypeError("DEX archive payload is not an object");
  if (
    parsed.schemaVersion !== DEX_ARCHIVE_SCHEMA_VERSION
    || parsed.codec !== DEX_ARCHIVE_CODEC
    || parsed.family !== expected.family
    || parsed.generationId !== expected.generationId
    || parsed.uncompressedBytes !== expected.uncompressedBytes
    || parsed.rowCount !== expected.rowCount
    || parsed.dependencyRowCount !== expected.dependencyRowCount
    || !Array.isArray(parsed.tables)
    || !Array.isArray(parsed.dependencyGenerationIds)
  ) {
    throw new Error("DEX archive identity or count verification failed");
  }
  return parsed as unknown as DexArchiveArtifact;
}
