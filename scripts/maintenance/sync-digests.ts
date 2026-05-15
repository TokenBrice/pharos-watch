/**
 * Fetches all digests from an explicit API base/URL and writes them to data/digests.json.
 * Run before builds to ensure static digest pages have fresh data:
 *   DIGEST_API_URL=https://ops-api.example.com tsx scripts/sync-digests.ts
 */

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

function tsToDate(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function getArgValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function resolveDigestApiUrl(): string {
  const explicitUrl =
    getArgValue("--api-url") ??
    process.env.DIGEST_API_URL ??
    process.env.SMOKE_API_BASE ??
    process.env.API_BASE_URL;
  if (!explicitUrl) {
    throw new Error(
      "Provide --api-url or set DIGEST_API_URL / SMOKE_API_BASE / API_BASE_URL before running sync-digests.",
    );
  }

  if (explicitUrl.endsWith("/api/digest-archive")) {
    return explicitUrl;
  }

  return `${explicitUrl.replace(/\/+$/, "")}/api/digest-archive`;
}

function resolveOutputPath(): URL {
  const explicitOutput = getArgValue("--output");
  if (!explicitOutput) {
    return new URL("../data/digests.json", import.meta.url);
  }

  return new URL(explicitOutput, `file://${process.cwd()}/`);
}

async function main() {
  const apiUrl = resolveDigestApiUrl();
  const outputPath = resolveOutputPath();
  const digestApiKey = (process.env.DIGEST_API_KEY ?? "").trim();

  console.log("Fetching digest archive...");
  console.log(`Digest source: ${apiUrl}`);
  const headers = new Headers();
  if (digestApiKey) {
    headers.set("X-API-Key", digestApiKey);
  }
  const res = await fetch(apiUrl, { headers });
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  const { digests } = (await res.json()) as { digests: ApiDigest[] };
  console.log(`Fetched ${digests.length} digests`);

  const entries: DigestEntry[] = digests
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

  const { mkdirSync, writeFileSync } = await import("fs");
  const { fileURLToPath } = await import("url");
  const outputFile = fileURLToPath(outputPath);
  mkdirSync(new URL(".", outputPath), { recursive: true });
  writeFileSync(outputFile, JSON.stringify(entries, null, 2) + "\n");
  console.log(`Wrote ${entries.length} digests to ${outputFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
