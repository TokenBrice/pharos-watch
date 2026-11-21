import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import type { Reporter, TestModule } from "vitest/node";

/** Report kind `build-test-timings.ts` recognises as per-file wall-clock evidence. */
export const FILE_TIMINGS_REPORT_KIND = "pharos-vitest-file-timings";

/**
 * Nightly-only Vitest reporter: records each test file's wall cost (worker
 * prepare and environment where attributed, setup files, import/collect and
 * run) so PR shards balance on what a file really costs, not only on its
 * assertion time. Writes nothing unless PHAROS_VITEST_FILE_TIMINGS names the
 * output path.
 */
export default class FileTimingsReporter implements Reporter {
  private readonly files: Record<string, number> = {};

  onTestModuleEnd(testModule: TestModule): void {
    const diagnostic = testModule.diagnostic();
    const wall = diagnostic.prepareDuration + diagnostic.environmentSetupDuration
      + diagnostic.setupDuration + diagnostic.collectDuration + diagnostic.duration;
    const file = relative(process.cwd(), testModule.moduleId).replaceAll("\\", "/");
    this.files[file] = Math.max(this.files[file] ?? 0, Math.round(wall));
  }

  onTestRunEnd(): void {
    const output = process.env.PHAROS_VITEST_FILE_TIMINGS;
    if (!output) return;
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify({ kind: FILE_TIMINGS_REPORT_KIND, files: this.files })}\n`);
  }
}
