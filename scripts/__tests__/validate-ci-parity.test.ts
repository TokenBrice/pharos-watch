import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCiValidateStepPlan,
  VALIDATE_PREBUILD_COMMANDS,
} from "../lib/validate-contract.mjs";

function extractRunSteps(yaml) {
  const lines = yaml.split(/\r?\n/g);
  const steps = [];
  let current = null;

  function flushCurrent() {
    if (current?.cmd) {
      steps.push(current);
    }
    current = null;
  }

  for (const line of lines) {
    if (/^\s*-\s+(uses|run|if):/.test(line)) {
      flushCurrent();
      current = { cmd: null, condition: null };
    }

    if (!current) {
      continue;
    }

    const ifMatch = line.match(/^\s*if:\s+\$\{\{\s+inputs\.([a-z_]+)\s+\}\}\s*$/);
    if (ifMatch) {
      current.condition = ifMatch[1];
      continue;
    }

    const inlineIfMatch = line.match(/^\s*-\s+if:\s+\$\{\{\s+inputs\.([a-z_]+)\s+\}\}\s*$/);
    if (inlineIfMatch) {
      current.condition = inlineIfMatch[1];
      continue;
    }

    const trimmed = line.trim();
    const runPrefix = trimmed.startsWith("- ") ? "- run:" : "run:";
    if (trimmed.startsWith(runPrefix)) {
      current.cmd = trimmed.slice(runPrefix.length).trim();
      continue;
    }

    if (/^\s*-\s+uses:/.test(line)) {
      flushCurrent();
    }
  }

  flushCurrent();
  return steps;
}

function extractJobBlock(yaml: string, jobName: string, nextJobName?: string): string {
  const startMarker = `  ${jobName}:`;
  const start = yaml.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`Missing workflow job block: ${jobName}`);
  }
  if (!nextJobName) {
    return yaml.slice(start);
  }
  const endMarker = `  ${nextJobName}:`;
  const end = yaml.indexOf(endMarker, start);
  return end === -1 ? yaml.slice(start) : yaml.slice(start, end);
}

describe("validate-ci parity", () => {
  it("keeps the shared CI validate workflow aligned with the merge-gate command contract", () => {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/validate-ci.yml"), "utf8");
    const setupWorkspaceAction = readFileSync(
      resolve(process.cwd(), ".github/actions/setup-workspace/action.yml"),
      "utf8",
    );
    const validateJob = extractJobBlock(workflow, "validate", "validate-lts");
    const setupWorkspaceRunSteps = extractRunSteps(setupWorkspaceAction);

    expect([...setupWorkspaceRunSteps, ...extractRunSteps(validateJob)]).toEqual([
      { cmd: "npm ci", condition: null },
      ...buildCiValidateStepPlan(),
    ]);
  });

  it("threads the coverage compare ref through the LTS validate lane", () => {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/validate-ci.yml"), "utf8");
    const validateLtsJob = extractJobBlock(workflow, "validate-lts");

    expect(extractRunSteps(validateLtsJob)).toContainEqual({
      cmd: "npm run validate:lts -- --pages-changed=${{ inputs.pages_changed }} --worker-changed=${{ inputs.worker_changed }} --coverage-compare-ref=${{ inputs.coverage-compare-ref }}",
      condition: null,
    });
  });

  it("keeps validate:prebuild delegated to the shared registry", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts["validate:prebuild"]).toBe("node scripts/run-validate-prebuild.mjs");
    expect(VALIDATE_PREBUILD_COMMANDS).toEqual([
      "npm run audit:deps",
      "npm run audit:pricing-providers",
      "npm run lint",
      "npm run typecheck",
      "npm run check:cemetery-dataset",
      "npm run check:cron-abort-contract",
      "npm run check:cron-connections",
      "npm run check:cron-sync",
      "npm run check:doc-counts",
      "npm run check:doc-source-paths",
      "npm run check:doc-sync",
      "npm run check:duplicate-exports",
      "npm run check:env-contract",
      "npm run check:hotspot-ratchet",
      "npm run check:llms-txt",
      "npm run check:migrations",
      "npm run check:openapi",
      "npm run check:postman",
      "npm run check:redemption-backstops",
      "npm run check:shared-cycles",
      "npm run check:sql-safety",
      "npm run check:stablecoin-data",
      "npm run check:unused-code",
      "npm run check:verified-doc-links",
      "npm run check:world-map",
      "npm run check:worker-boundary",
    ]);
  });
});
