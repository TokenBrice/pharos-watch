import { runDocSyncChecks } from "./lib/doc-sync/checks";

function main(): void {
  const failures = runDocSyncChecks();

  if (failures.length > 0) {
    console.error("Methodology drift detected:\n");
    for (const failure of failures) {
      console.error(
        `  ${failure.file} ${failure.label}: expected="${failure.expected}" actual="${failure.found ?? "null"}"`,
      );
    }
    console.error("");
    console.error(`${failures.length} doc sync check(s) failed.`);
    console.error("");
    console.error("Fix: update the doc files above to match the source-of-truth values");
    console.error("in shared/lib/ (version labels, weights, thresholds, etc.).");
    process.exit(1);
  }

  console.log("Doc sync check passed.");
}

main();
