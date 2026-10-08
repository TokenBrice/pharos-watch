import { z } from "zod";
import { Sha256Schema } from "./safety-schema-primitives";

// Worst-case SQL quoting doubles this to 64 KB, leaving ample space below
// D1's 100 KB statement limit and 2 MB row limit, including key/hash overhead.
export const DEPENDENCY_SCENARIO_CHUNK_BYTES = 32_000;
export const DependencyScenarioChunkManifestSchema = z.object({
  storageFormat: z.literal("d1-chunks-v1"),
  payloadSha256: Sha256Schema,
  byteLength: z.number().int().positive(),
  chunkCount: z.number().int().positive(),
}).strict();
export type DependencyScenarioChunkManifest = z.output<typeof DependencyScenarioChunkManifestSchema>;
export const DependencyScenarioChunkSchema = z.object({
  chunk_index: z.number().int().nonnegative(),
  value: z.string(),
  byte_length: z.number().int().positive().max(DEPENDENCY_SCENARIO_CHUNK_BYTES),
  sha256: Sha256Schema,
}).strict();
export type DependencyScenarioChunk = z.output<typeof DependencyScenarioChunkSchema>;
