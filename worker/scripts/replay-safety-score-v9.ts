import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import {
  assertCliUsage,
  parseCliInteger,
  parseStrictCliArgs,
  runCliEntrypoint,
  writeCliHelpIfRequested,
} from "../../scripts/lib/cli-args.mjs";
import {
  normalizeFixedInput,
  parseReportCardsFixedInputCacheValue,
  type ReportCardsFixedInput,
} from "../src/lib/report-cards-fixed-input";
import { deriveSupplyModelExitRouteObservation } from "../src/lib/redemption-exit-route-observations";
import { computeRedemptionPayloadFingerprint } from "@shared/lib/report-cards-fixed-input-identity";
import {
  buildSafetyScoreV9Candidate,
  type SafetyScoreV9CandidatePipelineResult,
} from "../src/lib/safety-score-v9-candidate";

const USAGE = `Usage: npm run safety-score-v9:replay -- --input <path> --output <path> [options]

Options:
  --input <path>                  Exact fixed-input JSON or compressed cache envelope (required)
  --output <path>                 Canonical V9 replay JSON (required)
  --published-at <time>           Fixed ISO timestamp or Unix seconds (required)
  --extension <path>              Optional reviewed V9 fact-extension JSON
  --release-candidate-id <id>     Optional v9-rc-N publication identity override
  -h, --help                      Show this help`;

export interface SafetyScoreV9ReplayArtifact {
  schemaVersion: 1;
  kind: "safety-score-v9-candidate-replay";
  lifecycle: "active";
  releaseAuthorization: {
    authorized: false;
    reason: "v9-replay-only";
  };
  pipeline: Readonly<SafetyScoreV9CandidatePipelineResult>;
}

function readJson(path: string): unknown {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- explicit local operator input path.
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
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
 * Parse either normalized fixed-input JSON or the exact compressed cache
 * envelope. Cache envelopes deliberately go through the production checksum,
 * byte-length, generation, and exact-capture parser.
 */
export async function parseSafetyScoreV9ReplayFixedInput(value: unknown): Promise<ReportCardsFixedInput> {
  if (isFixedInputCacheEnvelope(value)) return parseReportCardsFixedInputCacheValue(value);
  return normalizeFixedInput(value);
}

/**
 * SIM-EXIT-L2 replay-lane emulation: a captured supply-model redemption row
 * carries the observation the producer derived with the code that was live at
 * capture time, and the shadow pipeline never re-derives when a native
 * observation exists. Re-derive exactly the lever class (undisclosed-reviewed
 * fee) with the current shared derivation so the frozen capture reflects what
 * the producer republishes after this code ships. Every other row keeps its
 * captured observation byte-for-byte.
 */
function rederiveUndisclosedFeeObservations(
  fixedInput: ReportCardsFixedInput,
): ReportCardsFixedInput | Omit<ReportCardsFixedInput, "baseInputGenerationId"> {
  const map: ReportCardsFixedInput["redemptionBackstopMap"] = { ...fixedInput.redemptionBackstopMap };
  let changed = false;
  for (const [assetId, entry] of Object.entries(map)) {
    if (!entry || entry.feeModelKind !== "undisclosed-reviewed") continue;
    const profile = entry.capacityProfile;
    if (!profile || (profile.exitRouteObservations?.length ?? 0) === 0) continue;
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
}): SafetyScoreV9ReplayArtifact {
  return {
    schemaVersion: 1,
    kind: "safety-score-v9-candidate-replay",
    lifecycle: "active",
    releaseAuthorization: {
      authorized: false,
      reason: "v9-replay-only",
    },
    pipeline: buildSafetyScoreV9Candidate(input),
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
      "release-candidate-id": { type: "string" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE)) return;
  assertCliUsage(typeof values.input === "string", "--input is required");
  assertCliUsage(typeof values.output === "string", "--output is required");

  const publishedAtSec = parseSafetyScoreV9PublishedAtSec(values["published-at"]);
  const releaseCandidateId = values["release-candidate-id"];
  assertCliUsage(
    releaseCandidateId === undefined || /^v9-rc-[1-9][0-9]*$/.test(String(releaseCandidateId)),
    "--release-candidate-id must match v9-rc-N",
  );

  const fixedInput = rederiveUndisclosedFeeObservations(
    await parseSafetyScoreV9ReplayFixedInput(readJson(values.input)),
  );
  const extension = typeof values.extension === "string" ? readJson(values.extension) : undefined;
  const artifact = buildSafetyScoreV9ReplayArtifact({
    fixedInput,
    ...(extension === undefined ? {} : { extension }),
    publishedAtSec,
    ...(releaseCandidateId === undefined ? {} : { releaseCandidateId: String(releaseCandidateId) }),
  });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- explicit local operator output path.
  writeFileSync(values.output, serializeSafetyScoreV9ReplayArtifact(artifact), "utf8");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void runCliEntrypoint(() => runSafetyScoreV9ReplayCli(process.argv.slice(2)), {
    label: "safety-score-v9:replay",
    usage: USAGE,
  });
}
