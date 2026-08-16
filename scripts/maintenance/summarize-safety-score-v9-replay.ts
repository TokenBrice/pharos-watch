// One-shot summary of a V9 replay JSON: rateable count, supply weight, and
// top blocker classes, so shadow iteration doesn't need ad-hoc scripts.
// Usage: node --import tsx scripts/maintenance/summarize-safety-score-v9-replay.ts <replay.json> [--top N]
import { readFileSync } from "node:fs";

interface ReplayCard {
  id: string;
  grade: string;
  score?: number | null;
  bindingCap?: { kind?: string | null } | null;
  nrReasons?: Array<{ code: string }>;
  pillars?: Record<string, { score?: number | null; reasons?: Array<{ code: string }> }>;
}

interface ReplayAsset {
  assetId: string;
  stressState?: { exitPortfolio?: { circulatingUsd?: number } };
}

interface ReplayArtifact {
  pipeline?: {
    candidate?: { cards?: ReplayCard[] };
    evaluatedSet?: { assets?: ReplayAsset[] };
  };
}

const args = process.argv.slice(2);
const inputPath = args.find((a) => !a.startsWith("--"));
if (!inputPath) {
  console.error("Usage: node --import tsx scripts/maintenance/summarize-safety-score-v9-replay.ts <replay.json> [--top N]");
  process.exit(1);
}
const topIndex = args.indexOf("--top");
const topN = topIndex >= 0 ? Number(args[topIndex + 1]) : 20;

const replay = JSON.parse(readFileSync(inputPath, "utf8")) as ReplayArtifact;
const cards = replay?.pipeline?.candidate?.cards;
if (!Array.isArray(cards)) {
  console.error("No pipeline.candidate.cards in input — is this a V9 replay JSON?");
  process.exit(1);
}

const assets = replay?.pipeline?.evaluatedSet?.assets ?? [];
const supplyById = new Map(
  assets.map((asset) => [asset.assetId, asset.stressState?.exitPortfolio?.circulatingUsd ?? 0]),
);

const rated = cards.filter((card) => card.grade !== "NR");
const totalSupply = cards.reduce((sum, card) => sum + (supplyById.get(card.id) ?? 0), 0);
const ratedSupply = rated.reduce((sum, card) => sum + (supplyById.get(card.id) ?? 0), 0);

console.log(`cards: ${cards.length}  rateable: ${rated.length}`);
if (totalSupply > 0) {
  console.log(`supply weight rated: ${((ratedSupply / totalSupply) * 100).toFixed(2)}%`);
}
for (const card of [...rated].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))) {
  console.log(`  ${card.id}  ${card.grade}  ${card.score}  bindingCap=${card.bindingCap?.kind ?? "none"}`);
}

const pillarBlockers = new Map<string, number>();
const nrCodes = new Map<string, number>();
for (const card of cards) {
  if (card.grade !== "NR") continue;
  for (const reason of card.nrReasons ?? []) {
    nrCodes.set(reason.code, (nrCodes.get(reason.code) ?? 0) + 1);
  }
  for (const [pillarName, pillar] of Object.entries(card.pillars ?? {})) {
    if (pillar.score != null) continue;
    for (const reason of pillar.reasons ?? []) {
      const key = `${pillarName}:${reason.code}`;
      pillarBlockers.set(key, (pillarBlockers.get(key) ?? 0) + 1);
    }
  }
}

const printTop = (label: string, map: ReadonlyMap<string, number>): void => {
  console.log(`\n${label}`);
  [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .forEach(([key, count]) => console.log(`  ${String(count).padStart(4)}  ${key}`));
};
printTop("NR reason codes (assets affected):", nrCodes);
printTop("null-pillar blocker classes:", pillarBlockers);
