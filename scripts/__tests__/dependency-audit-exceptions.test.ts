import type { SpawnSyncReturns } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import {
  DEPENDENCY_AUDIT_EXCEPTION_REGISTRY,
  runFullLockfileDependencyAudit,
  verifyDependencyAuditReport,
} from "../ci/verify-dependency-audit.ts";
import { buildPrStaticCheckPlan } from "../maintenance/run-pr-static-checks.ts";

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

  it("accepts disjoint reviewed advisory roots without cross-contaminating package allowlists", () => {
    const other = {
      ...exception, advisoryId: "GHSA-other-fixture", source: 2, dependency: "other",
      nodes: ["node_modules/other"], affectedPackages: ["other", "other-consumer"],
    };
    const report = reviewedReport();
    report.vulnerabilities.other = {
      name: "other", severity: "high", nodes: other.nodes, effects: ["other-consumer"],
      via: [{
        source: 2, name: "other", dependency: "other", severity: "high", range: "<1.1.18",
        url: "https://github.com/advisories/GHSA-other-fixture",
      }],
    };
    report.vulnerabilities["other-consumer"] = {
      name: "other-consumer", severity: "high", nodes: ["node_modules/other-consumer"],
      effects: [], via: ["other"],
    };
    expect(verifyDependencyAuditReport(report, {
      registry: { version: 1, exceptions: [exception, other] }, now: reviewedNow,
    })).toEqual({ acceptedExceptionIds: ["GHSA-other-fixture", "GHSA-reviewed-fixture"] });
  });

  it("rejects both reachable unapproved packages and disconnected indirect vulnerabilities", () => {
    for (const reachable of [true, false]) {
      const report = reviewedReport();
      report.vulnerabilities.unapproved = {
        name: "unapproved", severity: "high", nodes: ["node_modules/unapproved"],
        effects: [], via: ["minimatch"],
      };
      if (reachable) report.vulnerabilities.minimatch.effects.push("unapproved");
      expect(() => verifyDependencyAuditReport(report, { registry: reviewedRegistry, now: reviewedNow }))
        .toThrow(reachable ? "reached unreviewed package unapproved" : "Unreviewed high/critical vulnerability affects unapproved");
    }
  });

  it("rejects changed advisory identity, range and additional direct advisories", () => {
    for (const mutation of [{ source: 2 }, { range: "*" }, { extra: true }]) {
      const report = reviewedReport();
      const vulnerability = report.vulnerabilities["brace-expansion"];
      if ("extra" in mutation) vulnerability.via.push({ source: 2 });
      else Object.assign(vulnerability.via[0] as object, mutation);
      expect(() => verifyDependencyAuditReport(report, { registry: reviewedRegistry, now: reviewedNow }))
        .toThrow("Unreviewed high/critical advisory affects brace-expansion");
    }
  });

  it("fails closed for spawn errors, unexpected statuses and malformed JSON", () => {
    for (const failure of [
      { error: new Error("spawn failed"), status: null, stdout: JSON.stringify(reviewedReport()), message: "spawn failed" },
      { status: 2, stdout: JSON.stringify(reviewedReport()), message: "exited unexpectedly" },
      { status: 0, stdout: "{", message: "did not emit JSON" },
    ]) {
      const spawn = (): SpawnSyncReturns<string> => ({
        pid: 0, output: [], stderr: "", signal: null, ...failure,
      });
      expect(() => runFullLockfileDependencyAudit({ spawn, registry: reviewedRegistry, now: reviewedNow }))
        .toThrow(failure.message);
    }
  });

  it("accepts the final expiry-day instant and rejects the next UTC midnight", () => {
    expect(verifyDependencyAuditReport(reviewedReport(), {
      registry: reviewedRegistry, now: new Date("2026-08-15T23:59:59.999Z"),
    })).toEqual({ acceptedExceptionIds: [exception.advisoryId] });
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
