import type { SpawnSyncReturns } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import {
  DEPENDENCY_AUDIT_EXCEPTION_REGISTRY,
  runFullLockfileDependencyAudit,
  verifyDependencyAuditReport,
} from "../ci/verify-dependency-audit.ts";
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

const exception = {
  advisoryId: "GHSA-reviewed-fixture",
  source: 1,
  dependency: "brace-expansion",
  severity: "high",
  range: "<1.1.18",
  expiresOn: "2026-08-15",
  nodes: [
    "node_modules/@eslint/config-array/node_modules/brace-expansion",
    "node_modules/@eslint/eslintrc/node_modules/brace-expansion",
  ],
  affectedPackages: ["brace-expansion", "minimatch"],
} as const;
const reviewedRegistry = { version: 1, exceptions: [exception] };
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
  it("keeps the live registry empty after the reviewed advisories are patched", () => {
    expect(DEPENDENCY_AUDIT_EXCEPTION_REGISTRY).toEqual({ version: 1, exceptions: [] });
    expect(verifyDependencyAuditReport({ auditReportVersion: 2, vulnerabilities: {} }, { now: reviewedNow })).toEqual({
      acceptedExceptionIds: [],
    });
  });

  it("suppresses only the exact reviewed advisory and dependency nodes", () => {
    expect(verifyDependencyAuditReport(reviewedReport(), { registry: reviewedRegistry, now: reviewedNow })).toEqual({
      acceptedExceptionIds: [exception.advisoryId],
    });

    const changedPath = reviewedReport();
    changedPath.vulnerabilities["brace-expansion"].nodes.push("node_modules/unreviewed/node_modules/brace-expansion");
    expect(() => verifyDependencyAuditReport(changedPath, { registry: reviewedRegistry, now: reviewedNow })).toThrow(
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

    expect(() => verifyDependencyAuditReport(report, { registry: reviewedRegistry, now: reviewedNow })).toThrow(
      "Unreviewed high/critical advisory affects new-risk.",
    );
  });

  it("fails closed after the exception expiry date", () => {
    expect(() =>
      verifyDependencyAuditReport(reviewedReport(), {
        registry: reviewedRegistry,
        now: new Date("2026-08-16T00:00:00.000Z"),
      }),
    ).toThrow("Dependency-audit exception expired on 2026-08-15.");
  });

  it("processes npm audit's expected finding exit code before applying exceptions", () => {
    const stdout = JSON.stringify(reviewedReport());
    const spawn = vi.fn((): SpawnSyncReturns<string> => ({
      pid: 0,
      output: [null, stdout, ""],
      stdout,
      stderr: "",
      status: 1,
      signal: null,
    }));

    expect(runFullLockfileDependencyAudit({ now: reviewedNow, registry: reviewedRegistry, spawn })).toEqual({
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
