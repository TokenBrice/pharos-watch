import { readFileSync, writeFileSync } from "node:fs";
import { parseStrictCliArgs, runCliEntrypoint, writeCliHelpIfRequested } from "../../scripts/lib/cli-args.mjs";
import { parseSafetyScoreV9ReplayFixedInput } from "./replay-safety-score-v9";
import { loadSafetyScoreV9RegistryRef, localRegistrySnapshot } from "./lib/safety-score-v9-registry";

const USAGE = `Usage: npx tsx worker/scripts/capture-report-cards-fixed-input.ts [options]

Options:
  --output <path>              Fixed input JSON (required)
  --exact-cache-export <path>  Raw cache envelope or Wrangler D1 JSON query result (required)
  --registry-ref <git-sha>      Capture-time registry; defaults to verified local registry.
                               Output embeds the full fingerprint-bound registry snapshot.
  --normalized-only           Export only normalized input for current-curation workflows.
                               Cannot be combined with --registry-ref.
  -h, --help                   Show this help`;

async function main(): Promise<void> {
  const { values } = parseStrictCliArgs(process.argv.slice(2), {
    options: {
      output: { type: "string" },
      "exact-cache-export": { type: "string" },
      "registry-ref": { type: "string" },
      "normalized-only": { type: "boolean" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE)) return;
  if (typeof values.output !== "string") throw new Error("--output is required");
  if (typeof values["exact-cache-export"] !== "string") {
    throw new Error("--exact-cache-export is required");
  }
  if (values["normalized-only"] === true && values["registry-ref"] !== undefined) {
    throw new Error("--normalized-only cannot be combined with --registry-ref");
  }

  // Accept either the raw cache envelope or Wrangler D1's JSON query result.
  let raw: unknown = JSON.parse(readFileSync(values["exact-cache-export"], "utf8"));
  if (Array.isArray(raw)) raw = raw[0];
  if (raw && typeof raw === "object" && "results" in raw) {
    raw = (raw as { results?: Array<{ value?: unknown }> }).results?.[0]?.value;
  }
  if (typeof raw === "string") raw = JSON.parse(raw);
  if (values["normalized-only"] === true) {
    const fixedInput = await parseSafetyScoreV9ReplayFixedInput(raw);
    writeFileSync(values.output, `${JSON.stringify(fixedInput)}\n`, "utf8");
    return;
  }
  const registrySnapshot = typeof values["registry-ref"] === "string"
    ? loadSafetyScoreV9RegistryRef(values["registry-ref"])
    : localRegistrySnapshot();
  const fixedInput = await parseSafetyScoreV9ReplayFixedInput(raw, registrySnapshot);
  writeFileSync(values.output, `${JSON.stringify({
    kind: "safety-score-v9-registry-capture",
    registrySnapshot,
    fixedInput,
  })}\n`, "utf8");
}

void runCliEntrypoint(main, { label: "report-cards:capture-fixed-input", usage: USAGE });
