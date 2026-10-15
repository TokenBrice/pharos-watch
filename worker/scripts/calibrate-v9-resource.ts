import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertCliUsage, parseStrictCliArgs, runDirectCli } from "../../scripts/lib/cli-args.mjs";
import { measureV9Resource, type ResourceReport } from "../src/lib/__tests__/safety-score-v9-resource-budget.test-support";
import { CALIBRATION_MAX_BYTES, GLOBAL_HEAP_BYTES, RESOURCE_PHASES, ROUNDING_BYTES, TOLERANCE_BYTES, validateResourcePolicy } from "./lib/v9-resource-policy";

export async function calibrateV9Resource(root: string, runs: number, measure = measureV9Resource) {
  const directory = resolve(root, ".tmp/safety-score-v9-resource");
  mkdirSync(directory, { recursive: true });
  rmSync(resolve(directory, "proposed-policy.json"), { force: true });
  const reports: ResourceReport[] = [];
  const reportSha256s: string[] = [];
  for (let run = 1; run <= runs; run += 1) {
    const runDirectory = resolve(directory, `calibration-${run}`);
    const report = await measure(root, "compute", 1, "post-p2", { directory: runDirectory });
    reports.push(report);
    reportSha256s.push(createHash("sha256").update(readFileSync(resolve(runDirectory, "report.json"))).digest("hex"));
  }
  const identity = reports[0]?.identity;
  const phaseMaximaBytes: Record<string, number> = {};
  const violations: Array<{ reason: string; [key: string]: unknown }> = [];
  for (const report of reports) {
    if (!report.complete || report.violations.length) violations.push({ reason: "calibration-run-failed", violations: report.violations });
    if (!identity || JSON.stringify(identity) !== JSON.stringify(report.identity)) violations.push({ reason: "calibration-identity-mismatch" });
    if (report.runs.length !== 1 || report.runs[0]?.["hard-cap"]?.status !== 0 || report.runs[0]?.["hard-cap"]?.reasons.length) violations.push({ reason: "natural-128-mib-failed" });
    for (const phase of RESOURCE_PHASES) {
      const value = report.runs[0]?.live?.phaseMaxima[phase]?.postGcHeapBytes;
      if (!Number.isSafeInteger(value) || !value || value <= 0) violations.push({ reason: "missing-phase", phase });
      else {
        phaseMaximaBytes[phase] = Math.max(phaseMaximaBytes[phase] ?? 0, value);
        if (value > CALIBRATION_MAX_BYTES) violations.push({ reason: "calibration-phase-exceeded", phase, observed: value, limit: CALIBRATION_MAX_BYTES });
      }
    }
  }
  const phaseLimitsBytes = Object.fromEntries(RESOURCE_PHASES.map((phase) => [phase, Math.min(GLOBAL_HEAP_BYTES, Math.ceil(((phaseMaximaBytes[phase] ?? 0) + TOLERANCE_BYTES) / ROUNDING_BYTES) * ROUNDING_BYTES)]));
  const policy = { schemaVersion: 1, identity, globalPostGcHeapBytes: GLOBAL_HEAP_BYTES,
    hardCapOldSpaceMiB: 128, measurementOldSpaceMiB: 256, toleranceBytes: TOLERANCE_BYTES, roundingBytes: ROUNDING_BYTES,
    phaseLimitsBytes, calibration: { revision: String(reports[0]?.testedSha ?? "unavailable"), reportSha256s,
      natural128MiBSuccesses: reports.filter((report) => report.complete && report.runs[0]?.["hard-cap"]?.status === 0).length, phaseMaximaBytes } };
  // A smoke proposal is deliberately unqualified; only five complete runs can be reviewed/applied.
  let qualified = false;
  if (identity && !violations.length) {
    try { validateResourcePolicy(policy, identity); qualified = true; }
    catch (error) { if (runs === 5) violations.push({ reason: "invalid-calibration-policy", detail: String(error) }); }
  }
  writeFileSync(resolve(directory, "proposed-policy.json"), `${JSON.stringify(policy, null, 2)}\n`);
  writeFileSync(resolve(directory, "report.json"), `${JSON.stringify({ schemaVersion: 1, calibration: true, qualified, runs: reports, violations, complete: violations.length === 0 }, null, 2)}\n`);
  let previous: { phaseLimitsBytes?: Record<string, number> } = {};
  try { previous = JSON.parse(readFileSync(resolve(root, ".ci/safety-score-v9-resource-budget.json"), "utf8")); }
  catch { console.log("Checked-in policy missing or unreadable; proposal is not applied."); }
  console.log("Phase | checked-in bytes | proposed bytes | delta");
  for (const phase of RESOURCE_PHASES) {
    const old = previous.phaseLimitsBytes?.[phase];
    console.log(`${phase} | ${old ?? "missing"} | ${phaseLimitsBytes[phase]} | ${old === undefined ? "new" : phaseLimitsBytes[phase] - old}`);
  }
  console.log(JSON.stringify({ proposedPolicy: ".tmp/safety-score-v9-resource/proposed-policy.json", qualified, runs, violations }, null, 2));
  return { qualified, violations, policy };
}

runDirectCli(import.meta.url, async () => {
  const { values } = parseStrictCliArgs(process.argv.slice(2), { options: { runs: { type: "string", default: "5" } } });
  if (values.help) { console.log("Usage: npm run calibrate:v9-resource -- --runs=5\nWrites a proposed policy only; five qualifying live + natural compute runs are required before review."); return; }
  assertCliUsage(typeof values.runs === "string" && /^[1-9]\d*$/.test(values.runs) && Number.isSafeInteger(Number(values.runs)), "--runs must be a positive integer");
  const result = await calibrateV9Resource(resolve(import.meta.dirname, "../.."), Number(values.runs));
  process.exitCode = result.violations.length ? 1 : 0;
}, { label: "[calibrate-v9-resource]" });
