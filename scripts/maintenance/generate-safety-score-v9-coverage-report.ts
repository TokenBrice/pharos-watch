import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { evaluateV9ReleaseCoverage } from "@shared/lib/safety-score-v9/coverage";
import {
  V9CoverageEvaluationSnapshotV1Schema,
  V9ReleaseCohortManifestV1Schema,
  V9ReleaseCoverageReportV1Schema,
  type V9ReleaseCoverageReportV1,
} from "@shared/types/safety-score-v9-coverage";
import { assertCliUsage, parseStrictCliArgs, runCliEntrypoint, writeCliHelpIfRequested } from "../lib/cli-args.mjs";

const USAGE = `Usage: npx tsx scripts/maintenance/generate-safety-score-v9-coverage-report.ts [options]

Options:
  --fact-set <path>       Native compiled V3 fact-set JSON (required)
  --evaluation <path>     Identity-preserving V9 evaluation snapshot JSON (required)
  --manifest <path>       Frozen release-cohort manifest JSON (required)
  --output <path>         Strict coverage report JSON (required)
  --require-pass          Exit nonzero after writing when the report is no-go
  -h, --help              Show this help`;

export interface V9OperationalReportIo {
  readJson(path: string): unknown;
  writeText(path: string, contents: string): void;
  stdout: { write(text: string): unknown };
}

const DEFAULT_IO: V9OperationalReportIo = {
  readJson: (path) => JSON.parse(readFileSync(path, "utf8")) as unknown,
  writeText: (path, contents) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, "utf8");
  },
  stdout: process.stdout,
};

export function generateV9CoverageReportFromArtifacts(input: {
  factSet: unknown;
  evaluation: unknown;
  manifest: unknown;
}): V9ReleaseCoverageReportV1 {
  return V9ReleaseCoverageReportV1Schema.parse(
    evaluateV9ReleaseCoverage({
      factSet: input.factSet,
      evaluation: V9CoverageEvaluationSnapshotV1Schema.parse(input.evaluation),
      manifest: V9ReleaseCohortManifestV1Schema.parse(input.manifest),
    }),
  );
}

export function runV9CoverageReportCli(
  argv: readonly string[],
  io: V9OperationalReportIo = DEFAULT_IO,
): V9ReleaseCoverageReportV1 | null {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      "fact-set": { type: "string" },
      evaluation: { type: "string" },
      manifest: { type: "string" },
      output: { type: "string" },
      "require-pass": { type: "boolean" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE, io.stdout)) return null;
  assertCliUsage(typeof values["fact-set"] === "string", "--fact-set is required");
  assertCliUsage(typeof values.evaluation === "string", "--evaluation is required");
  assertCliUsage(typeof values.manifest === "string", "--manifest is required");
  assertCliUsage(typeof values.output === "string", "--output is required");

  const report = generateV9CoverageReportFromArtifacts({
    factSet: io.readJson(values["fact-set"]),
    evaluation: io.readJson(values.evaluation),
    manifest: io.readJson(values.manifest),
  });
  io.writeText(values.output, `${JSON.stringify(report, null, 2)}\n`);
  if (values["require-pass"] === true && report.decision !== "gate-passed") {
    throw new Error(`Safety Score v9 release coverage is no-go (${report.blockers.length} blocker(s))`);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCliEntrypoint(() => runV9CoverageReportCli(process.argv.slice(2)), {
    label: "safety-score-v9:coverage",
    usage: USAGE,
  });
}
