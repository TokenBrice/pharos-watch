import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseStrictCliArgs, runCliEntrypoint, writeCliHelpIfRequested } from "../../scripts/lib/cli-args.mjs";
import { parseSafetyScoreV9ReplayFixedInput } from "./replay-safety-score-v9";
import { loadSafetyScoreV9RegistryRef, localRegistrySnapshot, type SafetyScoreV9RegistrySnapshot } from "./lib/safety-score-v9-registry";
import { parseSafetyScoreV9PublicationReplayCacheRows, parseSafetyScoreV9PublicationReplayCapture } from "../src/lib/safety-score-v9/publication-replay-capture";

/** The accepted-cache-export admission path shared by the CLI and archive round-trip tests. */
export async function parseReportCardsAcceptedCacheExport(value: unknown, registrySnapshot?: SafetyScoreV9RegistrySnapshot) {
  const rows = parseSafetyScoreV9PublicationReplayCacheRows(value);
  const base = await parseSafetyScoreV9ReplayFixedInput(rows.baseValue, registrySnapshot);
  const capture = await parseSafetyScoreV9PublicationReplayCapture(rows.deltaValue, base);
  if (rows.retainedAtSec !== base.clockSec) throw new Error("accepted-publication-replay-retention-base-clock-mismatch");
  return { ...capture, registrySnapshot };
}

const USAGE = `Usage: npx tsx worker/scripts/capture-report-cards-fixed-input.ts [options]

Options:
  --output <path>              Capture JSON (required)
  --exact-cache-export <path>  Raw prepare-time envelope or Wrangler D1 JSON result
  --accepted-cache-export <path>
                               One Wrangler D1 SELECT exporting both retained accepted
                               base and enrichment rows; mutually exclusive with --exact-cache-export.
  --registry-ref <git-sha>      Capture-time registry; defaults to verified local registry.
                               Output embeds the full fingerprint-bound registry snapshot.
  --normalized-only           Export only normalized input for current-curation workflows.
                               Cannot be combined with --registry-ref.
  -h, --help                   Show this help`;

export async function runReportCardsFixedInputCaptureCli(argv: readonly string[]): Promise<void> {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      output: { type: "string" },
      "exact-cache-export": { type: "string" },
      "accepted-cache-export": { type: "string" },
      "registry-ref": { type: "string" },
      "normalized-only": { type: "boolean" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE)) return;
  if (typeof values.output !== "string") throw new Error("--output is required");
  const accepted = typeof values["accepted-cache-export"] === "string";
  if (accepted === (typeof values["exact-cache-export"] === "string")) {
    throw new Error("Exactly one of --exact-cache-export or --accepted-cache-export is required");
  }
  if (values["normalized-only"] === true && values["registry-ref"] !== undefined) {
    throw new Error("--normalized-only cannot be combined with --registry-ref");
  }
  if (accepted && values["normalized-only"] === true) {
    throw new Error("--normalized-only cannot be combined with --accepted-cache-export");
  }
  const registrySnapshot = values["normalized-only"] === true ? undefined
    : typeof values["registry-ref"] === "string" ? loadSafetyScoreV9RegistryRef(values["registry-ref"]) : localRegistrySnapshot();
  if (typeof values["accepted-cache-export"] === "string") {
    const capture = await parseReportCardsAcceptedCacheExport(JSON.parse(readFileSync(values["accepted-cache-export"], "utf8")), registrySnapshot);
    writeFileSync(values.output, `${JSON.stringify(capture)}\n`, "utf8");
    return;
  }

  const exactCacheExport = values["exact-cache-export"];
  if (typeof exactCacheExport !== "string") throw new Error("--exact-cache-export is required");
  // Accept either the raw cache envelope or Wrangler D1's JSON query result.
  let raw: unknown = JSON.parse(readFileSync(exactCacheExport, "utf8"));
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
  const fixedInput = await parseSafetyScoreV9ReplayFixedInput(raw, registrySnapshot);
  writeFileSync(values.output, `${JSON.stringify({
    kind: "safety-score-v9-registry-capture",
    registrySnapshot,
    fixedInput,
  })}\n`, "utf8");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void runCliEntrypoint(() => runReportCardsFixedInputCaptureCli(process.argv.slice(2)), {
    label: "report-cards:capture-fixed-input", usage: USAGE,
  });
}
