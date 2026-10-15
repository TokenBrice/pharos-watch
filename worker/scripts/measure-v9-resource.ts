import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { assertCliUsage, parseStrictCliArgs } from "../../scripts/lib/cli-args.mjs";
import { measureV9Resource } from "../src/lib/__tests__/safety-score-v9-resource-budget.test-support";
import type { PhaseManifest, ResourceProfile } from "../src/lib/__tests__/safety-score-v9-resource-budget.test-support";

async function main() {
  const { values } = parseStrictCliArgs(process.argv.slice(2), { options: {
    profile: { type: "string", default: "compute" }, runs: { type: "string", default: "1" },
    "phase-manifest": { type: "string" },
  } });
  if (values.help) {
    console.log("Usage: npm run measure:v9-resource -- --profile=compute|heavy-warm --runs=N [--phase-manifest=pre-p2|post-p2]\nNon-gating Node diagnostic; writes .tmp/safety-score-v9-resource/report.json, including child failures.");
  } else {
    assertCliUsage(values.profile === "compute" || values.profile === "heavy-warm", "--profile must be compute or heavy-warm");
    assertCliUsage(typeof values.runs === "string" && /^[1-9]\d*$/.test(values.runs) && Number.isSafeInteger(Number(values.runs)), "--runs must be a positive integer");
    const root = resolve(import.meta.dirname, "../..");
    const runner = readFileSync(resolve(root, "worker/src/lib/safety-score-v9/publication-runner.ts"), "utf8");
    const detected = runner.includes("loadSafetyScoreV9AcceptedBaseline") ? "post-p2" : "pre-p2";
    const manifest = values["phase-manifest"] ?? detected;
    assertCliUsage(manifest === "pre-p2" || manifest === "post-p2", "--phase-manifest must be pre-p2 or post-p2");
    const report = await measureV9Resource(root, values.profile as ResourceProfile, Number(values.runs), manifest as PhaseManifest);
    console.log(JSON.stringify({ report: ".tmp/safety-score-v9-resource/report.json", complete: report.complete, violations: report.violations }, null, 2));
    // Diagnostic only: memory failures are recorded results, not an acceptance gate.
    if (report.violations.some((violation: { reason: string }) => violation.reason === "harness-error")) process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error && typeof error === "object" && "exitCode" in error ? Number(error.exitCode) : 1;
});
