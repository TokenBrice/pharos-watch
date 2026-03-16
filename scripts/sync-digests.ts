/**
 * Fetches all digests from the API and writes them to data/digests.json.
 * Run before builds to ensure static digest pages have fresh data:
 *   tsx scripts/sync-digests.ts
 */

const API_URL = "https://api.pharos.watch/api/digest-archive";

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

async function main() {
  console.log("Fetching digest archive...");
  const res = await fetch(API_URL);
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  const { digests } = (await res.json()) as { digests: ApiDigest[] };
  console.log(`Fetched ${digests.length} digests`);

  const entries: DigestEntry[] = digests
    .map((d) => ({
      date: tsToDate(d.generatedAt),
      title: d.digestTitle || "Signal & Noise",
      text: d.digestText,
      extended: d.digestExtended || "",
      generatedAt: d.generatedAt,
      digestType: d.digestType ?? ("daily" as const),
      editionNumber: d.editionNumber ?? 0,
    }))
    .sort((a, b) => b.generatedAt - a.generatedAt);

  const path = new URL("../data/digests.json", import.meta.url);
  const { writeFileSync } = await import("fs");
  const { fileURLToPath } = await import("url");
  writeFileSync(fileURLToPath(path), JSON.stringify(entries, null, 2) + "\n");
  console.log(`Wrote ${entries.length} digests to data/digests.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
