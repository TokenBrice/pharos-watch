import { readFileSync } from "node:fs";
import { parseStrictCliArgs, requireCliString, writeCliHelpIfRequested, writeJsonOutput } from "./cli-args.mjs";

type CliOptions = NonNullable<Parameters<typeof parseStrictCliArgs>[1]>["options"];
type CliValues = ReturnType<typeof parseStrictCliArgs>["values"];

export interface ReportCliIo {
  readJson(path: string): unknown;
  writeText(path: string, contents: string): void;
  stdout: { write(text: string): unknown };
}

export function createDefaultReportCliIo(): ReportCliIo {
  return { readJson: (path) => JSON.parse(readFileSync(path, "utf8")), writeText: writeJsonOutput, stdout: process.stdout };
}

export function runOperationalQueueCli<T>(input: {
  argv: readonly string[];
  io: ReportCliIo;
  usage: string;
  options: CliOptions;
  buildQueue(values: CliValues, io: ReportCliIo): T;
  isClear(queue: T): boolean;
  failureMessage(queue: T): string;
  writeSummary?(queue: T, stdout: ReportCliIo["stdout"]): void;
}): T | null {
  const { values } = parseStrictCliArgs(input.argv, {
    options: {
      ...input.options,
      output: { type: "string" },
      "require-clear": { type: "boolean" },
    },
  });
  if (writeCliHelpIfRequested(values, input.usage, input.io.stdout)) return null;
  const outputPath = requireCliString(values.output, "--output");
  const queue = input.buildQueue(values, input.io);
  input.io.writeText(outputPath, `${JSON.stringify(queue, null, 2)}\n`);
  input.writeSummary?.(queue, input.io.stdout);
  if (values["require-clear"] === true && !input.isClear(queue)) {
    throw new Error(input.failureMessage(queue));
  }
  return queue;
}

export * from "./coverage-audit-cli";

export {
  parseCoverageAuditCliArgs as parseReportCliArgs,
  renderCoverageAuditReport as renderReport,
  runCoverageAuditCli as runReportCli,
} from "./coverage-audit-cli";

export type {
  CoverageAuditCliDescriptor as ReportCliDescriptor,
  CoverageAuditOptionDescriptor as ReportCliOptionDescriptor,
  CoverageAuditReportFormat as ReportCliReportFormat,
  CoverageAuditRunDescriptor as ReportCliRunDescriptor,
  CoverageAuditShellOptions as ReportCliShellOptions,
} from "./coverage-audit-cli";
