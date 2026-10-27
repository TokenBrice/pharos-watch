import { z } from "zod";
import { isValidIsoDateOnly } from "./date-primitives";

// shared/types must stay dependency-free of shared/lib (ESLint pharos/shared-types-imports), so the
// record guard is local here rather than imported from @shared/lib/type-guards.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const DIGEST_SAFETY_MAP_TIERS = ["A", "B", "C", "D", "F"] as const;
export type DigestSafetyMapProfile = "canonical" | "archive-compatible";

export type DigestSafetyMapSummary = z.output<typeof DigestSafetyMapSummarySchema>;
export type DigestSafetyMapTierSummary = DigestSafetyMapSummary["tiers"][number];
export type DigestSafetyMapManifest = z.output<typeof CanonicalReaderManifestSchema> & {
  mapSummary?: DigestSafetyMapSummary;
};
export type DigestSafetyMapCapture = z.output<typeof DigestSafetyMapCaptureSchema>;
export type DigestSafetyMapArchiveCapture = z.output<typeof ArchiveReaderCaptureSchema>;
export type DigestSafetyMapArchiveTier = DigestSafetyMapArchiveCapture["manifest"]["mapSummary"]["tiers"][number];

export interface DigestSafetyMapContractIssue {
  path: (string | number)[];
  message: string;
}

export function parseDigestSafetyMapUtcDateMs(value: unknown): number | null {
  if (!isValidIsoDateOnly(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) ? parsed.getTime() : null;
}

/** Safety Map dates are UTC `YYYY-MM-DD` calendar days; that rule has one definition. */
const isDigestSafetyMapUtcDate = isValidIsoDateOnly;

function getDigestSafetyMapSummaryIssues(
  summary: Pick<DigestSafetyMapSummary, "gradedCount" | "totalMcapUsd"> & {
    tiers: Array<Pick<DigestSafetyMapTierSummary, "tier" | "count" | "mcapUsd" | "sharePct">>;
  },
): DigestSafetyMapContractIssue[] {
  const issues: DigestSafetyMapContractIssue[] = [];
  if (new Set(summary.tiers.map((tier) => tier.tier)).size !== DIGEST_SAFETY_MAP_TIERS.length) {
    issues.push({ path: ["tiers"], message: "Safety Map tiers must be unique and complete" });
  }
  if (summary.tiers.reduce((sum, tier) => sum + tier.count, 0) !== summary.gradedCount) {
    issues.push({ path: ["gradedCount"], message: "Safety Map tier counts must equal gradedCount" });
  }
  const tierMcapUsd = summary.tiers.reduce((sum, tier) => sum + tier.mcapUsd, 0);
  if (Math.abs(tierMcapUsd - summary.totalMcapUsd) > Math.max(0.01, summary.totalMcapUsd * 1e-9)) {
    issues.push({ path: ["totalMcapUsd"], message: "Safety Map tier supply must equal totalMcapUsd" });
  }
  summary.tiers.forEach((tier, index) => {
    const share = summary.totalMcapUsd === 0 ? 0 : (tier.mcapUsd / summary.totalMcapUsd) * 100;
    if (Math.abs(share - tier.sharePct) > 0.11) {
      issues.push({ path: ["tiers", index, "sharePct"], message: "Safety Map tier share must match tier supply" });
    }
  });
  return issues;
}

function getDigestSafetyMapCaptureIssues(capture: DigestSafetyMapCapture): DigestSafetyMapContractIssue[] {
  const issues: DigestSafetyMapContractIssue[] = [];
  if (capture.manifest.mapSummary.date !== capture.manifest.date) {
    issues.push({ path: ["manifest", "mapSummary", "date"], message: "Safety Map capture dates must match" });
  }
  if (capture.manifest.mapSummary.asOfSec !== capture.manifest.asOfSec) {
    issues.push({ path: ["manifest", "mapSummary", "asOfSec"], message: "Safety Map capture timestamps must match" });
  }
  if (capture.freshness === "current" && capture.ageDays !== 0) {
    issues.push({ path: ["ageDays"], message: "A current Safety Map capture must have ageDays 0" });
  }
  if (capture.freshness === "carried-forward" && capture.ageDays === 0) {
    issues.push({ path: ["ageDays"], message: "A carried-forward Safety Map capture must have positive ageDays" });
  }
  try {
    const imageUrl = new URL(capture.imageUrl);
    if (!imageUrl.pathname.endsWith("/safety-scores/map.png") || imageUrl.searchParams.get("date") !== capture.manifest.date) {
      issues.push({ path: ["imageUrl"], message: "Safety Map image URL must name the manifest date" });
    }
  } catch {
    issues.push({ path: ["imageUrl"], message: "Safety Map image URL must be absolute" });
  }
  return issues;
}

// PURE boundaries keep unused strict-schema construction out of reader-only bundles.
const mapFields = /* @__PURE__ */ (() => {
  const nonnegative = z.number().nonnegative();
  const integer = z.number().int().nonnegative();
  const text = z.string().trim().min(1);
  const coverage = z.object({
    complete: z.boolean(), observedCount: integer, unavailableCount: integer,
    unavailableById: z.record(z.string(), z.string()), shareBasis: z.literal("known-mapped-supply"),
  });
  const leader = z.object({ symbol: text, score: nonnegative.max(100), mcapUsd: nonnegative }).strict();
  const tier = z.object({
    tier: z.enum(DIGEST_SAFETY_MAP_TIERS), range: text, count: integer, mcapUsd: nonnegative,
    sharePct: nonnegative.max(100).describe("Percentage points, 0-100 scale (not a 0-1 ratio)"),
    leaders: z.array(leader).max(3),
  }).strict();
  return { nonnegative, integer, text, coverage, leader, tier };
})();

export const DigestSafetyMapUtcDateSchema = /* @__PURE__ */ (() => z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isDigestSafetyMapUtcDate, "Safety Map date must be a real UTC calendar day"))();

const summaryFields = /* @__PURE__ */ (() => ({
  date: DigestSafetyMapUtcDateSchema, asOfSec: mapFields.integer, methodologyVersion: mapFields.text,
  gradedCount: mapFields.integer, notRatedCount: mapFields.integer, totalMcapUsd: mapFields.nonnegative,
  supplyCoverage: mapFields.coverage.optional(),
  floorMcapByTier: z.object({ a: mapFields.nonnegative, other: mapFields.nonnegative }).strict(),
  tiers: z.array(mapFields.tier).length(5),
}))();

export const DigestSafetyMapSummarySchema = /* @__PURE__ */ (() => z.object(summaryFields).strict()
  .superRefine((summary, ctx) => {
    for (const issue of getDigestSafetyMapSummaryIssues(summary)) ctx.addIssue({ code: "custom", ...issue });
  }))();

const manifestFields = /* @__PURE__ */ (() => ({
  date: summaryFields.date, asOfSec: summaryFields.asOfSec, renderedAtSec: mapFields.integer,
  edition: z.literal("daily"), bytes: z.object({ png: z.number().positive() }).strict(),
}))();
const captureFields = /* @__PURE__ */ (() => ({
  imageUrl: mapFields.text, freshness: z.enum(["current", "carried-forward"]), ageDays: mapFields.integer,
}))();

export const DigestSafetyMapCaptureSchema = /* @__PURE__ */ (() => z.object({
  ...captureFields, manifest: z.object({ ...manifestFields, mapSummary: DigestSafetyMapSummarySchema }).strict(),
}).strict()
  .superRefine((capture, ctx) => {
    for (const issue of getDigestSafetyMapCaptureIssues(capture)) ctx.addIssue({ code: "custom", ...issue });
  }))();

const readerText = /* @__PURE__ */ (() => z.string().refine((value) => value.trim().length > 0))();
// Readers historically used Number.isInteger, not Zod's stricter safe-integer bound.
const readerInteger = /* @__PURE__ */ (() => mapFields.nonnegative.refine(Number.isInteger))();
const readerCoverage = /* @__PURE__ */ (() => mapFields.coverage.extend({
  observedCount: readerInteger, unavailableCount: readerInteger,
  // Legacy JSON readers accepted array-shaped reason records too; preserve that admission.
  unavailableById: z.custom<Record<string, string>>((value) => isRecord(value)
    && Object.values(value).every((reason) => typeof reason === "string")),
}).refine((coverage) => coverage.complete === (coverage.unavailableCount === 0)
  && isRecord(coverage.unavailableById) && Object.keys(coverage.unavailableById).length === coverage.unavailableCount))();
const readerSummaryFields = /* @__PURE__ */ (() => ({
  ...summaryFields, methodologyVersion: readerText, supplyCoverage: readerCoverage.optional(),
  asOfSec: readerInteger, gradedCount: readerInteger, notRatedCount: readerInteger,
}))();
const archiveTierSchema = /* @__PURE__ */ (() => mapFields.tier.pick({
  tier: true, count: true, mcapUsd: true, sharePct: true,
}).strip().extend({ count: readerInteger }))();
const archiveSummarySchema = /* @__PURE__ */ (() => z.object({
  ...readerSummaryFields, totalMcapUsd: summaryFields.totalMcapUsd.positive(),
  tiers: z.array(archiveTierSchema).length(5),
}).omit({ floorMcapByTier: true }))();
const canonicalSummarySchema = /* @__PURE__ */ (() => z.object({
  ...readerSummaryFields,
  floorMcapByTier: summaryFields.floorMcapByTier.strip(),
  tiers: z.array(mapFields.tier.extend({
    range: readerText, count: readerInteger,
    leaders: z.array(mapFields.leader.extend({ symbol: readerText }).strip()).max(3),
  }).strip()).length(5),
}))();

function refineReaderSummary(
  summary: Pick<DigestSafetyMapSummary, "gradedCount" | "totalMcapUsd" | "tiers" | "supplyCoverage">
    | z.output<typeof archiveSummarySchema>,
  ctx: z.RefinementCtx,
) {
  for (const issue of getDigestSafetyMapSummaryIssues(summary)) ctx.addIssue({ code: "custom", ...issue });
  if (summary.supplyCoverage && summary.supplyCoverage.observedCount + summary.supplyCoverage.unavailableCount !== summary.gradedCount) {
    ctx.addIssue({ code: "custom", path: ["supplyCoverage"], message: "Safety Map coverage must equal gradedCount" });
  }
}

const CanonicalReaderSummarySchema = /* @__PURE__ */ (() => canonicalSummarySchema.superRefine(refineReaderSummary)
  .transform(({ supplyCoverage, ...summary }) => ({ ...summary, ...(supplyCoverage ? { supplyCoverage } : {}) })))();
const ArchiveReaderSummarySchema = /* @__PURE__ */ (() => archiveSummarySchema.superRefine(refineReaderSummary)
  .transform(({ supplyCoverage, ...summary }) => ({ ...summary, ...(supplyCoverage ? { supplyCoverage } : {}) })))();
const CanonicalReaderManifestSchema = /* @__PURE__ */ (() => z.object({
  ...manifestFields, asOfSec: z.number(), renderedAtSec: z.number(), bytes: manifestFields.bytes.strip(),
}))();
const archiveCaptureFields = /* @__PURE__ */ (() => ({
  imageUrl: readerText, freshness: captureFields.freshness, ageDays: readerInteger.optional(),
  manifest: z.object({ date: summaryFields.date, mapSummary: ArchiveReaderSummarySchema }),
}))();
const ArchiveReaderCaptureSchema = /* @__PURE__ */ (() => z.object(archiveCaptureFields).transform((capture) => ({
  ...capture, ageDays: capture.ageDays ?? null,
})))();
const CanonicalReaderCaptureSchema = /* @__PURE__ */ (() => z.object({
  ...captureFields, imageUrl: readerText, ageDays: readerInteger,
  manifest: z.object({
    ...manifestFields, asOfSec: readerInteger, renderedAtSec: readerInteger,
    bytes: manifestFields.bytes.strip(), mapSummary: CanonicalReaderSummarySchema,
  }),
}).superRefine((capture, ctx) => {
  for (const issue of getDigestSafetyMapCaptureIssues(capture)) ctx.addIssue({ code: "custom", ...issue });
}))();

export function parseDigestSafetyMapSummary(value: unknown, profile: "canonical"): DigestSafetyMapSummary | null;
export function parseDigestSafetyMapSummary(value: unknown, profile: "archive-compatible"): DigestSafetyMapArchiveCapture["manifest"]["mapSummary"] | null;
export function parseDigestSafetyMapSummary(value: unknown, profile: DigestSafetyMapProfile) {
  const result = (profile === "canonical" ? CanonicalReaderSummarySchema : ArchiveReaderSummarySchema).safeParse(value);
  return result.success ? result.data : null;
}

export function parseDigestSafetyMapManifest(value: unknown, _profile: "canonical"): DigestSafetyMapManifest | null {
  const result = CanonicalReaderManifestSchema.safeParse(value);
  if (!result.success) return null;
  const summary = isRecord(value) ? parseDigestSafetyMapSummary(value.mapSummary, "canonical") : null;
  return summary && summary.date === result.data.date && summary.asOfSec === result.data.asOfSec
    ? { ...result.data, mapSummary: summary }
    : result.data;
}

export function parseDigestSafetyMapCapture(value: unknown, profile: "archive-compatible"): DigestSafetyMapArchiveCapture | null;
export function parseDigestSafetyMapCapture(value: unknown, profile: "canonical"): DigestSafetyMapCapture | null;
export function parseDigestSafetyMapCapture(value: unknown, profile: DigestSafetyMapProfile) {
  if (profile === "canonical") {
    const result = CanonicalReaderCaptureSchema.safeParse(value);
    return result.success ? result.data : null;
  }
  if (!isRecord(value) || !isRecord(value.manifest)) return null;
  const result = ArchiveReaderCaptureSchema.safeParse({
    ...value, manifest: { ...value.manifest, mapSummary: value.manifest.mapSummary ?? value.mapSummary ?? value.summary },
  });
  if (!result.success || result.data.manifest.date !== result.data.manifest.mapSummary.date) return null;
  try {
    const url = new URL(result.data.imageUrl, "https://pharos.watch");
    return url.pathname.endsWith("/safety-scores/map.png") && url.searchParams.get("date") === result.data.manifest.date
      ? result.data : null;
  } catch { return null; }
}
