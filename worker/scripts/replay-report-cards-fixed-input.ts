import { readFileSync, writeFileSync } from "node:fs";
import { parseStrictCliArgs, runCliEntrypoint, writeCliHelpIfRequested } from "../../scripts/lib/cli-args.mjs";
import {
  buildReportCardsSnapshotFromFixedInput,
  serializeNormalizedReportCardsReplay,
} from "../src/lib/report-cards-fixed-input";

const USAGE = `Usage: npx tsx worker/scripts/replay-report-cards-fixed-input.ts --input <path> [options]

Options:
  --input <path>                  Fixed build-input JSON
  --output <path>                 Write replay JSON instead of stdout
  --allow-methodology-mismatch    Replay a captured input with current methodology code
  --dex-max-age-sec <seconds>     Override the DEX observation freshness window
  --redemption-max-age-sec <sec>  Override the live-redemption freshness window
  -h, --help                      Show this help`;

async function main(): Promise<void> {
  const { values } = parseStrictCliArgs(process.argv.slice(2), {
    options: {
      input: { type: "string" },
      output: { type: "string" },
      "allow-methodology-mismatch": { type: "boolean" },
      "dex-max-age-sec": { type: "string" },
      "redemption-max-age-sec": { type: "string" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE)) return;
  if (typeof values.input !== "string") throw new Error("--input is required");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- explicit local operator input path.
  const fixedInput = JSON.parse(readFileSync(values.input, "utf8")) as unknown;
  const parseMaxAge = (raw: unknown, flag: string): number | undefined => {
    if (raw == null) return undefined;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative integer`);
    return parsed;
  };
  const snapshot = buildReportCardsSnapshotFromFixedInput(fixedInput, {
    allowMethodologyMismatch: values["allow-methodology-mismatch"] === true,
    dexExitObservationMaxAgeSec: parseMaxAge(values["dex-max-age-sec"], "--dex-max-age-sec"),
    liveRedemptionExitObservationMaxAgeSec: parseMaxAge(values["redemption-max-age-sec"], "--redemption-max-age-sec"),
  });
  const output = serializeNormalizedReportCardsReplay(snapshot);
  if (typeof values.output === "string") {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- explicit local operator output path.
    writeFileSync(values.output, output, "utf8");
  } else {
    process.stdout.write(output);
  }
}

void runCliEntrypoint(main, { label: "report-cards:replay", usage: USAGE });
