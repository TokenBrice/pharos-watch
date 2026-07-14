// Rating-parity gate for the Safety Score V9 candidate
// (agents/safety-score-v9/rating-parity-plan.md §6): every asset graded by
// V8 must be V9-rateable, unless every one of its V9 NR reasons is in the
// frozen stays-NR set (integrity/classification failures). Exit 1 on any
// violation.
//
// Usage:
//   node scripts/maintenance/check-safety-score-v9-parity.mjs \
//     --replay <replay-v9-candidate.json> --v8-cards <v8-cards.json>
//
// --v8-cards accepts either a plain array of { id, grade } or the decoded
// production snapshot payload ({ payload: { cards: [...] } } or { cards }).
import { readFileSync } from "node:fs";

const STAYS_NR = new Set([
  "critical-unresolved",
  "future-dated-input-fact",
  "historical-critical-input",
  "implementation-parent-cycle",
  "insufficient-evidence",
  "missing-archetype",
  "missing-parent-score",
  "missing-pillar",
  "missing-pillar-evidence",
  "parent-cycle",
]);

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

const replayPath = arg("--replay");
const v8Path = arg("--v8-cards");
if (!replayPath || !v8Path) {
  console.error("Usage: check-safety-score-v9-parity.mjs --replay <v9-replay.json> --v8-cards <v8-cards.json>");
  process.exit(2);
}

const replay = JSON.parse(readFileSync(replayPath, "utf8"));
const v9Cards = replay?.pipeline?.candidate?.cards ?? replay?.candidate?.cards ?? replay?.cards;
if (!Array.isArray(v9Cards)) {
  console.error("Could not find V9 candidate cards in the replay JSON");
  process.exit(2);
}

const v8Raw = JSON.parse(readFileSync(v8Path, "utf8"));
const v8CardsRaw = Array.isArray(v8Raw) ? v8Raw : (v8Raw?.payload?.cards ?? v8Raw?.cards);
if (!Array.isArray(v8CardsRaw)) {
  console.error("Could not find V8 cards in the v8-cards JSON");
  process.exit(2);
}
// Accept both plain { id, grade } rows and full V8 report cards.
const v8Cards = v8CardsRaw.map((card) => ({ id: card.id, grade: card.grade ?? card.overallGrade ?? null }));

const v9ById = new Map(v9Cards.map((card) => [card.id, card]));
const v8Graded = v8Cards.filter((card) => card.grade && card.grade !== "NR");

let justified = 0;
const violations = [];
for (const v8Card of v8Graded) {
  const v9Card = v9ById.get(v8Card.id);
  if (!v9Card) continue; // active-set drift between captures is not a parity violation
  if (v9Card.grade !== "NR") continue;
  const codes = (v9Card.nrReasons ?? []).map((reason) => reason.code);
  const unjustified = codes.filter((code) => !STAYS_NR.has(code));
  if (codes.length > 0 && unjustified.length === 0) {
    justified += 1;
    console.log(`justified NR: ${v8Card.id} (v8 ${v8Card.grade}) — ${[...new Set(codes)].join(", ")}`);
    continue;
  }
  violations.push({ id: v8Card.id, v8Grade: v8Card.grade, unjustified: [...new Set(unjustified)] });
}

const v9Rated = v9Cards.filter((card) => card.grade !== "NR").length;
console.log(`v8 graded: ${v8Graded.length}  v9 rateable: ${v9Rated}/${v9Cards.length}  justified NR: ${justified}`);
if (violations.length > 0) {
  console.error(`PARITY VIOLATIONS (${violations.length}):`);
  for (const violation of violations) {
    console.error(`  ${violation.id} (v8 ${violation.v8Grade}) — ${violation.unjustified.join(", ") || "no reasons"}`);
  }
  process.exit(1);
}
console.log("parity gate PASSED");
