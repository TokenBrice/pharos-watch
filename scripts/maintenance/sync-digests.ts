/**
 * Fetches all digests from an explicit API base/URL and writes them to data/digests.json.
 * Run before builds to ensure static digest pages have fresh data:
 *   DIGEST_API_URL=https://ops-api.example.com tsx scripts/maintenance/sync-digests.ts
 */

import { getArgValue, parseCheckMode } from "../lib/cli.mjs";
import { fetchWithRetry, resolveApiUrl, syncJson, tsToDate } from "../lib/sync-from-api";

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

function resolveOutputPath(): URL {
  const explicitOutput = getArgValue(process.argv, "--output");
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

async function main() {
  // --check mode is a smoke test for the script's own wiring (no network).
  if (parseCheckMode(process.argv)) {
    console.log("[sync-digests] --check mode: helpers wired OK.");
    return;
  }

  const apiUrl = resolveApiUrl({
    argName: "--api-url",
    envNames: ["DIGEST_API_URL", "SMOKE_API_BASE", "API_BASE_URL"],
    apiPath: "/api/digest-archive",
    scriptName: "sync-digests",
  });
  const outputPath = resolveOutputPath();
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

  const { entries, outputFile } = await syncJson<DigestEntry>({
    writeTo: outputPath,
    parse: async () => {
      const res = await fetchWithRetry(fetchUrl, { headers }, { logLabel: "sync-digests" });
      if (!res.ok) throw new Error(`API returned ${res.status}`);
      const { digests } = (await res.json()) as { digests: ApiDigest[] };
      console.log(`Fetched ${digests.length} digests`);
      return digests
        .map((d) => ({
          date: tsToDate(d.generatedAt) + (d.digestType === "weekly" ? "-weekly" : ""),
          title: d.digestTitle || "Signal & Noise",
          text: d.digestText,
          extended: d.digestExtended || "",
          generatedAt: d.generatedAt,
          digestType: d.digestType ?? ("daily" as const),
          editionNumber: d.editionNumber ?? 0,
        }))
        .sort((a, b) => b.generatedAt - a.generatedAt);
    },
  });
  console.log(`Wrote ${entries.length} digests to ${outputFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
