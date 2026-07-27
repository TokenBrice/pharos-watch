// Composite ("frankenstein") A+ reachability gate — reshape-v2 plan §5.
//
// Asserts that a stablecoin assembled from the BEST real, currently-measured
// pillar sub-scores can reach A+ under the live formula. If a methodology
// change silently makes A+ unreachable, this check fails. Part of the
// canonical V9 composite-ceiling audit;
// it needs a replay artifact, so it runs operator-side, not in CI.
//
// Usage: node scripts/maintenance/check-safety-score-v9-composite-ceiling.mjs --replay <replay.json>
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const replayFlag = args.indexOf("--replay");
if (replayFlag === -1 || !args[replayFlag + 1]) {
  console.error("Usage: check-safety-score-v9-composite-ceiling.mjs --replay <replay.json>");
  process.exit(2);
}

const root = resolve(new URL("../..", import.meta.url).pathname);
const replay = JSON.parse(readFileSync(resolve(args[replayFlag + 1]), "utf8"));
const policy = JSON.parse(
  readFileSync(resolve(root, "shared/data/safety-score-v9/methodology-policy-candidate-v1.json"), "utf8"),
);
const registry = JSON.parse(readFileSync(resolve(root, "shared/data/stablecoins/coins.generated.json"), "utf8"));

const formula = (policy.policy?.semantic ?? policy.semantic).formula;
const weights = formula.pillarWeights;
const aPlus = formula.gradeThresholds.find((row) => row.grade === "A+").minScore;
const cards = (replay.pipeline?.candidate ?? replay.candidate ?? replay).cards.filter(
  (card) => card.grade !== "NR" && card.score !== null,
);
const archetypeById = new Map(
  (Array.isArray(registry) ? registry : registry.coins ?? []).map((coin) => [coin.id, coin.mechanismArchetype]),
);

const ISSUER_ARCHETYPES = new Set(["fiat-cash", "tbill"]);
const isWrapper = (card) => (card.caps ?? []).some((cap) => cap.source === "parent");

const VARIANTS = [
  { name: "unrestricted", filter: () => true },
  { name: "non-wrapper", filter: (card) => !isWrapper(card) },
  { name: "issuer-class", filter: (card) => ISSUER_ARCHETYPES.has(archetypeById.get(card.id)) && !isWrapper(card) },
];

function bestPillar(pool, pillar) {
  let best = null;
  for (const card of pool) {
    const score = card.pillars?.[pillar]?.score;
    if (typeof score === "number" && (best === null || score > best.score)) best = { id: card.id, score };
  }
  return best;
}

let failed = false;
for (const variant of VARIANTS) {
  const pool = cards.filter(variant.filter);
  const donors = {
    backing: bestPillar(pool, "backing"),
    exit: bestPillar(pool, "exit"),
    control: bestPillar(pool, "control"),
  };
  if (!donors.backing || !donors.exit || !donors.control) {
    console.error(`✖ ${variant.name}: empty donor pool (${pool.length} cards)`);
    failed = true;
    continue;
  }
  const blend =
    donors.backing.score * weights.backing + donors.exit.score * weights.exit + donors.control.score * weights.control;
  const weakest = Math.min(donors.backing.score, donors.exit.score, donors.control.score);
  const controlWeakest = donors.control.score === weakest;
  const headroom = controlWeakest ? formula.controlCompensabilityHeadroom : formula.compensabilityHeadroom;
  const capped = Math.min(blend, weakest + headroom);
  const pass = capped >= aPlus;
  if (!pass) failed = true;
  console.log(
    `${pass ? "✔" : "✖"} ${variant.name}: composite ${capped.toFixed(2)} (blend ${blend.toFixed(2)}, ` +
      `bounded-comp limit ${(weakest + headroom).toFixed(2)}) vs A+ ${aPlus} — margin ${(capped - aPlus).toFixed(2)}`,
  );
  console.log(
    `   donors: backing=${donors.backing.id}@${donors.backing.score.toFixed(1)} ` +
      `exit=${donors.exit.id}@${donors.exit.score.toFixed(1)} control=${donors.control.id}@${donors.control.score.toFixed(1)} ` +
      `(pool ${pool.length})`,
  );
}

const frontier = [...cards].sort((a, b) => b.score - a.score).slice(0, 5);
console.log("real-coin frontier (top 5):");
for (const card of frontier) {
  console.log(
    `   ${card.grade} ${card.score} ${card.id} — binding ${card.bindingCap?.kind ?? "none"}` +
      ` (distance to A+ ${(aPlus - card.score).toFixed(0)})`,
  );
}

if (failed) {
  console.error("COMPOSITE CEILING GATE: FAIL — A+ is not reachable from real measured sub-scores.");
  process.exit(1);
}
console.log("COMPOSITE CEILING GATE: PASS");
