import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildV9CuratedMintPostureQueue,
  type V9CuratedMintPostureInput,
  type V9CuratedMintPostureQueue,
} from "@shared/lib/safety-score-v9/mint-posture-annotation";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { assertCliUsage, parseStrictCliArgs, runCliEntrypoint, writeCliHelpIfRequested } from "../lib/cli-args.mjs";

const USAGE = `Usage: npx tsx scripts/maintenance/generate-safety-score-v9-mint-posture-queue.ts [options]

Reports every tracked asset whose curated \`mintAuthority.authorityPosture\`
annotation disagrees with the mint posture V9 derives and publishes. Safety 9.1
demoted the curated field to a validated annotation: it never scores, so a
disagreement is curation work rather than a score effect.

Assets whose card publishes no breakdowns (NR) derive no posture at all. They are
reported in a separate \`nrCards\` bucket and excluded from the disagreement
count: an NR card is a rating gap, not a curation disagreement.

Options:
  --replay <path>    V9 replay artifact or publication payload with cards (required)
  --output <path>    Strict curated-mint-posture queue JSON (required)
  --require-clear    Exit nonzero after writing when disagreements remain
  -h, --help         Show this help`;

export interface V9MintPostureQueueIo {
  readJson(path: string): unknown;
  writeText(path: string, contents: string): void;
  stdout: { write(text: string): unknown };
}

const DEFAULT_IO: V9MintPostureQueueIo = {
  readJson: (path) => JSON.parse(readFileSync(path, "utf8")) as unknown,
  writeText: (path, contents) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, "utf8");
  },
  stdout: process.stdout,
};

interface PublishedCard {
  id?: unknown;
  breakdowns?: { control?: { components?: { kind?: unknown; posture?: unknown }[] } | null } | null;
}

/** Cards live under the replay pipeline or directly on a publication payload. */
export function readV9PublishedCards(artifact: unknown): PublishedCard[] {
  const roots = [
    (artifact as { pipeline?: { candidate?: { cards?: unknown } } })?.pipeline?.candidate?.cards,
    (artifact as { cards?: unknown })?.cards,
    (artifact as { data?: { cards?: unknown } })?.data?.cards,
  ];
  const cards = roots.find((value): value is PublishedCard[] => Array.isArray(value));
  assertCliUsage(cards !== undefined, "--replay does not contain a published card array");
  return cards;
}

export function buildV9MintPostureQueueFromCards(cards: readonly PublishedCard[]): V9CuratedMintPostureQueue {
  const inputs: V9CuratedMintPostureInput[] = [];
  for (const card of cards) {
    const assetId = typeof card.id === "string" ? card.id : null;
    if (assetId === null) continue;
    const mint = card.breakdowns?.control?.components?.find((component) => component.kind === "mint");
    inputs.push({
      assetId,
      curatedPosture: TRACKED_META_BY_ID.get(assetId)?.mintAuthority?.authorityPosture,
      derivedPosture: typeof mint?.posture === "string" ? mint.posture : null,
      publishesBreakdowns: card.breakdowns != null,
    });
  }
  return buildV9CuratedMintPostureQueue(inputs);
}

export function runV9MintPostureQueueCli(
  argv: readonly string[],
  io: V9MintPostureQueueIo = DEFAULT_IO,
): V9CuratedMintPostureQueue | null {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      replay: { type: "string" },
      output: { type: "string" },
      "require-clear": { type: "boolean" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE, io.stdout)) return null;
  assertCliUsage(typeof values.replay === "string", "--replay is required");
  assertCliUsage(typeof values.output === "string", "--output is required");

  const queue = buildV9MintPostureQueueFromCards(readV9PublishedCards(io.readJson(values.replay)));
  io.writeText(values.output, `${JSON.stringify(queue, null, 2)}\n`);
  io.stdout.write(
    `Curated mint-posture queue: ${queue.entries.length} disagreement(s) across ${queue.reviewedAssetCount} asset(s); ` +
      `${queue.nrCards.length} NR card(s) excluded.\n`,
  );
  if (values["require-clear"] === true && queue.entries.length > 0) {
    throw new Error(`${queue.entries.length} curated mint-posture disagreement(s) remain`);
  }
  return queue;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCliEntrypoint(() => runV9MintPostureQueueCli(process.argv.slice(2)), {
    label: "safety-score-v9:mint-posture-queue",
    usage: USAGE,
  });
}
