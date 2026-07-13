// One-shot summary of a V9 replay JSON: rateable count, supply weight, and
// top blocker classes, so shadow iteration doesn't need ad-hoc scripts.
// Usage: node scripts/maintenance/summarize-safety-score-v9-replay.mjs <replay.json> [--top N]
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const inputPath = args.find((a) => !a.startsWith("--"));
if (!inputPath) {
  console.error("Usage: node scripts/maintenance/summarize-safety-score-v9-replay.mjs <replay.json> [--top N]");
  process.exit(1);
}
const topIndex = args.indexOf("--top");
const topN = topIndex >= 0 ? Number(args[topIndex + 1]) : 20;

const replay = JSON.parse(readFileSync(inputPath, "utf8"));
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

const pillarBlockers = new Map();
const nrCodes = new Map();
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

const printTop = (label, map) => {
  console.log(`\n${label}`);
  [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .forEach(([key, count]) => console.log(`  ${String(count).padStart(4)}  ${key}`));
};
printTop("NR reason codes (assets affected):", nrCodes);
printTop("null-pillar blocker classes:", pillarBlockers);
