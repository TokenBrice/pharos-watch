import { z } from "zod";
import { base64ToBytes, bytesToBase64 } from "@shared/lib/base64";
import { Sha256Schema } from "@shared/types/safety-schema-primitives";
import { sha256Hex } from "@shared/lib/sha256";
import { parseJson } from "./json-parse";
import { gunzipTextBounded, gzipCanonicalJson } from "./canonical-json-gzip";

export const REPORT_CARDS_FIXED_INPUT_CACHE_KEY = "report-cards:fixed-input:exact";

const CACHE_MAX_BYTES = 1_900_000;
const MAX_COMPRESSED_BYTES = 1_350_000;
const MAX_UNCOMPRESSED_BYTES = 8_000_000;

export const FixedInputCacheEnvelopeFields = {
  kind: z.literal("report-cards-fixed-input-exact"),
  encoding: z.literal("gzip-base64"),
  sourceGeneration: z.string().min(1),
  payloadSha256: Sha256Schema,
  uncompressedBytes: z.number().int().positive(),
  payload: z.string().min(1),
};

interface BuildFixedInputCacheEntryOptions {
  schemaVersion: 1 | 2;
  sourceGeneration: string;
  safetyScoreIdentity?: unknown;
  payload: unknown;
  label: string;
}

export interface FixedInputCacheEntry {
  key: string;
  value: string;
  storedBytes: number;
  uncompressedBytes: number;
}

export async function buildFixedInputCacheEntry(
  options: BuildFixedInputCacheEntryOptions,
): Promise<FixedInputCacheEntry> {
  const payload = JSON.stringify(options.payload);
  const compressed = await gzipCanonicalJson(payload, {
    label: options.label,
    maximumCompressedBytes: MAX_COMPRESSED_BYTES,
    maximumUncompressedBytes: MAX_UNCOMPRESSED_BYTES,
  });
  const envelope = JSON.stringify({
    schemaVersion: options.schemaVersion,
    kind: "report-cards-fixed-input-exact",
    encoding: "gzip-base64",
    sourceGeneration: options.sourceGeneration,
    ...(options.safetyScoreIdentity !== undefined
      ? { safetyScoreIdentity: options.safetyScoreIdentity }
      : {}),
    payloadSha256: compressed.contentSha256,
    uncompressedBytes: compressed.uncompressedBytes,
    payload: bytesToBase64(compressed.compressed),
  });
  const storedBytes = new TextEncoder().encode(envelope).byteLength;
  if (storedBytes > CACHE_MAX_BYTES) {
    throw new Error(`${options.label} is ${storedBytes} bytes; maximum is ${CACHE_MAX_BYTES}`);
  }
  return {
    key: REPORT_CARDS_FIXED_INPUT_CACHE_KEY,
    value: envelope,
    storedBytes,
    uncompressedBytes: compressed.uncompressedBytes,
  };
}

interface FixedInputCacheEnvelope {
  sourceGeneration: string;
  payloadSha256: string;
  uncompressedBytes: number;
  payload: string;
}

export async function parseFixedInputCacheEntry<TEnvelope extends FixedInputCacheEnvelope>(options: {
  value: unknown;
  envelopeSchema: z.ZodType<TEnvelope>;
  malformedEnvelopeLabel: string;
  malformedPayloadLabel: string;
  artifactLabel: string;
}): Promise<{ envelope: TEnvelope; payload: unknown }> {
  const parsedEnvelope = typeof options.value === "string" ? parseJson(options.value) : null;
  if (parsedEnvelope && !parsedEnvelope.ok) {
    throw new Error(`${options.malformedEnvelopeLabel}: ${parsedEnvelope.message}`);
  }
  const raw = parsedEnvelope?.ok ? parsedEnvelope.value : options.value;
  const envelope = options.envelopeSchema.parse(raw);
  if (envelope.payload.length > Math.ceil(MAX_COMPRESSED_BYTES / 3) * 4) {
    throw new Error(`${options.artifactLabel} exceeds its compressed byte limit`);
  }
  const payloadText = await gunzipTextBounded(base64ToBytes(envelope.payload), {
    label: options.artifactLabel,
    maximumCompressedBytes: MAX_COMPRESSED_BYTES,
    maximumUncompressedBytes: MAX_UNCOMPRESSED_BYTES,
    expectedUncompressedBytes: envelope.uncompressedBytes,
  });
  const payloadSha256 = sha256Hex(payloadText);
  if (payloadSha256 !== envelope.payloadSha256) {
    throw new Error(`${options.artifactLabel} checksum mismatch`);
  }
  const parsedPayload = parseJson(payloadText);
  if (!parsedPayload.ok) {
    throw new Error(`${options.malformedPayloadLabel}: ${parsedPayload.message}`);
  }
  return { envelope, payload: parsedPayload.value };
}
