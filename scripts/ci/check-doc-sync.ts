import { runDocSyncChecks } from "../lib/doc-sync/checks";

function main(): void {
  const failures = runDocSyncChecks();

  if (failures.length > 0) {
    console.error("Doc sync drift detected:\n");
    for (const failure of failures) {
      console.error(
        `  ${failure.file} ${failure.label}: expected="${failure.expected}" actual="${failure.found ?? "null"}"`,
      );
    }
    console.error("");
    console.error(`${failures.length} doc sync check(s) failed.`);
    console.error("");
    console.error("Refresh managed contract blocks: node --import tsx scripts/maintenance/generate-doc-contracts.ts");
    console.error("Refresh lane matrix: node --import tsx scripts/maintenance/generate-lane-freshness-matrix.ts");
    console.error("Keep authored explanations aligned with their source-of-truth owners.");
    process.exit(1);
  }

  console.log("Doc sync check passed.");
}

main();
