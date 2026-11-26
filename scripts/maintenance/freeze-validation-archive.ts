#!/usr/bin/env tsx
// Boundary waiver: validation-archive-v9-capture-decode. See docs/process/boundary-waivers.md.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import { compareCodeUnits } from "@shared/lib/compare";
import { GENIUS_REGIME_STATE } from "@shared/lib/compliance-regime-state";
import {
  GENIUS_APPLICABILITY_VALUES,
  GENIUS_AUTHORIZATION_STATUS_VALUES,
  GENIUS_DASP_OFFER_SALE_STATUS_VALUES,
  GENIUS_ENFORCEMENT_STATUS_VALUES,
  GENIUS_FOREIGN_EXCEPTION_STATUS_VALUES,
  GENIUS_ISSUER_PATHWAY_VALUES,
  GENIUS_PRIMARY_FEDERAL_REGULATOR_VALUES,
  MICA_STATUS_VALUES,
} from "@shared/types/compliance-vocabulary";
import { Sha256Schema, StrictIsoDateSchema } from "@shared/types/safety-schema-primitives";
import { SafetyScoreV9PublicationIdentitySchema } from "@shared/types/safety-score-publication";
import { V9GradeSchema } from "@shared/types/safety-score-v9";
import { V9RatingStatusSchema } from "@shared/types/safety-score-v9-causes";
import { MicaProfileSchema } from "@shared/types/stablecoin-meta-compliance-schemas";
import {
  archiveObjectKey,
  decodeSafetyScoreCaptureArchiveObject,
} from "../../worker/src/lib/safety-score-v9/capture-archive-contract";
import { buildComplianceRegistryOutput } from "../build-data/build-client-registry.mjs";
import {
  CliUsageError,
  parseStrictCliArgs,
  runDirectCli,
  writeCliHelpIfRequested,
  writeFileResolved,
} from "../lib/cli-args.mjs";
import { createR2MeasurementsClient } from "../lib/r2-measurements-client";
import { R2ObjectExistsError, type R2ObjectClient, type R2PutOptions } from "../lib/r2-object-client";
import { createD1Client, decodeD1Envelopes, type D1Client } from "../lib/remote-d1";
import { loadPerCoinStablecoinEntries } from "../lib/stablecoin-catalog-sources";
import { fetchWithRetry } from "../lib/sync-from-api";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DESIGN_DOC_REPO_PATH = "docs/process/pre-cliff-baseline.md";
const DEFAULT_DESIGN_DOC_PATH = resolve(REPO_ROOT, DESIGN_DOC_REPO_PATH);
const SEAL_TRACKED_PATHS = [
  DESIGN_DOC_REPO_PATH,
  "shared/data/stablecoins/",
  "shared/lib/compliance-regime-state.ts",
] as const;
export const TRUSTED_PROD_API_ORIGIN = "https://api.pharos.watch";
const DEFAULT_API_BASE = TRUSTED_PROD_API_ORIGIN;
const DEFAULT_PROD_D1_DATABASE = "stablecoin-db";
const PAGE_SIZE = 1_000;
const BASELINE_SNAPSHOT_WINDOW_DAYS = 14;
const REQUIRED_BASELINE_ENDPOINT_ROLES = ["peg-summary", "dex-liquidity", "report-cards-v9"] as const;

export const VALIDATION_ARCHIVE_PREFIX = "pinned/validation/";
export const PRE_CLIFF_BASELINE_MAX_DATE = "2026-12-31" as const;
export const MICA_CLIFF_EVENT_DATE = "2027-01-08" as const;
export const GENIUS_CLIFF_EVENT_DATE = "2027-01-18" as const;
/** Minimum seconds past 23:59:59Z before a completed UTC day may be rolled. */
export const ROLL_DAY_END_GRACE_SEC = 15 * 60;
/** `reserve_composition_history` and `reserve_sync_attempt_history` prune window in D1 (30 days).
 * `report_card_evidence_journal` has no active production writer since ef1052443 (dormant archival table). */
export const RESERVE_HISTORY_RETENTION_DAYS = 30;
export const RESERVE_HISTORY_RETENTION_SEC = RESERVE_HISTORY_RETENTION_DAYS * 86_400;
export const MAX_ROLL_RANGE_DAYS = 180;
export const VENUES_REVIEWED_AT = "2026-11-26" as const;

const USAGE = `Usage: npx tsx scripts/maintenance/freeze-validation-archive.ts <mode> [options]
  baseline --date YYYY-MM-DD [--seal] [--dry-run] [--allow-partial] [--out <path>] [--prefix <pinned/validation/...>] [--api-base <url>]
  roll     [--date YYYY-MM-DD | --from YYYY-MM-DD --to YYYY-MM-DD] [--dry-run] [--allow-partial] [--prefix <pinned/validation/...>] [--database <name>] [--local]
  verify   [--prefix <pinned/validation/...> | --manifest <r2Key>] [--allow-partial]

Notes:
  - Writes strictly under pinned/validation/... (never captures/) with If-None-Match: *.
  - Payload PUTs resume safely on identical SHA-256/byte-length; manifest collisions are fatal.
  - baseline --seal fails closed unless date <= ${PRE_CLIFF_BASELINE_MAX_DATE}, date matches actual UTC capture date,
    API origin is ${TRUSTED_PROD_API_ORIGIN} (redirect: "error"), all 14 dated snapshots + 3 endpoints pass contract validation
    with valid safetyScoreIdentity, and tracked design/compliance/regime files match HEAD.
    Run after daily-0800 (08:00 UTC) so the seal-day /api/snapshots/<date>.json exists.
    --dry-run cannot be combined with --out.
    Partial seals (--allow-partial) are refused on any canonical pre-cliff-YYYY-MM/ or rolling/ prefix; pass a non-canonical --prefix (e.g. pinned/validation/partial/...).
  - roll enforces day-end + 15m grace and 30-day reserve_composition_history D1 retention,
    forces --dry-run on --local or non-default --database, skips already-sealed days in --from/--to range mode,
    decodes V9 captures via capture-archive-contract, exports dormant report_card_evidence_journal rows if present,
    content-addresses live markets/eligibility under observedDate distinct from D1 export day (recovering prior-day live captures on post-midnight retry),
    and refuses partial non-dry-run seals on any canonical pre-cliff-YYYY-MM/ or rolling/ prefix.
  - verify requires design doc verification at manifest gitSha (never falls back to working tree),
    verifies every successful regionalEligibility[].r2Key appears in objects[],
    and rejects partial: true manifests unless --allow-partial is passed.
  - Credentials:
      R2_MEASUREMENTS_ACCESS_KEY_ID, R2_MEASUREMENTS_SECRET_ACCESS_KEY, CLOUDFLARE_ACCOUNT_ID (for R2 operations);
      PHAROS_API_KEY is REQUIRED for baseline (all 4 Pharos endpoints require X-API-Key; attached strictly to ${TRUSTED_PROD_API_ORIGIN}).
`;

const DateYmdSchema = StrictIsoDateSchema;
const IsoUtcSchema = z.string().datetime().refine((value) => {
  const datePart = value.slice(0, 10);
  if (!StrictIsoDateSchema.safeParse(datePart).success) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === datePart;
}, "Expected strict UTC ISO-8601");

export const MicaCohortSchema = z.enum([...MICA_STATUS_VALUES, "unassessed"]);
export type MicaCohort = z.output<typeof MicaCohortSchema>;

export const GeniusCohortSchema = z.enum([...GENIUS_AUTHORIZATION_STATUS_VALUES, "unassessed"]);
export type GeniusCohort = z.output<typeof GeniusCohortSchema>;

const GeniusRegimeStateSchema = z.object({
  publicLawDate: DateYmdSchema,
  finalRulesIssuedAt: DateYmdSchema.optional(),
  statutoryFallbackEffectiveDate: DateYmdSchema,
  effectiveDate: DateYmdSchema,
  rulemakingPhase: z.enum(["pre-rulemaking", "proposed-rules", "final-rules-issued", "effective"]),
  sourceLabel: z.string().min(1),
  sourceUrl: z.string().url(),
  sourceReferences: z.array(z.object({ label: z.string().min(1), url: z.string().url() }).strict()).optional(),
  reviewedAt: DateYmdSchema,
}).strict();

const GeniusComplianceSummarySchema = z.object({
  applicability: z.enum(GENIUS_APPLICABILITY_VALUES),
  authorizationStatus: z.enum(GENIUS_AUTHORIZATION_STATUS_VALUES),
  issuerPathway: z.enum(GENIUS_ISSUER_PATHWAY_VALUES),
  issuerEntity: z.string().min(1).optional(),
  issuerDomicile: z.string().min(1).optional(),
  licensingRegulator: z.string().min(1).optional(),
  primaryFederalRegulator: z.enum(GENIUS_PRIMARY_FEDERAL_REGULATOR_VALUES).optional(),
  stateRegulator: z.string().min(1).optional(),
  foreignExceptionStatus: z.enum(GENIUS_FOREIGN_EXCEPTION_STATUS_VALUES).optional(),
  foreignExceptionEvidence: z.object({
    summary: z.string().min(1),
    references: z.array(z.record(z.string(), z.unknown())).optional(),
  }).strict().optional(),
  enforcementStatus: z.enum(GENIUS_ENFORCEMENT_STATUS_VALUES).optional(),
  daspOfferSaleStatus: z.enum(GENIUS_DASP_OFFER_SALE_STATUS_VALUES).optional(),
  reserveDisclosurePresent: z.boolean().optional(),
  reserveDisclosureUrl: z.string().url().optional(),
  redemptionPolicyPresent: z.boolean().optional(),
  monthlyAttestationPresent: z.boolean().optional(),
  reviewer: z.string().min(1).optional(),
  reviewedAt: DateYmdSchema.optional(),
}).strict();

export const ComplianceSnapshotEntrySchema = z.object({
  id: z.string().min(1),
  mica: MicaProfileSchema.nullable(),
  genius: GeniusComplianceSummarySchema.nullable(),
}).strict();
export type ComplianceSnapshotEntry = z.output<typeof ComplianceSnapshotEntrySchema>;

export const PreCliffCohortRowSchema = z.object({
  id: z.string().min(1),
  mica: MicaCohortSchema,
  genius: GeniusCohortSchema,
}).strict();
export type PreCliffCohortRow = z.output<typeof PreCliffCohortRowSchema>;

export const VenueRecordSchema = z.object({
  venueId: z.string().min(1),
  kind: z.enum(["cex", "dex", "regulator", "issuer-notice", "eligibility-notice"]),
  legalEntity: z.string().min(1).nullable(),
  jurisdictionTags: z.array(z.enum(["global", "EEA", "US", "permissionless"])).min(1),
  sourceUrl: z.string().url(),
  reviewedAt: DateYmdSchema,
}).strict();
export type VenueRecord = z.output<typeof VenueRecordSchema>;

export const MarketDepthRowSchema = z.object({
  id: z.string().min(1),
  venueId: z.enum(["kraken-global", "coinbase-global"]),
  pair: z.string().min(1),
  quoteCurrency: z.enum(["USD", "EUR", "USDC"]),
  listed: z.boolean().nullable(),
  bidDepthQuote1pct: z.number().finite().nonnegative().nullable(),
  askDepthQuote1pct: z.number().finite().nonnegative().nullable(),
  bidDepthUsd1pct: z.number().finite().nonnegative().nullable(),
  askDepthUsd1pct: z.number().finite().nonnegative().nullable(),
  bidDepthTruncated: z.boolean().nullable(),
  askDepthTruncated: z.boolean().nullable(),
  fxRate: z.number().finite().positive().nullable(),
  fxSource: z.string().min(1).nullable(),
  fxObservedAt: IsoUtcSchema.nullable(),
  unavailableReason: z.string().min(1).nullable(),
}).strict().superRefine((row, ctx) => {
  const missingUsd = row.bidDepthUsd1pct === null || row.askDepthUsd1pct === null;
  if (missingUsd && row.unavailableReason === null) {
    ctx.addIssue({ code: "custom", path: ["unavailableReason"], message: "Missing USD depth requires unavailableReason" });
  }
  if (!missingUsd && row.unavailableReason !== null) {
    ctx.addIssue({ code: "custom", path: ["unavailableReason"], message: "Observed USD depth cannot carry unavailableReason" });
  }
  if (row.quoteCurrency !== "USD" && row.fxRate === null && !missingUsd) {
    ctx.addIssue({ code: "custom", path: ["fxRate"], message: "Non-USD quote depth requires observed fxRate for USD conversion" });
  }
  if (row.listed === false && !missingUsd) {
    ctx.addIssue({ code: "custom", path: ["listed"], message: "Unlisted pair cannot report observed depth" });
  }
});
export type MarketDepthRow = z.output<typeof MarketDepthRowSchema>;

export const RegionalEligibilityObservationSchema = z.object({
  sourceId: z.string().min(1),
  venueId: z.string().min(1),
  jurisdiction: z.enum(["EEA", "US"]),
  sourceUrl: z.string().url(),
  observedAt: IsoUtcSchema,
  status: z.enum(["ok", "unavailable"]),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  bodySha256: Sha256Schema.nullable(),
  bytes: z.number().int().nonnegative().safe().nullable(),
  r2Key: z.string().min(1).refine((key) => isValidationArchiveKey(key), {
    message: `r2Key must be a relative key under ${VALIDATION_ARCHIVE_PREFIX}`,
  }).nullable(),
  restrictedSymbols: z.array(z.string().min(1)).nullable(),
  unavailableReason: z.string().min(1).nullable(),
}).strict().superRefine((obs, ctx) => {
  if (obs.status === "ok") {
    if (obs.r2Key === null || obs.bytes === null || obs.bodySha256 === null) {
      ctx.addIssue({ code: "custom", message: "status=ok regionalEligibility requires non-null r2Key, bytes, and bodySha256" });
    }
  } else if (obs.r2Key !== null || obs.bytes !== null || obs.bodySha256 !== null) {
    ctx.addIssue({ code: "custom", message: "status=unavailable regionalEligibility cannot reference r2Key, bytes, or bodySha256" });
  }
});
export type RegionalEligibilityObservation = z.output<typeof RegionalEligibilityObservationSchema>;

export const ArchiveObjectEntrySchema = z.object({
  role: z.string().min(1),
  date: DateYmdSchema.optional(),
  observedDate: DateYmdSchema.optional(),
  sha256: Sha256Schema,
  bytes: z.number().int().nonnegative().safe(),
  r2Key: z.string().min(1).refine((key) => isValidationArchiveKey(key), {
    message: `r2Key must be a relative key under ${VALIDATION_ARCHIVE_PREFIX}`,
  }),
}).strict();
export type ArchiveObjectEntry = z.output<typeof ArchiveObjectEntrySchema>;

export const SkippedArchiveEntrySchema = z.object({
  role: z.string().min(1),
  date: DateYmdSchema.optional(),
  reason: z.string().min(1),
}).strict();
export type SkippedArchiveEntry = z.output<typeof SkippedArchiveEntrySchema>;

export const PreCliffBaselineManifestSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("pre-cliff-baseline"),
  apiBase: z.string().url(),
  baselineDate: DateYmdSchema,
  capturedDate: DateYmdSchema,
  capturedAt: IsoUtcSchema,
  gitSha: z.string().regex(/^[0-9a-f]{7,40}$/i),
  designSha256: Sha256Schema,
  partial: z.boolean(),
  safetyScoreIdentity: SafetyScoreV9PublicationIdentitySchema.nullable(),
  regimes: z.object({
    genius: GeniusRegimeStateSchema,
    micaEvent: z.literal(MICA_CLIFF_EVENT_DATE),
    geniusEvent: z.literal(GENIUS_CLIFF_EVENT_DATE),
  }).strict(),
  compliance: z.array(ComplianceSnapshotEntrySchema),
  cohorts: z.array(PreCliffCohortRowSchema),
  venues: z.array(VenueRecordSchema),
  markets: z.array(MarketDepthRowSchema),
  regionalEligibility: z.array(RegionalEligibilityObservationSchema),
  objects: z.array(ArchiveObjectEntrySchema),
  skipped: z.array(SkippedArchiveEntrySchema),
}).strict();
export type PreCliffBaselineManifest = z.output<typeof PreCliffBaselineManifestSchema>;

export const RollingDayManifestSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("rolling-validation-day"),
  day: DateYmdSchema,
  observedDate: DateYmdSchema.nullable(),
  capturedAt: IsoUtcSchema,
  partial: z.boolean(),
  rowCounts: z.record(z.string().min(1), z.number().int().nonnegative().safe()),
  objects: z.array(ArchiveObjectEntrySchema),
  skippedFamilies: z.array(z.object({ role: z.string().min(1), reason: z.string().min(1) }).strict()),
}).strict();
export type RollingDayManifest = z.output<typeof RollingDayManifestSchema>;

const RollingMarketsPayloadSchema = z.object({
  exportDay: DateYmdSchema,
  observedDate: DateYmdSchema,
  observedAt: IsoUtcSchema,
  markets: z.array(MarketDepthRowSchema).min(1),
  regionalEligibility: z.array(RegionalEligibilityObservationSchema).min(1),
}).strict();

export interface ValidationArchiveR2Client extends R2ObjectClient {
  list?(prefix: string): Promise<string[]>;
}

export interface ComplianceRowInput {
  id: string;
  mica?: { status: z.output<typeof MicaProfileSchema>["status"] } | null;
  genius?: { authorizationStatus: z.output<typeof GeniusComplianceSummarySchema>["authorizationStatus"] } | null;
}

export interface AcceptedCaptureIndexRow {
  generation_id: string;
  published_at: number;
  methodology_version: string;
  policy_digest: string;
  evaluation_build_digest: string;
  r2_key: string;
  object_sha256: string;
  object_bytes: number;
}

export interface VerifyArchiveFailure {
  r2Key: string;
  reason:
    | "missing"
    | "byte-length-mismatch"
    | "sha256-mismatch"
    | "malformed-manifest"
    | "incomplete-baseline"
    | "incomplete-roll"
    | "partial-archive-not-complete"
    | "design-doc-unverifiable-at-git-sha"
    | "design-sha256-mismatch";
  expectedSha256: string;
  actualSha256: string | null;
  expectedBytes: number;
  actualBytes: number | null;
  detail?: string;
}

export interface VerifyArchiveResult {
  ok: boolean;
  partial?: boolean;
  checked: number;
  failures: VerifyArchiveFailure[];
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isValidationArchiveKey(key: string): boolean {
  if (!key || key !== key.trim() || !key.startsWith(VALIDATION_ARCHIVE_PREFIX) || key.includes("\\")) return false;
  return key.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

export function assertValidationArchiveKey(key: string): string {
  if (!isValidationArchiveKey(key)) {
    throw new Error(`Refusing R2 key outside ${VALIDATION_ARCHIVE_PREFIX}: ${key}`);
  }
  return key;
}

export function assertValidationArchivePrefix(prefix: string): string {
  if (!prefix || prefix !== prefix.trim() || !prefix.startsWith(VALIDATION_ARCHIVE_PREFIX) || prefix.includes("//") || prefix.includes("\\")) {
    throw new CliUsageError(`Prefix must stay strictly under ${VALIDATION_ARCHIVE_PREFIX}: ${prefix}`);
  }
  const normalized = prefix.endsWith("/") ? prefix : `${prefix}/`;
  try {
    assertValidationArchiveKey(`${normalized}manifest.json`);
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error));
  }
  return normalized;
}

export function computeDesignSha256(designDocPath = DEFAULT_DESIGN_DOC_PATH): string {
  return sha256Hex(readFileSync(designDocPath));
}

function readGitDesignDoc(gitRef: string): Buffer | null {
  try {
    return execFileSync("git", ["show", `${gitRef}:${DESIGN_DOC_REPO_PATH}`], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function defaultCheckDirtySealPaths(): string[] {
  const out = execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=all", "--", ...SEAL_TRACKED_PATHS],
    { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Classify MiCA and GENIUS pre-cliff cohorts from compliance sidecars.
 * Absent rows stay explicitly `unassessed` and are never coerced to `non-compliant`.
 */
export function classifyPreCliffCohorts(
  complianceRows: readonly ComplianceRowInput[],
  universeIds?: readonly string[],
): PreCliffCohortRow[] {
  const byId = new Map(complianceRows.map((row) => [row.id, row] as const));
  const ids = [...new Set(universeIds ?? complianceRows.map((row) => row.id))].sort(compareCodeUnits);
  return ids.map((id) => {
    const row = byId.get(id);
    return PreCliffCohortRowSchema.parse({
      id,
      mica: row?.mica?.status ?? "unassessed",
      genius: row?.genius?.authorizationStatus ?? "unassessed",
    });
  });
}

export function countPreCliffCohorts(cohorts: readonly PreCliffCohortRow[]): {
  mica: Record<string, number>;
  genius: Record<string, number>;
} {
  const mica: Record<string, number> = {};
  const genius: Record<string, number> = {};
  for (const row of cohorts) {
    mica[row.mica] = (mica[row.mica] ?? 0) + 1;
    genius[row.genius] = (genius[row.genius] ?? 0) + 1;
  }
  return { mica, genius };
}

/**
 * M4 locked rule: select strictly the first accepted V9 capture per UTC day,
 * ordered by earliest `published_at` with code-unit `generation_id` tie-break.
 */
export function selectDailyFirstAcceptedCaptures<T extends Pick<AcceptedCaptureIndexRow, "generation_id" | "published_at">>(
  rows: readonly T[],
): Array<{ day: string; capture: T }> {
  const byDay = new Map<string, T>();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.published_at) || row.published_at < 0) continue;
    const day = new Date(row.published_at * 1_000).toISOString().slice(0, 10);
    const current = byDay.get(day);
    if (
      !current ||
      row.published_at < current.published_at ||
      (row.published_at === current.published_at && compareCodeUnits(row.generation_id, current.generation_id) < 0)
    ) {
      byDay.set(day, row);
    }
  }
  return [...byDay.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([day, capture]) => ({ day, capture }));
}

/**
 * Immutable write under `pinned/validation/...` with forced `If-None-Match: *`.
 * When `allowIdenticalReuse` is true (payload objects only), a collision triggers
 * a GET readback and succeeds only if byteLength and SHA-256 match identically.
 * Manifest writes keep `allowIdenticalReuse: false` so collisions stay fatal.
 */
export async function sealArchiveObject(
  client: Pick<R2ObjectClient, "put" | "get">,
  key: string,
  body: Uint8Array,
  options: Omit<R2PutOptions, "ifNoneMatch"> & { allowIdenticalReuse?: boolean } = {},
): Promise<{ r2Key: string; sha256: string; bytes: number; reused: boolean }> {
  const safeKey = assertValidationArchiveKey(key);
  const { allowIdenticalReuse = false, ...putOptions } = options;
  const expectedSha256 = sha256Hex(body);
  try {
    await client.put(safeKey, body, { ...putOptions, ifNoneMatch: "*" });
    return { r2Key: safeKey, sha256: expectedSha256, bytes: body.byteLength, reused: false };
  } catch (error) {
    if (!(error instanceof R2ObjectExistsError) || !allowIdenticalReuse) throw error;
    const existing = await client.get(safeKey);
    if (existing === null) {
      throw new Error(`R2 collision on ${safeKey} but verification GET returned null`);
    }
    const actualSha256 = sha256Hex(existing);
    if (existing.byteLength !== body.byteLength || actualSha256 !== expectedSha256) {
      throw new Error(
        `Existing R2 payload mismatch on ${safeKey}: expected ${body.byteLength}B/${expectedSha256}, got ${existing.byteLength}B/${actualSha256}`,
      );
    }
    return { r2Key: safeKey, sha256: expectedSha256, bytes: body.byteLength, reused: true };
  }
}

function isCanonicalValidationPrefix(prefix: string): boolean {
  return prefix.startsWith(`${VALIDATION_ARCHIVE_PREFIX}rolling/`)
    || /^pinned\/validation\/pre-cliff-\d{4}-\d{2}\//.test(prefix);
}

export function collectBaselineCompletenessIssues(
  manifest: Pick<PreCliffBaselineManifest, "baselineDate" | "partial" | "safetyScoreIdentity" | "objects" | "skipped"> & {
    regionalEligibility?: readonly RegionalEligibilityObservation[];
  },
): string[] {
  const issues: string[] = [];
  const objectKeys = new Set(manifest.objects.map((obj) => obj.r2Key));
  for (const obs of manifest.regionalEligibility ?? []) {
    if (obs.status === "ok" && obs.r2Key === null) {
      issues.push(`missing r2Key on regionalEligibility:${obs.sourceId}`);
    } else if (obs.r2Key !== null && !objectKeys.has(obs.r2Key)) {
      issues.push(`missing regionalEligibility object:${obs.sourceId}:${obs.r2Key}`);
    }
  }
  if (manifest.partial) return issues;
  const snapshotDates = new Set(
    manifest.objects.filter((obj) => obj.role === "public-snapshot" && obj.date).map((obj) => obj.date!),
  );
  for (let offset = BASELINE_SNAPSHOT_WINDOW_DAYS - 1; offset >= 0; offset -= 1) {
    const expectedDate = addUtcDays(manifest.baselineDate, -offset);
    if (!snapshotDates.has(expectedDate)) issues.push(`missing public-snapshot:${expectedDate}`);
  }
  const roles = new Set(manifest.objects.map((obj) => obj.role));
  for (const role of REQUIRED_BASELINE_ENDPOINT_ROLES) {
    if (!roles.has(role)) issues.push(`missing ${role}`);
  }
  if (manifest.safetyScoreIdentity === null) issues.push("missing safetyScoreIdentity");
  if (manifest.skipped.length > 0) issues.push(`non-empty skipped (${manifest.skipped.length})`);
  return issues;
}

export function collectRollingCompletenessIssues(
  manifest: Pick<RollingDayManifest, "partial" | "observedDate" | "objects" | "skippedFamilies">,
): string[] {
  if (manifest.partial) return [];
  const issues: string[] = [];
  const roles = new Set(manifest.objects.map((obj) => obj.role));
  for (const role of ["reserve-composition-history", "v9-accepted"] as const) {
    if (!roles.has(role)) issues.push(`missing ${role}`);
  }
  const marketsObj = manifest.objects.find((obj) => obj.role === "markets");
  if (!marketsObj) {
    const historicalSkip = manifest.skippedFamilies.some(
      (entry) => entry.role === "markets" && entry.reason === "historical-day-no-live-orderbook",
    );
    if (!historicalSkip) issues.push("missing markets");
  } else if (manifest.observedDate === null || marketsObj.observedDate !== manifest.observedDate) {
    issues.push("markets object missing matching observedDate");
  }
  for (const skipped of manifest.skippedFamilies) {
    if (!(skipped.role === "markets" && skipped.reason === "historical-day-no-live-orderbook")) {
      issues.push(`unexpected skip ${skipped.role}:${skipped.reason}`);
    }
  }
  return issues;
}

/** Re-GET every listed R2 object in a manifest and verify exact byte count and SHA-256. */
export async function verifyArchiveManifest(
  client: Pick<R2ObjectClient, "get">,
  manifest: { objects: readonly ArchiveObjectEntry[] },
): Promise<VerifyArchiveResult> {
  const failures: VerifyArchiveFailure[] = [];
  for (const entry of manifest.objects) {
    const bytes = await client.get(entry.r2Key);
    if (bytes === null) {
      failures.push({
        r2Key: entry.r2Key,
        reason: "missing",
        expectedSha256: entry.sha256,
        actualSha256: null,
        expectedBytes: entry.bytes,
        actualBytes: null,
      });
      continue;
    }
    const actualSha256 = sha256Hex(bytes);
    if (bytes.byteLength !== entry.bytes) {
      failures.push({
        r2Key: entry.r2Key,
        reason: "byte-length-mismatch",
        expectedSha256: entry.sha256,
        actualSha256,
        expectedBytes: entry.bytes,
        actualBytes: bytes.byteLength,
      });
      continue;
    }
    if (actualSha256 !== entry.sha256) {
      failures.push({
        r2Key: entry.r2Key,
        reason: "sha256-mismatch",
        expectedSha256: entry.sha256,
        actualSha256,
        expectedBytes: entry.bytes,
        actualBytes: bytes.byteLength,
      });
    }
  }
  return { ok: failures.length === 0, checked: manifest.objects.length, failures };
}

function parseUtcDayStartSec(ymd: string): number {
  if (!DateYmdSchema.safeParse(ymd).success) throw new CliUsageError(`Invalid date: ${ymd} (expected YYYY-MM-DD)`);
  const parsed = new Date(`${ymd}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== ymd) {
    throw new CliUsageError(`Non-calendar UTC date: ${ymd}`);
  }
  return Math.floor(parsed.getTime() / 1_000);
}

function addUtcDays(ymd: string, deltaDays: number): string {
  const startSec = parseUtcDayStartSec(ymd);
  return new Date((startSec + deltaDays * 86_400) * 1_000).toISOString().slice(0, 10);
}

function defaultPreviousUtcDay(now: Date): string {
  return new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
}

function buildStaticVenues(): VenueRecord[] {
  return [
    {
      venueId: "kraken-global",
      kind: "cex",
      legalEntity: "Payward, Inc. (shared global spot orderbook)",
      jurisdictionTags: ["global"],
      sourceUrl: "https://api.kraken.com/0/public/AssetPairs",
      reviewedAt: VENUES_REVIEWED_AT,
    },
    {
      venueId: "coinbase-global",
      kind: "cex",
      legalEntity: "Coinbase, Inc. (shared Exchange spot orderbook)",
      jurisdictionTags: ["global"],
      sourceUrl: "https://api.exchange.coinbase.com/products",
      reviewedAt: VENUES_REVIEWED_AT,
    },
    {
      venueId: "kraken-eea-eligibility",
      kind: "eligibility-notice",
      legalEntity: "Payward Europe Solutions Limited",
      jurisdictionTags: ["EEA"],
      sourceUrl: "https://support.kraken.com/articles/stablecoin-offerings-for-eea-clients",
      reviewedAt: VENUES_REVIEWED_AT,
    },
    {
      venueId: "coinbase-eea-eligibility",
      kind: "eligibility-notice",
      legalEntity: "Coinbase Europe Limited",
      jurisdictionTags: ["EEA"],
      sourceUrl: "https://help.coinbase.com/en-gb/coinbase/other-topics/other/mica-restricted-stablecoins",
      reviewedAt: VENUES_REVIEWED_AT,
    },
    {
      venueId: "esma-emtwp-register",
      kind: "regulator",
      legalEntity: "European Securities and Markets Authority (ESMA)",
      jurisdictionTags: ["EEA"],
      sourceUrl: "https://www.esma.europa.eu/sites/default/files/2024-12/EMTWP.csv",
      reviewedAt: VENUES_REVIEWED_AT,
    },
    {
      venueId: "stablr-holder-notices",
      kind: "issuer-notice",
      legalEntity: "StablR Ltd",
      jurisdictionTags: ["EEA"],
      sourceUrl: "https://www.stablr.com/insights",
      reviewedAt: VENUES_REVIEWED_AT,
    },
    {
      venueId: "dex-permissionless",
      kind: "dex",
      legalEntity: null,
      jurisdictionTags: ["permissionless"],
      sourceUrl: "https://api.pharos.watch/api/dex-liquidity",
      reviewedAt: VENUES_REVIEWED_AT,
    },
  ];
}

export interface GlobalMarketSpec {
  id: string;
  venueId: "kraken-global" | "coinbase-global";
  exchange: "kraken" | "coinbase";
  pair: string;
  quoteCurrency: "USD" | "EUR" | "USDC";
}

/** Verified global spot pairs; resolved dynamically against exchange product catalogs at run time. */
export const GLOBAL_MARKET_SPECS: readonly GlobalMarketSpec[] = [
  { id: "usdc-circle", venueId: "kraken-global", exchange: "kraken", pair: "USDCUSD", quoteCurrency: "USD" },
  { id: "usdc-circle", venueId: "kraken-global", exchange: "kraken", pair: "USDCEUR", quoteCurrency: "EUR" },
  { id: "usdt-tether", venueId: "kraken-global", exchange: "kraken", pair: "USDTUSD", quoteCurrency: "USD" },
  { id: "usdt-tether", venueId: "kraken-global", exchange: "kraken", pair: "USDTEUR", quoteCurrency: "EUR" },
  { id: "eurc-circle", venueId: "kraken-global", exchange: "kraken", pair: "EURCUSD", quoteCurrency: "USD" },
  { id: "eurc-circle", venueId: "kraken-global", exchange: "kraken", pair: "EURCEUR", quoteCurrency: "EUR" },
  { id: "dai-makerdao", venueId: "kraken-global", exchange: "kraken", pair: "DAIUSD", quoteCurrency: "USD" },
  { id: "pyusd-paypal", venueId: "kraken-global", exchange: "kraken", pair: "PYUSDUSD", quoteCurrency: "USD" },
  { id: "usdg-paxos", venueId: "kraken-global", exchange: "kraken", pair: "USDGUSD", quoteCurrency: "USD" },
  { id: "rlusd-ripple", venueId: "kraken-global", exchange: "kraken", pair: "RLUSDUSD", quoteCurrency: "USD" },
  { id: "usds-sky", venueId: "kraken-global", exchange: "kraken", pair: "USDSUSD", quoteCurrency: "USD" },
  { id: "usdc-circle", venueId: "coinbase-global", exchange: "coinbase", pair: "USDC-EUR", quoteCurrency: "EUR" },
  { id: "usdt-tether", venueId: "coinbase-global", exchange: "coinbase", pair: "USDT-USD", quoteCurrency: "USD" },
  { id: "usdt-tether", venueId: "coinbase-global", exchange: "coinbase", pair: "USDT-EUR", quoteCurrency: "EUR" },
  { id: "eurc-circle", venueId: "coinbase-global", exchange: "coinbase", pair: "EURC-USDC", quoteCurrency: "USDC" },
  { id: "usds-sky", venueId: "coinbase-global", exchange: "coinbase", pair: "USDS-USD", quoteCurrency: "USD" },
  { id: "usdp-paxos", venueId: "coinbase-global", exchange: "coinbase", pair: "PAX-USD", quoteCurrency: "USD" },
];

export interface BandMeasurementResult {
  schemaOk: boolean;
  empty: boolean;
  bidDepthQuote1pct: number | null;
  askDepthQuote1pct: number | null;
  bidDepthTruncated: boolean | null;
  askDepthTruncated: boolean | null;
  reason: string | null;
}

function verifyEligibilityBlobContent(
  obs: Pick<RegionalEligibilityObservation, "sourceId" | "status" | "bodySha256" | "bytes" | "r2Key">,
  gzBytes: Buffer,
): string | null {
  if (obs.status !== "ok") {
    if (obs.r2Key !== null || obs.bytes !== null || obs.bodySha256 !== null) {
      return `unavailable regionalEligibility has unexpected integrity metadata:${obs.sourceId}`;
    }
    return null;
  }
  if (obs.r2Key === null || obs.bytes === null || obs.bodySha256 === null) {
    return `regionalEligibility missing integrity metadata:${obs.sourceId}`;
  }
  let raw: Buffer;
  try {
    raw = gunzipSync(gzBytes);
  } catch {
    return `unreadable gzipped regionalEligibility blob:${obs.sourceId}:${obs.r2Key}`;
  }
  if (raw.byteLength !== obs.bytes) {
    return `regionalEligibility raw byte-length mismatch:${obs.sourceId}:${raw.byteLength}!=${obs.bytes}`;
  }
  const actualRawSha = sha256Hex(raw);
  if (actualRawSha !== obs.bodySha256) {
    return `regionalEligibility raw sha256 mismatch:${obs.sourceId}`;
  }
  return null;
}

function isStrictDecimalLiteral(trimmed: string): boolean {
  const expParts = trimmed.split(/[eE]/);
  if (expParts.length > 2) return false;
  const mantissa = expParts[0]!;
  const dotParts = mantissa.split(".");
  if (dotParts.length > 2) return false;
  const intPart = dotParts[0]!;
  const fracPart = dotParts[1];
  const digitsOnly = (s: string) => s.length > 0 && /^\d+$/.test(s);
  const validMantissa = fracPart === undefined
    ? digitsOnly(intPart)
    : (intPart.length === 0 ? digitsOnly(fracPart) : digitsOnly(intPart) && digitsOnly(fracPart));
  if (!validMantissa) return false;
  if (expParts.length === 2) {
    const exp = expParts[1]!;
    const unsignedExp = exp.startsWith("+") || exp.startsWith("-") ? exp.slice(1) : exp;
    if (!digitsOnly(unsignedExp)) return false;
  }
  return true;
}

function parsePositiveDecimalField(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!isStrictDecimalLiteral(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function parseBookLevel(entry: unknown): [number, number] | null {
  if (!Array.isArray(entry) || entry.length < 2) return null;
  const price = parsePositiveDecimalField(entry[0]);
  const qty = parsePositiveDecimalField(entry[1]);
  if (price === null || qty === null) return null;
  return [price, qty];
}

/**
 * Measure +-1% orderbook depth strictly in quote currency.
 * Never silently drops malformed in-band levels and explicitly flags truncation
 * when the last returned level still falls inside the +-1% band.
 */
export function measureOrderbookBand(rawBids: unknown, rawAsks: unknown): BandMeasurementResult {
  if (!Array.isArray(rawBids) || !Array.isArray(rawAsks)) {
    return {
      schemaOk: false,
      empty: false,
      bidDepthQuote1pct: null,
      askDepthQuote1pct: null,
      bidDepthTruncated: null,
      askDepthTruncated: null,
      reason: "malformed-orderbook-payload",
    };
  }
  if (rawBids.length === 0 || rawAsks.length === 0) {
    return {
      schemaOk: true,
      empty: true,
      bidDepthQuote1pct: null,
      askDepthQuote1pct: null,
      bidDepthTruncated: null,
      askDepthTruncated: null,
      reason: "empty-orderbook",
    };
  }
  const bestBidLevel = parseBookLevel(rawBids[0]);
  const bestAskLevel = parseBookLevel(rawAsks[0]);
  if (!bestBidLevel || !bestAskLevel) {
    return {
      schemaOk: false,
      empty: false,
      bidDepthQuote1pct: null,
      askDepthQuote1pct: null,
      bidDepthTruncated: null,
      askDepthTruncated: null,
      reason: "malformed-top-of-book",
    };
  }
  const [bestBid] = bestBidLevel;
  const [bestAsk] = bestAskLevel;
  if (bestBid > bestAsk) {
    return {
      schemaOk: false,
      empty: false,
      bidDepthQuote1pct: null,
      askDepthQuote1pct: null,
      bidDepthTruncated: null,
      askDepthTruncated: null,
      reason: "crossed-orderbook",
    };
  }

  const mid = (bestBid + bestAsk) / 2;
  const bidFloor = mid * 0.99;
  const askCeil = mid * 1.01;

  let bidDepth: number | null = 0;
  let bidTruncated: boolean | null = true;
  let bidReason: string | null = null;
  let prevBidPrice = Number.POSITIVE_INFINITY;
  for (const rawLevel of rawBids) {
    const parsed = parseBookLevel(rawLevel);
    if (!parsed || parsed[0] > prevBidPrice) {
      bidDepth = null;
      bidTruncated = null;
      bidReason = "malformed-bid-level";
      break;
    }
    const [price, qty] = parsed;
    prevBidPrice = price;
    if (price < bidFloor) {
      bidTruncated = false;
      break;
    }
    bidDepth += price * qty;
  }

  let askDepth: number | null = 0;
  let askTruncated: boolean | null = true;
  let askReason: string | null = null;
  let prevAskPrice = 0;
  for (const rawLevel of rawAsks) {
    const parsed = parseBookLevel(rawLevel);
    if (!parsed || parsed[0] < prevAskPrice) {
      askDepth = null;
      askTruncated = null;
      askReason = "malformed-ask-level";
      break;
    }
    const [price, qty] = parsed;
    prevAskPrice = price;
    if (price > askCeil) {
      askTruncated = false;
      break;
    }
    askDepth += price * qty;
  }

  const levelError = bidReason ?? askReason;
  return {
    schemaOk: levelError === null,
    empty: false,
    bidDepthQuote1pct: bidDepth === null ? null : Math.round(bidDepth * 100) / 100,
    askDepthQuote1pct: askDepth === null ? null : Math.round(askDepth * 100) / 100,
    bidDepthTruncated: bidTruncated,
    askDepthTruncated: askTruncated,
    reason: levelError,
  };
}

interface FxQuoteObservation {
  rate: number;
  source: string;
  observedAt: string;
}

async function fetchKrakenMidRate(
  pair: string,
  sourceLabel: string,
  fetchImpl: typeof fetch,
  observedAt: string,
): Promise<FxQuoteObservation | null> {
  try {
    const response = await fetchImpl(`https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent(pair)}`, {
      headers: { Accept: "application/json", "User-Agent": "pharos-validation-archive/1" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const payload = (await response.json()) as { error?: unknown[]; result?: Record<string, { a?: unknown[]; b?: unknown[] }> };
    if (!payload || (Array.isArray(payload.error) && payload.error.length > 0) || !payload.result || typeof payload.result !== "object") {
      return null;
    }
    const ticker = Object.values(payload.result)[0];
    const ask = parsePositiveDecimalField(ticker?.a?.[0]);
    const bid = parsePositiveDecimalField(ticker?.b?.[0]);
    if (ask === null || bid === null || bid > ask) return null;
    return { rate: Math.round(((ask + bid) / 2) * 1e6) / 1e6, source: sourceLabel, observedAt };
  } catch {
    return null;
  }
}

interface ExchangeCatalogEntry {
  canonicalPair: string;
  listingState: "online" | "delisted" | "unavailable";
  unavailableReason: string | null;
}

type ExchangeCatalogResult =
  | { kind: "ok"; entries: Map<string, ExchangeCatalogEntry>; hasMalformedEntries: boolean }
  | { kind: "empty" }
  | { kind: "unavailable" };

async function fetchCoinbaseCatalog(fetchImpl: typeof fetch): Promise<ExchangeCatalogResult> {
  try {
    const response = await fetchImpl("https://api.exchange.coinbase.com/products", {
      headers: { Accept: "application/json", "User-Agent": "pharos-validation-archive/1" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { kind: "unavailable" };
    }
    const payload = await response.json();
    if (!Array.isArray(payload)) return { kind: "unavailable" };
    if (payload.length === 0) return { kind: "empty" };
    const entries = new Map<string, ExchangeCatalogEntry>();
    let hasMalformedEntries = false;
    for (const item of payload) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        hasMalformedEntries = true;
        continue;
      }
      const entry = item as Record<string, unknown>;
      if (typeof entry.id !== "string" || entry.id.length === 0) {
        hasMalformedEntries = true;
        continue;
      }
      const status = typeof entry.status === "string" && entry.status.trim().length > 0 ? entry.status.trim() : null;
      const disabled = entry.trading_disabled === true;
      let listingState: ExchangeCatalogEntry["listingState"];
      let unavailableReason: string | null;
      if (status === "delisted") {
        listingState = "delisted";
        unavailableReason = "coinbase-product-delisted";
      } else if (disabled) {
        listingState = "unavailable";
        unavailableReason = "coinbase-trading-disabled";
      } else if (status === "online") {
        listingState = "online";
        unavailableReason = null;
      } else if (status === null) {
        listingState = "unavailable";
        unavailableReason = "coinbase-product-status-unknown";
      } else {
        listingState = "unavailable";
        unavailableReason = `coinbase-product-${status}`;
      }
      entries.set(entry.id, { canonicalPair: entry.id, listingState, unavailableReason });
    }
    return entries.size === 0 ? { kind: "unavailable" } : { kind: "ok", entries, hasMalformedEntries };
  } catch {
    return { kind: "unavailable" };
  }
}

async function fetchKrakenCatalog(fetchImpl: typeof fetch): Promise<ExchangeCatalogResult> {
  try {
    const response = await fetchImpl("https://api.kraken.com/0/public/AssetPairs", {
      headers: { Accept: "application/json", "User-Agent": "pharos-validation-archive/1" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { kind: "unavailable" };
    }
    const payload = (await response.json()) as { error?: unknown[]; result?: Record<string, Record<string, unknown>> };
    if (!payload || (Array.isArray(payload.error) && payload.error.length > 0) || !payload.result || typeof payload.result !== "object" || Array.isArray(payload.result)) {
      return { kind: "unavailable" };
    }
    const resultEntries = Object.entries(payload.result);
    if (resultEntries.length === 0) return { kind: "empty" };
    const entries = new Map<string, ExchangeCatalogEntry>();
    let hasMalformedEntries = false;
    for (const [key, item] of resultEntries) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        hasMalformedEntries = true;
        entries.set(key, {
          canonicalPair: key,
          listingState: "unavailable",
          unavailableReason: "kraken-catalog-entry-malformed",
        });
        continue;
      }
      const status = typeof item.status === "string" && item.status.trim().length > 0 ? item.status.trim() : null;
      let listingState: ExchangeCatalogEntry["listingState"];
      let unavailableReason: string | null;
      if (status === "delisted") {
        listingState = "delisted";
        unavailableReason = "kraken-product-delisted";
      } else if (status === "online") {
        listingState = "online";
        unavailableReason = null;
      } else if (status === null) {
        listingState = "unavailable";
        unavailableReason = "kraken-product-status-unknown";
      } else {
        listingState = "unavailable";
        unavailableReason = `kraken-product-${status}`;
      }
      const record: ExchangeCatalogEntry = { canonicalPair: key, listingState, unavailableReason };
      entries.set(key, record);
      if (typeof item.altname === "string" && item.altname.length > 0) {
        entries.set(item.altname, record);
      } else if (item.altname !== undefined) {
        hasMalformedEntries = true;
      }
      if (typeof item.wsname === "string" && item.wsname.length > 0) {
        entries.set(item.wsname, record);
      } else if (item.wsname !== undefined) {
        hasMalformedEntries = true;
      }
    }
    return entries.size === 0 ? { kind: "unavailable" } : { kind: "ok", entries, hasMalformedEntries };
  } catch {
    return { kind: "unavailable" };
  }
}

function buildDepthRow(
  spec: GlobalMarketSpec,
  listed: boolean | null,
  measurement: BandMeasurementResult | null,
  fx: FxQuoteObservation | null,
  fallbackReason: string | null,
): MarketDepthRow {
  const quoteBid = measurement?.bidDepthQuote1pct ?? null;
  const quoteAsk = measurement?.askDepthQuote1pct ?? null;
  const effectiveFx = spec.quoteCurrency === "USD"
    ? { rate: 1, source: "identity-usd", observedAt: fx?.observedAt ?? null }
    : fx;
  const usdBid = quoteBid !== null && effectiveFx !== null ? Math.round(quoteBid * effectiveFx.rate * 100) / 100 : null;
  const usdAsk = quoteAsk !== null && effectiveFx !== null ? Math.round(quoteAsk * effectiveFx.rate * 100) / 100 : null;
  const missingUsd = usdBid === null || usdAsk === null;
  const reason = missingUsd
    ? (fallbackReason ?? measurement?.reason ?? (effectiveFx === null ? `fx-rate-unavailable:${spec.quoteCurrency}` : "depth-unavailable"))
    : null;
  return MarketDepthRowSchema.parse({
    id: spec.id,
    venueId: spec.venueId,
    pair: spec.pair,
    quoteCurrency: spec.quoteCurrency,
    listed,
    bidDepthQuote1pct: quoteBid,
    askDepthQuote1pct: quoteAsk,
    bidDepthUsd1pct: usdBid,
    askDepthUsd1pct: usdAsk,
    bidDepthTruncated: measurement?.bidDepthTruncated ?? null,
    askDepthTruncated: measurement?.askDepthTruncated ?? null,
    fxRate: effectiveFx?.rate ?? null,
    fxSource: effectiveFx?.source ?? null,
    fxObservedAt: effectiveFx?.observedAt ?? null,
    unavailableReason: reason,
  });
}

export async function collectGlobalOrderbooks(
  fetchImpl: typeof fetch,
  nowDate: Date,
  specs: readonly GlobalMarketSpec[] = GLOBAL_MARKET_SPECS,
): Promise<MarketDepthRow[]> {
  const observedAt = nowDate.toISOString();
  const needsKraken = specs.some((spec) => spec.exchange === "kraken");
  const needsCoinbase = specs.some((spec) => spec.exchange === "coinbase");
  const needsEurFx = specs.some((spec) => spec.quoteCurrency === "EUR");
  const needsUsdcFx = specs.some((spec) => spec.quoteCurrency === "USDC");

  const [krakenCatalog, coinbaseCatalog, eurFx, usdcFx] = await Promise.all([
    needsKraken ? fetchKrakenCatalog(fetchImpl) : Promise.resolve<ExchangeCatalogResult>({ kind: "unavailable" }),
    needsCoinbase ? fetchCoinbaseCatalog(fetchImpl) : Promise.resolve<ExchangeCatalogResult>({ kind: "unavailable" }),
    needsEurFx ? fetchKrakenMidRate("EURUSD", "kraken:ZEURZUSD", fetchImpl, observedAt) : Promise.resolve(null),
    needsUsdcFx ? fetchKrakenMidRate("USDCUSD", "kraken:USDCUSD", fetchImpl, observedAt) : Promise.resolve(null),
  ]);
  const usdIdentityFx: FxQuoteObservation = { rate: 1, source: "identity-usd", observedAt };
  const fxFor = (quote: GlobalMarketSpec["quoteCurrency"]): FxQuoteObservation | null =>
    quote === "USD" ? usdIdentityFx : quote === "EUR" ? eurFx : usdcFx;

  const rows: MarketDepthRow[] = [];
  for (const spec of specs) {
    const fx = fxFor(spec.quoteCurrency);
    const catalog = spec.exchange === "kraken" ? krakenCatalog : coinbaseCatalog;
    let queryPair = spec.pair;
    if (catalog.kind === "empty") {
      rows.push(buildDepthRow(spec, null, null, fx, `${spec.exchange}-catalog-empty`));
      continue;
    }
    if (catalog.kind === "ok") {
      const catalogEntry = catalog.entries.get(spec.pair);
      if (!catalogEntry) {
        rows.push(buildDepthRow(
          spec,
          catalog.hasMalformedEntries ? null : false,
          null,
          fx,
          catalog.hasMalformedEntries ? `${spec.exchange}-catalog-partially-malformed` : `${spec.exchange}-pair-not-in-catalog`,
        ));
        continue;
      }
      if (catalogEntry.listingState === "delisted") {
        rows.push(buildDepthRow(spec, false, null, fx, catalogEntry.unavailableReason));
        continue;
      }
      if (catalogEntry.listingState === "unavailable") {
        rows.push(buildDepthRow(spec, null, null, fx, catalogEntry.unavailableReason));
        continue;
      }
      queryPair = catalogEntry.canonicalPair;
    }

    const url = spec.exchange === "kraken"
      ? `https://api.kraken.com/0/public/Depth?pair=${encodeURIComponent(queryPair)}&count=500`
      : `https://api.exchange.coinbase.com/products/${encodeURIComponent(queryPair)}/book?level=2`;

    try {
      const response = await fetchImpl(url, {
        headers: { Accept: "application/json", "User-Agent": "pharos-validation-archive/1" },
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const reason = response.status === 404
          ? `${spec.exchange}-book-404-unconfirmed`
          : `${spec.exchange}-http-${response.status}`;
        rows.push(buildDepthRow(spec, null, null, fx, reason));
        continue;
      }
      const payload = (await response.json()) as Record<string, unknown>;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        rows.push(buildDepthRow(spec, null, null, fx, `${spec.exchange}-malformed-orderbook-payload`));
        continue;
      }

      if (spec.exchange === "kraken") {
        if (Array.isArray(payload.error) && payload.error.length > 0) {
          const firstError = String(payload.error[0]);
          const isUnknownPair = payload.error.some((entry) => String(entry).includes("EQuery:Unknown asset pair"));
          const catalogConfirmedOnline = catalog.kind === "ok";
          rows.push(
            buildDepthRow(
              spec,
              isUnknownPair && !catalogConfirmedOnline ? false : null,
              null,
              fx,
              isUnknownPair
                ? (catalogConfirmedOnline ? "kraken-catalog-depth-contradiction" : "kraken-unknown-asset-pair")
                : `kraken-api-error:${firstError.slice(0, 80)}`,
            ),
          );
          continue;
        }
        const resultEntries = payload.result && typeof payload.result === "object" && !Array.isArray(payload.result)
          ? Object.values(payload.result as Record<string, unknown>)
          : [];
        const book = resultEntries[0] && typeof resultEntries[0] === "object" && !Array.isArray(resultEntries[0])
          ? (resultEntries[0] as Record<string, unknown>)
          : null;
        if (!book) {
          rows.push(buildDepthRow(spec, null, null, fx, "kraken-malformed-orderbook-payload"));
          continue;
        }
        const measured = measureOrderbookBand(book.bids, book.asks);
        if (!measured.schemaOk) {
          rows.push(buildDepthRow(spec, null, null, fx, `kraken-${measured.reason ?? "malformed-orderbook-payload"}`));
          continue;
        }
        rows.push(buildDepthRow(spec, true, measured, fx, measured.empty ? "kraken-empty-orderbook" : null));
        continue;
      }

      const measured = measureOrderbookBand(payload.bids, payload.asks);
      if (!measured.schemaOk) {
        rows.push(buildDepthRow(spec, null, null, fx, `coinbase-${measured.reason ?? "malformed-orderbook-payload"}`));
        continue;
      }
      rows.push(buildDepthRow(spec, true, measured, fx, measured.empty ? "coinbase-empty-orderbook" : null));
    } catch (error) {
      const msg = error instanceof Error ? error.name || error.message : String(error);
      rows.push(buildDepthRow(spec, null, null, fx, `${spec.exchange}-fetch-error:${msg.slice(0, 80)}`));
    }
  }
  return rows;
}

export interface RegionalEligibilitySourceSpec {
  sourceId: string;
  venueId: string;
  jurisdiction: "EEA" | "US";
  sourceUrl: string;
  ext: "html" | "csv";
}

export const REGIONAL_ELIGIBILITY_SOURCES: readonly RegionalEligibilitySourceSpec[] = [
  {
    sourceId: "kraken-eea-offerings",
    venueId: "kraken-eea-eligibility",
    jurisdiction: "EEA",
    sourceUrl: "https://support.kraken.com/articles/stablecoin-offerings-for-eea-clients",
    ext: "html",
  },
  {
    sourceId: "coinbase-eea-mica",
    venueId: "coinbase-eea-eligibility",
    jurisdiction: "EEA",
    sourceUrl: "https://help.coinbase.com/en-gb/coinbase/other-topics/other/mica-restricted-stablecoins",
    ext: "html",
  },
  {
    sourceId: "esma-emtwp-register",
    venueId: "esma-emtwp-register",
    jurisdiction: "EEA",
    sourceUrl: "https://www.esma.europa.eu/sites/default/files/2024-12/EMTWP.csv",
    ext: "csv",
  },
  {
    sourceId: "stablr-holder-notices",
    venueId: "stablr-holder-notices",
    jurisdiction: "EEA",
    sourceUrl: "https://www.stablr.com/insights",
    ext: "html",
  },
];

function extractKrakenEeaRestrictedSymbols(html: string): string[] | null {
  const plain = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
  const start = plain.indexOf("delisted in the EEA");
  if (start < 0) return null;
  const end = plain.indexOf("cannot be traded", start);
  const windowText = end > start ? plain.slice(start, end) : plain.slice(start, start + 600);
  const matches = [...windowText.matchAll(/\(([A-Z0-9]{2,10})\)/g)].map((m) => m[1]!);
  return matches.length > 0 ? [...new Set(matches)].sort(compareCodeUnits) : null;
}

async function collectRegionalEligibility(
  fetchImpl: typeof fetch,
  observedAt: string,
  r2KeyBuilder: (source: RegionalEligibilitySourceSpec, gzDigest: string) => string,
): Promise<{
  observations: RegionalEligibilityObservation[];
  stagedBlobs: Array<{ role: string; r2Key: string; body: Buffer; sha256: string; bytes: number }>;
}> {
  const observations: RegionalEligibilityObservation[] = [];
  const stagedBlobs: Array<{ role: string; r2Key: string; body: Buffer; sha256: string; bytes: number }> = [];
  for (const source of REGIONAL_ELIGIBILITY_SOURCES) {
    const { ext: _ext, ...observationBase } = source;
    try {
      const response = await fetchImpl(source.sourceUrl, {
        headers: { Accept: "text/html,text/csv,*/*", "User-Agent": "pharos-validation-archive/1" },
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        observations.push(RegionalEligibilityObservationSchema.parse({
          ...observationBase,
          observedAt,
          status: "unavailable",
          httpStatus: response.status,
          bodySha256: null,
          bytes: null,
          r2Key: null,
          restrictedSymbols: null,
          unavailableReason: `http-${response.status}`,
        }));
        continue;
      }
      const rawBytes = Buffer.from(await response.arrayBuffer());
      const rawText = rawBytes.toString("utf8");
      if (rawBytes.byteLength === 0 || /<title>\s*Just a moment\.\.\.\s*<\/title>/i.test(rawText)) {
        observations.push(RegionalEligibilityObservationSchema.parse({
          ...observationBase,
          observedAt,
          status: "unavailable",
          httpStatus: response.status,
          bodySha256: null,
          bytes: null,
          r2Key: null,
          restrictedSymbols: null,
          unavailableReason: rawBytes.byteLength === 0 ? "empty-response" : "bot-challenge-page",
        }));
        continue;
      }
      const gz = gzipSync(rawBytes, { level: 9 });
      const gzDigest = sha256Hex(gz);
      const r2Key = assertValidationArchiveKey(r2KeyBuilder(source, gzDigest));
      stagedBlobs.push({
        role: `regional-eligibility:${source.sourceId}`,
        r2Key,
        body: gz,
        sha256: gzDigest,
        bytes: gz.byteLength,
      });
      observations.push(RegionalEligibilityObservationSchema.parse({
        ...observationBase,
        observedAt,
        status: "ok",
        httpStatus: response.status,
        bodySha256: sha256Hex(rawBytes),
        bytes: rawBytes.byteLength,
        r2Key,
        restrictedSymbols: source.sourceId === "kraken-eea-offerings" ? extractKrakenEeaRestrictedSymbols(rawText) : null,
        unavailableReason: null,
      }));
    } catch (error) {
      const msg = error instanceof Error ? error.name || error.message : String(error);
      observations.push(RegionalEligibilityObservationSchema.parse({
        ...observationBase,
        observedAt,
        status: "unavailable",
        httpStatus: null,
        bodySha256: null,
        bytes: null,
        r2Key: null,
        restrictedSymbols: null,
        unavailableReason: `fetch-error:${msg.slice(0, 80)}`,
      }));
    }
  }
  return { observations, stagedBlobs };
}

function parseAndValidateApiBase(raw: string): { apiBase: string; origin: string; isTrustedProdOrigin: boolean } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new CliUsageError(`Invalid --api-base URL: ${raw}`);
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new CliUsageError(`Unsupported --api-base URL (expected clean http(s) origin): ${raw}`);
  }
  const normalizedPath = parsed.pathname.replace(/\/+$/, "");
  const isTrustedProdOrigin = parsed.origin === TRUSTED_PROD_API_ORIGIN && normalizedPath === "";
  return {
    apiBase: `${parsed.origin}${normalizedPath}`,
    origin: parsed.origin,
    isTrustedProdOrigin,
  };
}

/** Attach `X-API-Key` strictly for the trusted production Pharos API origin (`https://api.pharos.watch`). */
export function buildPharosApiHeaders(
  url: string,
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  try {
    const parsed = new URL(url);
    const apiKey = env.PHAROS_API_KEY?.trim();
    if (parsed.origin === TRUSTED_PROD_API_ORIGIN && apiKey) {
      headers["X-API-Key"] = apiKey;
    }
  } catch {
    // Malformed URLs never receive credentials.
  }
  return headers;
}

const BaselinePublicSnapshotPayloadSchema = z.object({
  snapshotDate: DateYmdSchema,
  generatedAt: z.number().int().nonnegative(),
  stablecoins: z.array(z.object({
    id: z.string().min(1),
    circulating: z.record(z.string(), z.number().finite()),
  }).passthrough()).min(1),
}).passthrough();

const BaselinePegSummaryPayloadSchema = z.object({
  coins: z.array(z.object({
    id: z.string().min(1),
    symbol: z.string().min(1),
    pegType: z.string().min(1),
    currentDeviationBps: z.number().finite().nullable(),
  }).passthrough()).min(1),
  summary: z.object({
    totalTracked: z.number().int().nonnegative(),
  }).passthrough().nullable(),
  methodology: z.object({
    version: z.string().min(1),
  }).passthrough().optional(),
}).passthrough();

const BaselineDexLiquidityRowSchema = z.object({
  totalTvlUsd: z.number().finite().nonnegative(),
  effectiveTvlUsd: z.number().finite().nonnegative(),
  totalVolume24hUsd: z.number().finite().nonnegative().nullable(),
  poolCount: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  methodologyVersion: z.string().min(1),
}).passthrough();

const BaselineDexLiquidityPayloadSchema = z.record(z.string().min(1), BaselineDexLiquidityRowSchema)
  .refine((map) => Object.keys(map).length > 0, "dex-liquidity map must be non-empty");

const BaselineReportCardsV9CardSchema = z.object({
  id: z.string().min(1),
  ratingStatus: V9RatingStatusSchema,
  grade: V9GradeSchema.nullable(),
  score: z.number().finite().min(0).max(100).nullable(),
}).passthrough().superRefine((card, ctx) => {
  if ((card.ratingStatus === "pipeline-gap") !== (card.grade === null)
    || (card.ratingStatus === "rated") !== (card.score !== null)
    || (card.ratingStatus === "not-rated") !== (card.grade === "NR")) {
    ctx.addIssue({ code: "custom", message: "card ratingStatus, grade, and score must agree" });
  }
});

const BaselineReportCardsV9PayloadSchema = z.object({
  model: z.literal("v9"),
  safetyScoreIdentity: SafetyScoreV9PublicationIdentitySchema,
  cards: z.array(BaselineReportCardsV9CardSchema).min(1),
}).passthrough();

function summarizeZodError(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "<root>"}:${issue.message}`)
    .join("; ")
    .slice(0, 140);
}

async function fetchPharosJsonBytes(
  apiBase: string,
  apiPath: string,
  fetchImpl?: typeof fetch,
  env: Record<string, string | undefined> = process.env,
): Promise<{ ok: true; bytes: Buffer; parsed: unknown } | { ok: false; reason: string }> {
  const url = `${apiBase.replace(/\/+$/, "")}${apiPath}`;
  const headers = buildPharosApiHeaders(url, env);
  try {
    const response = fetchImpl
      ? await fetchImpl(url, { headers, redirect: "error", signal: AbortSignal.timeout(25_000) })
      : await fetchWithRetry(
          url,
          { headers, redirect: "error" },
          { logLabel: "validation-archive", attempts: 2, timeoutMs: 25_000 },
        );
    if (response.redirected) {
      await response.body?.cancel();
      return { ok: false, reason: "unexpected-redirect" };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, reason: `http-${response.status}` };
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    try {
      return { ok: true, bytes, parsed: JSON.parse(bytes.toString("utf8")) };
    } catch {
      return { ok: false, reason: "invalid-json" };
    }
  } catch (error) {
    const msg = error instanceof Error ? error.name || error.message : String(error);
    return { ok: false, reason: `fetch-error:${msg.slice(0, 80)}` };
  }
}

/**
 * Derive active coin compliance rows and pre-cliff cohorts directly from the
 * tracked per-coin sources (`shared/data/stablecoins/coins/*.json`) and domain
 * sidecars (`shared/data/stablecoins/domains/compliance/*.json`), with zero
 * dependency on gitignored `coins*.generated.json` artifacts.
 */
export function loadActiveComplianceInputs(rootDir = REPO_ROOT): {
  compliance: ComplianceSnapshotEntry[];
  cohorts: PreCliffCohortRow[];
} {
  const sourceCoins = loadPerCoinStablecoinEntries(rootDir).map((entry) => entry.coin);
  const { complianceEntries } = buildComplianceRegistryOutput({ sourceCoins });
  const activeIds = sourceCoins
    .filter((coin) => (coin.status ?? "active") === "active")
    .map((coin) => coin.id)
    .sort(compareCodeUnits);
  const byId = new Map(
    (complianceEntries as Array<Record<string, unknown>>).map((row) => [String(row.id), row] as const),
  );
  const compliance: ComplianceSnapshotEntry[] = activeIds.map((id) => {
    const row = byId.get(id);
    return ComplianceSnapshotEntrySchema.parse({
      id,
      mica: row?.mica ?? null,
      genius: row?.genius ?? null,
    });
  });
  const cohorts = classifyPreCliffCohorts(compliance, activeIds);
  return { compliance, cohorts };
}

function selectD1Rows<T>(client: Pick<D1Client, "queryRaw">, sql: string, schema: { parse(value: unknown): T }): T[] {
  const envelopes = decodeD1Envelopes(JSON.parse(client.queryRaw(sql)));
  if (envelopes.length !== 1 || envelopes[0]!.success !== true) throw new Error("d1-validation-archive-query-failed");
  return envelopes[0]!.results.map((row) => schema.parse(row));
}

const ReserveHistoryArchiveRowSchema = z.object({
  attempt_row_id: z.number().int().nonnegative(),
  stablecoin_id: z.string().min(1),
  attempted_at: z.number().int().nonnegative(),
  adapter_key: z.string().min(1),
  breaker_key: z.string().min(1),
  attempt_id: z.string().min(1).nullable(),
  attempt_status: z.string().min(1),
  attempt_warning_count: z.number().int().nonnegative(),
  attempt_warnings: z.string().nullable(),
  attempt_last_error: z.string().nullable(),
  attempt_metadata: z.string(),
  composition_row_id: z.number().int().nonnegative().nullable(),
  fetched_at: z.number().int().nonnegative().nullable(),
  payload_sha256: Sha256Schema.nullable(),
  slices: z.string().nullable(),
  metadata: z.string().nullable(),
  warnings: z.string().nullable(),
  warning_count: z.number().int().nonnegative().nullable(),
  adapter_source_model: z.string().nullable(),
  adapter_evidence_class: z.string().nullable(),
}).strict();

/**
 * Bounded indexed traversal over `reserve_sync_attempt_history` (`idx_reserve_sync_attempt_history_time`)
 * joined on `(stablecoin_id, attempt_id)` to `reserve_composition_history`
 * (`idx_reserve_composition_history_coin_attempt_unique`), exporting `payload_sha256` and attempt evidence
 * with zero table scans and zero temp B-trees.
 */
function readDayReserveHistory(client: Pick<D1Client, "queryRaw">, fromSec: number, toSec: number): Array<z.output<typeof ReserveHistoryArchiveRowSchema>> {
  const rows: Array<z.output<typeof ReserveHistoryArchiveRowSchema>> = [];
  let cursor = "";
  while (true) {
    // SAFETY: fromSec, toSec, PAGE_SIZE, and cursor values are validated safe integers; tables/columns are fixed constants.
    const page = selectD1Rows(
      client,
      `SELECT
         a.id AS attempt_row_id,
         a.stablecoin_id,
         a.attempted_at,
         a.adapter_key,
         a.breaker_key,
         a.attempt_id,
         a.status AS attempt_status,
         a.warning_count AS attempt_warning_count,
         a.warnings AS attempt_warnings,
         a.last_error AS attempt_last_error,
         a.metadata AS attempt_metadata,
         h.id AS composition_row_id,
         h.fetched_at,
         h.payload_sha256,
         h.slices,
         h.metadata,
         h.warnings,
         h.warning_count,
         h.adapter_source_model,
         h.adapter_evidence_class
       FROM reserve_sync_attempt_history a
       LEFT JOIN reserve_composition_history h
         ON h.stablecoin_id = a.stablecoin_id
        AND h.attempt_id = a.attempt_id
        AND a.attempt_id IS NOT NULL
       WHERE a.attempted_at >= ${fromSec} AND a.attempted_at < ${toSec} ${cursor}
       ORDER BY a.attempted_at ASC, a.id ASC
       LIMIT ${PAGE_SIZE}`,
      ReserveHistoryArchiveRowSchema,
    );
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    const last = page[page.length - 1]!;
    cursor = `AND (a.attempted_at, a.id) > (${last.attempted_at}, ${last.attempt_row_id})`;
  }
  return rows;
}

const EvidenceJournalQueryRowSchema = z.object({
  _rowid: z.number().int().nonnegative(),
  journal_id: z.string().min(1),
  schema_version: z.number().int(),
  lane: z.string().min(1),
  asset_id: z.string().min(1),
  attempt_id: z.string().min(1),
  attempted_at: z.number().int().nonnegative(),
  completed_at: z.number().int().nonnegative(),
  source_id: z.string().min(1),
  attempt_code: z.string().min(1),
  admission_code: z.string().min(1),
  fallback_code: z.string().min(1),
  payload_json: z.string().min(1),
  payload_bytes: z.number().int().positive(),
  recorded_at: z.number().int().nonnegative(),
}).strict();

/**
 * Bounded indexed traversal over `report_card_evidence_journal` using
 * `idx_report_card_evidence_journal_retention (recorded_at)` with `(recorded_at, rowid)` pagination
 * (zero table scans, zero temp B-tree).
 */
function readDayEvidenceJournal(
  client: Pick<D1Client, "queryRaw">,
  fromSec: number,
  toSec: number,
): Array<Omit<z.output<typeof EvidenceJournalQueryRowSchema>, "_rowid">> {
  const rows: Array<Omit<z.output<typeof EvidenceJournalQueryRowSchema>, "_rowid">> = [];
  let cursor = "";
  while (true) {
    // SAFETY: fromSec, toSec, PAGE_SIZE, and cursor values are validated safe integers; table/columns are fixed constants.
    const page = selectD1Rows(
      client,
      `SELECT
         rowid AS _rowid,
         journal_id, schema_version, lane, asset_id, attempt_id,
         attempted_at, completed_at, source_id, attempt_code,
         admission_code, fallback_code, payload_json, payload_bytes, recorded_at
       FROM report_card_evidence_journal
       WHERE recorded_at >= ${fromSec} AND recorded_at < ${toSec} ${cursor}
       ORDER BY recorded_at ASC, rowid ASC
       LIMIT ${PAGE_SIZE}`,
      EvidenceJournalQueryRowSchema,
    );
    for (const { _rowid, ...exported } of page) {
      rows.push(exported);
    }
    if (page.length < PAGE_SIZE) break;
    const last = page[page.length - 1]!;
    cursor = `AND (recorded_at, rowid) > (${last.recorded_at}, ${last._rowid})`;
  }
  return rows;
}

const AcceptedCaptureQueryRowSchema = z.object({
  _rowid: z.number().int().nonnegative(),
  generation_id: z.string().min(1),
  published_at: z.number().int().nonnegative(),
  methodology_version: z.string().min(1),
  policy_digest: Sha256Schema,
  evaluation_build_digest: Sha256Schema,
  r2_key: z.string().min(1),
  object_sha256: Sha256Schema,
  object_bytes: z.number().int().nonnegative(),
}).strict();

/**
 * Bounded indexed traversal over `safety_score_capture_archive` using
 * `idx_safety_score_capture_archive_published (published_at)` with `(published_at, rowid)` pagination.
 */
function readDayAcceptedCaptures(client: Pick<D1Client, "queryRaw">, fromSec: number, toSec: number): AcceptedCaptureIndexRow[] {
  const rows: AcceptedCaptureIndexRow[] = [];
  let cursor = "";
  while (true) {
    // SAFETY: fromSec, toSec, PAGE_SIZE, and cursor values are validated safe integers; table/columns are fixed constants.
    const page = selectD1Rows(
      client,
      `SELECT
         rowid AS _rowid,
         generation_id, published_at, methodology_version, policy_digest,
         evaluation_build_digest, r2_key, object_sha256, object_bytes
       FROM safety_score_capture_archive
       WHERE published_at >= ${fromSec} AND published_at < ${toSec} ${cursor}
       ORDER BY published_at ASC, rowid ASC
       LIMIT ${PAGE_SIZE}`,
      AcceptedCaptureQueryRowSchema,
    );
    for (const { _rowid, ...row } of page) {
      rows.push(row);
    }
    if (page.length < PAGE_SIZE) break;
    const last = page[page.length - 1]!;
    cursor = `AND (published_at, rowid) > (${last.published_at}, ${last._rowid})`;
  }
  return rows;
}

function validateRollDayGuards(day: string, nowDate: Date, allowPartial: boolean): { fromSec: number; toSec: number; outOfRetention: boolean } {
  const fromSec = parseUtcDayStartSec(day);
  const toSec = fromSec + 86_400;
  const nowSec = Math.floor(nowDate.getTime() / 1_000);
  const todayUtc = nowDate.toISOString().slice(0, 10);

  if (day >= todayUtc) {
    throw new CliUsageError(`Refusing roll for ${day}: day has not ended (today UTC is ${todayUtc})`);
  }
  if (nowSec < toSec + ROLL_DAY_END_GRACE_SEC) {
    throw new CliUsageError(
      `Refusing roll for ${day}: wait at least ${ROLL_DAY_END_GRACE_SEC / 60} minutes past 23:59:59Z before sealing`,
    );
  }

  const dayStartAgeSec = nowSec - fromSec;
  const pastReserveRetention = dayStartAgeSec > RESERVE_HISTORY_RETENTION_SEC;
  if (pastReserveRetention && !allowPartial) {
    const detail = `day start age (${Math.floor(dayStartAgeSec / 3_600)}h) exceeds ${RESERVE_HISTORY_RETENTION_DAYS}-day reserve_composition_history D1 retention`;
    throw new CliUsageError(`Refusing roll for ${day}: ${detail}; pass --allow-partial to archive partial older days`);
  }
  return { fromSec, toSec, outOfRetention: pastReserveRetention };
}

function resolveRollDays(values: Record<string, unknown>, nowDate: Date): { days: string[]; isRange: boolean } {
  const hasFrom = typeof values.from === "string";
  const hasTo = typeof values.to === "string";
  if (hasFrom !== hasTo) {
    throw new CliUsageError("roll --from and --to must be provided together");
  }
  if (hasFrom && hasTo) {
    const from = values.from as string;
    const to = values.to as string;
    const fromSec = parseUtcDayStartSec(from);
    const toSec = parseUtcDayStartSec(to);
    if (toSec < fromSec) throw new CliUsageError(`roll --to (${to}) must be on or after --from (${from})`);
    const spanDays = Math.floor((toSec - fromSec) / 86_400) + 1;
    if (spanDays > MAX_ROLL_RANGE_DAYS) {
      throw new CliUsageError(`roll range exceeds maximum of ${MAX_ROLL_RANGE_DAYS} days (${spanDays})`);
    }
    const days: string[] = [];
    for (let i = 0; i < spanDays; i += 1) days.push(addUtcDays(from, i));
    return { days, isRange: true };
  }
  const day = typeof values.date === "string" ? values.date : defaultPreviousUtcDay(nowDate);
  parseUtcDayStartSec(day);
  return { days: [day], isRange: false };
}

export interface FreezeValidationArchiveDeps {
  r2?: ValidationArchiveR2Client;
  d1?: Pick<D1Client, "queryRaw">;
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  gitSha?: () => string;
  checkDirtySealPaths?: () => string[];
  readDesignDocAtGitRef?: (gitRef: string) => Buffer | null;
  stdout?: { write(text: string): unknown };
}

export async function runFreezeValidationArchiveCli(
  argv: readonly string[],
  deps: FreezeValidationArchiveDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const { values, positionals } = parseStrictCliArgs(argv, {
    allowPositionals: true,
    conflicts: [
      ["prefix", "manifest"],
      ["date", "from"],
      ["date", "to"],
      ["dry-run", "out"],
    ],
    options: {
      date: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      seal: { type: "boolean" },
      "allow-partial": { type: "boolean" },
      out: { type: "string" },
      prefix: { type: "string" },
      manifest: { type: "string" },
      "dry-run": { type: "boolean" },
      "api-base": { type: "string" },
      database: { type: "string" },
      local: { type: "boolean" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE, stdout)) return 0;

  const mode = positionals[0];
  if (positionals.length !== 1 || !["baseline", "roll", "verify"].includes(mode ?? "")) {
    throw new CliUsageError("Exactly one mode is required: baseline, roll, verify");
  }
  const allowedByMode: Record<string, readonly string[]> = {
    baseline: ["date", "seal", "dry-run", "allow-partial", "out", "prefix", "api-base"],
    roll: ["date", "from", "to", "dry-run", "allow-partial", "prefix", "database", "local"],
    verify: ["prefix", "manifest", "allow-partial"],
  };
  for (const key of Object.keys(values)) {
    if (key !== "help" && !allowedByMode[mode!]!.includes(key)) {
      throw new CliUsageError(`--${key} is not valid for ${mode}`);
    }
  }

  const now = deps.now ?? (() => new Date());
  const allowPartial = values["allow-partial"] === true;
  const getR2 = (): ValidationArchiveR2Client => deps.r2 ?? createR2MeasurementsClient();
  const readDesignAtRef = deps.readDesignDocAtGitRef ?? readGitDesignDoc;

  if (mode === "baseline") {
    const date = values.date;
    if (typeof date !== "string") throw new CliUsageError("baseline requires --date YYYY-MM-DD");
    parseUtcDayStartSec(date);
    const canonicalPrefix = assertValidationArchivePrefix(`${VALIDATION_ARCHIVE_PREFIX}pre-cliff-${date.slice(0, 7)}/`);
    const prefix = typeof values.prefix === "string"
      ? assertValidationArchivePrefix(values.prefix)
      : canonicalPrefix;

    const nowDate = now();
    const capturedAt = nowDate.toISOString();
    const capturedDate = capturedAt.slice(0, 10);
    const dryRun = values["dry-run"] === true;
    const sealing = values.seal === true && !dryRun;
    const env = deps.env ?? process.env;
    const rawApiBase = typeof values["api-base"] === "string"
      ? values["api-base"]
      : (env.PHAROS_API_BASE?.trim() || DEFAULT_API_BASE);
    const { apiBase, isTrustedProdOrigin } = parseAndValidateApiBase(rawApiBase);

    if (sealing && !isTrustedProdOrigin) {
      throw new CliUsageError(
        `Refusing baseline --seal against non-production API origin (${apiBase}); expected ${TRUSTED_PROD_API_ORIGIN} (omit --seal or pass --dry-run for local preview)`,
      );
    }
    if (sealing && date > PRE_CLIFF_BASELINE_MAX_DATE) {
      throw new CliUsageError(
        `Refusing baseline --seal for ${date}: exceeds registered pre-cliff baseline deadline (${PRE_CLIFF_BASELINE_MAX_DATE}, strictly before ${MICA_CLIFF_EVENT_DATE} MiCA cliff)`,
      );
    }
    if (sealing && date !== capturedDate) {
      throw new CliUsageError(
        `Refusing baseline --seal: --date (${date}) disagrees with actual UTC capture date (${capturedDate}) for live reads`,
      );
    }
    if (sealing && allowPartial && isCanonicalValidationPrefix(prefix)) {
      throw new CliUsageError(
        `Refusing partial baseline --seal on canonical prefix ${prefix}: pass an explicit non-canonical --prefix (e.g. ${VALIDATION_ARCHIVE_PREFIX}partial/pre-cliff-${date.slice(0, 7)}/)`,
      );
    }
    const designSha256 = computeDesignSha256();
    if (sealing) {
      const dirtyPaths = (deps.checkDirtySealPaths ?? defaultCheckDirtySealPaths)();
      if (dirtyPaths.length > 0) {
        throw new Error(`Refusing baseline --seal with uncommitted changes in tracked design/compliance/regime paths: ${dirtyPaths.join(", ")}`);
      }
      const headDoc = readDesignAtRef("HEAD");
      if (headDoc === null || sha256Hex(headDoc) !== designSha256) {
        throw new Error(`Refusing baseline --seal: ${DESIGN_DOC_REPO_PATH} does not match committed HEAD`);
      }
    }

    const gitSha = (deps.gitSha ?? (() => execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim()))();
    const { compliance, cohorts } = loadActiveComplianceInputs();

    const stagedObjects: Array<{ role: string; date?: string; r2Key: string; body: Buffer; sha256: string; bytes: number }> = [];
    const skipped: SkippedArchiveEntry[] = [];
    const stageGzipPayload = (role: string, rawBytes: Uint8Array, objectDate?: string) => {
      const gz = gzipSync(rawBytes, { level: 9 });
      const digest = sha256Hex(gz);
      stagedObjects.push({
        role,
        ...(objectDate ? { date: objectDate } : {}),
        r2Key: assertValidationArchiveKey(`${prefix}${digest}.json.gz`),
        body: gz,
        sha256: digest,
        bytes: gz.byteLength,
      });
    };

    for (let offset = BASELINE_SNAPSHOT_WINDOW_DAYS - 1; offset >= 0; offset -= 1) {
      const snapDate = addUtcDays(date, -offset);
      const snap = await fetchPharosJsonBytes(apiBase, `/api/snapshots/${snapDate}.json`, deps.fetch, env);
      if (!snap.ok) {
        skipped.push({ role: "public-snapshot", date: snapDate, reason: snap.reason });
        continue;
      }
      const validated = BaselinePublicSnapshotPayloadSchema.safeParse(snap.parsed);
      if (!validated.success) {
        skipped.push({ role: "public-snapshot", date: snapDate, reason: `invalid-payload:${summarizeZodError(validated.error)}` });
        continue;
      }
      if (validated.data.snapshotDate !== snapDate) {
        skipped.push({ role: "public-snapshot", date: snapDate, reason: `snapshot-date-mismatch:${validated.data.snapshotDate}!=${snapDate}` });
        continue;
      }
      stageGzipPayload("public-snapshot", snap.bytes, snapDate);
    }

    const peg = await fetchPharosJsonBytes(apiBase, "/api/peg-summary", deps.fetch, env);
    if (!peg.ok) {
      skipped.push({ role: "peg-summary", date: capturedDate, reason: peg.reason });
    } else {
      const validated = BaselinePegSummaryPayloadSchema.safeParse(peg.parsed);
      if (!validated.success) {
        skipped.push({ role: "peg-summary", date: capturedDate, reason: `invalid-payload:${summarizeZodError(validated.error)}` });
      } else {
        stageGzipPayload("peg-summary", peg.bytes, capturedDate);
      }
    }

    const dex = await fetchPharosJsonBytes(apiBase, "/api/dex-liquidity", deps.fetch, env);
    if (!dex.ok) {
      skipped.push({ role: "dex-liquidity", date: capturedDate, reason: dex.reason });
    } else {
      const validated = BaselineDexLiquidityPayloadSchema.safeParse(dex.parsed);
      if (!validated.success) {
        skipped.push({ role: "dex-liquidity", date: capturedDate, reason: `invalid-payload:${summarizeZodError(validated.error)}` });
      } else {
        stageGzipPayload("dex-liquidity", dex.bytes, capturedDate);
      }
    }

    let safetyScoreIdentity: z.output<typeof SafetyScoreV9PublicationIdentitySchema> | null = null;
    const cards = await fetchPharosJsonBytes(apiBase, "/api/report-cards/v9", deps.fetch, env);
    if (!cards.ok) {
      skipped.push({ role: "report-cards-v9", date: capturedDate, reason: cards.reason });
    } else {
      const validated = BaselineReportCardsV9PayloadSchema.safeParse(cards.parsed);
      if (!validated.success) {
        skipped.push({ role: "report-cards-v9", date: capturedDate, reason: `invalid-payload:${summarizeZodError(validated.error)}` });
      } else {
        safetyScoreIdentity = validated.data.safetyScoreIdentity;
        stageGzipPayload("report-cards-v9", cards.bytes, capturedDate);
      }
    }

    const fetchImpl = deps.fetch ?? fetch;
    const markets = await collectGlobalOrderbooks(fetchImpl, nowDate);
    const eligibility = await collectRegionalEligibility(
      fetchImpl,
      capturedAt,
      (_source, gzDigest) => `${prefix}${gzDigest}.bin.gz`,
    );
    for (const blob of eligibility.stagedBlobs) {
      stagedObjects.push({ ...blob, date: capturedDate });
    }
    const finishedDate = now().toISOString().slice(0, 10);
    if (sealing && finishedDate !== date) {
      stdout.write(`${JSON.stringify({
        ok: false,
        sealed: false,
        reason: "baseline-collection-crossed-utc-midnight",
        baselineDate: date,
        finishedDate,
        manifestKey: `${prefix}manifest.json`,
      }, null, 2)}\n`);
      return 1;
    }

    const isIncomplete = skipped.length > 0 || safetyScoreIdentity === null;
    if (sealing && isIncomplete && !allowPartial) {
      stdout.write(`${JSON.stringify({
        ok: false,
        sealed: false,
        reason: "incomplete-baseline",
        manifestKey: `${prefix}manifest.json`,
        skipped,
      }, null, 2)}\n`);
      return 1;
    }

    const manifest = PreCliffBaselineManifestSchema.parse({
      schemaVersion: 1,
      kind: "pre-cliff-baseline",
      apiBase,
      baselineDate: date,
      capturedDate,
      capturedAt,
      gitSha,
      designSha256,
      partial: isIncomplete,
      safetyScoreIdentity,
      regimes: {
        genius: GENIUS_REGIME_STATE,
        micaEvent: MICA_CLIFF_EVENT_DATE,
        geniusEvent: GENIUS_CLIFF_EVENT_DATE,
      },
      compliance,
      cohorts,
      venues: buildStaticVenues(),
      markets,
      regionalEligibility: eligibility.observations,
      objects: stagedObjects.map(({ role, date: d, sha256, bytes, r2Key }) => ({
        role,
        ...(d ? { date: d } : {}),
        sha256,
        bytes,
        r2Key,
      })),
      skipped,
    });

    const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
    if (sealing) {
      const r2 = getR2();
      for (const obj of stagedObjects) {
        await sealArchiveObject(r2, obj.r2Key, obj.body, {
          contentType: "application/gzip",
          cacheControl: "public, max-age=31536000, immutable",
          allowIdenticalReuse: true,
        });
      }
      await sealArchiveObject(r2, `${prefix}manifest.json`, Buffer.from(manifestJson, "utf8"), {
        contentType: "application/json",
        cacheControl: "public, max-age=31536000, immutable",
        allowIdenticalReuse: false,
      });
    }
    if (typeof values.out === "string") {
      writeFileResolved(values.out, manifestJson);
    }
    stdout.write(`${JSON.stringify({
      ok: !isIncomplete || allowPartial,
      sealed: sealing,
      partial: manifest.partial,
      apiBase,
      manifestKey: `${prefix}manifest.json`,
      manifestSha256: sha256Hex(manifestJson),
      designSha256,
      cohortsCount: manifest.cohorts.length,
      cohortCounts: countPreCliffCohorts(manifest.cohorts),
      objectsCount: manifest.objects.length,
      marketsCount: manifest.markets.length,
      regionalEligibilityCount: manifest.regionalEligibility.length,
      skipped,
      out: typeof values.out === "string" ? values.out : null,
    }, null, 2)}\n`);
    return !isIncomplete || allowPartial ? 0 : 1;
  }

  if (mode === "roll") {
    const startNowDate = now();
    const { days, isRange } = resolveRollDays(values, startNowDate);
    const dayGuards = days.map((day) => ({ day, ...validateRollDayGuards(day, startNowDate, allowPartial) }));

    const canonicalRollPrefix = assertValidationArchivePrefix(`${VALIDATION_ARCHIVE_PREFIX}rolling/`);
    const rollPrefix = typeof values.prefix === "string"
      ? assertValidationArchivePrefix(values.prefix)
      : canonicalRollPrefix;
    const database = typeof values.database === "string" ? values.database : DEFAULT_PROD_D1_DATABASE;
    const isNonProdD1 = values.local === true || database !== DEFAULT_PROD_D1_DATABASE;
    const dryRun = values["dry-run"] === true || isNonProdD1;
    const forcedDryRunReason = isNonProdD1
      ? (values.local === true ? "local-d1-target" : "non-default-d1-database")
      : null;

    if (!dryRun && allowPartial && isCanonicalValidationPrefix(rollPrefix)) {
      throw new CliUsageError(
        `Refusing partial roll seal on canonical prefix ${rollPrefix}: pass an explicit non-canonical --prefix (e.g. ${VALIDATION_ARCHIVE_PREFIX}partial/rolling/) or --dry-run`,
      );
    }

    const d1 = deps.d1 ?? createD1Client(database, {
      cwd: resolve(REPO_ROOT, "worker"),
      target: values.local === true ? "local" : "remote",
    });
    const r2 = getR2();
    const fetchImpl = deps.fetch ?? fetch;
    const toNdjsonGz = (rows: readonly Record<string, unknown>[]): Buffer =>
      gzipSync(Buffer.from(rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : ""), "utf8"), { level: 9 });

    const daySummaries: Array<Record<string, unknown>> = [];
    let anyFailed = false;

    for (const { day, fromSec, toSec, outOfRetention } of dayGuards) {
      const manifestKey = `${rollPrefix}manifests/${day}.json`;
      if (isRange && !dryRun) {
        if ((await r2.head(manifestKey)) !== null) {
          daySummaries.push({ ok: true, sealed: true, alreadySealed: true, day, manifestKey });
          continue;
        }
      }

      const reserveRows = readDayReserveHistory(d1, fromSec, toSec);
      const journalRows = readDayEvidenceJournal(d1, fromSec, toSec);
      const captureRows = readDayAcceptedCaptures(d1, fromSec, toSec);
      const dailyFirst = selectDailyFirstAcceptedCaptures(captureRows).find((entry) => entry.day === day);

      const staged: Array<{ role: string; date?: string; observedDate?: string; r2Key: string; body: Buffer; contentType: string }> = [];
      const existingObjects: ArchiveObjectEntry[] = [];
      const skippedFamilies: Array<{ role: string; reason: string }> = [];
      let missingRequiredSource = outOfRetention;

      if (outOfRetention) {
        skippedFamilies.push({ role: "d1-retention-window", reason: "day-older-than-full-d1-retention" });
      }

      staged.push({
        role: "reserve-composition-history",
        date: day,
        r2Key: `${rollPrefix}reserve-composition-history/${day}.ndjson.gz`,
        body: toNdjsonGz(reserveRows),
        contentType: "application/gzip",
      });
      staged.push({
        role: "report-card-evidence-journal",
        date: day,
        r2Key: `${rollPrefix}report-card-evidence-journal/${day}.ndjson.gz`,
        body: toNdjsonGz(journalRows),
        contentType: "application/gzip",
      });

      let v9Archived = 0;
      if (!dailyFirst) {
        skippedFamilies.push({ role: "v9-accepted", reason: "no-accepted-capture-for-day" });
        missingRequiredSource = true;
      } else {
        const canonicalKey = archiveObjectKey(dailyFirst.capture);
        if (dailyFirst.capture.r2_key !== canonicalKey) {
          throw new Error(`v9-accepted non-canonical r2_key: ${dailyFirst.capture.r2_key} !== ${canonicalKey}`);
        }
        const sourceBytes = await r2.get(canonicalKey);
        if (sourceBytes === null) {
          skippedFamilies.push({ role: "v9-accepted", reason: "source-capture-object-missing" });
          missingRequiredSource = true;
        } else {
          decodeSafetyScoreCaptureArchiveObject(dailyFirst.capture, sourceBytes);
          staged.push({
            role: "v9-accepted",
            date: day,
            r2Key: `${rollPrefix}v9-accepted/${day}.json.gz`,
            body: gzipSync(sourceBytes, { level: 9 }),
            contentType: "application/gzip",
          });
          v9Archived = 1;
        }
      }

      // Sample clock at live collection so D1 reads crossing UTC midnight never mislabel live keys.
      const liveNowDate = now();
      const liveObservedAt = liveNowDate.toISOString();
      const liveObservedDate = liveObservedAt.slice(0, 10);
      const latestCompleteDay = defaultPreviousUtcDay(liveNowDate);

      let marketsCount = 0;
      let eligibilityCount = 0;
      let manifestObservedDate: string | null = null;
      let manifestCapturedAt = liveObservedAt;

      if (day < latestCompleteDay) {
        // Recover already-uploaded live markets + eligibility blobs if a prior run crashed after uploading live payloads before UTC midnight.
        const expectedPriorObsDate = addUtcDays(day, 1);
        let priorMarketKeys: string[] = [];
        let incompleteRecovery = false;
        if (r2.list) {
          try {
            priorMarketKeys = (await r2.list(`${rollPrefix}markets/${expectedPriorObsDate}.`)).sort(compareCodeUnits);
          } catch {
            incompleteRecovery = true;
          }
        }
        let selectedRecovery: {
          priorKey: string;
          priorBytes: Buffer;
          payload: z.output<typeof RollingMarketsPayloadSchema>;
          eligEntries: ArchiveObjectEntry[];
        } | null = null;
        for (const priorKey of priorMarketKeys) {
          let priorBytes: Buffer | null;
          try {
            priorBytes = await r2.get(priorKey);
          } catch {
            incompleteRecovery = true;
            continue;
          }
          if (priorBytes === null) {
            incompleteRecovery = true;
            continue;
          }
          let decoded: unknown;
          try {
            decoded = JSON.parse(gunzipSync(priorBytes).toString("utf8"));
          } catch {
            incompleteRecovery = true;
            continue;
          }
          const parsedPayload = RollingMarketsPayloadSchema.safeParse(decoded);
          if (!parsedPayload.success) {
            incompleteRecovery = true;
            continue;
          }
          if (parsedPayload.data.exportDay !== day) continue;
          if (parsedPayload.data.observedDate !== expectedPriorObsDate) {
            incompleteRecovery = true;
            continue;
          }
          const recoveredEligEntries: ArchiveObjectEntry[] = [];
          let allBlobsValid = true;
          for (const obs of parsedPayload.data.regionalEligibility) {
            if (obs.status === "ok") {
              if (obs.r2Key === null || obs.bytes === null || obs.bodySha256 === null) {
                allBlobsValid = false;
                break;
              }
              let blobBytes: Buffer | null;
              try {
                blobBytes = await r2.get(obs.r2Key);
              } catch {
                allBlobsValid = false;
                break;
              }
              if (blobBytes === null || verifyEligibilityBlobContent(obs, blobBytes) !== null) {
                allBlobsValid = false;
                break;
              }
              recoveredEligEntries.push({
                role: `regional-eligibility:${obs.sourceId}`,
                observedDate: expectedPriorObsDate,
                sha256: sha256Hex(blobBytes),
                bytes: blobBytes.byteLength,
                r2Key: obs.r2Key,
              });
            } else if (obs.r2Key !== null || obs.bytes !== null || obs.bodySha256 !== null) {
              allBlobsValid = false;
              break;
            }
          }
          if (!allBlobsValid) {
            incompleteRecovery = true;
            continue;
          }
          if (selectedRecovery === null) {
            selectedRecovery = { priorKey, priorBytes, payload: parsedPayload.data, eligEntries: recoveredEligEntries };
          }
        }
        if (incompleteRecovery) {
          skippedFamilies.push({ role: "markets", reason: "incomplete-live-recovery-after-midnight" });
          missingRequiredSource = true;
        } else if (selectedRecovery !== null) {
          existingObjects.push(...selectedRecovery.eligEntries, {
            role: "markets",
            observedDate: expectedPriorObsDate,
            sha256: sha256Hex(selectedRecovery.priorBytes),
            bytes: selectedRecovery.priorBytes.byteLength,
            r2Key: selectedRecovery.priorKey,
          });
          marketsCount = selectedRecovery.payload.markets.length;
          eligibilityCount = selectedRecovery.payload.regionalEligibility.length;
          manifestObservedDate = expectedPriorObsDate;
          manifestCapturedAt = selectedRecovery.payload.observedAt;
        } else {
          skippedFamilies.push({ role: "markets", reason: "historical-day-no-live-orderbook" });
        }
      } else {
        const markets = await collectGlobalOrderbooks(fetchImpl, liveNowDate);
        const eligibility = await collectRegionalEligibility(
          fetchImpl,
          liveObservedAt,
          (source, gzDigest) => `${rollPrefix}eligibility/${liveObservedDate}/${source.sourceId}.${gzDigest.slice(0, 8)}.${source.ext}.gz`,
        );
        const afterLiveDate = now().toISOString().slice(0, 10);
        if (afterLiveDate !== liveObservedDate) {
          skippedFamilies.push({ role: "markets", reason: "live-collection-crossed-utc-midnight" });
          missingRequiredSource = true;
        } else {
          manifestObservedDate = liveObservedDate;
          marketsCount = markets.length;
          eligibilityCount = eligibility.observations.length;
          const marketsPayload = RollingMarketsPayloadSchema.parse({
            exportDay: day,
            observedDate: liveObservedDate,
            observedAt: liveObservedAt,
            markets,
            regionalEligibility: eligibility.observations,
          });
          const marketsBody = gzipSync(Buffer.from(`${JSON.stringify(marketsPayload, null, 2)}\n`, "utf8"), { level: 9 });
          const marketsSha8 = sha256Hex(marketsBody).slice(0, 8);
          // Upload referenced eligibility blobs BEFORE markets so a mid-upload crash never leaves an orphan markets blob.
          for (const blob of eligibility.stagedBlobs) {
            staged.push({
              role: blob.role,
              observedDate: liveObservedDate,
              r2Key: blob.r2Key,
              body: blob.body,
              contentType: "application/gzip",
            });
          }
          staged.push({
            role: "markets",
            observedDate: liveObservedDate,
            r2Key: `${rollPrefix}markets/${liveObservedDate}.${marketsSha8}.json.gz`,
            body: marketsBody,
            contentType: "application/gzip",
          });
        }
      }

      const rowCounts: Record<string, number> = {
        "reserve-composition-history": reserveRows.length,
        "report-card-evidence-journal": journalRows.length,
        "v9-accepted": v9Archived,
        markets: marketsCount,
        "regional-eligibility": eligibilityCount,
      };

      if (missingRequiredSource && !allowPartial && !dryRun) {
        anyFailed = true;
        daySummaries.push({
          ok: false,
          sealed: false,
          reason: "missing-required-roll-source",
          day,
          observedDate: manifestObservedDate,
          dryRun,
          forcedDryRunReason,
          manifestKey,
          rowCounts,
          v9GenerationId: dailyFirst?.capture.generation_id ?? null,
          skippedFamilies,
        });
        continue;
      }

      const manifest = RollingDayManifestSchema.parse({
        schemaVersion: 1,
        kind: "rolling-validation-day",
        day,
        observedDate: manifestObservedDate,
        capturedAt: manifestCapturedAt,
        partial: missingRequiredSource,
        rowCounts,
        objects: [
          ...staged.map((obj) => ({
            role: obj.role,
            ...(obj.date ? { date: obj.date } : {}),
            ...(obj.observedDate ? { observedDate: obj.observedDate } : {}),
            sha256: sha256Hex(obj.body),
            bytes: obj.body.byteLength,
            r2Key: obj.r2Key,
          })),
          ...existingObjects,
        ],
        skippedFamilies,
      });
      const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
      if (!dryRun) {
        for (const obj of staged) {
          await sealArchiveObject(r2, obj.r2Key, obj.body, {
            contentType: obj.contentType,
            cacheControl: "public, max-age=31536000, immutable",
            allowIdenticalReuse: true,
          });
        }
        await sealArchiveObject(r2, manifestKey, Buffer.from(manifestJson, "utf8"), {
          contentType: "application/json",
          cacheControl: "public, max-age=31536000, immutable",
          allowIdenticalReuse: false,
        });
      }
      daySummaries.push({
        ok: !missingRequiredSource || allowPartial,
        sealed: !dryRun,
        partial: manifest.partial,
        day,
        observedDate: manifest.observedDate,
        dryRun,
        forcedDryRunReason,
        manifestKey,
        rowCounts,
        reserveRows: reserveRows.length,
        journalRows: journalRows.length,
        v9GenerationId: dailyFirst?.capture.generation_id ?? null,
        objects: manifest.objects,
        skippedFamilies,
      });
      if (missingRequiredSource && !allowPartial) anyFailed = true;
    }

    if (isRange) {
      stdout.write(`${JSON.stringify({ ok: !anyFailed, range: { from: days[0], to: days[days.length - 1] }, dryRun, forcedDryRunReason, days: daySummaries }, null, 2)}\n`);
    } else {
      stdout.write(`${JSON.stringify(daySummaries[0], null, 2)}\n`);
    }
    return anyFailed ? 1 : 0;
  }

  // verify mode
  const r2 = getR2();
  let manifestKeys: string[];
  if (typeof values.manifest === "string") {
    try {
      manifestKeys = [assertValidationArchiveKey(values.manifest)];
    } catch (error) {
      throw new CliUsageError(error instanceof Error ? error.message : String(error));
    }
  } else {
    const prefix = typeof values.prefix === "string"
      ? assertValidationArchivePrefix(values.prefix)
      : VALIDATION_ARCHIVE_PREFIX;
    if (!r2.list) throw new Error("R2 client does not support list()");
    const keys = await r2.list(prefix);
    manifestKeys = keys.filter((key) => key.endsWith("/manifest.json") || /\/manifests\/\d{4}-\d{2}-\d{2}\.json$/.test(key)).sort(compareCodeUnits);
  }
  if (manifestKeys.length === 0) {
    stdout.write(`${JSON.stringify({ ok: false, reason: "no-manifests-found", checkedManifests: 0 })}\n`);
    return 1;
  }

  const results: Array<{ manifestKey: string; result: VerifyArchiveResult }> = [];
  for (const manifestKey of manifestKeys) {
    const bytes = await r2.get(manifestKey);
    if (bytes === null) {
      results.push({
        manifestKey,
        result: {
          ok: false,
          checked: 0,
          failures: [{ r2Key: manifestKey, reason: "missing", expectedSha256: "", actualSha256: null, expectedBytes: 0, actualBytes: null }],
        },
      });
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      results.push({
        manifestKey,
        result: {
          ok: false,
          checked: 0,
          failures: [{
            r2Key: manifestKey,
            reason: "malformed-manifest",
            expectedSha256: "",
            actualSha256: sha256Hex(bytes),
            expectedBytes: 0,
            actualBytes: bytes.byteLength,
            detail: error instanceof Error ? error.message : String(error),
          }],
        },
      });
      continue;
    }

    const kind = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { kind?: unknown }).kind : undefined;
    if (kind === "rolling-validation-day") {
      const parsed = RollingDayManifestSchema.safeParse(raw);
      if (!parsed.success) {
        results.push({
          manifestKey,
          result: {
            ok: false,
            checked: 0,
            failures: [{
              r2Key: manifestKey,
              reason: "malformed-manifest",
              expectedSha256: "",
              actualSha256: sha256Hex(bytes),
              expectedBytes: 0,
              actualBytes: bytes.byteLength,
              detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
            }],
          },
        });
        continue;
      }
      const objectCheck = await verifyArchiveManifest(r2, parsed.data);
      const completenessIssues = collectRollingCompletenessIssues(parsed.data);
      const marketsObj = parsed.data.objects.find((obj) => obj.role === "markets");
      if (marketsObj && !objectCheck.failures.some((f) => f.r2Key === marketsObj.r2Key)) {
        const marketsBytes = await r2.get(marketsObj.r2Key);
        if (marketsBytes !== null) {
          try {
            const decoded = JSON.parse(gunzipSync(marketsBytes).toString("utf8"));
            const parsedMarkets = RollingMarketsPayloadSchema.safeParse(decoded);
            if (!parsedMarkets.success) {
              completenessIssues.push(`malformed rolling markets payload:${marketsObj.r2Key}`);
            } else {
              const objectKeys = new Set(parsed.data.objects.map((obj) => obj.r2Key));
              for (const obs of parsedMarkets.data.regionalEligibility) {
                if (obs.status !== "ok") {
                  if (obs.r2Key !== null || obs.bytes !== null || obs.bodySha256 !== null) {
                    completenessIssues.push(`unavailable rolling regionalEligibility has unexpected integrity metadata:${obs.sourceId}`);
                  }
                } else if (obs.r2Key === null || obs.bytes === null || obs.bodySha256 === null) {
                  completenessIssues.push(`missing integrity metadata on rolling regionalEligibility:${obs.sourceId}`);
                } else if (!objectKeys.has(obs.r2Key)) {
                  completenessIssues.push(`missing rolling regionalEligibility object:${obs.sourceId}:${obs.r2Key}`);
                } else {
                  const blobBytes = await r2.get(obs.r2Key);
                  const contentIssue = blobBytes === null ? `missing rolling regionalEligibility blob:${obs.r2Key}` : verifyEligibilityBlobContent(obs, blobBytes);
                  if (contentIssue) completenessIssues.push(contentIssue);
                }
              }
            }
          } catch {
            completenessIssues.push(`unreadable gzipped markets payload:${marketsObj.r2Key}`);
          }
        }
      }
      const failures = [...objectCheck.failures];
      if (parsed.data.partial && !allowPartial) {
        failures.push({
          r2Key: manifestKey,
          reason: "partial-archive-not-complete",
          expectedSha256: "",
          actualSha256: sha256Hex(bytes),
          expectedBytes: 0,
          actualBytes: bytes.byteLength,
          detail: "rolling manifest is marked partial: true; pass --allow-partial to accept a partial archive",
        });
      }
      if (completenessIssues.length > 0) {
        failures.push({
          r2Key: manifestKey,
          reason: "incomplete-roll",
          expectedSha256: "",
          actualSha256: sha256Hex(bytes),
          expectedBytes: 0,
          actualBytes: bytes.byteLength,
          detail: completenessIssues.join("; "),
        });
      }
      results.push({
        manifestKey,
        result: { ok: failures.length === 0, partial: parsed.data.partial, checked: objectCheck.checked, failures },
      });
      continue;
    }

    if (kind === "pre-cliff-baseline") {
      const parsed = PreCliffBaselineManifestSchema.safeParse(raw);
      if (!parsed.success) {
        results.push({
          manifestKey,
          result: {
            ok: false,
            checked: 0,
            failures: [{
              r2Key: manifestKey,
              reason: "malformed-manifest",
              expectedSha256: "",
              actualSha256: sha256Hex(bytes),
              expectedBytes: 0,
              actualBytes: bytes.byteLength,
              detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
            }],
          },
        });
        continue;
      }
      const objectCheck = await verifyArchiveManifest(r2, parsed.data);
      const failures = [...objectCheck.failures];
      if (parsed.data.partial && !allowPartial) {
        failures.push({
          r2Key: manifestKey,
          reason: "partial-archive-not-complete",
          expectedSha256: "",
          actualSha256: sha256Hex(bytes),
          expectedBytes: 0,
          actualBytes: bytes.byteLength,
          detail: "baseline manifest is marked partial: true; pass --allow-partial to accept a partial archive",
        });
      }
      const completenessIssues = collectBaselineCompletenessIssues(parsed.data);
      for (const obs of parsed.data.regionalEligibility) {
        if (obs.status !== "ok") {
          if (obs.r2Key !== null || obs.bytes !== null || obs.bodySha256 !== null) {
            completenessIssues.push(`unavailable baseline regionalEligibility has unexpected integrity metadata:${obs.sourceId}`);
          }
        } else if (obs.r2Key === null || obs.bytes === null || obs.bodySha256 === null) {
          completenessIssues.push(`missing integrity metadata on baseline regionalEligibility:${obs.sourceId}`);
        } else if (!objectCheck.failures.some((f) => f.r2Key === obs.r2Key)) {
          const blobBytes = await r2.get(obs.r2Key);
          const contentIssue = blobBytes === null ? `missing baseline regionalEligibility blob:${obs.r2Key}` : verifyEligibilityBlobContent(obs, blobBytes);
          if (contentIssue) completenessIssues.push(contentIssue);
        }
      }
      if (completenessIssues.length > 0) {
        failures.push({
          r2Key: manifestKey,
          reason: "incomplete-baseline",
          expectedSha256: "",
          actualSha256: sha256Hex(bytes),
          expectedBytes: 0,
          actualBytes: bytes.byteLength,
          detail: completenessIssues.join("; "),
        });
      }
      const designBytes = readDesignAtRef(parsed.data.gitSha);
      if (designBytes === null) {
        failures.push({
          r2Key: manifestKey,
          reason: "design-doc-unverifiable-at-git-sha",
          expectedSha256: parsed.data.designSha256,
          actualSha256: null,
          expectedBytes: 0,
          actualBytes: null,
          detail: `could not read ${DESIGN_DOC_REPO_PATH} at gitSha ${parsed.data.gitSha}`,
        });
      } else {
        const actualDesignSha = sha256Hex(designBytes);
        if (actualDesignSha !== parsed.data.designSha256) {
          failures.push({
            r2Key: manifestKey,
            reason: "design-sha256-mismatch",
            expectedSha256: parsed.data.designSha256,
            actualSha256: actualDesignSha,
            expectedBytes: 0,
            actualBytes: designBytes.byteLength,
            detail: `design doc at ${parsed.data.gitSha} does not match manifest designSha256`,
          });
        }
      }
      results.push({
        manifestKey,
        result: { ok: failures.length === 0, partial: parsed.data.partial, checked: objectCheck.checked, failures },
      });
      continue;
    }

    results.push({
      manifestKey,
      result: {
        ok: false,
        checked: 0,
        failures: [{
          r2Key: manifestKey,
          reason: "malformed-manifest",
          expectedSha256: "",
          actualSha256: sha256Hex(bytes),
          expectedBytes: 0,
          actualBytes: bytes.byteLength,
          detail: `Unsupported manifest kind: ${String(kind)}`,
        }],
      },
    });
  }

  const ok = results.every((entry) => entry.result.ok);
  stdout.write(`${JSON.stringify({ ok, checkedManifests: results.length, results }, null, 2)}\n`);
  return ok ? 0 : 1;
}

runDirectCli(
  import.meta.url,
  async () => {
    process.exitCode = await runFreezeValidationArchiveCli(process.argv.slice(2));
  },
  { label: "freeze-validation-archive", usage: USAGE },
);
