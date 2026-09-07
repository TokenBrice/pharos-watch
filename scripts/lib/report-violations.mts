import { formatScannedOk } from "./source-files.mts";

export interface OutputWriter {
  write(chunk: string): unknown;
}

export type GateLaneStatus = "failed" | "passed" | "skipped";

export interface GateLaneReport {
  id: string;
  command: string;
  status: GateLaneStatus;
  durationMs: number;
  failureTail: string;
}

export interface GateReport<TClassification = unknown> {
  base: string;
  changedFiles: string[];
  classification: TClassification;
  durationMs: number;
  head: string;
  lanes: GateLaneReport[];
  status: "failed" | "passed";
}

const FAILURE_TAIL_MAX_CHARS = 4_000;
let stdoutPipeErrorHandlerInstalled = false;

function installStdoutPipeErrorHandler(output: OutputWriter): void {
  if (output !== process.stdout || stdoutPipeErrorHandlerInstalled) return;
  process.stdout.on("error", (error) => {
    if ((error as NodeJS.ErrnoException).code !== "EPIPE") throw error;
  });
  stdoutPipeErrorHandlerInstalled = true;
}

export function writeJsonReport(value: unknown, output: OutputWriter = process.stdout): void {
  installStdoutPipeErrorHandler(output);
  output.write(`${JSON.stringify(value)}\n`);
}

export function formatFailureTail(output: unknown, maxChars = FAILURE_TAIL_MAX_CHARS): string {
  const normalized = String(output ?? "").trim();
  if (!normalized) return "";
  if (normalized.length <= maxChars) return normalized;
  return `[...tail truncated...]\n${normalized.slice(-maxChars)}`;
}

export interface GateReportOutputOptions {
  json: boolean;
  label: string;
  stderr?: OutputWriter;
  stdout?: OutputWriter;
}

export function reportGateResult<TClassification>(
  report: GateReport<TClassification>,
  { json, stdout = process.stdout }: GateReportOutputOptions,
): void {
  if (json) writeJsonReport(report, stdout);
}

interface ReportViolationOptions {
  label: string;
  violations: readonly string[];
  heading?: string;
  hint?: string;
  scannedCount?: number;
  stdout?: OutputWriter;
  stderr?: OutputWriter;
}

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
}: ReportViolationOptions): 0 | 1 {
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
