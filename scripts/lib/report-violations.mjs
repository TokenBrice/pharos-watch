import { formatScannedOk } from "./source-files.mjs";

/**
 * One violation reporter for the `scripts/ci` scanners.
 *
 * Failure path: writes `<heading>:` followed by one indented line per
 * violation, a violation count, and an optional `hint`, all to stderr, then
 * returns 1.
 *
 * Success path: writes `formatScannedOk(label, scannedCount)` to stdout when a
 * `scannedCount` was supplied — scanners with a bespoke OK line simply omit it
 * and print their own — then returns 0.
 *
 * The return value is the intended process exit code, so each caller keeps its
 * own exit convention: `return reportViolations(...)` from a `runAsCli` main,
 * or `process.exit(reportViolations(...))` from a top-level script.
 *
 * @param {{
 *   label: string,
 *   violations: readonly string[],
 *   heading?: string,
 *   hint?: string,
 *   scannedCount?: number,
 *   stdout?: { write: (chunk: string) => unknown },
 *   stderr?: { write: (chunk: string) => unknown },
 * }} options
 * @returns {0 | 1}
 */
export function reportViolations({
  label,
  violations,
  heading = `${label} violations`,
  hint,
  scannedCount,
  stdout = process.stdout,
  stderr = process.stderr,
}) {
  if (violations.length > 0) {
    stderr.write(`${heading}:\n\n`);
    for (const violation of violations) stderr.write(`  ${violation}\n`);
    stderr.write(`\n${violations.length} violation(s) found.\n`);
    if (hint) stderr.write(`${hint}\n`);
    return 1;
  }

  if (scannedCount !== undefined) stdout.write(formatScannedOk(label, scannedCount));
  return 0;
}
