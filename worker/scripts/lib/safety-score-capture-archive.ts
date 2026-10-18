import { createHash } from "node:crypto";
import { z } from "zod";
import { SafetyScoreCaptureArchiveObjectSchema } from "@shared/types/safety-score-capture-archive";
import { parseSafetyScoreV9PublicationReplayCacheRows } from "../../src/lib/safety-score-v9/publication-replay-capture";
import { parseSafetyScoreV9Publication } from "../../src/lib/safety-score-v9/publication-codec";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const SafetyScoreCaptureArchiveIndexSchema = z.object({
  generation_id: z.string().min(1),
  published_at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  methodology_version: z.string().min(1),
  policy_digest: digest,
  evaluation_build_digest: digest,
  r2_key: z.string().min(1),
  object_sha256: digest,
  object_bytes: z.number().int().positive().max(8 * 1024 * 1024),
  archived_at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type SafetyScoreCaptureArchiveIndex = z.infer<typeof SafetyScoreCaptureArchiveIndexSchema>;
const unixSeconds = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Accepted V9 publications are named `report-cards:v9:v1:<sha256>` by `safety-score-v9/candidate.ts`. */
export const SafetyScorePublicationGenerationIdSchema = z.string().regex(/^report-cards:v9:v1:[a-f0-9]{64}$/u);
export const SafetyScoreCaptureArchiveJournalGapSchema = SafetyScoreCaptureArchiveIndexSchema.pick({
  generation_id: true, published_at: true, methodology_version: true, policy_digest: true, evaluation_build_digest: true,
}).extend({
  attempt_id: z.string().min(1),
  attempted_at: unixSeconds,
});
export type SafetyScoreCaptureArchiveJournalGap = z.infer<typeof SafetyScoreCaptureArchiveJournalGapSchema>;
/** One productive `compute-safety-score-v9` run whose metadata names an accepted publication generation. */
export const SafetyScoreCaptureArchiveRecentCronRowSchema = z.object({
  run_id: z.number().int().positive(),
  started_at: unixSeconds,
  status: z.string().min(1),
  generation_id: z.unknown(),
  archive_indexed: z.number().int().min(0).max(1),
});
export type SafetyScoreCaptureArchiveRecentCronRow = z.infer<typeof SafetyScoreCaptureArchiveRecentCronRowSchema>;
export const SAFETY_SCORE_CAPTURE_ARCHIVE_GAP_EVIDENCE_SOURCES = ["accepted-attempt-journal", "recent-cron"] as const;
export type SafetyScoreCaptureArchiveGapEvidenceSource = (typeof SAFETY_SCORE_CAPTURE_ARCHIVE_GAP_EVIDENCE_SOURCES)[number];
export const SafetyScoreCaptureArchiveRecentCronRunSchema = SafetyScoreCaptureArchiveRecentCronRowSchema.pick({
  run_id: true, started_at: true, status: true,
});
export type SafetyScoreCaptureArchiveRecentCronRun = z.infer<typeof SafetyScoreCaptureArchiveRecentCronRunSchema>;
/** One run naming a schema-validated generation that carries no archive index row. */
export type SafetyScoreCaptureArchiveCronGapEvidence = {
  generation_id: string;
  run_id: number;
  started_at: number;
  status: string;
};
/** A generation with no archive index row, carrying whichever optional evidence sources still retain it. */
export const SafetyScoreCaptureArchiveGapSchema = z.object({
  generation_id: z.string().min(1),
  evidence_sources: z.array(z.enum(SAFETY_SCORE_CAPTURE_ARCHIVE_GAP_EVIDENCE_SOURCES)).min(1),
  journal: SafetyScoreCaptureArchiveJournalGapSchema.omit({ generation_id: true }).nullable(),
  recent_cron_runs: z.array(SafetyScoreCaptureArchiveRecentCronRunSchema),
}).superRefine((gap, ctx) => {
  const expected: SafetyScoreCaptureArchiveGapEvidenceSource[] = [
    ...(gap.journal === null ? [] : ["accepted-attempt-journal" as const]),
    ...(gap.recent_cron_runs.length === 0 ? [] : ["recent-cron" as const]),
  ];
  if (gap.evidence_sources.length !== expected.length || gap.evidence_sources.some((source, index) => source !== expected[index])) {
    ctx.addIssue({ code: "custom", path: ["evidence_sources"], message: "Gap provenance must name exactly the evidence sources present" });
  }
});
export type SafetyScoreCaptureArchiveGap = z.infer<typeof SafetyScoreCaptureArchiveGapSchema>;
export const SafetyScoreCaptureArchiveRecentCronEvidenceSchema = z.object({
  job: z.string().min(1),
  clock: z.literal("run-started-at"),
  window: z.object({ fromSec: unixSeconds, toSec: unixSeconds }).nullable(),
  retention: z.object({ sec: z.number().int().positive(), earliestRetainedSec: unixSeconds, observedAtSec: unixSeconds }),
  coverage: z.enum(["complete-window", "incomplete-window"]),
  rows: z.object({
    productive: z.number().int().nonnegative(),
    validGeneration: z.number().int().nonnegative(),
    archiveIndexed: z.number().int().nonnegative(),
    missingGeneration: z.number().int().nonnegative(),
    malformedGeneration: z.number().int().nonnegative(),
    gapGenerations: z.number().int().nonnegative(),
  }),
});
export type SafetyScoreCaptureArchiveRecentCronEvidence = z.infer<typeof SafetyScoreCaptureArchiveRecentCronEvidenceSchema>;

/**
 * Union journal and recent-cron evidence per generation. Journal page order is
 * `(published_at, generation_id, attempt_id)`, so the earliest retained accepted
 * attempt names each generation; repeated cron rows for one run collapse by
 * `run_id`. Nothing is invented: a cron-only gap has no publication clock,
 * identity digests or attempt.
 */
export function mergeArchiveGapEvidence(
  journal: readonly SafetyScoreCaptureArchiveJournalGap[],
  recentCron: readonly SafetyScoreCaptureArchiveCronGapEvidence[],
): SafetyScoreCaptureArchiveGap[] {
  const merged = new Map<string, { journal: SafetyScoreCaptureArchiveGap["journal"]; runs: Map<number, SafetyScoreCaptureArchiveRecentCronRun> }>();
  const entryFor = (generationId: string) => {
    let entry = merged.get(generationId);
    if (!entry) { entry = { journal: null, runs: new Map() }; merged.set(generationId, entry); }
    return entry;
  };
  for (const row of journal) {
    const entry = entryFor(row.generation_id);
    entry.journal ??= {
      published_at: row.published_at, methodology_version: row.methodology_version,
      policy_digest: row.policy_digest, evaluation_build_digest: row.evaluation_build_digest,
      attempt_id: row.attempt_id, attempted_at: row.attempted_at,
    };
  }
  for (const row of recentCron) {
    entryFor(row.generation_id).runs.set(row.run_id, { run_id: row.run_id, started_at: row.started_at, status: row.status });
  }
  const gaps = [...merged].map(([generationId, entry]) => ({
    generation_id: generationId,
    evidence_sources: SAFETY_SCORE_CAPTURE_ARCHIVE_GAP_EVIDENCE_SOURCES.filter(
      (source) => (source === "accepted-attempt-journal" ? entry.journal !== null : entry.runs.size > 0),
    ),
    journal: entry.journal,
    recent_cron_runs: [...entry.runs.values()].sort((left, right) => left.started_at - right.started_at || left.run_id - right.run_id),
  }));
  const firstClock = (gap: SafetyScoreCaptureArchiveGap): number =>
    gap.journal?.published_at ?? gap.recent_cron_runs[0]?.started_at ?? 0;
  gaps.sort((left, right) => firstClock(left) - firstClock(right)
    || (left.generation_id < right.generation_id ? -1 : left.generation_id > right.generation_id ? 1 : 0));
  return SafetyScoreCaptureArchiveGapSchema.array().parse(gaps);
}
export type ArchiveBoundary = { dateSec: number } | { field: "methodology_version" | "policy_digest" | "evaluation_build_digest"; identity: string };

export function parseArchiveDate(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error("Expected a UTC YYYY-MM-DD date");
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error("Invalid UTC date");
  return date.getTime() / 1000;
}

export function parseArchiveTimeBoundary(value: string): ArchiveBoundary {
  if (/^\d+$/u.test(value)) {
    const seconds = Number(value);
    if (!Number.isSafeInteger(seconds) || !Number.isFinite(new Date(seconds * 1000).getTime())) throw new Error("--before-time requires valid nonnegative Unix seconds");
    return { dateSec: seconds };
  }
  const prefix = value.slice(0, 19);
  const fraction = value.length === 20 ? "" : value.slice(20, -1);
  if (!value.endsWith("Z") || (value.length !== 20 && (value.length < 22 || value.length > 24)) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u.test(prefix) ||
      (value.length !== 20 && (value[19] !== "." || !/^\d{1,3}$/u.test(fraction)))) {
    throw new Error("--before-time requires Unix seconds or an ISO-8601 UTC timestamp ending in Z");
  }
  const date = new Date(value);
  const canonical = `${prefix}.${fraction.padEnd(3, "0")}Z`;
  if (!Number.isFinite(date.getTime()) || date.getTime() < 0 || date.toISOString() !== canonical) throw new Error("--before-time is not a valid UTC timestamp");
  return { dateSec: date.getTime() / 1000 };
}

export function parseArchiveBoundary(value: string): ArchiveBoundary {
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return { dateSec: parseArchiveDate(value) };
  const match = /^(methodology|policy|build):(.+)$/u.exec(value);
  if (!match) throw new Error("--before requires YYYY-MM-DD, methodology:<version>, policy:<sha256>, or build:<sha256>");
  const fields = { methodology: "methodology_version", policy: "policy_digest", build: "evaluation_build_digest" } as const;
  const kind = match[1] as keyof typeof fields;
  if (kind !== "methodology" && !/^[a-f0-9]{64}$/u.test(match[2]!)) throw new Error("Policy/build identity must be lowercase SHA-256");
  return { field: fields[kind], identity: match[2]! };
}

/** Most recent retained transition INTO the requested identity, never an inferred missing predecessor. */
export function resolveArchiveBoundary(rows: readonly SafetyScoreCaptureArchiveIndex[], boundary: ArchiveBoundary): SafetyScoreCaptureArchiveIndex | null {
  const ordered = [...rows].sort((a, b) => a.published_at - b.published_at || (a.generation_id < b.generation_id ? -1 : a.generation_id > b.generation_id ? 1 : 0));
  for (let index = ordered.length - 1; index >= 0; index--) {
    const current = ordered[index]!;
    if ("dateSec" in boundary) {
      if (current.published_at < boundary.dateSec) return current;
    } else if (index > 0 && current[boundary.field] === boundary.identity && ordered[index - 1]![boundary.field] !== boundary.identity) {
      return ordered[index - 1]!;
    }
  }
  return null;
}

export function archiveObjectKey(row: Pick<SafetyScoreCaptureArchiveIndex, "published_at" | "generation_id">): string {
  // Reject path separators before using an index identity in the offline filesystem path.
  if (!/^[A-Za-z0-9:_-]+$/u.test(row.generation_id)) throw new Error("Invalid archive generation path identity");
  return `captures/safety-score-v9-accepted/${new Date(row.published_at * 1000).toISOString().slice(0, 10)}/${row.generation_id}.json`;
}

export async function decodeArchiveExport(index: SafetyScoreCaptureArchiveIndex, bytes: Uint8Array) {
  if (createHash("sha256").update(bytes).digest("hex") !== index.object_sha256) throw new Error("capture-archive-sha256-mismatch");
  if (bytes.byteLength !== index.object_bytes) throw new Error("capture-archive-byte-length-mismatch");
  const object = SafetyScoreCaptureArchiveObjectSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
  if (object.generationId !== index.generation_id || object.publishedAt !== index.published_at ||
      object.methodologyVersion !== index.methodology_version || object.policyDigest !== index.policy_digest ||
      object.evaluationBuildDigest !== index.evaluation_build_digest || index.r2_key !== archiveObjectKey(index)) {
    throw new Error("capture-archive-index-identity-mismatch");
  }
  const cacheExport = [{ success: true as const, results: [object.base, object.delta].map((row) => ({
    key: row.key, value: row.value, updated_at: row.updatedAt,
  })) }];
  // Use the capture CLI's parser, including its paired-row timestamp contract.
  const rows = parseSafetyScoreV9PublicationReplayCacheRows(cacheExport);
  if (rows.retainedAtSec !== object.publishedAt || object.cards.updatedAt !== object.publishedAt) throw new Error("capture-archive-publication-clock-mismatch");
  const cards = await parseSafetyScoreV9Publication(object.cards.value);
  if (cards.publicationGenerationId !== object.generationId || cards.publishedAtSec !== object.publishedAt ||
      cards.policyVersion !== object.methodologyVersion || cards.policy.semanticDigest !== object.policyDigest ||
      cards.evaluationBuildDigest !== object.evaluationBuildDigest) throw new Error("capture-archive-cards-identity-mismatch");
  return { cacheExport, cards };
}
