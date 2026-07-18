/**
 * Fetches all digests from an explicit API base/URL and writes them to data/digests.json.
 * Run before builds to ensure static digest pages have fresh data:
 *   DIGEST_API_URL=https://ops-api.example.com tsx scripts/maintenance/sync-digests.ts
 */

import { formatIsoDate } from "@shared/lib/format";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseStrictCliArgs, runCliEntrypoint, writeCliHelpIfRequested } from "../lib/cli-args.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";
import {
  apiFetchHeaders,
  fetchWithRetry,
  preserveExistingJsonArrayOnFetchFailure,
  resolveApiUrl,
  shouldAllowExistingDataOnFetchFailure,
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

interface ApiDigest {
  digestText: string;
  digestTitle?: string;
  digestExtended?: string;
  generatedAt: number;
  digestType?: "daily" | "weekly";
  editionNumber?: number;
}

export interface DigestEntry {
  date: string;
  title: string;
  text: string;
  extended: string;
  generatedAt: number;
  digestType: "daily" | "weekly";
  editionNumber: number;
}

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

function readExistingDigestEntries(outputPath: URL): readonly DigestEntry[] {
  const outputFile = fileURLToPath(outputPath);
  if (!existsSync(outputFile)) return [];
  const parsed: unknown = JSON.parse(readFileSync(outputFile, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`Existing digest snapshot is not an array: ${outputFile}`);
  }
  return parsed as DigestEntry[];
}

export function findMissingDigestArchiveDates(
  previous: readonly DigestEntry[],
  current: readonly DigestEntry[],
): string[] {
  const currentDates = new Set(current.map((entry) => entry.date));
  return previous.map((entry) => entry.date).filter((date) => !currentDates.has(date));
}

export function assertDigestArchivePreserved(
  previous: readonly DigestEntry[],
  current: readonly DigestEntry[],
  allowShrink = false,
): void {
  const missing = findMissingDigestArchiveDates(previous, current);
  if (missing.length === 0) return;
  const sample = missing.slice(0, 10).join(", ");
  const suffix = missing.length > 10 ? ` (+${missing.length - 10} more)` : "";
  const message = `Digest archive lost ${missing.length} published slug(s): ${sample}${suffix}`;
  if (!allowShrink) {
    throw new Error(`${message}. Pass --allow-archive-shrink only for an explicitly reviewed removal.`);
  }
  console.warn(`[sync-digests] WARNING: ${message}`);
}

/** Keep one published route per digest date. A same-day editorial rerun can
 * leave multiple archive rows upstream, but the static route and sitemap have
 * only one canonical URL for that date. */
export function deduplicateDigestEntries(entries: readonly DigestEntry[]): DigestEntry[] {
  const latestByDate = new Map<string, DigestEntry>();
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
    const { entries, outputFile, written } = await syncJson<DigestEntry>({
      writeTo: outputPath,
      parse: async () => {
        const res = await fetchWithRetry(
          fetchUrl,
          { headers },
          {
            logLabel: "sync-digests",
            retryStatuses: [403],
            backoffMs: [12_000, 12_000],
          },
        );
        if (!res.ok) throw new Error(`API returned ${res.status}`);
        const { digests } = (await res.json()) as { digests: ApiDigest[] };
        console.log(`Fetched ${digests.length} digests`);
        const mappedEntries = digests.map((d) => ({
          date: formatIsoDate(d.generatedAt) + (d.digestType === "weekly" ? "-weekly" : ""),
          title: d.digestTitle || "Signal & Noise",
          text: d.digestText,
          extended: d.digestExtended || "",
          generatedAt: d.generatedAt,
          digestType: d.digestType ?? ("daily" as const),
          editionNumber: d.editionNumber ?? 0,
        }));
        const entries = deduplicateDigestEntries(mappedEntries);
        const duplicateCount = mappedEntries.length - entries.length;
        if (duplicateCount > 0) {
          console.warn(
            `[sync-digests] Deduplicated ${duplicateCount} superseded same-slug digest row(s); latest publication wins.`,
          );
        }
        assertDigestArchivePreserved(previousEntries, entries, options.allowArchiveShrink);
        return entries;
      },
      write: !options.dryRun,
    });
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

if (isDirectRun(import.meta.url, process.argv[1])) {
  void runCliEntrypoint(() => runDigestSync(), { label: "sync-digests", usage: USAGE });
}
