#!/usr/bin/env node
const required = [
  ["validate-prebuild", process.env.VALIDATE_PREBUILD_RESULT],
  ["test-noncritical", process.env.TEST_NONCRITICAL_RESULT],
  ["coverage-critical", process.env.COVERAGE_CRITICAL_RESULT],
];

const optional = [];
if (process.env.PAGES_BUILD_EXPECTED === "true") {
  required.push(["pages-build", process.env.PAGES_BUILD_RESULT]);
} else {
  optional.push(["pages-build", process.env.PAGES_BUILD_RESULT]);
}

if (process.env.WORKER_CHANGED === "true") {
  required.push(["typecheck-worker", process.env.TYPECHECK_WORKER_RESULT]);
  required.push(["typecheck-worker-scripts", process.env.TYPECHECK_WORKER_SCRIPTS_RESULT]);
} else {
  optional.push(["typecheck-worker", process.env.TYPECHECK_WORKER_RESULT]);
  optional.push(["typecheck-worker-scripts", process.env.TYPECHECK_WORKER_SCRIPTS_RESULT]);
}

let failed = false;
for (const [job, result] of required) {
  if (result !== "success") {
    console.error(`${job} result was ${result}; expected success.`);
    failed = true;
  }
}

for (const [job, result] of optional) {
  if (result !== "success" && result !== "skipped") {
    console.error(`${job} result was ${result}; expected success or skipped.`);
    failed = true;
  }
}

process.exit(failed ? 1 : 0);
