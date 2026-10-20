/**
 * Fetches all digests from an explicit API base/URL and writes them to data/digests.json.
 * Run before builds to ensure static digest pages have fresh data:
 *   DIGEST_API_URL=https://ops-api.example.com tsx scripts/maintenance/sync-digests.ts
 */

import { formatIsoDate } from "@shared/lib/format";
import {
  DigestArchiveCursorSchema,
  DigestArchiveEntrySchema,
  DigestArchiveResponseSchema,
  DigestStoredSnapshotSchema,
  type DigestArchiveEntry,
  type DigestContentEntry,
} from "@shared/types/digest";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath, URL } from "node:url";
import { parseStrictCliArgs, runDirectCli, writeCliHelpIfRequested } from "../lib/cli-args.mjs";
import {
  apiFetchHeaders,
  fetchWithRetry,
  preserveExistingJsonArrayOnFetchFailure,
  resolveApiUrl,
  shouldAllowExistingDataOnFetchFailure,
  SnapshotIntegrityError,
  syncJson,
} from "../lib/sync-from-api";

const USAGE = `Usage: npx tsx scripts/maintenance/sync-digests.ts [options]

Options:
  --api-url <url>   Digest API base or endpoint (overrides environment)
  --output <path>   Output path (default: data/digests.json)
  --allow-archive-shrink
                   Permit published digest slugs to disappear from the snapshot
  --dry-run         Fetch and validate without writing the output file
  --allow-existing-on-fetch-failure
                   Preserve a valid existing output file if the live fetch fails
  --check           Verify script wiring without network or file writes
  -h, --help        Show this help`;

// Older archive responses omit nullable display metrics and edition copy fields.
const DigestSyncResponseSchema = DigestArchiveResponseSchema.extend({
  digests: DigestArchiveEntrySchema.extend({
    digestTitle: DigestArchiveEntrySchema.shape.digestTitle.default(null),
    digestExtended: DigestArchiveEntrySchema.shape.digestExtended.default(null),
    psiScore: DigestArchiveEntrySchema.shape.psiScore.default(null),
    psiBand: DigestArchiveEntrySchema.shape.psiBand.default(null),
    totalMcapUsd: DigestArchiveEntrySchema.shape.totalMcapUsd.default(null),
    generatedAt: DigestArchiveEntrySchema.shape.generatedAt.refine(
      (timestamp) => Number.isFinite(new Date(timestamp * 1000).getTime()),
      "Digest generation timestamp must be a representable date",
    ),
  }).array(),
});


export interface DigestSyncCliOptions {
  allowArchiveShrink: boolean;
  allowExistingOnFetchFailure: boolean;
  apiUrl: string | null;
  check: boolean;
  dryRun: boolean;
  help: boolean;
  output: string | null;
}

export function parseDigestSyncArgs(argv: string[]): DigestSyncCliOptions {
  const { values } = parseStrictCliArgs(argv, {
    conflicts: [["check", "dry-run"]],
    options: {
      "allow-archive-shrink": { type: "boolean" },
      "api-url": { type: "string" },
      "allow-existing-on-fetch-failure": { type: "boolean" },
      check: { type: "boolean" },
      "dry-run": { type: "boolean" },
      output: { type: "string" },
    },
  });
  return {
    allowArchiveShrink: values["allow-archive-shrink"] === true,
    allowExistingOnFetchFailure: values["allow-existing-on-fetch-failure"] === true,
    apiUrl: typeof values["api-url"] === "string" ? values["api-url"] : null,
    check: values.check === true,
    dryRun: values["dry-run"] === true,
    help: values.help === true,
    output: typeof values.output === "string" ? values.output : null,
  };
}

function readExistingDigestEntries(outputPath: URL): readonly DigestContentEntry[] {
  const outputFile = fileURLToPath(outputPath);
  if (!existsSync(outputFile)) return [];
  return DigestStoredSnapshotSchema.parse(JSON.parse(readFileSync(outputFile, "utf8")));
}

export function findMissingDigestArchiveDates(
  previous: readonly DigestContentEntry[],
  current: readonly DigestContentEntry[],
): string[] {
  const currentDates = new Set(current.map((entry) => entry.date));
  return previous.map((entry) => entry.date).filter((date) => !currentDates.has(date));
}

export function assertDigestArchivePreserved(
  previous: readonly DigestContentEntry[],
  current: readonly DigestContentEntry[],
  allowShrink = false,
): void {
  const missing = findMissingDigestArchiveDates(previous, current);
  if (missing.length === 0) return;
  const sample = missing.slice(0, 10).join(", ");
  const suffix = missing.length > 10 ? ` (+${missing.length - 10} more)` : "";
  const message = `Digest archive lost ${missing.length} published slug(s): ${sample}${suffix}`;
  if (!allowShrink) {
    throw new SnapshotIntegrityError(`${message}. Pass --allow-archive-shrink only for an explicitly reviewed removal.`);
  }
  console.warn(`[sync-digests] WARNING: ${message}`);
}

/** Keep one published route per digest date. A same-day editorial rerun can
 * leave multiple archive rows upstream, but the static route and sitemap have
 * only one canonical URL for that date. */
export function deduplicateDigestEntries(entries: readonly DigestContentEntry[]): DigestContentEntry[] {
  const latestByDate = new Map<string, DigestContentEntry>();
  for (const entry of entries) {
    const existing = latestByDate.get(entry.date);
    if (
      !existing
      || entry.generatedAt > existing.generatedAt
      || (entry.generatedAt === existing.generatedAt && entry.editionNumber > existing.editionNumber)
    ) {
      latestByDate.set(entry.date, entry);
    }
  }
  return [...latestByDate.values()].sort(
    (left, right) => right.generatedAt - left.generatedAt || left.date.localeCompare(right.date),
  );
}

function resolveOutputPath(explicitOutput: string | null): URL {
  if (!explicitOutput) {
    return new URL("../../data/digests.json", import.meta.url);
  }

  return new URL(explicitOutput, `file://${process.cwd()}/`);
}

function cacheBustedUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.searchParams.set("staticSync", String(Date.now()));
  url.searchParams.set("history", "all");
  url.searchParams.delete("cursor");
  return url.toString();
}

export async function runDigestSync(argv = process.argv.slice(2)) {
  const options = parseDigestSyncArgs(argv);
  if (writeCliHelpIfRequested(options, USAGE)) return;

  // --check mode is a smoke test for the script's own wiring (no network).
  if (options.check) {
    console.log("[sync-digests] --check mode: helpers wired OK.");
    return;
  }

  const apiUrl = resolveApiUrl({
    argName: "--api-url",
    explicitUrl: options.apiUrl,
    envNames: ["DIGEST_API_URL", "SMOKE_API_BASE", "API_BASE_URL"],
    apiPath: "/api/digest-archive",
    scriptName: "sync-digests",
  });
  const outputPath = resolveOutputPath(options.output);
  const previousEntries = readExistingDigestEntries(outputPath);
  console.log("Fetching digest archive...");
  console.log(`Digest source: ${apiUrl}`);
  const fetchUrl = cacheBustedUrl(apiUrl);
  const headers = new Headers(apiFetchHeaders(["DIGEST_API_KEY"], { url: fetchUrl }));
  headers.set("Cache-Control", "no-cache");
  headers.set("Pragma", "no-cache");

  try {
    const { entries, outputFile } = await syncJson<DigestContentEntry>({
      writeTo: outputPath,
      parse: async () => {
        const digests: DigestArchiveEntry[] = [];
        let cursor: string | null = null;
        let horizon: number | null = null;
        let total: number | null = null;
        let scanned = 0;
        do {
          const pageUrl = new URL(fetchUrl);
          if (cursor) pageUrl.searchParams.set("cursor", cursor);
          const res = await fetchWithRetry(
            pageUrl.toString(),
            { headers },
            { logLabel: "sync-digests", retryStatuses: [403], backoffMs: [12_000, 12_000] },
          );
          if (!res.ok) {
            await res.body?.cancel();
            throw new Error(`API returned ${res.status}`);
          }
          let payload: unknown;
          try {
            payload = await res.json();
          } catch (error) {
            if (error instanceof SyntaxError) {
              throw new SnapshotIntegrityError("Invalid digest archive response: malformed JSON");
            }
            throw error;
          }
          const parsed = DigestSyncResponseSchema.safeParse(payload);
          if (!parsed.success) {
            throw new SnapshotIntegrityError(`Invalid digest archive response: ${parsed.error.message}`);
          }
          const page = parsed.data;
          if (!page.pagination) {
            throw new SnapshotIntegrityError("Incomplete digest archive traversal: missing or invalid pagination");
          }
          const progress = page.pagination;
          horizon ??= progress.horizon;
          total ??= progress.total;
          const delta = progress.scanned - scanned;
          if (progress.horizon !== horizon || progress.total !== total
            || progress.scanned > total || delta > 365 || delta < page.digests.length
            || (total > 0 ? delta <= 0 : progress.scanned !== 0)
            || (progress.nextCursor === null) !== (progress.scanned === total)) {
            throw new SnapshotIntegrityError("Incomplete digest archive traversal: inconsistent page progress");
          }
          if (progress.nextCursor !== null) {
            const next = DigestArchiveCursorSchema.safeParse(
              /^\d+\.\d+\.\d+\.\d+\.\d+$/.test(progress.nextCursor) ? progress.nextCursor.split(".").map(Number) : null,
            );
            if (!next.success || next.data[0] !== horizon || next.data[1] !== total
              || next.data[2] !== progress.scanned || next.data[4] > horizon) {
              throw new SnapshotIntegrityError("Incomplete digest archive traversal: invalid continuation");
            }
          }
          digests.push(...page.digests);
          scanned = progress.scanned;
          cursor = progress.nextCursor;
        } while (cursor !== null);
        console.log(`Fetched ${digests.length} digests across complete history`);
        const mappedEntries = digests.map((d) => ({
          date: formatIsoDate(d.generatedAt) + (d.digestType === "weekly" ? "-weekly" : ""),
          title: d.digestTitle || "Signal & Noise",
          text: d.digestText,
          extended: d.digestExtended || "",
          generatedAt: d.generatedAt,
          ...(typeof d.llm?.servedModel === "string" && d.llm.servedModel
            ? { llm: { servedModel: d.llm.servedModel } } : {}),
          digestType: d.digestType ?? ("daily" as const),
          editionNumber: d.editionNumber ?? 0,
          // Provenance is persisted only when the upstream edition actually
          // carries it. Editions predating the policy stay absent, and the
          // `pre-policy` sentinel the API computes for display is stripped
          // here: writing it would tag an archive with a policy it never
          // followed, which the provenance contract forbids.
          ...(d.editorialStyleVersion && d.editorialStyleVersion !== "pre-policy"
            ? { editorialStyleVersion: d.editorialStyleVersion }
            : {}),
          ...(d.editorialStyleHash && d.editorialStyleHash !== "pre-policy"
            ? { editorialStyleHash: d.editorialStyleHash }
            : {}),
        }));
        const stored = DigestStoredSnapshotSchema.safeParse(deduplicateDigestEntries(mappedEntries));
        if (!stored.success) {
          throw new SnapshotIntegrityError(`Invalid stored digest snapshot: ${stored.error.message}`);
        }
        const entries = stored.data;
        const duplicateCount = mappedEntries.length - entries.length;
        if (duplicateCount > 0) {
          console.warn(
            `[sync-digests] Deduplicated ${duplicateCount} superseded same-slug digest row(s); latest publication wins.`,
          );
        }
        assertDigestArchivePreserved(previousEntries, entries, options.allowArchiveShrink);
        return entries;
      },
      write: false,
    });
    const written = !options.dryRun;
    if (written) {
      mkdirSync(new URL(".", outputPath), { recursive: true });
      const temporaryFile = `${outputFile}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporaryFile, JSON.stringify(entries, null, 2) + "\n", { flag: "wx" });
        renameSync(temporaryFile, outputFile);
      } finally {
        rmSync(temporaryFile, { force: true });
      }
    }
    console.log(
      written
        ? `Wrote ${entries.length} digests to ${outputFile}`
        : `[sync-digests] Dry run: would write ${entries.length} digests to ${outputFile}`,
    );
  } catch (err) {
    const allowExisting =
      options.allowExistingOnFetchFailure ||
      shouldAllowExistingDataOnFetchFailure(["DIGEST_SYNC_ALLOW_EXISTING_ON_FETCH_FAILURE"]);
    if (
      preserveExistingJsonArrayOnFetchFailure({
        allow: allowExisting && !options.dryRun,
        error: err,
        label: "sync-digests",
        outputPath,
      })
    ) {
      return;
    }
    throw err;
  }
}

runDirectCli(import.meta.url, () => runDigestSync(), { label: "sync-digests", usage: USAGE });
