import { spawnSync } from "node:child_process";

import {
  buildValidateCommandPlan,
} from "./lib/validate-contract.mjs";

const TARGET_LTS_NODE_MAJOR = 24;

function parseBooleanArg(name, defaultValue) {
  const prefix = `${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  if (!match) {
    return defaultValue;
  }

  const value = match.slice(prefix.length).toLowerCase();
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }

  throw new Error(`Expected ${name}=true|false, received: ${match}`);
}

function parseStringArg(name, defaultValue = "") {
  const prefix = `${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  if (!match) {
    return defaultValue;
  }
  return match.slice(prefix.length);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function runCommand(cmd) {
  console.log(`\n[lts] ${cmd}`);
  const result = spawnSync(cmd, {
    shell: true,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  if (result.error) {
    throw result.error;
  }
}

function assertTargetNodeMajor() {
  const currentMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (currentMajor !== TARGET_LTS_NODE_MAJOR) {
    throw new Error(
      `npm run validate:lts must run on Node ${TARGET_LTS_NODE_MAJOR}.x (current: ${process.version}).`,
    );
  }
}

function main() {
  assertTargetNodeMajor();

  const pagesChanged = parseBooleanArg("--pages-changed", true);
  const workerChanged = parseBooleanArg("--worker-changed", true);
  const coverageCompareRef = parseStringArg("--coverage-compare-ref", "");
  const plan = buildValidateCommandPlan({ pagesChanged, workerChanged }).map((cmd) =>
    cmd === "npm run coverage:critical" && coverageCompareRef
      ? `CRITICAL_COVERAGE_COMPARE_REF=${shellQuote(coverageCompareRef)} ${cmd}`
      : cmd,
  );

  console.log(
    `[lts] Running ${plan.length} shared validation steps on Node ${process.version} for the explicit LTS target (${TARGET_LTS_NODE_MAJOR}.x).`,
  );

  for (const cmd of plan) {
    runCommand(cmd);
  }
}

main();
