import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { CAPTURE_SUMMARY_SUFFIX, captureLookupKeys, parseMechanismCaptureSummary, verifyCaptureBody } from "../../scripts/lib/mechanism-measurement/capture-summary";
import { createR2MeasurementsClient } from "../../scripts/lib/r2-measurements-client";
import type { R2ObjectClient } from "../../scripts/lib/r2-object-client";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import mechanismReviewOverlaysAsset from "@shared/data/safety-score-v9/mechanism-review-overlays-v1.json";
import { parseIsoDateOrUtcInstantSec } from "@shared/types/date-primitives";
import {
  assertCliUsage,
  parseCliInteger,
  parseStrictCliArgs,
  runCliEntrypoint,
  writeCliHelpIfRequested,
} from "../../scripts/lib/cli-args.mjs";
import {
  computeNativeDexLiquidityPayloadFingerprint,
  NativeSafetyScoreV9InputSchema,
  normalizeSafetyScoreV9CompilerInput,
  parseSafetyScoreV9InputCacheValue,
  type SafetyScoreV9CompilerInput,
} from "../src/lib/safety-score-v9/native-input";
import { deriveSupplyModelExitRouteObservation } from "../src/lib/redemption-exit-route-observations";
import { computeRedemptionPayloadFingerprint, computeReportCardsRegistryFingerprint } from "@shared/lib/report-cards-fixed-input-identity";
import {
  buildSafetyScoreV9Candidate,
  type SafetyScoreV9CandidatePipelineResult,
} from "../src/lib/safety-score-v9/candidate";
import { resolveCapturedChainSupply } from "../src/lib/safety-score-v9/fact-set-peg-supply";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  loadSafetyScoreV9RegistryRef,
  registryNavAssetIds,
  verifyRegistrySnapshot,
  type SafetyScoreV9RegistrySnapshot,
} from "./lib/safety-score-v9-registry";

import { parseSafetyScoreV9TransferMaterialityGeneration, type SafetyScoreV9TransferMaterialityGeneration } from "../src/lib/safety-score-v9/transfer-materiality";
import {
  projectExpiredMeasuredExitRoutes,
  type SafetyScoreV9AcceptedPublicationBaseline,
} from "../src/lib/safety-score-v9/publication-assessment";
import {
  parseSafetyScoreV9ReplayLaneScreening,
  parseSafetyScoreV9SourceAdmissionBaseline,
  replayLaneIncidentCertificates,
  type SafetyScoreV9ReplayLaneScreening,
} from "../src/lib/safety-score-v9/publication-replay-capture";
export interface SafetyScoreV9FutureDatedReview {
  assetId: string;
  field: "reviewedAt" | "compositionAsOf" | "mechanism.reviewedAt" | `mechanism.components.${string}.review.reviewedAt`;
  date: string;
}

/**
 * A replay compiles against the CURRENT registry at the CAPTURE's clock. A
 * curated reserve review dated after that clock is rejected by
 * `reviewedReserveMatches`, which drops the asset's whole curated composition
 * and collapses its backing pillar — silently, unlike the transfer overlay,
 * which throws on the same condition. Replaying yesterday's capture against
 * data reviewed today therefore manufactures large phantom score drops that
 * read exactly like a regression. Surface them before the operator diffs.
 */
export function findFutureDatedCuratedReviews(
  clockSec: number,
  metaById = ACTIVE_META_BY_ID,
  mechanismOverlays: readonly {
    assetId: string; reviewedAt: string; components: Record<string, { review?: { reviewedAt: string }; [field: string]: unknown } | undefined>;
  }[] = mechanismReviewOverlaysAsset.overlays,
): SafetyScoreV9FutureDatedReview[] {
  const found: SafetyScoreV9FutureDatedReview[] = [];
  for (const [assetId, meta] of metaById) {
    const review = (meta as { reserveReview?: { reviewedAt?: string; compositionAsOf?: string } }).reserveReview;
    if (!review) continue;
    for (const field of ["reviewedAt", "compositionAsOf"] as const) {
      const date = review[field];
      if (typeof date !== "string" || date.length === 0) continue;
      const sec = Date.parse(`${date}T00:00:00.000Z`) / 1_000;
      if (Number.isFinite(sec) && sec > clockSec) found.push({ assetId, field, date });
    }
  }
  for (const overlay of mechanismOverlays) {
    if (!metaById.has(overlay.assetId)) continue;
    if (parseIsoDateOrUtcInstantSec(overlay.reviewedAt) > clockSec) {
      found.push({ assetId: overlay.assetId, field: "mechanism.reviewedAt", date: overlay.reviewedAt });
    }
    for (const [key, component] of Object.entries(overlay.components)) {
      const date = component?.review?.reviewedAt;
      if (date && parseIsoDateOrUtcInstantSec(date) > clockSec) {
        found.push({ assetId: overlay.assetId, field: `mechanism.components.${key}.review.reviewedAt`, date });
      }
    }
  }
  return found.sort((a, b) => a.assetId.localeCompare(b.assetId) || a.field.localeCompare(b.field));
}

export function formatFutureDatedReviewError(
  rows: readonly SafetyScoreV9FutureDatedReview[],
  clockSec: number,
): string {
  const clockIso = new Date(clockSec * 1_000).toISOString();
  const lines = rows.map((row) => `  ${row.assetId}: ${row.field} ${row.date}`);
  return [
    `${rows.length} curated review date(s) postdate the capture clock ${clockIso}:`,
    ...lines,
    "",
    "Those reviews are rejected at this clock, withdrawing the affected curated",
    "reserve composition or mechanism claims. Any score drop caused by those",
    "withdrawals is an artifact of replaying an old capture against newer curation,",
    "not a regression. Take a newer capture instead: --published-at does not move",
    "the fact-set clock, which comes from the capture.",
    "Pass --allow-future-reviews to replay anyway and read those movers as invalid.",
  ].join("\n");
}

const USAGE = `Usage: npm run safety-score-v9:replay -- --input <path-or-sha256> --output <path> [options]

Options:
  --input <path-or-sha256>         V9 input capture path, SHA-256 capture identity, raw JSON or compressed cache envelope (required).
                                  Accepts native capture v4 (envelope v2) and retired capture v3
                                  (envelope v1). Both recompile through the current schema-4
                                  cause resolver; absent exact proofs stay U, never inferred A/B.
  --output <path>                 Canonical V9 replay JSON (required)
  --published-at <time>           Fixed ISO timestamp or Unix seconds (required)
  --extension <path>              Optional reviewed V9 fact-extension JSON
  --registry-ref <git-sha>         Verified capture-time registry from a trusted local Git commit.
                                  Otherwise uses an embedded registry snapshot, then the local registry.
  --release-candidate-id <id>     Optional v9-rc-N publication identity override
  --rederive-current-redemption   Explicit current-curation scenario: rederive captured
                                  undisclosed-reviewed fee observations. Incompatible
                                  with accepted captures or capture-time registry modes.
  --admit-asset <id>              Add a local registry-active asset to a native v4 capture
                                  for an admission scenario (repeatable).
  --supply-observations <path>    JSON observations keyed by admitted asset ID, required for
                                  assets without usable captured supply.
  --allow-future-reviews          Replay even when curated review dates postdate the capture
                                  clock. Those reviews are rejected at that clock, silently
                                  dropping the asset's curated reserve composition, so their
                                  movers are artifacts and must not be read as regressions.
  --allow-registry-mismatch       Replay a capture whose registry fingerprint does not match
                                  the local registry. Needed when carrying a frozen capture
                                  across a registry-changing curation commit. The resulting
                                  diff then measures code and curation changes TOGETHER and
                                  must be partitioned by attribution before it is read as an
                                  equivalence result.
  -h, --help                      Show this help`;

const AdmissionSupplyObservationsSchema = NativeSafetyScoreV9InputSchema.shape.replaySupplyObservationsById.unwrap();

interface AssetAdmissionScenario {
  kind: "asset-admission";
  sourceBaseInputGenerationId: string;
  registryFingerprint: string;
  assets: Array<{
    assetId: string;
    captureIdSuffix: string;
    supplyObservation?: z.infer<typeof AdmissionSupplyObservationsSchema.valueType>;
  }>;
}

export interface SafetyScoreV9ReplayArtifact {
  schemaVersion: 1;
  kind: "safety-score-v9-candidate-replay";
  lifecycle: "active";
  releaseAuthorization: {
    authorized: false;
    reason: "v9-replay-only";
  };
  pipeline: Readonly<SafetyScoreV9CandidatePipelineResult>;
  /** v3 accepted captures: the prior accepted baseline the publication was admitted against (null = bootstrap). */
  sourceAdmissionBaseline?: SafetyScoreV9AcceptedPublicationBaseline | null;
  /** Exact lane witnesses retained for downstream replay/reproduction. */
  laneScreening?: SafetyScoreV9ReplayLaneScreening | null;
  replayScenario?: {
    kind: "current-redemption-rederivation";
    sourceBaseInputGenerationId: string;
  } | AssetAdmissionScenario;
}

const CAPTURE_SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const DEFAULT_CAPTURE_SUMMARY_ROOT = resolve(
  process.cwd(),
  "shared/data/safety-score-v9/mechanism-measurements",
);
const DEFAULT_CAPTURE_CACHE_DIR = resolve(process.cwd(), "agents/.cache/measurements");

export interface SafetyScoreV9ReplayInputResolverOptions {
  cacheDir?: string;
  summaryRoot?: string;
  r2Client?: R2ObjectClient;
}

interface CaptureReference {
  sha256: string;
  r2Key: string;
}

function findCaptureReference(directory: string, expectedSha256: string): CaptureReference | null {
  if (!existsSync(directory)) return null;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      const found = findCaptureReference(path, expectedSha256);
      if (found) return found;
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(CAPTURE_SUMMARY_SUFFIX)) continue;
    const summary = parseMechanismCaptureSummary(JSON.parse(readFileSync(path, "utf8")), path);
    if (summary.sha256 === expectedSha256) return { sha256: summary.sha256, r2Key: summary.r2Key };
  }
  return null;
}

/** Resolve a SHA-256 capture through the durable local cache, then R2. */
export async function resolveSafetyScoreV9ReplayInput(
  sha256: string,
  options: SafetyScoreV9ReplayInputResolverOptions = {},
): Promise<Buffer> {
  const expectedSha256 = sha256.trim();
  if (!CAPTURE_SHA256_PATTERN.test(expectedSha256)) {
    throw new Error(`Invalid capture sha256: ${sha256}`);
  }
  const cacheDir = resolve(options.cacheDir ?? DEFAULT_CAPTURE_CACHE_DIR);
  const cachedPath = resolve(cacheDir, `${expectedSha256}.json`);
  if (existsSync(cachedPath)) {
    return verifyCaptureBody(readFileSync(cachedPath), expectedSha256);
  }

  const reference = findCaptureReference(resolve(options.summaryRoot ?? DEFAULT_CAPTURE_SUMMARY_ROOT), expectedSha256);
  if (!reference) throw new Error(`capture ${expectedSha256} expired: non-replayable`);
  const client = options.r2Client ?? createR2MeasurementsClient();
  const keys = captureLookupKeys(reference.r2Key);
  for (const key of keys) {
    const compressed = await client.get(key);
    if (!compressed) continue;
    const body = verifyCaptureBody(compressed, expectedSha256);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cachedPath, body);
    return body;
  }
  throw new Error(`capture ${expectedSha256} expired: non-replayable`);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}
async function readReplayInput(input: string): Promise<unknown> {
  if (CAPTURE_SHA256_PATTERN.test(input.trim())) {
    return JSON.parse(new TextDecoder().decode(await resolveSafetyScoreV9ReplayInput(input))) as unknown;
  }
  return readJson(input);
}


function isFixedInputCacheEnvelope(value: unknown): boolean {
  if (typeof value === "string") return true;
  return (
    value !== null &&
    typeof value === "object" &&
    "kind" in value &&
    (value as { kind?: unknown }).kind === "report-cards-fixed-input-exact"
  );
}

/**
 * Parse either normalized capture JSON or a compressed cache envelope. Cache
 * envelopes deliberately go through the production checksum, byte-length,
 * generation, and exact-capture parsers.
 *
 * Both capture generations are admissible. `parseSafetyScoreV9InputCacheValue`
 * routes envelope v2 to the native v4 parser and envelope v1 to the untouched
 * legacy v3 parser; `normalizeSafetyScoreV9CompilerInput` makes the same split
 * on raw JSON by `schemaVersion`. Historical producer bytes and identity stay
 * fixed; recompilation applies today's cause resolver, not historical scoring.
 */
export async function parseSafetyScoreV9ReplayFixedInput(
  value: unknown,
  registrySnapshot?: SafetyScoreV9RegistrySnapshot,
): Promise<SafetyScoreV9CompilerInput> {
  const navAssetIds = registrySnapshot ? registryNavAssetIds(verifyRegistrySnapshot(registrySnapshot)) : undefined;
  const input = isFixedInputCacheEnvelope(value)
    ? await parseSafetyScoreV9InputCacheValue(value, navAssetIds)
    : normalizeSafetyScoreV9CompilerInput(value, navAssetIds);
  if (registrySnapshot && input.registryFingerprint !== registrySnapshot.fingerprint) {
    throw new Error(`Capture registry fingerprint ${input.registryFingerprint} does not match supplied snapshot ${registrySnapshot.fingerprint}`);
  }
  return input;
}

/** Explicit current-curation scenario; all other producer observations stay captured. */
export function rederiveUndisclosedFeeObservations(
  fixedInput: SafetyScoreV9CompilerInput,
): SafetyScoreV9CompilerInput | Omit<SafetyScoreV9CompilerInput, "baseInputGenerationId"> {
  const map: SafetyScoreV9CompilerInput["redemptionBackstopMap"] = { ...fixedInput.redemptionBackstopMap };
  let changed = false;
  for (const [assetId, entry] of Object.entries(map)) {
    if (!entry) continue;
    const profile = entry.capacityProfile;
    if (!profile || (profile.exitRouteObservations?.length ?? 0) === 0) continue;
    if (entry.feeModelKind !== "undisclosed-reviewed" &&
        profile.exitRouteObservations?.some((observation) => observation.feeEvidence === "undisclosed-reviewed") !== true) continue;
    const derived = deriveSupplyModelExitRouteObservation(
      { ...entry, capacityProfile: { ...profile, exitRouteObservations: undefined } },
      fixedInput.clockSec,
    );
    if (!derived) continue;
    map[assetId] = { ...entry, capacityProfile: { ...profile, exitRouteObservations: [derived] } };
    changed = true;
  }
  if (!changed) return fixedInput;
  // The substituted payload carries new producer bytes: refresh the payload
  // fingerprint and drop the stored base generation id so `normalizeFixedInput`
  // re-derives it from its own normalized payload, exactly like a fresh capture.
  const { baseInputGenerationId: _stale, ...next } = fixedInput;
  return {
    ...next,
    redemptionBackstopMap: map,
    redemptionPayloadFingerprint: computeRedemptionPayloadFingerprint(map, fixedInput.redemptionGenerationId),
  };
}

function buildAssetAdmissionScenario(
  capturedInput: SafetyScoreV9CompilerInput,
  assetIds: string[],
  observations: z.infer<typeof AdmissionSupplyObservationsSchema>,
) {
  const { baseInputGenerationId, ...input } = capturedInput;
  const updatedAt = input.inputFreshness.dexLiquidity.updatedAt;
  if (input.schemaVersion !== 4 || updatedAt == null) {
    throw new Error("--admit-asset requires a native v4 capture with a captured DEX generation");
  }
  assertCliUsage(new Set(assetIds).size === assetIds.length, "--admit-asset IDs must be unique");
  for (const id of Object.keys(observations)) {
    assertCliUsage(assetIds.includes(id), `Supply observation provided for unrequested asset ${id}`);
  }
  const dexLiqMap = { ...input.dexLiqMap };
  const assets = [...assetIds].sort().map((assetId) => {
    assertCliUsage(ACTIVE_META_BY_ID.has(assetId), `${assetId} is not active in the local registry`);
    assertCliUsage(!input.activeAssetIds.includes(assetId), `${assetId} is already active in the capture`);
    dexLiqMap[assetId] ??= { updatedAt };
    const admission = { assetId, captureIdSuffix: `+admit:${assetId}` };
    const supplyObservation = observations[assetId];
    if (getCirculatingRawOrNull(input.aggregateCirculatingById[assetId]) !== null ||
      resolveCapturedChainSupply(capturedInput, assetId) !== null) {
      assertCliUsage(supplyObservation === undefined, `${assetId} already has usable captured supply`);
      return admission;
    }
    if (supplyObservation === undefined) throw new Error(`${assetId} requires a --supply-observations entry`);
    const { observedAtSec, retrievedAtSec } = supplyObservation;
    assertCliUsage(getCirculatingRawOrNull(supplyObservation) !== null, `${assetId} requires observed USD supply buckets`);
    assertCliUsage(observedAtSec === null || observedAtSec <= Math.min(input.clockSec, retrievedAtSec),
      `${assetId} supply observation time must not follow the capture clock or retrieval time`);
    return { ...admission, supplyObservation };
  });
  const replayScenario: AssetAdmissionScenario = {
    kind: "asset-admission",
    sourceBaseInputGenerationId: baseInputGenerationId,
    registryFingerprint: computeReportCardsRegistryFingerprint(),
    assets,
  };
  return {
    fixedInput: {
      ...input,
      activeAssetIds: [...input.activeAssetIds, ...assetIds],
      ...(Object.keys(observations).length > 0 ? { replaySupplyObservationsById: observations } : {}),
      dexLiqMap,
      dexPayloadFingerprint: computeNativeDexLiquidityPayloadFingerprint(dexLiqMap, input.dexGenerationId),
    },
    replayScenario,
  };
}

export function parseSafetyScoreV9PublishedAtSec(value: unknown): number {
  const raw = String(value ?? "").trim();
  assertCliUsage(raw.length > 0, "--published-at is required");
  if (/^[0-9]+$/.test(raw)) {
    return parseCliInteger(raw, { name: "--published-at", min: 0 });
  }
  const millis = Date.parse(raw);
  assertCliUsage(Number.isFinite(millis), "--published-at must be a valid ISO timestamp or Unix seconds");
  assertCliUsage(millis >= 0, "--published-at must not predate the Unix epoch");
  assertCliUsage(millis % 1_000 === 0, "--published-at must resolve to whole Unix seconds");
  return millis / 1_000;
}

export function buildSafetyScoreV9ReplayArtifact(input: {
  fixedInput: unknown;
  extension?: unknown;
  publishedAtSec: number;
  releaseCandidateId?: string;
  allowRegistryMismatch?: boolean;
  registrySnapshot?: SafetyScoreV9RegistrySnapshot;
  transferMaterialityGeneration?: SafetyScoreV9TransferMaterialityGeneration | null;
  sourceAdmissionBaseline?: SafetyScoreV9AcceptedPublicationBaseline | null;
  replayScenario?: AssetAdmissionScenario;
  /** Captured lane witnesses; absent means the capture could not record them. */
  laneScreening?: SafetyScoreV9ReplayLaneScreening | null;
}): SafetyScoreV9ReplayArtifact {
  const { sourceAdmissionBaseline, laneScreening, replayScenario, ...candidateInput } = input;
  if (input.registrySnapshot && (!input.fixedInput || typeof input.fixedInput !== "object" ||
    !("registryFingerprint" in input.fixedInput) || input.fixedInput.registryFingerprint !== input.registrySnapshot.fingerprint)) {
    throw new Error("Capture registry fingerprint does not match supplied snapshot");
  }
  return {
    schemaVersion: 1,
    kind: "safety-score-v9-candidate-replay",
    lifecycle: "active",
    releaseAuthorization: {
      authorized: false,
      reason: "v9-replay-only",
    },
    ...(sourceAdmissionBaseline === undefined ? {} : { sourceAdmissionBaseline }),
    ...(laneScreening === undefined ? {} : { laneScreening }),
    ...(replayScenario === undefined ? {} : { replayScenario }),
    pipeline: buildSafetyScoreV9Candidate({
      ...candidateInput,
      // The lane witnesses the publication actually read: without them a
      // replayed publication cannot reproduce a closure it applied.
      ...(laneScreening === undefined || laneScreening === null ? {} : {
        laneIncidentCertificates: replayLaneIncidentCertificates(laneScreening),
        laneEmitterDescriptors: laneScreening.descriptors,
      }),
      // Reproduce 10.35 measured-route quarantine against the same accepted baseline.
      ...(sourceAdmissionBaseline === undefined ? {} : { measuredExitExpiry: {
        routes: projectExpiredMeasuredExitRoutes(input.fixedInput as SafetyScoreV9CompilerInput),
        acceptedPublication: sourceAdmissionBaseline,
      } }),
      ...(input.registrySnapshot ? {
        registry: {
          metaById: new Map(verifyRegistrySnapshot(input.registrySnapshot).activeStablecoins.map((coin) => [coin.id, coin])),
          registryFingerprint: input.registrySnapshot.fingerprint,
          reviewedTransferFacts: new Map(input.registrySnapshot.transferReviews.map((review) => [review.assetId, review])),
        },
      } : {}),
    }, replayScenario?.kind),
  };
}

export function serializeSafetyScoreV9ReplayArtifact(value: SafetyScoreV9ReplayArtifact): string {
  return `${stableJsonStringifyV1(value)}\n`;
}

export async function runSafetyScoreV9ReplayCli(argv: readonly string[]): Promise<void> {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      input: { type: "string" },
      output: { type: "string" },
      "published-at": { type: "string" },
      extension: { type: "string" },
      "registry-ref": { type: "string" },
      "release-candidate-id": { type: "string" },
      "allow-registry-mismatch": { type: "boolean" },
      "allow-future-reviews": { type: "boolean" },
      "rederive-current-redemption": { type: "boolean" },
      "admit-asset": { type: "string", multiple: true },
      "supply-observations": { type: "string" },
    },
    conflicts: [["admit-asset", "registry-ref"], ["admit-asset", "rederive-current-redemption"], ["admit-asset", "extension"]],
  });
  if (writeCliHelpIfRequested(values, USAGE)) return;
  assertCliUsage(typeof values.input === "string", "--input is required");
  assertCliUsage(typeof values.output === "string", "--output is required");
  const admitAssetIds = (values["admit-asset"] ?? []) as string[];
  const supplyObservationsPath = values["supply-observations"];
  assertCliUsage(supplyObservationsPath === undefined || admitAssetIds.length > 0, "--supply-observations requires --admit-asset");

  const publishedAtSec = parseSafetyScoreV9PublishedAtSec(values["published-at"]);
  const releaseCandidateId = values["release-candidate-id"];
  assertCliUsage(
    releaseCandidateId === undefined || /^v9-rc-[1-9][0-9]*$/.test(String(releaseCandidateId)),
    "--release-candidate-id must match v9-rc-N",
  );

  const raw = await readReplayInput(values.input);
  const capture = raw as { kind?: string; fixedInput?: unknown; registrySnapshot?: SafetyScoreV9RegistrySnapshot; transferMaterialityGeneration?: unknown; sourceAdmissionBaseline?: unknown; laneScreening?: unknown };
  const acceptedCapture = capture.kind === "safety-score-v9-accepted-publication-capture";
  const embedded = capture.kind === "safety-score-v9-registry-capture" || acceptedCapture ? capture.registrySnapshot : undefined;
  assertCliUsage(
    !(values["registry-ref"] !== undefined && values["allow-registry-mismatch"] === true),
    "--registry-ref cannot be combined with --allow-registry-mismatch",
  );
  if (capture.kind === "safety-score-v9-registry-capture" && !embedded) throw new Error("Registry capture is missing its snapshot");
  const registrySnapshot = typeof values["registry-ref"] === "string"
    ? loadSafetyScoreV9RegistryRef(values["registry-ref"])
    : values["allow-registry-mismatch"] === true ? undefined : embedded;
  assertCliUsage(admitAssetIds.length === 0 || (!acceptedCapture && registrySnapshot === undefined),
    "--admit-asset requires base inputs and the local registry. Use a prepare-time export with --normalized-only");
  if (embedded) {
    verifyRegistrySnapshot(embedded);
    if (registrySnapshot && (registrySnapshot.fingerprint !== embedded.fingerprint ||
      registrySnapshot.transferReviewsDigest !== embedded.transferReviewsDigest)) {
      throw new Error("Embedded registry and --registry-ref disagree");
    }
  }
  const capturedInput = await parseSafetyScoreV9ReplayFixedInput(
    capture.kind === "safety-score-v9-registry-capture" || acceptedCapture ? capture.fixedInput : raw, registrySnapshot,
  );
  assertCliUsage(
    !(values["rederive-current-redemption"] === true &&
      (acceptedCapture || embedded !== undefined || values["registry-ref"] !== undefined)),
    "--rederive-current-redemption cannot be combined with accepted captures or capture-time registry modes",
  );
  const admission = admitAssetIds.length > 0 ? buildAssetAdmissionScenario(
    capturedInput,
    admitAssetIds,
    typeof supplyObservationsPath === "string" ? AdmissionSupplyObservationsSchema.parse(readJson(supplyObservationsPath)) : {},
  ) : undefined;
  // Captured producer bytes are the default, even with current checkout curation.
  const fixedInput = values["rederive-current-redemption"] === true
    ? rederiveUndisclosedFeeObservations(capturedInput)
    : admission?.fixedInput ?? capturedInput;
  if (values["allow-future-reviews"] !== true) {
    const futureDated = findFutureDatedCuratedReviews(fixedInput.clockSec, registrySnapshot
      ? new Map(registrySnapshot.activeStablecoins.map((coin) => [coin.id, coin]))
      : ACTIVE_META_BY_ID);
    assertCliUsage(futureDated.length === 0, formatFutureDatedReviewError(futureDated, fixedInput.clockSec));
  }
  const extension = typeof values.extension === "string" ? readJson(values.extension) : undefined;
  const artifact = buildSafetyScoreV9ReplayArtifact({
    fixedInput,
    registrySnapshot,
    replayScenario: admission?.replayScenario,
    ...(acceptedCapture ? { transferMaterialityGeneration: capture.transferMaterialityGeneration === null ? null : parseSafetyScoreV9TransferMaterialityGeneration(capture.transferMaterialityGeneration) } : {}),
    ...(acceptedCapture && capture.sourceAdmissionBaseline !== undefined
      ? { sourceAdmissionBaseline: parseSafetyScoreV9SourceAdmissionBaseline(capture.sourceAdmissionBaseline, capturedInput.clockSec)?.baseline ?? null } : {}),
    ...(acceptedCapture && capture.laneScreening !== undefined
      ? { laneScreening: capture.laneScreening === null ? null : parseSafetyScoreV9ReplayLaneScreening(capture.laneScreening) } : {}),
    ...(extension === undefined ? {} : { extension }),
    publishedAtSec,
    ...(releaseCandidateId === undefined ? {} : { releaseCandidateId: String(releaseCandidateId) }),
    ...(values["allow-registry-mismatch"] === true ? { allowRegistryMismatch: true } : {}),
  });
  if (values["rederive-current-redemption"] === true) {
    artifact.replayScenario = {
      kind: "current-redemption-rederivation",
      sourceBaseInputGenerationId: capturedInput.baseInputGenerationId,
    };
  }
  writeFileSync(values.output, serializeSafetyScoreV9ReplayArtifact(artifact), "utf8");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void runCliEntrypoint(() => runSafetyScoreV9ReplayCli(process.argv.slice(2)), {
    label: "safety-score-v9:replay",
    usage: USAGE,
  });
}
