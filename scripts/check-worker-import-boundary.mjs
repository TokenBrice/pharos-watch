import { spawnSync } from "node:child_process";

function runCheck(label, args) {
  const result = spawnSync("rg", args, {
    encoding: "utf8",
  });

  if (result.status === 1) {
    return true;
  }

  if (result.status === 0) {
    console.error(`[boundary] ${label} failed: found forbidden worker -> src/lib imports`);
    if (result.stdout) process.stderr.write(result.stdout);
    return false;
  }

  console.error(`[boundary] ${label} check failed to execute rg`);
  if (result.stderr) process.stderr.write(result.stderr);
  return false;
}

const allWorkerOk = runCheck("all worker sources", [
  "-n",
  "src/lib/",
  "worker/src",
]);

const nonTestWorkerOk = runCheck("non-test worker sources", [
  "-n",
  "src/lib/",
  "worker/src",
  "--glob",
  "!**/__tests__/**",
]);

if (!allWorkerOk || !nonTestWorkerOk) {
  process.exit(1);
}

console.log("[boundary] Worker import boundary checks passed");
