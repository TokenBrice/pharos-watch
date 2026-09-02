import {
  buildV9CuratedMintPostureQueue,
  type V9CuratedMintPostureInput,
  type V9CuratedMintPostureQueue,
} from "@shared/lib/safety-score-v9/mint-posture-annotation";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  assertCliUsage,
  requireCliString,
  runDirectCli,
} from "../lib/cli-args.mjs";
import {
  createDefaultReportCliIo,
  runOperationalQueueCli,
  type ReportCliIo,
} from "../lib/report-cli";

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

export type V9MintPostureQueueIo = ReportCliIo;

const DEFAULT_IO = createDefaultReportCliIo();

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
  return runOperationalQueueCli({
    argv,
    io,
    usage: USAGE,
    options: {
      replay: { type: "string" },
    },
    buildQueue(values) {
      const replayPath = requireCliString(values.replay, "--replay");
      return buildV9MintPostureQueueFromCards(readV9PublishedCards(io.readJson(replayPath)));
    },
    isClear: (queue) => queue.entries.length === 0,
    failureMessage: (queue) => `${queue.entries.length} curated mint-posture disagreement(s) remain`,
    writeSummary(queue, stdout) {
      stdout.write(
        `Curated mint-posture queue: ${queue.entries.length} disagreement(s) across ${queue.reviewedAssetCount} asset(s); ` +
          `${queue.nrCards.length} NR card(s) excluded.\n`,
      );
    },
  });
}

runDirectCli(import.meta.url, () => runV9MintPostureQueueCli(process.argv.slice(2)), {
  label: "safety-score-v9:mint-posture-queue",
  usage: USAGE,
});
