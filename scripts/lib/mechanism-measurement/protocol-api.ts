import { createHash } from "node:crypto";

import { parse as parseLosslessJson } from "lossless-json";
import { z } from "zod";

import {
  CanonicalDecimalSchema,
  canonicalizeDecimal,
  EthenaCollateralizationStatusSchema,
  EthenaProofOfReservesSchema,
  ETHENA_PROTOCOL_API_URLS,
  FalconTransparencySchema,
  FALCON_TRANSPARENCY_URL,
  JSON_NUMBER_TOKEN_KEY,
  jsonNumberToken,
  type EthenaCollateralizationStatus,
  type EthenaProofOfReserves,
  type FalconTransparency,
} from "@shared/lib/protocol-api-sources";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";

const FUTURE_TOLERANCE_MS = 5 * 60 * 1_000;
const DERIVATION_SCALE = 12;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const METRIC_IDS = [
  "collateralizationRatio",
  "reserveExcessPct",
  "dedicatedLossAbsorptionShare",
  "hedgeCoverageRatio",
  "exchangeMarginHeadroomPct",
  "fundingBasisStress",
  "executableUnwindCapacityUsd",
] as const;

export type ProtocolApiMetricId = (typeof METRIC_IDS)[number];

export const PROTOCOL_API_TARGETS = {
  "usde-ethena": {
    family: "ethena-status-por-v1",
    archetype: "synthetic-delta-neutral",
    sources: [
      {
        sourceId: "ethena-collateralization-status",
        url: ETHENA_PROTOCOL_API_URLS.collateralizationStatus,
        maxAgeMs: 12 * 60 * 60 * 1_000,
      },
      {
        sourceId: "ethena-proof-of-reserves",
        url: ETHENA_PROTOCOL_API_URLS.proofOfReserves,
        maxAgeMs: 10 * 24 * 60 * 60 * 1_000,
      },
    ],
  },
  "usdf-falcon": {
    family: "falcon-transparency-v1",
    archetype: "synthetic-delta-neutral",
    sources: [{ sourceId: "falcon-transparency", url: FALCON_TRANSPARENCY_URL, maxAgeMs: 36 * 60 * 60 * 1_000 }],
  },
} as const;

export type ProtocolApiAssetId = keyof typeof PROTOCOL_API_TARGETS;

const HashSchema = z.string().regex(SHA256_PATTERN);
const SourceIdsSchema = z
  .array(z.string().min(1))
  .min(1)
  .refine((ids) => new Set(ids).size === ids.length, "source observation IDs must be unique");
const DerivationSchema = z
  .object({
    formulaId: z.string().min(1),
    numerator: CanonicalDecimalSchema,
    denominator: CanonicalDecimalSchema,
    rounding: z.literal("half-up"),
    scale: z.literal(DERIVATION_SCALE),
  })
  .strict();

const MetricBaseSchema = z.object({
  id: z.enum(METRIC_IDS),
  unit: z.enum(["ratio", "pct", "usd"]),
  scope: z.string().min(1),
  sourceObservationIds: SourceIdsSchema,
});

const MetricSchema = z.discriminatedUnion("state", [
  MetricBaseSchema.extend({ state: z.literal("measured"), value: CanonicalDecimalSchema, derivation: DerivationSchema }).strict(),
  MetricBaseSchema.extend({
    state: z.literal("documented-only"),
    value: CanonicalDecimalSchema,
    blocker: z.string().min(1),
  }).strict(),
  MetricBaseSchema.extend({ state: z.literal("unavailable"), blocker: z.string().min(1) }).strict(),
  MetricBaseSchema.extend({ state: z.literal("not-applicable"), blocker: z.string().min(1) }).strict(),
]);

const HeadersSchema = z
  .object({
    "content-type": z.string().min(1).optional(),
    etag: z.string().min(1).optional(),
    "last-modified": z.string().min(1).optional(),
    "content-digest": z.string().min(1).optional(),
    "signature-input": z.string().min(1).optional(),
    signature: z.string().min(1).optional(),
  })
  .strict();

const ObservationSchema = z
  .object({
    sourceId: z.string().min(1),
    url: z.string().url(),
    observedAt: z.string().datetime(),
    rawBodyBase64: z.string().min(1),
    rawBodySha256: HashSchema,
    observationHash: HashSchema,
    parsedPayload: z.unknown(),
    headers: HeadersSchema,
    contentDigestVerification: z.enum(["not-present", "verified", "unsupported"]),
    httpSignatureVerification: z.enum(["not-present", "unverified"]),
  })
  .strict();

const ClaimSchema = z
  .object({
    id: z.enum(["deltaNeutral", "overCollateralized"]),
    value: z.boolean(),
    observedAt: z.string().datetime(),
    sourceObservationIds: SourceIdsSchema,
  })
  .strict();

const BreakdownSchema = z
  .object({
    id: z.enum(["assetAllocation", "custodyAllocation"]),
    scope: z.string().min(1),
    sourceObservationIds: SourceIdsSchema,
    entries: z
      .array(
        z
          .object({
            key: z.string().min(1),
            amountUsd: CanonicalDecimalSchema,
            share: CanonicalDecimalSchema,
            shareDerivation: DerivationSchema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const ReconciliationSchema = z
  .object({
    id: z.enum(["assetRowsToTvl", "publishedReservesToAssetRows", "publishedReservesToSupply"]),
    status: z.enum(["pass", "unresolved"]),
    left: CanonicalDecimalSchema,
    right: CanonicalDecimalSchema,
    absoluteDelta: CanonicalDecimalSchema,
    relativeDelta: CanonicalDecimalSchema,
    relativeDeltaDerivation: DerivationSchema,
    tolerance: CanonicalDecimalSchema,
    scopeDisposition: z.string().min(1),
  })
  .strict();

const CheckSchema = z
  .object({
    id: z.string().min(1),
    status: z.literal("pass"),
    detail: z.string().min(1),
  })
  .strict();

const ProtocolApiMechanismMeasurementBaseSchema = z
  .object({
    kind: z.literal("protocol-api-mechanism-measurement"),
    schemaVersion: z.literal(2),
    family: z.enum(["ethena-status-por-v1", "falcon-transparency-v1"]),
    assetId: z.enum(["usde-ethena", "usdf-falcon"]),
    archetype: z.literal("synthetic-delta-neutral"),
    snapshotObservedAt: z.string().datetime(),
    capturedAt: z.string().datetime(),
    snapshotId: HashSchema,
    observations: z.array(ObservationSchema).min(1),
    claims: z.array(ClaimSchema),
    metrics: z.array(MetricSchema).length(METRIC_IDS.length),
    breakdowns: z.array(BreakdownSchema),
    reconciliations: z.array(ReconciliationSchema),
    checks: z.array(CheckSchema).min(1),
    adoptionEligibility: z
      .object({ status: z.literal("blocked"), blockers: z.array(z.string().min(1)).min(1) })
      .strict(),
    scoreImpactAssessment: z
      .object({
        expectedEffect: z.enum(["confirm", "indeterminate"]),
        rationale: z.string().min(1),
        independentBlockers: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    tool: z
      .object({ name: z.literal("measure-protocol-api-mechanism-metrics"), version: z.literal("2") })
      .strict(),
  })
  .strict();

function observationIdentity(observation: {
  sourceId: string;
  url: string;
  observedAt: string;
  rawBodySha256: string;
}): string {
  return sha256Hex(
    stableJsonStringifyV1({
      sourceId: observation.sourceId,
      url: observation.url,
      observedAt: observation.observedAt,
      rawBodySha256: observation.rawBodySha256,
    }),
  );
}

function snapshotIdentity(input: {
  schemaVersion: 2;
  family: string;
  assetId: string;
  observations: Array<{ observationHash: string }>;
}): string {
  return sha256Hex(
    stableJsonStringifyV1({
      schemaVersion: input.schemaVersion,
      family: input.family,
      assetId: input.assetId,
      observationHashes: input.observations.map((observation) => observation.observationHash),
    }),
  );
}

const ProtocolApiMechanismMeasurementTargetSchema = z.discriminatedUnion("family", [
  ProtocolApiMechanismMeasurementBaseSchema.extend({
    family: z.literal("ethena-status-por-v1"),
    assetId: z.literal("usde-ethena"),
  }),
  ProtocolApiMechanismMeasurementBaseSchema.extend({
    family: z.literal("falcon-transparency-v1"),
    assetId: z.literal("usdf-falcon"),
  }),
]);

export const ProtocolApiMechanismMeasurementSchema = ProtocolApiMechanismMeasurementTargetSchema.superRefine(
  (artifact, context) => {
    const target = PROTOCOL_API_TARGETS[artifact.assetId];
    const observationIds = artifact.observations.map((observation) => observation.sourceId);
    const expectedIds = target.sources.map((source) => source.sourceId);
    if (stableJsonStringifyV1(observationIds) !== stableJsonStringifyV1(expectedIds)) {
      context.addIssue({ code: "custom", path: ["observations"], message: "observations are not in target-registry order" });
    }
    for (const [index, observation] of artifact.observations.entries()) {
      const rawBody = Buffer.from(observation.rawBodyBase64, "base64");
      if (rawBody.toString("base64") !== observation.rawBodyBase64) {
        context.addIssue({ code: "custom", path: ["observations", index, "rawBodyBase64"], message: "invalid base64" });
      }
      if (hashBytes(rawBody) !== observation.rawBodySha256) {
        context.addIssue({ code: "custom", path: ["observations", index, "rawBodySha256"], message: "raw-body hash mismatch" });
      }
      if (observationIdentity(observation) !== observation.observationHash) {
        context.addIssue({ code: "custom", path: ["observations", index, "observationHash"], message: "observation hash mismatch" });
      }
      const expectedSource = target.sources[index];
      if (!expectedSource || observation.url !== expectedSource.url) {
        context.addIssue({ code: "custom", path: ["observations", index, "url"], message: "observation URL mismatch" });
      }
    }
    if (snapshotIdentity(artifact) !== artifact.snapshotId) {
      context.addIssue({ code: "custom", path: ["snapshotId"], message: "snapshot ID mismatch" });
    }
    const newestObservedAt = [...artifact.observations]
      .map((observation) => observation.observedAt)
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
    if (newestObservedAt !== artifact.snapshotObservedAt) {
      context.addIssue({ code: "custom", path: ["snapshotObservedAt"], message: "snapshot time is not newest source time" });
    }
    if (new Set(observationIds).size !== observationIds.length) {
      context.addIssue({ code: "custom", path: ["observations"], message: "duplicate observation ID" });
    }
    for (const [collectionName, entries] of [
      ["claims", artifact.claims],
      ["metrics", artifact.metrics],
      ["breakdowns", artifact.breakdowns],
    ] as const) {
      for (const [index, entry] of entries.entries()) {
        const unknownIds = entry.sourceObservationIds.filter((sourceId) => !observationIds.includes(sourceId));
        if (unknownIds.length > 0) {
          context.addIssue({
            code: "custom",
            path: [collectionName, index, "sourceObservationIds"],
            message: `unknown source observation ID: ${unknownIds.join(", ")}`,
          });
        }
      }
    }
    const metricIds = artifact.metrics.map((metric) => metric.id);
    if (new Set(metricIds).size !== METRIC_IDS.length || METRIC_IDS.some((id) => !metricIds.includes(id))) {
      context.addIssue({ code: "custom", path: ["metrics"], message: "canonical metric set is incomplete or duplicated" });
    }
  },
);

export type ProtocolApiMechanismMeasurement = z.infer<typeof ProtocolApiMechanismMeasurementSchema>;

export interface RawProtocolApiObservationInput {
  sourceId: string;
  url: string;
  rawBody: Uint8Array;
  headers?: Record<string, string>;
}

interface FixedDecimal {
  coefficient: bigint;
  scale: number;
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseFixed(value: string): FixedDecimal {
  const canonical = canonicalizeDecimal(value);
  const negative = canonical.startsWith("-");
  const unsigned = negative ? canonical.slice(1) : canonical;
  const [integer, fraction = ""] = unsigned.split(".");
  return {
    coefficient: BigInt(`${negative ? "-" : ""}${integer}${fraction}`),
    scale: fraction.length,
  };
}

function pow10(power: number): bigint {
  return 10n ** BigInt(power);
}

function decimalFromScaled(coefficient: bigint, scale: number): string {
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, "0");
  const value = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return canonicalizeDecimal(`${negative ? "-" : ""}${value}`);
}

function align(left: FixedDecimal, right: FixedDecimal): [bigint, bigint, number] {
  const scale = Math.max(left.scale, right.scale);
  return [left.coefficient * pow10(scale - left.scale), right.coefficient * pow10(scale - right.scale), scale];
}

function addDecimals(left: string, right: string): string {
  const [leftValue, rightValue, scale] = align(parseFixed(left), parseFixed(right));
  return decimalFromScaled(leftValue + rightValue, scale);
}

function subtractDecimals(left: string, right: string): string {
  const [leftValue, rightValue, scale] = align(parseFixed(left), parseFixed(right));
  return decimalFromScaled(leftValue - rightValue, scale);
}

function compareDecimals(left: string, right: string): number {
  const [leftValue, rightValue] = align(parseFixed(left), parseFixed(right));
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function absDecimal(value: string): string {
  return value.startsWith("-") ? value.slice(1) : value;
}

function divideRounded(numerator: string, denominator: string, multiplier = 1): string {
  const numeratorValue = parseFixed(numerator);
  const denominatorValue = parseFixed(denominator);
  if (denominatorValue.coefficient === 0n) throw new Error("Cannot divide by zero");
  const signedNumerator =
    numeratorValue.coefficient * pow10(denominatorValue.scale) * BigInt(multiplier) * pow10(DERIVATION_SCALE);
  const signedDenominator = denominatorValue.coefficient * pow10(numeratorValue.scale);
  const negative = (signedNumerator < 0n) !== (signedDenominator < 0n);
  const absoluteNumerator = signedNumerator < 0n ? -signedNumerator : signedNumerator;
  const absoluteDenominator = signedDenominator < 0n ? -signedDenominator : signedDenominator;
  let quotient = absoluteNumerator / absoluteDenominator;
  if ((absoluteNumerator % absoluteDenominator) * 2n >= absoluteDenominator) quotient += 1n;
  return decimalFromScaled(negative ? -quotient : quotient, DERIVATION_SCALE);
}

function divideByPowerOfTenExact(value: string, power: number): string {
  const fixed = parseFixed(value);
  return decimalFromScaled(fixed.coefficient, fixed.scale + power);
}

function sumDecimals(values: Iterable<string>): string {
  let total = "0";
  for (const value of values) total = addDecimals(total, value);
  return total;
}

function assertPositive(label: string, value: string): void {
  if (compareDecimals(value, "0") <= 0) throw new Error(`${label} must be positive`);
}

function assertNonnegative(label: string, value: string): void {
  if (compareDecimals(value, "0") < 0) throw new Error(`${label} must be nonnegative`);
}

function parseSourceJson(rawBody: Uint8Array): unknown {
  const body = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
  return parseLosslessJson(body, undefined, { parseNumber: jsonNumberToken });
}

function normalizeTaggedNumberTokens(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeTaggedNumberTokens);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length === 1 && typeof record[JSON_NUMBER_TOKEN_KEY] === "string") {
      return canonicalizeDecimal(record[JSON_NUMBER_TOKEN_KEY]);
    }
    return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, normalizeTaggedNumberTokens(entry)]));
  }
  return value;
}

function parseEthenaTimestamp(value: string): string {
  // eslint-disable-next-line security/detect-unsafe-regex
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.([0-9]+))? UTC$/.exec(value);
  if (!match) throw new Error(`Invalid Ethena collateralization timestamp: ${value}`);
  const [, date, time, fraction = ""] = match;
  const parsed = new Date(`${date}T${time}.${fraction.slice(0, 3).padEnd(3, "0")}Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== `${date}T${time}`) {
    throw new Error(`Invalid Ethena collateralization timestamp: ${value}`);
  }
  return parsed.toISOString();
}

function parseFalconTimestamp(value: string): string {
  const fixed = parseFixed(value);
  if (fixed.scale !== 0 || fixed.coefficient <= 0n) throw new Error("Falcon snapshot_date must be a positive integer");
  let milliseconds = fixed.coefficient;
  if (milliseconds < 10_000_000_000n) milliseconds *= 1_000n;
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Falcon snapshot_date is out of range");
  const date = new Date(Number(milliseconds));
  if (!Number.isFinite(date.getTime())) throw new Error("Falcon snapshot_date is invalid");
  return date.toISOString();
}

function assertFresh(label: string, observedAt: string, capturedAt: Date, maxAgeMs: number): void {
  const observedMs = Date.parse(observedAt);
  const capturedMs = capturedAt.getTime();
  if (!Number.isFinite(observedMs) || !Number.isFinite(capturedMs)) throw new Error(`${label} has an invalid timestamp`);
  if (observedMs > capturedMs + FUTURE_TOLERANCE_MS) throw new Error(`${label} timestamp is in the future`);
  if (capturedMs - observedMs > maxAgeMs) throw new Error(`${label} is stale`);
}

function allowlistedHeaders(input: Record<string, string> | undefined): z.infer<typeof HeadersSchema> {
  const allowed = new Set(["content-type", "etag", "last-modified", "content-digest", "signature-input", "signature"]);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    const normalizedKey = key.toLowerCase();
    if (allowed.has(normalizedKey) && value.length > 0) headers[normalizedKey] = value;
  }
  return HeadersSchema.parse(headers);
}

function verifyContentDigest(rawBody: Uint8Array, header: string | undefined): "not-present" | "verified" | "unsupported" {
  if (!header) return "not-present";
  const match = /(?:^|,)\s*sha-256=:([^:]+):(?:\s*(?:,|$))/i.exec(header);
  if (!match) return "unsupported";
  const expected = Buffer.from(match[1]!, "base64");
  const actual = createHash("sha256").update(rawBody).digest();
  if (expected.length !== actual.length || !actual.equals(expected)) throw new Error("Content-Digest SHA-256 mismatch");
  return "verified";
}

function makeObservation(
  input: RawProtocolApiObservationInput,
  observedAt: string,
  parsedPayload: unknown,
): z.infer<typeof ObservationSchema> {
  const headers = allowlistedHeaders(input.headers);
  const rawBodySha256 = hashBytes(input.rawBody);
  const identityInput = { sourceId: input.sourceId, url: input.url, observedAt, rawBodySha256 };
  return ObservationSchema.parse({
    ...identityInput,
    rawBodyBase64: Buffer.from(input.rawBody).toString("base64"),
    observationHash: observationIdentity(identityInput),
    parsedPayload,
    headers,
    contentDigestVerification: verifyContentDigest(input.rawBody, headers["content-digest"]),
    httpSignatureVerification: headers.signature || headers["signature-input"] ? "unverified" : "not-present",
  });
}

function derivation(formulaId: string, numerator: string, denominator: string) {
  return { formulaId, numerator, denominator, rounding: "half-up" as const, scale: DERIVATION_SCALE as 12 };
}

function measuredMetric(
  id: ProtocolApiMetricId,
  unit: "ratio" | "pct" | "usd",
  scope: string,
  sourceObservationIds: string[],
  value: string,
  formulaId: string,
  numerator: string,
  denominator: string,
) {
  return { id, state: "measured" as const, unit, scope, sourceObservationIds, value, derivation: derivation(formulaId, numerator, denominator) };
}

function unavailableMetric(
  id: ProtocolApiMetricId,
  unit: "ratio" | "pct" | "usd",
  scope: string,
  sourceObservationIds: string[],
  blocker: string,
) {
  return { id, state: "unavailable" as const, unit, scope, sourceObservationIds, blocker };
}

function commonUnavailableMetrics(sourceObservationIds: string[]) {
  return [
    unavailableMetric(
      "hedgeCoverageRatio",
      "ratio",
      "protocol synthetic backing",
      sourceObservationIds,
      "The source does not publish reconciled hedge notionals or net delta.",
    ),
    unavailableMetric(
      "exchangeMarginHeadroomPct",
      "pct",
      "exchange hedge venues",
      sourceObservationIds,
      "The source does not publish exchange margin balances and maintenance requirements.",
    ),
    unavailableMetric(
      "fundingBasisStress",
      "ratio",
      "hedge funding basis",
      sourceObservationIds,
      "The source does not publish a quantitative funding-basis stress measurement.",
    ),
    unavailableMetric(
      "executableUnwindCapacityUsd",
      "usd",
      "executable hedge unwind",
      sourceObservationIds,
      "The source does not publish executable depth or position-level unwind capacity.",
    ),
  ];
}

function normalizeInputs(assetId: ProtocolApiAssetId, inputs: RawProtocolApiObservationInput[]) {
  const target = PROTOCOL_API_TARGETS[assetId];
  if (inputs.length !== target.sources.length) throw new Error(`${assetId} requires ${target.sources.length} source responses`);
  return inputs.map((input, index) => {
    const expected = target.sources[index]!;
    if (input.sourceId !== expected.sourceId || input.url !== expected.url) {
      throw new Error(`${assetId} source ${index + 1} does not match the target registry`);
    }
    return { input, expected, parsed: parseSourceJson(input.rawBody) };
  });
}

function buildEthena(
  inputs: ReturnType<typeof normalizeInputs>,
  capturedAt: Date,
): Omit<ProtocolApiMechanismMeasurement, "snapshotId"> {
  const status = normalizeTaggedNumberTokens(EthenaCollateralizationStatusSchema.parse(inputs[0]!.parsed)) as EthenaCollateralizationStatus;
  const por = normalizeTaggedNumberTokens(EthenaProofOfReservesSchema.parse(inputs[1]!.parsed)) as EthenaProofOfReserves;
  assertPositive("Ethena backing", status.totalBackingAssetsInUsd);
  assertPositive("Ethena supply", status.totalTokenSupplyInUsd);
  assertNonnegative("Ethena reserve fund", status.totalReserveFundInUsd);
  const statusObservedAt = parseEthenaTimestamp(status.timestamp);
  const porObservedAt = new Date(por.lastUpdatedAt).toISOString();
  assertFresh("Ethena collateralization status", statusObservedAt, capturedAt, inputs[0]!.expected.maxAgeMs);
  assertFresh("Ethena proof of reserves", porObservedAt, capturedAt, inputs[1]!.expected.maxAgeMs);

  const latestReport = [...por.reports].sort((left, right) => Date.parse(right.date) - Date.parse(left.date))[0]!;
  if (latestReport.date !== por.lastUpdatedAt) {
    throw new Error("Ethena proof-of-reserves lastUpdatedAt does not match the latest report");
  }
  const confirmedAuditors = latestReport.auditors
    .filter((auditor) => auditor.is_confirmed)
    .map((auditor) => auditor.name)
    .sort();
  if (confirmedAuditors.length === 0) throw new Error("Ethena proof-of-reserves report has no confirmed auditor");

  const sourceIds = inputs.map(({ input }) => input.sourceId);
  const backing = status.totalBackingAssetsInUsd;
  const supply = status.totalTokenSupplyInUsd;
  const reserveFund = status.totalReserveFundInUsd;
  const reserveExcess = subtractDecimals(backing, supply);
  const observations = [
    makeObservation(inputs[0]!.input, statusObservedAt, status),
    makeObservation(inputs[1]!.input, porObservedAt, por),
  ];
  return {
    kind: "protocol-api-mechanism-measurement",
    schemaVersion: 2,
    family: "ethena-status-por-v1",
    assetId: "usde-ethena",
    archetype: "synthetic-delta-neutral",
    snapshotObservedAt: statusObservedAt > porObservedAt ? statusObservedAt : porObservedAt,
    capturedAt: capturedAt.toISOString(),
    observations,
    claims: [
      { id: "deltaNeutral", value: latestReport.deltaNeutral, observedAt: latestReport.date, sourceObservationIds: [sourceIds[1]!] },
      {
        id: "overCollateralized",
        value: latestReport.overCollateralized,
        observedAt: latestReport.date,
        sourceObservationIds: [sourceIds[1]!],
      },
    ],
    metrics: [
      measuredMetric("collateralizationRatio", "ratio", "total backing assets / token supply", [sourceIds[0]!], divideRounded(backing, supply), "backing-over-supply", backing, supply),
      measuredMetric("reserveExcessPct", "pct", "total backing assets less token supply", [sourceIds[0]!], divideRounded(reserveExcess, supply, 100), "backing-excess-pct-of-supply", reserveExcess, supply),
      measuredMetric("dedicatedLossAbsorptionShare", "ratio", "Reserve Fund / token supply", [sourceIds[0]!], divideRounded(reserveFund, supply), "reserve-fund-over-supply", reserveFund, supply),
      ...commonUnavailableMetrics(sourceIds),
    ],
    breakdowns: [],
    reconciliations: [],
    checks: [
      { id: "status.fresh", status: "pass", detail: `collateralization status observed at ${statusObservedAt}` },
      { id: "por.fresh", status: "pass", detail: `proof of reserves observed at ${porObservedAt}` },
      { id: "por.confirmed-auditors", status: "pass", detail: `latest report confirmed by ${confirmedAuditors.join(", ")}` },
      { id: "source.raw-byte-integrity", status: "pass", detail: "both source bodies are preserved and SHA-256 bound" },
    ],
    adoptionEligibility: {
      status: "blocked",
      blockers: [
        "The current synthetic overlay requires quantitative hedge coverage, which is unavailable.",
        "The current synthetic overlay requires exchange margin headroom, which is unavailable.",
      ],
    },
    scoreImpactAssessment: {
      expectedEffect: "confirm",
      rationale: "The measured Reserve Fund share can confirm the restrictive disposition but cannot clear the independently unsafe reserve slice.",
      independentBlockers: ["Direct score adoption remains identity-bound.", "Unsafe backing remains an independent cap."],
    },
    tool: { name: "measure-protocol-api-mechanism-metrics", version: "2" },
  };
}

function mapTotals(entries: Array<Record<string, string>>, keySelector: (entry: Record<string, string>) => Iterable<[string, string]>) {
  const totals = new Map<string, string>();
  for (const entry of entries) {
    for (const [key, amount] of keySelector(entry)) totals.set(key, addDecimals(totals.get(key) ?? "0", amount));
  }
  return totals;
}

function breakdownEntries(totals: Map<string, string>, total: string) {
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, amountUsd]) => ({
      key,
      amountUsd,
      share: divideRounded(amountUsd, total),
      shareDerivation: derivation("allocation-share", amountUsd, total),
    }));
}

function reconciliation(
  id: "assetRowsToTvl" | "publishedReservesToAssetRows" | "publishedReservesToSupply",
  left: string,
  right: string,
  tolerance: string,
  scopeDisposition: string,
) {
  const absoluteDelta = absDecimal(subtractDecimals(left, right));
  return {
    id,
    status: compareDecimals(absoluteDelta, tolerance) <= 0 ? ("pass" as const) : ("unresolved" as const),
    left,
    right,
    absoluteDelta,
    relativeDelta: divideRounded(absoluteDelta, right),
    relativeDeltaDerivation: derivation("absolute-delta-over-comparison-value", absoluteDelta, right),
    tolerance,
    scopeDisposition,
  };
}

function buildFalcon(
  inputs: ReturnType<typeof normalizeInputs>,
  capturedAt: Date,
): Omit<ProtocolApiMechanismMeasurement, "snapshotId"> {
  const payload = normalizeTaggedNumberTokens(FalconTransparencySchema.parse(inputs[0]!.parsed)) as FalconTransparency;
  const observedAt = parseFalconTimestamp(payload.snapshot_date);
  assertFresh("Falcon transparency", observedAt, capturedAt, inputs[0]!.expected.maxAgeMs);
  assertPositive("Falcon TVL", payload.tvl);
  assertPositive("Falcon USDf supply", payload.usdf.supply);
  assertNonnegative("Falcon insurance fund", payload.usdf.insurance_fund);

  const assets = payload.usdf.breakdown.assets as Array<Record<string, string>>;
  const assetTotals = mapTotals(assets, (asset) => [[asset.label!, sumDecimals(Object.entries(asset).filter(([key]) => key !== "label").map(([, value]) => value))]]);
  const custodyTotals = mapTotals(assets, (asset) => Object.entries(asset).filter(([key]) => key !== "label"));
  const assetTvl = sumDecimals(assetTotals.values());
  const proportionalTolerance = divideByPowerOfTenExact(payload.tvl, 9);
  const tvlTolerance = compareDecimals("0.01", proportionalTolerance) >= 0
    ? "0.01"
    : proportionalTolerance;
  const assetTvlReconciliation = reconciliation(
    "assetRowsToTvl",
    assetTvl,
    payload.tvl,
    tvlTolerance,
    "asset rows are admitted as backing only when they reconcile to published TVL",
  );
  if (assetTvlReconciliation.status !== "pass") {
    throw new Error(`Falcon asset rows do not reconcile to TVL: delta ${assetTvlReconciliation.absoluteDelta}`);
  }

  const reservesTotal = sumDecimals(
    Object.values(payload.usdf.reserves).flatMap((reserve) => Object.values(reserve)),
  );
  const reserveExcess = subtractDecimals(assetTvl, payload.usdf.supply);
  const sourceId = inputs[0]!.input.sourceId;
  const observation = makeObservation(inputs[0]!.input, observedAt, payload);
  return {
    kind: "protocol-api-mechanism-measurement",
    schemaVersion: 2,
    family: "falcon-transparency-v1",
    assetId: "usdf-falcon",
    archetype: "synthetic-delta-neutral",
    snapshotObservedAt: observedAt,
    capturedAt: capturedAt.toISOString(),
    observations: [observation],
    claims: [],
    metrics: [
      measuredMetric("collateralizationRatio", "ratio", "reconciled asset-row TVL / USDf supply", [sourceId], divideRounded(assetTvl, payload.usdf.supply), "reconciled-asset-tvl-over-supply", assetTvl, payload.usdf.supply),
      measuredMetric("reserveExcessPct", "pct", "reconciled asset-row TVL less USDf supply", [sourceId], divideRounded(reserveExcess, payload.usdf.supply, 100), "reconciled-asset-tvl-excess-pct-of-supply", reserveExcess, payload.usdf.supply),
      measuredMetric("dedicatedLossAbsorptionShare", "ratio", "insurance fund / USDf supply", [sourceId], divideRounded(payload.usdf.insurance_fund, payload.usdf.supply), "insurance-fund-over-supply", payload.usdf.insurance_fund, payload.usdf.supply),
      ...commonUnavailableMetrics([sourceId]),
    ],
    breakdowns: [
      { id: "assetAllocation", scope: "reconciled Falcon backing asset rows", sourceObservationIds: [sourceId], entries: breakdownEntries(assetTotals, assetTvl) },
      { id: "custodyAllocation", scope: "custody columns across Falcon backing asset rows", sourceObservationIds: [sourceId], entries: breakdownEntries(custodyTotals, assetTvl) },
    ],
    reconciliations: [
      assetTvlReconciliation,
      reconciliation("publishedReservesToAssetRows", reservesTotal, assetTvl, tvlTolerance, "excluded from backing because the separately published reserves object has unresolved scope"),
      reconciliation("publishedReservesToSupply", reservesTotal, payload.usdf.supply, tvlTolerance, "reported for scope diagnosis only; excluded from backing and loss absorption"),
    ],
    checks: [
      { id: "transparency.fresh", status: "pass", detail: `transparency snapshot observed at ${observedAt}` },
      { id: "asset-rows.reconcile", status: "pass", detail: `asset rows reconcile to TVL within ${tvlTolerance} USD` },
      { id: "insurance.separate", status: "pass", detail: "insurance fund is excluded from backing TVL and measured only as dedicated loss absorption" },
      { id: "source.raw-byte-integrity", status: "pass", detail: "source body is preserved and SHA-256 bound" },
    ],
    adoptionEligibility: {
      status: "blocked",
      blockers: [
        "The current synthetic overlay requires quantitative hedge coverage, which is unavailable.",
        "The current synthetic overlay requires exchange margin headroom, which is unavailable.",
      ],
    },
    scoreImpactAssessment: {
      expectedEffect: "indeterminate",
      rationale: "The source measures balance-sheet coverage and insurance share but not the trading-risk fields required by the current overlay.",
      independentBlockers: ["Direct score adoption remains identity-bound.", "Quantitative hedge and exchange-margin evidence is unavailable."],
    },
    tool: { name: "measure-protocol-api-mechanism-metrics", version: "2" },
  };
}

export function buildProtocolApiMeasurement(
  assetId: ProtocolApiAssetId,
  rawInputs: RawProtocolApiObservationInput[],
  capturedAt = new Date(),
): ProtocolApiMechanismMeasurement {
  const inputs = normalizeInputs(assetId, rawInputs);
  const withoutSnapshotId = assetId === "usde-ethena" ? buildEthena(inputs, capturedAt) : buildFalcon(inputs, capturedAt);
  return ProtocolApiMechanismMeasurementSchema.parse({
    ...withoutSnapshotId,
    snapshotId: snapshotIdentity(withoutSnapshotId),
  });
}

export function serializeProtocolApiMeasurement(artifact: ProtocolApiMechanismMeasurement): string {
  return `${stableJsonStringifyV1(ProtocolApiMechanismMeasurementSchema.parse(artifact))}\n`;
}

function firstCaptureProjection(artifact: ProtocolApiMechanismMeasurement): string {
  const clone = structuredClone(artifact);
  clone.capturedAt = "1970-01-01T00:00:00.000Z";
  for (const observation of clone.observations) {
    observation.headers = {};
    observation.contentDigestVerification = "not-present";
    observation.httpSignatureVerification = "not-present";
  }
  return serializeProtocolApiMeasurement(clone);
}

export function isSameProtocolApiSourceSnapshot(
  existing: ProtocolApiMechanismMeasurement,
  incoming: ProtocolApiMechanismMeasurement,
): boolean {
  return existing.snapshotId === incoming.snapshotId && firstCaptureProjection(existing) === firstCaptureProjection(incoming);
}

export function replayProtocolApiMeasurement(recordedInput: unknown): ProtocolApiMechanismMeasurement {
  const recorded = ProtocolApiMechanismMeasurementSchema.parse(recordedInput);
  const replayed = buildProtocolApiMeasurement(
    recorded.assetId,
    recorded.observations.map((observation) => ({
      sourceId: observation.sourceId,
      url: observation.url,
      rawBody: Buffer.from(observation.rawBodyBase64, "base64"),
      headers: observation.headers,
    })),
    new Date(recorded.capturedAt),
  );
  if (serializeProtocolApiMeasurement(replayed) !== serializeProtocolApiMeasurement(recorded)) {
    throw new Error(`Offline replay diverged for ${recorded.assetId} snapshot ${recorded.snapshotId}`);
  }
  return replayed;
}

function chronologyVector(artifact: ProtocolApiMechanismMeasurement): number[] {
  return artifact.observations.map((observation) => Date.parse(observation.observedAt));
}

export function compareProtocolApiChronology(
  left: ProtocolApiMechanismMeasurement,
  right: ProtocolApiMechanismMeasurement,
): number {
  const leftVector = chronologyVector(left);
  const rightVector = chronologyVector(right);
  for (let index = 0; index < Math.max(leftVector.length, rightVector.length); index += 1) {
    const difference = (rightVector[index] ?? 0) - (leftVector[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function validateProtocolApiArtifactSet(inputs: unknown[]): ProtocolApiMechanismMeasurement[] {
  const artifacts = inputs.map((input) => replayProtocolApiMeasurement(input));
  const snapshotIds = new Set<string>();
  const timeVectors = new Map<string, string>();
  for (const artifact of artifacts) {
    if (snapshotIds.has(artifact.snapshotId)) throw new Error(`Duplicate protocol API snapshot ID: ${artifact.snapshotId}`);
    snapshotIds.add(artifact.snapshotId);
    const vectorKey = `${artifact.assetId}:${chronologyVector(artifact).join(",")}`;
    const priorIdentity = timeVectors.get(vectorKey);
    if (priorIdentity && priorIdentity !== artifact.snapshotId) {
      throw new Error(`Conflicting protocol API snapshots share the same observation-time vector: ${vectorKey}`);
    }
    timeVectors.set(vectorKey, artifact.snapshotId);
  }
  return artifacts.sort((left, right) => left.assetId.localeCompare(right.assetId) || compareProtocolApiChronology(left, right));
}

export function protocolApiEvidenceFilename(artifact: ProtocolApiMechanismMeasurement): string {
  return `${artifact.snapshotObservedAt.replaceAll(":", "-")}-${artifact.snapshotId.slice(0, 12)}-protocol-api.json`;
}

export { ETHENA_PROTOCOL_API_URLS, FALCON_TRANSPARENCY_URL };
export type { EthenaCollateralizationStatus, EthenaProofOfReserves, FalconTransparency };
