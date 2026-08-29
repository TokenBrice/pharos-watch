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
