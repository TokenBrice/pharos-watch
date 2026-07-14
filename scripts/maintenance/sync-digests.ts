/**
 * Fetches all digests from an explicit API base/URL and writes them to data/digests.json.
 * Run before builds to ensure static digest pages have fresh data:
 *   DIGEST_API_URL=https://ops-api.example.com tsx scripts/maintenance/sync-digests.ts
 */

import { formatIsoDate } from "@shared/lib/format";
import {
  parseStrictCliArgs,
  runCliEntrypoint,
  writeCliHelpIfRequested,
} from "../lib/cli-args.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";
import { fetchWithRetry, resolveApiUrl, syncJson } from "../lib/sync-from-api";

const USAGE = `Usage: npx tsx scripts/maintenance/sync-digests.ts [options]

Options:
  --api-url <url>   Digest API base or endpoint (overrides environment)
  --output <path>   Output path (default: data/digests.json)
  --dry-run         Fetch and validate without writing the output file
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

interface DigestEntry {
  date: string;
  title: string;
  text: string;
  extended: string;
  generatedAt: number;
  digestType: "daily" | "weekly";
  editionNumber: number;
}

export interface DigestSyncCliOptions {
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
      "api-url": { type: "string" },
      check: { type: "boolean" },
      "dry-run": { type: "boolean" },
      output: { type: "string" },
    },
  });
  return {
    apiUrl: typeof values["api-url"] === "string" ? values["api-url"] : null,
    check: values.check === true,
    dryRun: values["dry-run"] === true,
    help: values.help === true,
    output: typeof values.output === "string" ? values.output : null,
  };
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
  const digestApiKey = (process.env.DIGEST_API_KEY ?? "").trim();

  console.log("Fetching digest archive...");
  console.log(`Digest source: ${apiUrl}`);
  const fetchUrl = cacheBustedUrl(apiUrl);
  const headers = new Headers();
  headers.set("Cache-Control", "no-cache");
  headers.set("Pragma", "no-cache");
  if (digestApiKey) {
    headers.set("X-API-Key", digestApiKey);
  }

  const { entries, outputFile, written } = await syncJson<DigestEntry>({
    writeTo: outputPath,
    parse: async () => {
      const res = await fetchWithRetry(fetchUrl, { headers }, {
        logLabel: "sync-digests",
        retryStatuses: [403],
        backoffMs: [12_000, 12_000],
      });
      if (!res.ok) throw new Error(`API returned ${res.status}`);
      const { digests } = (await res.json()) as { digests: ApiDigest[] };
      console.log(`Fetched ${digests.length} digests`);
      return digests
        .map((d) => ({
          date: formatIsoDate(d.generatedAt) + (d.digestType === "weekly" ? "-weekly" : ""),
          title: d.digestTitle || "Signal & Noise",
          text: d.digestText,
          extended: d.digestExtended || "",
          generatedAt: d.generatedAt,
          digestType: d.digestType ?? ("daily" as const),
          editionNumber: d.editionNumber ?? 0,
        }))
        .sort((a, b) => b.generatedAt - a.generatedAt);
    },
    write: !options.dryRun,
  });
  console.log(
    written
      ? `Wrote ${entries.length} digests to ${outputFile}`
      : `[sync-digests] Dry run: would write ${entries.length} digests to ${outputFile}`,
  );
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  void runCliEntrypoint(() => runDigestSync(), { label: "sync-digests", usage: USAGE });
}
