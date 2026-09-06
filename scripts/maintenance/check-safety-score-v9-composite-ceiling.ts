// Composite ("frankenstein") A+ reachability gate — reshape-v2 plan §5.
//
// Asserts that a stablecoin assembled from the BEST real, currently-measured
// pillar sub-scores can reach A+ under the live formula. If a methodology
// change silently makes A+ unreachable, this check fails. Part of the
// canonical V9 composite-ceiling audit;
// it needs a replay artifact, so it runs operator-side, not in CI.
//
// The donor composite is scored by the same production aggregation seam the
// live formula uses (aggregateV9SmoothBoundedHeadroom with the policy's single
// compensabilityHeadroom), so the gate certifies the real frontier instead of
// the retired pillar-specific hard minimum.
//
// Usage: node --import tsx scripts/maintenance/check-safety-score-v9-composite-ceiling.ts --replay <replay.json>
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { aggregateV9SmoothBoundedHeadroom } from "@shared/lib/safety-score-v9/aggregation";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

type PillarName = "backing" | "exit" | "control";

interface Card {
  id: string;
  grade: string;
  score: number | null;
  caps?: Array<{ source?: string }>;
  pillars?: Partial<Record<PillarName, { score?: number }>>;
  bindingCap?: { kind?: string };
}

interface MeasuredCard extends Card {
  score: number;
}

interface Formula {
  pillarWeights: Record<PillarName, number>;
  gradeThresholds: Array<{ grade: string; minScore: number }>;
  compensabilityHeadroom: number;
}

interface PolicyDocument {
  policy?: { semantic?: { formula: Formula } };
  semantic?: { formula: Formula };
}

interface RegistryCoin {
  id: string;
  mechanismArchetype?: string;
}

interface RegistryDocument {
  coins?: RegistryCoin[];
}

interface ReplayDocument {
  cards?: Card[];
  candidate?: { cards?: Card[] };
  pipeline?: { candidate?: { cards?: Card[] } };
}

const ISSUER_ARCHETYPES: Record<string, true> = { "fiat-cash": true, tbill: true };
const isWrapper = (card: Card): boolean => (card.caps ?? []).some((cap) => cap.source === "parent");

const VARIANTS: Array<{
  name: string;
  filter: (card: MeasuredCard, archetypeById: Map<string, string | undefined>) => boolean;
}> = [
  { name: "unrestricted", filter: () => true },
  { name: "non-wrapper", filter: (card) => !isWrapper(card) },
  {
    name: "issuer-class",
    filter: (card, archetypeById) =>
      Boolean(ISSUER_ARCHETYPES[archetypeById.get(card.id) ?? ""]) && !isWrapper(card),
  },
];

function bestPillar(pool: readonly MeasuredCard[], pillar: PillarName): { id: string; score: number } | null {
  let best: { id: string; score: number } | null = null;
  for (const card of pool) {
    const score = card.pillars?.[pillar]?.score;
    if (typeof score === "number" && (best === null || score > best.score)) best = { id: card.id, score };
  }
  return best;
}

export interface CompositeCeilingVariantOutcome {
  name: string;
  passed: boolean;
  composite: number;
}

export interface CompositeCeilingGateReport {
  passed: boolean;
  stdout: string[];
  stderr: string[];
  variants: CompositeCeilingVariantOutcome[];
}

export interface CompositeCeilingGateInput {
  replay: ReplayDocument;
  policy: PolicyDocument;
  registry: RegistryCoin[] | RegistryDocument;
}

export function runCompositeCeilingGate(input: CompositeCeilingGateInput): CompositeCeilingGateReport {
  const formula = (input.policy.policy?.semantic ?? input.policy.semantic)!.formula;
  const weights = formula.pillarWeights;
  const aPlus = formula.gradeThresholds.find((row) => row.grade === "A+")!.minScore;
  const replayCards = input.replay.pipeline?.candidate?.cards ?? input.replay.candidate?.cards ?? input.replay.cards;
  const cards: MeasuredCard[] = (replayCards ?? []).filter(
    (card): card is MeasuredCard => card.grade !== "NR" && card.score !== null,
  );
  const archetypeById = new Map(
    (Array.isArray(input.registry) ? input.registry : input.registry.coins ?? []).map(
      (coin): [string, string | undefined] => [coin.id, coin.mechanismArchetype],
    ),
  );

  const stdout: string[] = [];
  const stderr: string[] = [];
  const variants: CompositeCeilingVariantOutcome[] = [];
  let failed = false;
  for (const variant of VARIANTS) {
    const pool = cards.filter((card) => variant.filter(card, archetypeById));
    const donors = {
      backing: bestPillar(pool, "backing"),
      exit: bestPillar(pool, "exit"),
      control: bestPillar(pool, "control"),
    };
    if (!donors.backing || !donors.exit || !donors.control) {
      stderr.push(`✖ ${variant.name}: empty donor pool (${pool.length} cards)`);
      failed = true;
      continue;
    }
    const trace = aggregateV9SmoothBoundedHeadroom(
      { backing: donors.backing.score, exit: donors.exit.score, control: donors.control.score },
      weights,
      formula.compensabilityHeadroom,
    );
    const composite = trace.score;
    const pass = composite >= aPlus;
    if (!pass) failed = true;
    variants.push({ name: variant.name, passed: pass, composite });
    stdout.push(
      `${pass ? "✔" : "✖"} ${variant.name}: composite ${composite.toFixed(2)} ` +
        `(blend ${trace.weightedQuality.toFixed(2)}, weakest ${trace.weakestPillar} ${trace.weakestScore.toFixed(1)}, ` +
        `headroom ${formula.compensabilityHeadroom}) vs A+ ${aPlus} — margin ${(composite - aPlus).toFixed(2)}`,
    );
    stdout.push(
      `   donors: backing=${donors.backing.id}@${donors.backing.score.toFixed(1)} ` +
        `exit=${donors.exit.id}@${donors.exit.score.toFixed(1)} control=${donors.control.id}@${donors.control.score.toFixed(1)} ` +
        `(pool ${pool.length})`,
    );
  }

  const frontier = [...cards].sort((a, b) => b.score - a.score).slice(0, 5);
  stdout.push("real-coin frontier (top 5):");
  for (const card of frontier) {
    stdout.push(
      `   ${card.grade} ${card.score} ${card.id} — binding ${card.bindingCap?.kind ?? "none"}` +
        ` (distance to A+ ${(aPlus - card.score).toFixed(0)})`,
    );
  }

  return { passed: !failed, stdout, stderr, variants };
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  const args = process.argv.slice(2);
  const replayFlag = args.indexOf("--replay");
  if (replayFlag === -1 || !args[replayFlag + 1]) {
    console.error("Usage: node --import tsx scripts/maintenance/check-safety-score-v9-composite-ceiling.ts --replay <replay.json>");
    process.exit(2);
  }

  const root = resolve(new URL("../..", import.meta.url).pathname);
  const replay = JSON.parse(readFileSync(resolve(args[replayFlag + 1]), "utf8")) as ReplayDocument;
  const policy = JSON.parse(
    readFileSync(resolve(root, "shared/data/safety-score-v9/methodology-policy-candidate-v1.json"), "utf8"),
  ) as PolicyDocument;
  const registry = JSON.parse(readFileSync(resolve(root, "shared/data/stablecoins/coins.generated.json"), "utf8")) as
    | RegistryCoin[]
    | RegistryDocument;

  const report = runCompositeCeilingGate({ replay, policy, registry });
  for (const line of report.stdout) console.log(line);
  for (const line of report.stderr) console.error(line);
  if (!report.passed) {
    console.error("COMPOSITE CEILING GATE: FAIL — A+ is not reachable from real measured sub-scores.");
    process.exit(1);
  }
  console.log("COMPOSITE CEILING GATE: PASS");
}
