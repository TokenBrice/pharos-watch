import { readFileSync, writeFileSync } from "node:fs";
import { parseStrictCliArgs, runCliEntrypoint, writeCliHelpIfRequested } from "../../scripts/lib/cli-args.mjs";
import { parseSafetyScoreV9InputCacheValue } from "../src/lib/safety-score-v9/native-input";

const USAGE = `Usage: npx tsx worker/scripts/capture-report-cards-fixed-input.ts [options]

Options:
  --output <path>              Fixed input JSON (required)
  --exact-cache-export <path>  Raw cache envelope or Wrangler D1 JSON query result (required)
  -h, --help                   Show this help`;

async function main(): Promise<void> {
  const { values } = parseStrictCliArgs(process.argv.slice(2), {
    options: {
      output: { type: "string" },
      "exact-cache-export": { type: "string" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE)) return;
  if (typeof values.output !== "string") throw new Error("--output is required");
  if (typeof values["exact-cache-export"] !== "string") {
    throw new Error("--exact-cache-export is required");
  }

  // Accept either the raw cache envelope or Wrangler D1's JSON query result.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- explicit local operator input path.
  let raw: unknown = JSON.parse(readFileSync(values["exact-cache-export"], "utf8"));
  if (Array.isArray(raw)) raw = raw[0];
  if (raw && typeof raw === "object" && "results" in raw) {
    raw = (raw as { results?: Array<{ value?: unknown }> }).results?.[0]?.value;
  }
  const fixedInput = await parseSafetyScoreV9InputCacheValue(raw);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- explicit local operator output path.
  writeFileSync(values.output, `${JSON.stringify(fixedInput, null, 2)}\n`, "utf8");
}

void runCliEntrypoint(main, { label: "report-cards:capture-fixed-input", usage: USAGE });
