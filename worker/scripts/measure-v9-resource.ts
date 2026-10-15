import { resolve } from "node:path";
import { assertCliUsage, parseStrictCliArgs } from "../../scripts/lib/cli-args.mjs";
import { measureV9Resource } from "../src/lib/__tests__/safety-score-v9-resource-budget.test-support";
import type { PhaseManifest, ResourceProfile } from "../src/lib/__tests__/safety-score-v9-resource-budget.test-support";

async function main() {
  const { values } = parseStrictCliArgs(process.argv.slice(2), { options: {
    profile: { type: "string", default: "compute" }, runs: { type: "string", default: "1" },
    "phase-manifest": { type: "string", default: "post-p2" }, policy: { type: "string" }, "invocation-id": { type: "string" },
    guard: { type: "boolean", default: false },
  } });
  if (values.help) {
    console.log("Usage: npm run measure:v9-resource -- --profile=compute|heavy-warm --runs=N [--policy=PATH | --guard]\n--guard requires complete phases, correctness/bytes and natural 128 MiB; it automatically enforces a checked-in qualified policy, or explicitly reports policy: unqualified if absent. --policy always requires a valid file. Without either option this is diagnostic.");
  } else {
    assertCliUsage(values.profile === "compute" || values.profile === "heavy-warm", "--profile must be compute or heavy-warm");
    assertCliUsage(typeof values.runs === "string" && /^[1-9]\d*$/.test(values.runs) && Number.isSafeInteger(Number(values.runs)), "--runs must be a positive integer");
    const root = resolve(import.meta.dirname, "../..");
    const manifest = values["phase-manifest"];
    assertCliUsage(manifest === "post-p2", "--phase-manifest must be post-p2; historical pre-p2 instrumentation is not part of the current workload");
    assertCliUsage(!(values.guard && values.policy), "--guard and --policy are mutually exclusive");
    assertCliUsage((!values.guard && values.policy === undefined) || values.profile === "compute", "guard/policy assertions require the compute profile");
    const report = await measureV9Resource(root, values.profile as ResourceProfile, Number(values.runs), manifest as PhaseManifest, {
      policyPath: values.guard ? resolve(root, ".ci/safety-score-v9-resource-budget.json") : typeof values.policy === "string" ? resolve(root, values.policy) : undefined,
      allowUnqualifiedPolicy: values.guard === true,
      invocationId: typeof values["invocation-id"] === "string" ? values["invocation-id"] : undefined,
    });
    console.log(JSON.stringify({ report: ".tmp/safety-score-v9-resource/report.json", policy: report.policy, complete: report.complete, violations: report.violations }, null, 2));
    if (values.guard || values.policy ? !report.complete : report.violations.some((violation: { reason: string }) => violation.reason === "harness-error")) process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error && typeof error === "object" && "exitCode" in error ? Number(error.exitCode) : 1;
});
