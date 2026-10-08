import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// CI permits npm patch updates within this major; Node is pinned by .nvmrc.
const EXPECTED_NPM_MAJOR = 11;
const MISE_SETUP = "mise settings add idiomatic_version_file_enable_tools node && mise install";

export interface RuntimeVersions {
  node: string;
  npm: string;
}

export function readRuntimeVersions(): RuntimeVersions {
  return {
    node: process.version.replace(/^v/, ""),
    npm: execFileSync("npm", ["--version"], { encoding: "utf8" }).trim(),
  };
}

export function assertPinnedRuntime(
  versions: RuntimeVersions = readRuntimeVersions(),
  repoRoot = process.cwd(),
): void {
  const expectedNode = readFileSync(resolve(repoRoot, ".nvmrc"), "utf8").trim().replace(/^v/, "");
  const node = versions.node.replace(/^v/, "");
  const npmMajor = /^([0-9]+)\./.exec(versions.npm)?.[1];
  if (node !== expectedNode || Number(npmMajor) !== EXPECTED_NPM_MAJOR) {
    throw new Error(
      `check:pr requires Node ${expectedNode} exactly and npm ${EXPECTED_NPM_MAJOR}.x; ` +
      `found Node ${node}, npm ${versions.npm}. Activate mise shims in this shell, then run ` +
      `\`${MISE_SETUP}\`; ensure npm from that Node installation is on PATH.`,
    );
  }
}
