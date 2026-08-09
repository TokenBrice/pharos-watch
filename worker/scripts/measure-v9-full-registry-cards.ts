/**
 * Credential-free full-registry V9 card snapshot.
 *
 * The production equivalence harness needs a D1 capture of
 * `report-cards:fixed-input:exact`, which needs an authorized Wrangler session.
 * When one is unavailable, this runs the SAME publication pipeline over the
 * committed registry using the deterministic full-registry fixture, so a
 * before/after pair taken across a curation or methodology commit isolates that
 * commit's effect exactly.
 *
 * The fixture supplies synthetic peg, reserve, supply, and route rows, so
 * absolute scores are NOT production scores and must never be quoted as such.
 * The delta between two runs at the same fixture is the measurement.
 */
import { writeFileSync } from "node:fs";
import { parseStrictCliArgs, runCliEntrypoint, writeCliHelpIfRequested } from "../../scripts/lib/cli-args.mjs";
import { normalizeFixedInput } from "../src/lib/report-cards-fixed-input";
import { buildSafetyScoreV9PublicationFromNormalizedInput } from "../src/lib/safety-score-v9-candidate";
import { createSafetyScoreV9FullRegistryInput } from "../src/lib/__tests__/fixtures/safety-score-v9-full-registry-input";

const USAGE = `Usage: npx tsx worker/scripts/measure-v9-full-registry-cards.ts --output <path>

Writes one JSON object per active asset: score, grade, binding cap, weakest
pillar, reason codes, archetype, and the per-owner open-gap counts. Intended for
a before/after diff across a single commit.

Options:
  --output <path>   Snapshot JSON (required)
  -h, --help        Show this help`;

async function main(): Promise<void> {
  const { values } = parseStrictCliArgs(process.argv.slice(2), { options: { output: { type: "string" } } });
  if (writeCliHelpIfRequested(values, USAGE)) return;
  if (typeof values.output !== "string") throw new Error("--output is required");

  const input = normalizeFixedInput(createSafetyScoreV9FullRegistryInput());
  const result = buildSafetyScoreV9PublicationFromNormalizedInput({
    fixedInput: input,
    publishedAtSec: input.clockSec,
  });

  const cards = result.candidate.cards.map((card) => {
    const responsibility: Record<string, number> = {};
    for (const summary of card.scoreTrace?.evidenceResponsibility?.summaries ?? []) {
      if (summary.factCount > 0) responsibility[summary.responsibility] = summary.factCount;
    }
    return {
      id: card.id,
      score: card.score,
      grade: card.grade,
      pegAdjustedScore: card.pegAdjustedScore,
      bindingCap: card.bindingCap,
      weakestPillar: card.weakestPillar,
      pillars: Object.fromEntries(
        Object.entries(card.pillars ?? {}).map(([key, value]) => [key, (value as { score?: number }).score ?? null]),
      ),
      reasonCodes: [...(card.reasonCodes ?? [])].sort(),
      nrReasons: [...(card.nrReasons ?? [])].sort(),
      responsibility,
    };
  });

  writeFileSync(
    values.output,
    `${JSON.stringify(
      {
        clockSec: input.clockSec,
        policyVersion: result.candidate.policyVersion,
        factSetDigest: result.candidate.factSetDigest,
        cards,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`wrote ${cards.length} cards to ${values.output}`);
}

void runCliEntrypoint(main, { label: "measure-v9-full-registry-cards", usage: USAGE });
