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
  normalizeSafetyScoreV9CompilerInput,
  parseSafetyScoreV9InputCacheValue,
  type SafetyScoreV9CompilerInput,
} from "../src/lib/safety-score-v9-native-input";
import { deriveSupplyModelExitRouteObservation } from "../src/lib/redemption-exit-route-observations";
import { computeRedemptionPayloadFingerprint } from "@shared/lib/report-cards-fixed-input-identity";
import {
  buildSafetyScoreV9Candidate,
  type SafetyScoreV9CandidatePipelineResult,
} from "../src/lib/safety-score-v9-candidate";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";

export interface SafetyScoreV9FutureDatedReview {
  assetId: string;
  field: "reviewedAt" | "compositionAsOf";
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
export function findFutureDatedCuratedReviews(clockSec: number): SafetyScoreV9FutureDatedReview[] {
  const found: SafetyScoreV9FutureDatedReview[] = [];
  for (const [assetId, meta] of ACTIVE_META_BY_ID) {
    const review = (meta as { reserveReview?: { reviewedAt?: string; compositionAsOf?: string } }).reserveReview;
    if (!review) continue;
    for (const field of ["reviewedAt", "compositionAsOf"] as const) {
      const date = review[field];
      if (typeof date !== "string" || date.length === 0) continue;
      const sec = Date.parse(`${date}T00:00:00.000Z`) / 1_000;
      if (Number.isFinite(sec) && sec > clockSec) found.push({ assetId, field, date });
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
    "Those reviews are rejected at this clock, which drops each asset's curated",
    "reserve composition and collapses its backing pillar. Any score drop you see",
    "for them is an artifact of replaying an old capture against newer curation,",
    "not a regression. Take a newer capture instead: --published-at does not move",
    "the fact-set clock, which comes from the capture.",
    "Pass --allow-future-reviews to replay anyway and read those movers as invalid.",
  ].join("\n");
}

const USAGE = `Usage: npm run safety-score-v9:replay -- --input <path> --output <path> [options]

Options:
  --input <path>                  V9 input capture, raw JSON or compressed cache envelope (required).
                                  Accepts the native v4 capture (envelope v2) and, read-only, the
                                  retired v3 exact fixed input (envelope v1) so frozen pre-9.07
                                  operator captures keep replaying byte-for-byte.
  --output <path>                 Canonical V9 replay JSON (required)
  --published-at <time>           Fixed ISO timestamp or Unix seconds (required)
  --extension <path>              Optional reviewed V9 fact-extension JSON
  --release-candidate-id <id>     Optional v9-rc-N publication identity override
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
 * Parse either normalized capture JSON or a compressed cache envelope. Cache
 * envelopes deliberately go through the production checksum, byte-length,
 * generation, and exact-capture parsers.
 *
 * Both capture generations are admissible. `parseSafetyScoreV9InputCacheValue`
 * routes envelope v2 to the native v4 parser and envelope v1 to the untouched
 * legacy v3 parser; `normalizeSafetyScoreV9CompilerInput` makes the same split
 * on raw JSON by `schemaVersion`. The v3 lane is read-only: nothing writes it
 * any more, but frozen captures must keep replaying byte-for-byte.
 */
export async function parseSafetyScoreV9ReplayFixedInput(value: unknown): Promise<SafetyScoreV9CompilerInput> {
  if (isFixedInputCacheEnvelope(value)) return parseSafetyScoreV9InputCacheValue(value);
  return normalizeSafetyScoreV9CompilerInput(value);
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
  fixedInput: SafetyScoreV9CompilerInput,
): SafetyScoreV9CompilerInput | Omit<SafetyScoreV9CompilerInput, "baseInputGenerationId"> {
  const map: SafetyScoreV9CompilerInput["redemptionBackstopMap"] = { ...fixedInput.redemptionBackstopMap };
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
  allowRegistryMismatch?: boolean;
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
      "allow-registry-mismatch": { type: "boolean" },
      "allow-future-reviews": { type: "boolean" },
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
  if (values["allow-future-reviews"] !== true) {
    const futureDated = findFutureDatedCuratedReviews(fixedInput.clockSec);
    assertCliUsage(futureDated.length === 0, formatFutureDatedReviewError(futureDated, fixedInput.clockSec));
  }
  const extension = typeof values.extension === "string" ? readJson(values.extension) : undefined;
  const artifact = buildSafetyScoreV9ReplayArtifact({
    fixedInput,
    ...(extension === undefined ? {} : { extension }),
    publishedAtSec,
    ...(releaseCandidateId === undefined ? {} : { releaseCandidateId: String(releaseCandidateId) }),
    ...(values["allow-registry-mismatch"] === true ? { allowRegistryMismatch: true } : {}),
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
