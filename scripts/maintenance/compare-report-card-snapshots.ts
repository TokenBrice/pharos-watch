import { readFileSync, writeFileSync } from "node:fs";
import { parseStrictCliArgs, runCliEntrypoint, writeCliHelpIfRequested } from "../lib/cli-args.mjs";
import {
  compareReportCardPayloads,
  renderReportCardDiffMarkdown,
  serializeReportCardDiff,
} from "../lib/report-card-diff";

const USAGE = `Usage: npm run report-cards:diff -- --before <path> --after <path> [options]

Options:
  --before <path>                 Baseline report-card JSON payload
  --after <path>                  Candidate report-card JSON payload
  --generated-at <iso>            Fixed report generation time (required)
  --allow-methodology-mismatch    Permit an intentional version comparison
  --format <json|markdown>        Output format (default: json)
  --output <path>                 Write output to a file instead of stdout
  -h, --help                      Show this help`;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

async function main(): Promise<void> {
  const { values } = parseStrictCliArgs(process.argv.slice(2), {
    options: {
      before: { type: "string" },
      after: { type: "string" },
      "generated-at": { type: "string" },
      "allow-methodology-mismatch": { type: "boolean" },
      format: { type: "string", default: "json" },
      output: { type: "string" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE)) return;
  if (typeof values.before !== "string") throw new Error("--before is required");
  if (typeof values.after !== "string") throw new Error("--after is required");
  if (typeof values["generated-at"] !== "string") throw new Error("--generated-at is required");
  if (values.format !== "json" && values.format !== "markdown") {
    throw new Error("--format must be json or markdown");
  }

  const report = compareReportCardPayloads(readJson(values.before), readJson(values.after), {
    generatedAt: values["generated-at"],
    allowMethodologyMismatch: values["allow-methodology-mismatch"] === true,
  });
  const output = values.format === "markdown" ? renderReportCardDiffMarkdown(report) : serializeReportCardDiff(report);
  if (typeof values.output === "string") writeFileSync(values.output, output, "utf8");
  else process.stdout.write(output);
}

void runCliEntrypoint(main, { label: "report-cards:diff", usage: USAGE });
