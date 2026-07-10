#!/usr/bin/env tsx
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  DEFAULT_YIELD_OUTCOME_HORIZONS_DAYS,
  DEFAULT_YIELD_OUTCOME_MAX_GAP_HOURS,
  buildYieldOutcomeValidationReport,
} from "../lib/yield-outcome-validation";
import { parseYieldOutcomeDataset } from "../lib/yield-outcome-validation-dataset";
import {
  assertCliUsage,
  parseCliInteger,
  parseStrictCliArgs,
  runCliEntrypoint,
  writeCliHelpIfRequested,
} from "../lib/cli-args.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const USAGE = `Usage: tsx scripts/maintenance/generate-yield-outcome-validation.ts --input <dataset.json> [options]

Options:
  --input <path>          Generation-keyed Yield outcome dataset (required)
  --out <path>            Write deterministic JSON to this existing directory (default: stdout)
  --horizons <days>       Comma-separated forward horizons (default: 7,30,90)
  --max-gap-hours <n>     Maximum observation distance from each target (default: 36)
  -h, --help              Show this help

The script is offline-only. Formula weights are not configurable; component
ablations use the checked-in shared computePYS implementation.`;

export interface YieldOutcomeCliArgs {
  help: boolean;
  inputPath: string | null;
  outputPath: string | null;
  horizonDays: number[];
  maxGapHours: number;
}

function parseHorizons(value: unknown): number[] {
  const raw = String(value ?? DEFAULT_YIELD_OUTCOME_HORIZONS_DAYS.join(","));
  const segments = raw.split(",").map((segment) => segment.trim());
  assertCliUsage(segments.length > 0 && segments.every(Boolean), "--horizons must be a comma-separated day list");
  const horizons = segments.map((segment) => parseCliInteger(segment, { name: "--horizons values", min: 1, max: 365 }));
  assertCliUsage(new Set(horizons).size === horizons.length, "--horizons values must be unique");
  return horizons.sort((left, right) => left - right);
}

export function parseYieldOutcomeCliArgs(argv: readonly string[]): YieldOutcomeCliArgs {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      input: { type: "string" },
      out: { type: "string" },
      horizons: { type: "string" },
      "max-gap-hours": { type: "string" },
    },
  });
  const help = values.help === true;
  const inputPath = typeof values.input === "string" ? values.input : null;
  assertCliUsage(help || inputPath != null, "--input is required");
  return {
    help,
    inputPath,
    outputPath: typeof values.out === "string" ? values.out : null,
    horizonDays: parseHorizons(values.horizons),
    maxGapHours: parseCliInteger(values["max-gap-hours"] ?? DEFAULT_YIELD_OUTCOME_MAX_GAP_HOURS, {
      name: "--max-gap-hours",
      min: 1,
      max: 24 * 30,
    }),
  };
}

export function generateYieldOutcomeValidation(args: YieldOutcomeCliArgs): string {
  if (!args.inputPath) throw new Error("--input is required");
  const inputPath = resolve(process.cwd(), args.inputPath);
  const dataset = parseYieldOutcomeDataset(JSON.parse(readFileSync(inputPath, "utf8")) as unknown);
  const report = buildYieldOutcomeValidationReport(dataset, {
    horizonDays: args.horizonDays,
    maxObservationGapSeconds: args.maxGapHours * 3_600,
  });
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function runYieldOutcomeValidationCli(
  argv: readonly string[],
  output: Pick<NodeJS.WriteStream, "write"> = process.stdout,
): void {
  const args = parseYieldOutcomeCliArgs(argv);
  if (writeCliHelpIfRequested(args, USAGE, output)) return;
  const serialized = generateYieldOutcomeValidation(args);
  if (!args.outputPath) {
    output.write(serialized);
    return;
  }
  const outputPath = resolve(process.cwd(), args.outputPath);
  if (!existsSync(dirname(outputPath))) {
    throw new Error(`Output directory does not exist: ${dirname(outputPath)}`);
  }
  writeFileSync(outputPath, serialized);
  output.write(`Wrote ${args.outputPath}\n`);
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  void runCliEntrypoint(() => runYieldOutcomeValidationCli(process.argv.slice(2)), {
    label: "yield-outcome-validation",
    usage: USAGE,
  });
}
