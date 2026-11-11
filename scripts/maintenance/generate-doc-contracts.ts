import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseStrictCliArgs, runDirectCli, writeCliHelpIfRequested } from "../lib/cli-args.mjs";
import {
  findDocContractDrift,
  getDocContractRegions,
  replaceDocContractRegions,
} from "../lib/doc-sync/contract-blocks";

const ROOT = resolve(import.meta.dirname, "../..");
const USAGE = "Usage: node --import tsx scripts/maintenance/generate-doc-contracts.ts [--check]";

export function runDocContractsCli(argv: readonly string[], repoRoot = ROOT): void {
  const { values } = parseStrictCliArgs(argv, { options: { check: { type: "boolean" } } });
  if (writeCliHelpIfRequested(values, USAGE)) return;
  const read = (file: string) => readFileSync(resolve(repoRoot, file), "utf8");
  const regions = getDocContractRegions(read);
  const drift = findDocContractDrift(read, regions);
  if (values.check === true) {
    if (drift.length > 0) throw new Error(`${drift.map(({ file, id }) => `${file}: ${id}`).join("\n")}\nRun node --import tsx scripts/maintenance/generate-doc-contracts.ts`);
    console.log("Documentation contract blocks are current");
    return;
  }
  // Validate every marker before writing any document.
  const updates = [...new Set(drift.map(({ file }) => file))].map((file) => ({
    file,
    contents: replaceDocContractRegions(read(file), regions.filter((region) => region.file === file)),
  }));
  for (const { file, contents } of updates) writeFileSync(resolve(repoRoot, file), contents, "utf8");
  console.log(`Documentation contract blocks refreshed (${drift.length} blocks)`);
}

runDirectCli(import.meta.url, () => runDocContractsCli(process.argv.slice(2)), { label: "doc-contracts", usage: USAGE });
