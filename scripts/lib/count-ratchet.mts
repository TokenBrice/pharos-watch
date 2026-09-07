import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function readCountRatchetBaseline(path: string, cwd: string): Record<string, unknown> | null {
  const absolute = join(cwd, path);
  if (!existsSync(absolute)) return null;
  const parsed: unknown = JSON.parse(readFileSync(absolute, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

export function writeCountRatchetBaseline(path: string, counts: Record<string, number>, cwd: string): void {
  const absolute = join(cwd, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(counts, null, 2)}\n`);
}

export interface CountRatchetViolation {
  file: string;
  count: number;
  baselineCount: number;
}

export function compareCountRatchetCounts(
  current: Record<string, number>,
  baseline: Record<string, unknown>,
): CountRatchetViolation[] {
  const violations: CountRatchetViolation[] = [];
  for (const [file, count] of Object.entries(current)) {
    const baselineCount = Number(baseline[file] ?? 0);
    if (!Number.isFinite(baselineCount) || count > baselineCount) {
      violations.push({ file, count, baselineCount: Number.isFinite(baselineCount) ? baselineCount : 0 });
    }
  }
  return violations;
}

export function runCountRatchet({
  collectCounts,
  baselinePath,
  cwd = process.cwd(),
  updateBaseline = false,
  stdout = process.stdout,
  stderr = process.stderr,
  labels,
  remediation,
}: {
  collectCounts: () => Record<string, number>;
  baselinePath: string;
  cwd?: string;
  updateBaseline?: boolean;
  stdout?: { write(chunk: string): unknown };
  stderr?: { write(chunk: string): unknown };
  labels: {
    baselineUpdated: string;
    failedToReadBaseline: string;
    missingBaseline: string;
    increased: string;
    ok: string;
    countNoun: string;
  };
  remediation: string;
}): number {
  const current = collectCounts();

  if (updateBaseline) {
    writeCountRatchetBaseline(baselinePath, current, cwd);
    stdout.write(`${labels.baselineUpdated} (${Object.keys(current).length} file entries).\n`);
    return 0;
  }

  let baseline;
  try {
    baseline = readCountRatchetBaseline(baselinePath, cwd);
  } catch (error) {
    stderr.write(`${labels.failedToReadBaseline}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (!baseline) {
    stderr.write(`${labels.missingBaseline} at ${baselinePath}. Run with --update-baseline.\n`);
    return 1;
  }

  const violations = compareCountRatchetCounts(current, baseline);
  if (violations.length > 0) {
    stderr.write(`${labels.increased}:\n\n`);
    for (const violation of violations) {
      stderr.write(`  ${violation.file}: ${violation.count} > baseline ${violation.baselineCount}\n`);
    }
    stderr.write(`\n${remediation}\n`);
    return 1;
  }

  const currentTotal = Object.values(current).reduce((sum, count) => sum + count, 0);
  const baselineTotal = Object.values(baseline).reduce<number>((sum, count) => sum + Number(count), 0);
  stdout.write(`${labels.ok}: OK (${currentTotal}/${baselineTotal} ${labels.countNoun} at or below baseline)\n`);
  return 0;
}
