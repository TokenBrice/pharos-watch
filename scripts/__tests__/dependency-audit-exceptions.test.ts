import { describe, expect, it, vi } from "vitest";

import {
  DEPENDENCY_AUDIT_EXCEPTION_REGISTRY,
  runFullLockfileDependencyAudit,
  verifyDependencyAuditReport,
} from "../ci/verify-dependency-audit.mjs";
import { buildPrStaticCheckPlan } from "../maintenance/run-pr-static-checks.mjs";

type AuditVulnerability = {
  effects: string[];
  name: string;
  nodes: string[];
  severity: "high" | "critical";
  via: unknown[];
};

type AuditReport = {
  auditReportVersion: number;
  vulnerabilities: Record<string, AuditVulnerability>;
};

const exception = DEPENDENCY_AUDIT_EXCEPTION_REGISTRY.exceptions[0];
const reviewedNow = new Date("2026-07-29T12:00:00.000Z");

function reviewedReport(): AuditReport {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      "brace-expansion": {
        name: "brace-expansion",
        severity: "high",
        via: [
          {
            source: exception.source,
            name: exception.dependency,
            dependency: exception.dependency,
            severity: exception.severity,
            range: exception.range,
            url: `https://github.com/advisories/${exception.advisoryId}`,
          },
        ],
        effects: ["minimatch"],
        nodes: [...exception.nodes],
      },
      minimatch: {
        name: "minimatch",
        severity: "high",
        via: ["brace-expansion"],
        effects: [],
        nodes: ["node_modules/eslint/node_modules/minimatch"],
      },
    },
  };
}

describe("dependency-audit exceptions", () => {
  it("suppresses only the exact reviewed advisory and dependency nodes", () => {
    expect(verifyDependencyAuditReport(reviewedReport(), { now: reviewedNow })).toEqual({
      acceptedExceptionIds: [exception.advisoryId],
    });

    const changedPath = reviewedReport();
    changedPath.vulnerabilities["brace-expansion"].nodes.push("node_modules/unreviewed/node_modules/brace-expansion");
    expect(() => verifyDependencyAuditReport(changedPath, { now: reviewedNow })).toThrow(
      "Unreviewed high/critical advisory affects brace-expansion.",
    );
  });

  it("fails closed for a new high/critical advisory", () => {
    const report = reviewedReport();
    report.vulnerabilities["new-risk"] = {
      name: "new-risk",
      severity: "critical",
      via: [
        {
          source: 9999999,
          name: "new-risk",
          dependency: "new-risk",
          severity: "critical",
          range: "*",
          url: "https://github.com/advisories/GHSA-new-risk",
        },
      ],
      effects: [],
      nodes: ["node_modules/new-risk"],
    };

    expect(() => verifyDependencyAuditReport(report, { now: reviewedNow })).toThrow(
      "Unreviewed high/critical advisory affects new-risk.",
    );
  });

  it("fails closed after the exception expiry date", () => {
    expect(() => verifyDependencyAuditReport(reviewedReport(), { now: new Date("2026-08-16T00:00:00.000Z") })).toThrow(
      "Dependency-audit exception expired on 2026-08-15.",
    );
  });

  it("processes npm audit's expected finding exit code before applying exceptions", () => {
    const spawn = vi.fn(() => ({ status: 1, stdout: JSON.stringify(reviewedReport()) }));

    expect(runFullLockfileDependencyAudit({ now: reviewedNow, spawn })).toEqual({
      acceptedExceptionIds: [exception.advisoryId],
    });
    expect(spawn).toHaveBeenCalledWith(
      "npm",
      ["audit", "--json", "--audit-level=high"],
      expect.objectContaining({ encoding: "utf8" }),
    );
  });

  it("adds the production audit only for root dependency inputs", () => {
    for (const path of ["package.json", "package-lock.json"]) {
      expect(buildPrStaticCheckPlan([path]).commands.map((command) => command.name)).toContain("audit:deps");
    }
    expect(buildPrStaticCheckPlan(["worker/package.json"]).commands.map((command) => command.name)).not.toContain(
      "audit:deps",
    );
  });
});
