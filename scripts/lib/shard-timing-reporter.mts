import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Reporter, TestModule } from "vitest/node";
import { rawShardReportPath, type VitestJsonReport } from "./shard-timings.mts";

/** Unlike Vitest's JSON assertion spans, diagnostics include imports/collection and hooks. */
export default class ShardTimingReporter implements Reporter {
  onTestRunEnd(modules: readonly TestModule[], errors: readonly unknown[], reason: string): void {
    const timingsFile = process.env.PR_SHARD_TIMINGS_FILE;
    if (!timingsFile) return;
    const report: VitestJsonReport = {
      success: reason === "passed" && errors.length === 0,
      testResults: modules.map((module) => {
        const diagnostic = module.diagnostic();
        let testCount = 0;
        for (const test of module.children.allTests()) {
          void test;
          testCount++;
        }
        return {
          name: module.moduleId,
          testCount,
          startTime: 0,
          // collectDuration includes the test module's transitive imports. Do not
          // add importDurations again: those are already part of collection.
          endTime: diagnostic.prepareDuration + diagnostic.environmentSetupDuration
            + diagnostic.setupDuration + diagnostic.collectDuration + diagnostic.duration,
        };
      }),
    };
    const path = rawShardReportPath(timingsFile);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(report)}\n`);
  }
}
