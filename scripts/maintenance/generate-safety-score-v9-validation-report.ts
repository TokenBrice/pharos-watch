import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { evaluateV9HistoricalHoldout } from "@shared/lib/safety-score-v9/validation";
import {
  V9HistoricalHoldoutEvaluationInputSchema,
  V9HistoricalHoldoutValidationReportSchema,
  type V9HistoricalHoldoutValidationReport,
} from "@shared/types/safety-score-v9-validation";
import { assertCliUsage, parseStrictCliArgs, runCliEntrypoint, writeCliHelpIfRequested } from "../lib/cli-args.mjs";

const USAGE = `Usage: npx tsx scripts/maintenance/generate-safety-score-v9-validation-report.ts [options]

Options:
  --input <path>          Sealed holdout evaluation input JSON (required)
  --output <path>         Strict validation report JSON (required)
  --require-pass          Exit nonzero after writing when the report is no-go
  -h, --help              Show this help`;

export interface V9ValidationReportIo {
  readJson(path: string): unknown;
  writeText(path: string, contents: string): void;
  stdout: { write(text: string): unknown };
}

const DEFAULT_IO: V9ValidationReportIo = {
  readJson: (path) => JSON.parse(readFileSync(path, "utf8")) as unknown,
  writeText: (path, contents) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, "utf8");
  },
  stdout: process.stdout,
};

export function generateV9ValidationReportFromArtifact(input: unknown): V9HistoricalHoldoutValidationReport {
  return V9HistoricalHoldoutValidationReportSchema.parse(
    evaluateV9HistoricalHoldout(V9HistoricalHoldoutEvaluationInputSchema.parse(input)),
  );
}

export function runV9ValidationReportCli(
  argv: readonly string[],
  io: V9ValidationReportIo = DEFAULT_IO,
): V9HistoricalHoldoutValidationReport | null {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      input: { type: "string" },
      output: { type: "string" },
      "require-pass": { type: "boolean" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE, io.stdout)) return null;
  assertCliUsage(typeof values.input === "string", "--input is required");
  assertCliUsage(typeof values.output === "string", "--output is required");

  const report = generateV9ValidationReportFromArtifact(io.readJson(values.input));
  io.writeText(values.output, `${JSON.stringify(report, null, 2)}\n`);
  if (values["require-pass"] === true && report.decision !== "gate-passed") {
    throw new Error(`Safety Score v9 holdout validation is no-go (${report.noGoReasons.length} reason(s))`);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCliEntrypoint(() => runV9ValidationReportCli(process.argv.slice(2)), {
    label: "safety-score-v9:validation",
    usage: USAGE,
  });
}
