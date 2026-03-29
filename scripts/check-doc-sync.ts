import { runDocSyncChecks } from "./lib/doc-sync/checks";

function main(): void {
  const failures = runDocSyncChecks();

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(
        `FAIL ${failure.file} — ${failure.label}: found ${failure.found ?? "null"}, expected ${failure.expected}`,
      );
    }
    console.error(`\n${failures.length} doc sync check(s) failed.`);
    process.exit(1);
  }

  console.log("Doc sync check passed.");
}

main();
