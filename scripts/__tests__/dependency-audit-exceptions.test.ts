import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  DEPENDENCY_AUDIT_EXCEPTION_REGISTRY,
  runFullLockfileDependencyAudit,
  runNewSinceDependencyAudit,
  verifyDependencyAuditDelta,
  verifyDependencyAuditReport,
} from "../ci/verify-dependency-audit.ts";
import { buildPrStaticCheckPlan, resolvePrDependencyAuditBase } from "../maintenance/run-pr-static-checks.ts";

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

  it("reports pre-existing advisory/package pairs while passing a PR delta audit", () => {
    const baseSha = "a".repeat(40);
    let auditCount = 0;
    let snapshotDirectory = "";
    const stdout = { write: vi.fn() };
    const spawn = vi.fn((command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string> => {
      let output = "{}";
      if (command === "git") {
        expect(args[0]).toBe("show");
        expect([`${baseSha}:package.json`, `${baseSha}:package-lock.json`]).toContain(args[1]);
        expect(args).toHaveLength(2);
      } else {
        expect(command).toBe("npm");
        expect(args).toEqual(["audit", "--package-lock-only", "--json", "--audit-level=high", "--include=dev"]);
        auditCount++;
        if (auditCount === 1) {
          snapshotDirectory = String(options.cwd);
          expect(readFileSync(join(snapshotDirectory, "package.json"), "utf8")).toBe("{}");
          expect(readFileSync(join(snapshotDirectory, "package-lock.json"), "utf8")).toBe("{}");
        } else {
          expect(options.cwd).toBe("/current-repo");
        }
        output = JSON.stringify(reviewedReport());
      }
      return { pid: 0, output: [], stdout: output, stderr: "", status: command === "npm" ? 1 : 0, signal: null };
    });
    const result = runNewSinceDependencyAudit({ baseSha, cwd: "/current-repo", spawn, stdout });
    expect(result.preExisting).toEqual([
      { advisoryId: exception.advisoryId, package: "brace-expansion" },
      { advisoryId: exception.advisoryId, package: "minimatch" },
    ]);
    expect(stdout.write.mock.calls.map(([chunk]) => chunk).join("")).toContain("pre-existing, tracked by weekly audit");
    expect(auditCount).toBe(2);
    expect(existsSync(snapshotDirectory)).toBe(false);
  });

  it("fails on a new advisory even when its package already exists at base", () => {
    const current = reviewedReport();
    current.vulnerabilities["brace-expansion"].via.push({
      ...(current.vulnerabilities["brace-expansion"].via[0] as object),
      url: "https://github.com/advisories/GHSA-new-advisory",
    });
    expect(() => verifyDependencyAuditDelta(current, reviewedReport())).toThrow("GHSA-new-advisory affects brace-expansion");
  });

  it("fails when a pre-existing advisory reaches a new package", () => {
    const current = reviewedReport();
    current.vulnerabilities["new-parent"] = {
      name: "new-parent", severity: "high", via: ["minimatch"], effects: [], nodes: ["node_modules/new-parent"],
    };
    expect(() => verifyDependencyAuditDelta(current, reviewedReport())).toThrow(`${exception.advisoryId} affects new-parent`);
  });

  it("fails explicitly for missing base evidence without auditing the current tree", () => {
    const spawn = vi.fn((): SpawnSyncReturns<string> => ({
      pid: 0, output: [], stdout: "", stderr: "missing object", status: 128, signal: null,
    }));
    expect(() => runNewSinceDependencyAudit({ baseSha: "a".repeat(40), spawn }))
      .toThrow("Cannot read package.json at base");
    expect(spawn).toHaveBeenCalledOnce();
    expect(() => runNewSinceDependencyAudit({ baseSha: "", spawn })).toThrow("--new-since requires a full base commit SHA");
  });

  it.each([
    {},
    { vulnerabilities: { risk: { severity: "high", via: ["missing"] } } },
    { vulnerabilities: { risk: { severity: "high", via: ["risk"] } } },
    { vulnerabilities: { risk: { severity: "high", via: [{}] } } },
  ])("fails closed for malformed base/current audit evidence %j", (report) => {
    expect(() => verifyDependencyAuditDelta(report, reviewedReport())).toThrow();
    expect(() => verifyDependencyAuditDelta(reviewedReport(), report)).toThrow();
  });

  it("uses the frozen PR base without Git fallback and resolves merge-base otherwise", () => {
    const execGit = vi.fn(() => `${"b".repeat(40)}\n`);
    expect(resolvePrDependencyAuditBase({ NODE_ENV: "test", PR_BASE_SHA: "a".repeat(40) }, "HEAD", execGit)).toBe("a".repeat(40));
    expect(execGit).not.toHaveBeenCalled();
    expect(resolvePrDependencyAuditBase({ NODE_ENV: "test" }, "selected-head", execGit)).toBe("b".repeat(40));
    expect(execGit).toHaveBeenCalledWith(["merge-base", "selected-head", "origin/main"]);
    expect(() => resolvePrDependencyAuditBase({ NODE_ENV: "test" }, "HEAD", () => "")).toThrow("Cannot resolve dependency-audit base");
  });

  it("adds the production audit only to guards for root dependency inputs", () => {
    for (const path of ["package.json", "package-lock.json"]) {
      expect(buildPrStaticCheckPlan([path]).commands.map((command) => command.name)).toContain("audit:deps");
      expect(buildPrStaticCheckPlan([path], { group: "guards" }).commands.map((command) => command.name))
        .toContain("audit:deps");
      expect(buildPrStaticCheckPlan([path], { group: "compile" }).commands.map((command) => command.name))
        .not.toContain("audit:deps");
    }
    for (const group of [undefined, "compile", "guards"] as const) {
      expect(buildPrStaticCheckPlan(["worker/package.json"], { group }).commands.map((command) => command.name))
        .not.toContain("audit:deps");
    }
  });
});
