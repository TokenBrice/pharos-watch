import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  parseMechanismRefreshVerifierArgs,
  restoreMechanismRefreshArtifacts,
  verifyAppendOnlyMechanismRefreshDiff,
  verifyMechanismRefresh,
} from "../ci/verify-mechanism-refresh-diff";
import {
  buildProtocolApiMeasurement,
  FALCON_TRANSPARENCY_URL,
  protocolApiEvidenceFilename,
  serializeProtocolApiMeasurement,
} from "../lib/mechanism-measurement/protocol-api";

const TSX_LOADER = import.meta.resolve("tsx");
const TSCONFIG = resolve("tsconfig.json");

function write(root: string, path: string, content: string): void {
  const absolutePath = join(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

describe("mechanism refresh append-only verifier", () => {
  it("preserves the workflow rejection for a synthetic non-append PR", () => {
    const root = mkdtempSync(join(tmpdir(), "pharos-mechanism-refresh-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
    const path = "shared/data/safety-score-v9/mechanism-measurements/usde-ethena/existing-protocol-api.json";
    try {
      git("init", "-q");
      git("config", "user.name", "Fixture");
      git("config", "user.email", "fixture@example.test");
      write(root, path, "before\n");
      git("add", "--", path);
      git("commit", "-qm", "base");
      git("update-ref", "refs/remotes/origin/main", "HEAD");
      write(root, path, "after\n");
      git("add", "--", path);
      git("commit", "-qm", "modify capture");

      const expected = `::error title=Non-append-only mechanism PR::${path} has status M.`;
      expect(() => verifyAppendOnlyMechanismRefreshDiff("usde-ethena", { cwd: root })).toThrow(expected);

      const cli = spawnSync(
        process.execPath,
        [
          "--import",
          TSX_LOADER,
          resolve(process.cwd(), "scripts/ci/verify-mechanism-refresh-diff.ts"),
          "--asset",
          "usde-ethena",
          "--stage",
          "verify-diff",
        ],
        { cwd: root, encoding: "utf8", env: { ...process.env, TSX_TSCONFIG_PATH: TSCONFIG } },
      );
      expect(cli.status).toBe(1);
      expect(cli.stderr).toBe(`${expected}\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("mechanism refresh captured artifact handoff", () => {
  const asset = "usdf-falcon";
  const branch = `automated/protocol-api-mechanism-refresh/${asset}`;
  const evidenceRoot = `shared/data/safety-score-v9/mechanism-measurements/${asset}`;

  function artifact(capturedAt: string, supply = "90") {
    return buildProtocolApiMeasurement(asset, [{
      sourceId: "falcon-transparency",
      url: FALCON_TRANSPARENCY_URL,
      rawBody: Buffer.from(JSON.stringify({
        snapshot_date: 1784750400, tvl: "100",
        usdf: { supply, insurance_fund: "1", reserves: { ceffu: { stablecoins: "105" } },
          venues: {}, breakdown: { assets: [{ label: "USDC", ceffu: "100" }] } },
      })),
      headers: { date: capturedAt },
    }], new Date(capturedAt));
  }

  it.each([false, true])(
    "runs the real workflow handoff for an open PR (new snapshot: %s)",
    (newSnapshot) => {
      const root = mkdtempSync(join(tmpdir(), "pharos-mechanism-handoff-"));
      const cwd = join(root, "work");
      mkdirSync(cwd);
      const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
      const original = artifact("2026-07-22T20:05:00.000Z");
      const incoming = artifact("2026-07-22T21:05:00.000Z", newSnapshot ? "91" : "90");
      const originalPath = `${evidenceRoot}/${protocolApiEvidenceFilename(original)}`;
      const incomingPath = `${evidenceRoot}/${protocolApiEvidenceFilename(incoming)}`;
      try {
        git("init", "-qb", "main");
        git("config", "user.email", "fixture@example.test");
        git("config", "user.name", "Fixture");
        write(cwd, "base.txt", "base\n");
        git("add", "base.txt");
        git("commit", "-qm", "base");
        git("checkout", "-qb", branch);
        write(cwd, originalPath, serializeProtocolApiMeasurement(original));
        git("add", originalPath);
        git("commit", "-qm", "existing snapshot");
        execFileSync("git", ["init", "--bare", "-q", join(root, "remote.git")]);
        git("remote", "add", "origin", join(root, "remote.git"));
        git("push", "-q", "origin", "main", branch);
        git("checkout", "-q", "main");
        // Match a checkout without a pre-fetched automation tracking ref.
        git("update-ref", "-d", `refs/remotes/origin/${branch}`);
        write(cwd, incomingPath, serializeProtocolApiMeasurement(incoming));
        symlinkSync(resolve("scripts"), join(cwd, "scripts"), "dir");
        symlinkSync(resolve("node_modules"), join(cwd, "node_modules"), "dir");
        write(cwd, "bin/gh", '#!/bin/sh\nprintf \'[{"state":"OPEN","mergedAt":null}]\\n\'\n');
        execFileSync("chmod", ["+x", join(cwd, "bin/gh")]);

        const workflow = parseYaml(readFileSync(resolve(".github/workflows/protocol-api-mechanism-refresh.yml"), "utf8"));
        const step = workflow.jobs.refresh.steps.find((candidate: { name?: string }) => candidate.name === "Open or update refresh PR");
        // Execute the authored shell through checkout, rebase, restoration and
        // the no-change exit; stop before commit/push/PR publication.
        const prefix = step.run.slice(0, step.run.indexOf("git commit \\\n"));
        expect(prefix).toContain("--stage restore-artifacts");
        const result = spawnSync("bash", ["-c", prefix], {
          cwd, encoding: "utf8",
          env: { ...process.env, ASSET_ID: asset, GITHUB_REPOSITORY: "TokenBrice/pharos-watch",
            PATH: `${join(cwd, "bin")}:${process.env.PATH}`, TSX_TSCONFIG_PATH: TSCONFIG },
        });
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(git("branch", "--show-current").trim()).toBe(branch);
        expect(readFileSync(join(cwd, originalPath), "utf8")).toBe(serializeProtocolApiMeasurement(original));
        if (newSnapshot) {
          expect(git("diff", "--cached", "--name-status")).toBe(`A\t${incomingPath}\n`);
          expect(readFileSync(join(cwd, incomingPath), "utf8")).toBe(serializeProtocolApiMeasurement(incoming));
        } else {
          expect(result.stdout).toContain("No new usdf-falcon protocol API snapshot beyond the existing refresh PR.");
          expect(git("diff", "--cached", "--name-status")).toBe("");
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("refuses a conflicting snapshot at an existing path without overwriting it", () => {
    const root = mkdtempSync(join(tmpdir(), "pharos-mechanism-conflict-"));
    const original = artifact("2026-07-22T20:05:00.000Z");
    const incoming = artifact("2026-07-22T21:05:00.000Z", "91");
    const path = `${evidenceRoot}/${protocolApiEvidenceFilename(original)}`;
    try {
      write(root, path, serializeProtocolApiMeasurement(original));
      write(join(root, "captures"), path, serializeProtocolApiMeasurement(incoming));
      expect(() => restoreMechanismRefreshArtifacts(asset, join(root, "captures"), root))
        .toThrow("Conflicting mechanism artifact");
      expect(readFileSync(join(root, path), "utf8")).toBe(serializeProtocolApiMeasurement(original));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires an artifact directory only for restoration", () => {
    expect(() => parseMechanismRefreshVerifierArgs(["--asset", asset, "--stage", "restore-artifacts"]))
      .toThrow("--artifacts-dir is required only for restore-artifacts");
    expect(() => parseMechanismRefreshVerifierArgs([
      "--asset", asset, "--stage", "prepare-branch", "--artifacts-dir", "/tmp/captures",
    ])).toThrow("--artifacts-dir is required only for restore-artifacts");
  });
});

describe("mechanism refresh branch lifecycle", () => {
  const asset = "usdf-falcon";
  const repository = "TokenBrice/pharos-watch";
  const branch = `automated/protocol-api-mechanism-refresh/${asset}`;
  const head = "971a39803deaaa7d9e1424bdfaf01e81ec79648a";
  const deleteArgs = ["api", "--method", "DELETE", `repos/${repository}/git/refs/heads/${branch}`];
  const checkoutMainArgs = ["checkout", "-B", branch, "origin/main"];
  const deleteTrackingArgs = ["update-ref", "-d", `refs/remotes/origin/${branch}`];
  type PrHistory = Array<{ state: string; mergedAt: string | null }>;

  function branchRunner(options: {
    history?: PrHistory;
    mergedHeads?: string[];
    remoteStatus?: number;
    ancestorStatus?: number;
    mergedLookupStatus?: number;
    deleteStatus?: number;
    trackingCleanupStatus?: number;
  } = {}) {
    return vi.fn((file: string, args: readonly string[]) => {
      if (file === "gh" && args[0] === "pr" && args[1] === "list") {
        if (args[args.indexOf("--state") + 1] === "merged") {
          expect(args).toEqual([
            "pr", "list", "--repo", repository, "--state", "merged", "--base", "main", "--head", branch,
            "--limit", "100", "--json", "headRefOid",
          ]);
          return {
            status: options.mergedLookupStatus ?? 0,
            stdout: JSON.stringify((options.mergedHeads ?? [head]).map((headRefOid) => ({ headRefOid }))),
          };
        }
        expect(args).toEqual([
          "pr", "list", "--repo", repository, "--state", "all", "--base", "main", "--head", branch,
          "--limit", "100", "--json", "number,state,mergedAt",
        ]);
        return { status: 0, stdout: JSON.stringify(options.history ?? [{ state: "MERGED", mergedAt: "2026-10-16T12:00:00Z" }]) };
      }
      if (file === "gh" && args[0] === "api") {
        expect(args).toEqual(deleteArgs);
        return { status: options.deleteStatus ?? 0, stdout: "" };
      }
      if (file === "git") {
        switch (args[0]) {
          case "fetch":
            expect(args).toEqual(expect.arrayContaining(["origin"]));
            return { status: 0, stdout: "" };
          case "ls-remote":
            expect(args).toEqual(["ls-remote", "--exit-code", "--heads", "origin", branch]);
            return { status: options.remoteStatus ?? 0, stdout: `${head}\trefs/heads/${branch}\n` };
          case "merge-base":
            expect(args).toEqual(["merge-base", "--is-ancestor", `origin/${branch}`, "origin/main"]);
            return { status: options.ancestorStatus ?? 1, stdout: "" };
          case "rev-parse":
            expect(args).toEqual(["rev-parse", `origin/${branch}`]);
            return { status: 0, stdout: `${head}\n` };
          case "update-ref":
            expect(args).toEqual(deleteTrackingArgs);
            return { status: options.trackingCleanupStatus ?? 0, stdout: "" };
          case "checkout":
          case "rebase":
            return { status: 0, stdout: "" };
        }
      }
      throw new Error(`Unexpected command: ${file} ${args.join(" ")}`);
    });
  }

  it.each(["validate-branch", "prepare-branch"] as const)(
    "%s deletes only the squash-merged target branch before starting again from main",
    (stage) => {
      const run = branchRunner();
      verifyMechanismRefresh({ asset, stage }, { repository, run });
      expect(run).toHaveBeenCalledWith("gh", deleteArgs);
      expect(run).toHaveBeenCalledWith("git", deleteTrackingArgs);
      expect(run.mock.calls.filter(([file, args]) => file === "gh" && args[0] === "api")).toHaveLength(1);
      if (stage === "prepare-branch") {
        expect(run.mock.calls.at(-1)).toEqual(["git", checkoutMainArgs]);
      } else {
        expect(run.mock.calls.some(([, args]) => args[0] === "checkout")).toBe(false);
      }
      expect(run).toHaveBeenCalledWith("git", ["fetch", "origin", "main:refs/remotes/origin/main"]);
    },
  );

  it("does not treat an older merged PR as permission to delete new unowned commits", () => {
    const run = branchRunner({ mergedHeads: ["0".repeat(40)] });
    expect(() => verifyMechanismRefresh({ asset, stage: "prepare-branch" }, { repository, run }))
      .toThrow("Unowned mechanism refresh history");
    expect(run).not.toHaveBeenCalledWith("gh", deleteArgs);
    expect(run).not.toHaveBeenCalledWith("git", checkoutMainArgs);
  });

  it("refuses an orphaned branch without a merged PR", () => {
    const run = branchRunner({ history: [], mergedHeads: [] });
    expect(() => verifyMechanismRefresh({ asset, stage: "prepare-branch" }, { repository, run }))
      .toThrow("Unowned mechanism refresh history");
    expect(run).not.toHaveBeenCalledWith("gh", deleteArgs);
  });

  it("updates one open PR without deleting its branch even with prior merged history", () => {
    const run = branchRunner({
      history: [{ state: "MERGED", mergedAt: "2026-10-15T12:00:00Z" }, { state: "OPEN", mergedAt: null }],
    });
    verifyMechanismRefresh({ asset, stage: "prepare-branch" }, { repository, run });
    expect(run).toHaveBeenCalledWith("git", ["checkout", "-B", branch, `origin/${branch}`]);
    expect(run).toHaveBeenCalledWith("git", ["rebase", "origin/main"]);
    expect(run).not.toHaveBeenCalledWith("gh", deleteArgs);
  });

  it.each(["validate-branch", "prepare-branch"] as const)("%s refuses conflicting open PRs", (stage) => {
    const run = branchRunner({ history: [{ state: "OPEN", mergedAt: null }, { state: "OPEN", mergedAt: null }] });
    expect(() => verifyMechanismRefresh({ asset, stage }, { repository, run }))
      .toThrow("Ambiguous mechanism refresh PR");
    expect(run).not.toHaveBeenCalledWith("gh", deleteArgs);
  });

  it("refuses an open PR whose remote branch is missing", () => {
    const run = branchRunner({ history: [{ state: "OPEN", mergedAt: null }], remoteStatus: 2 });
    expect(() => verifyMechanismRefresh({ asset, stage: "validate-branch" }, { repository, run }))
      .toThrow("Inconsistent mechanism refresh branch");
    expect(run).not.toHaveBeenCalledWith("gh", deleteArgs);
  });

  it.each([0, 2])("refuses closed-unmerged history with remote status %s", (remoteStatus) => {
    const run = branchRunner({
      history: [{ state: "MERGED", mergedAt: "2026-10-15T12:00:00Z" }, { state: "CLOSED", mergedAt: null }],
      remoteStatus,
    });
    expect(() => verifyMechanismRefresh({ asset, stage: "prepare-branch" }, { repository, run }))
      .toThrow("Closed unmerged mechanism refresh");
    expect(run).not.toHaveBeenCalledWith("gh", deleteArgs);
    expect(run).not.toHaveBeenCalledWith("git", checkoutMainArgs);
  });

  it("starts from main after the previously merged branch was already deleted", () => {
    const run = branchRunner({ remoteStatus: 2 });
    verifyMechanismRefresh({ asset, stage: "prepare-branch" }, { repository, run });
    expect(run).toHaveBeenCalledWith("git", checkoutMainArgs);
    expect(run).toHaveBeenCalledWith("git", deleteTrackingArgs);
    expect(run).not.toHaveBeenCalledWith("gh", deleteArgs);
  });

  it("prepares a first refresh with no branch or PR history", () => {
    const run = branchRunner({ remoteStatus: 2, history: [] });
    verifyMechanismRefresh({ asset, stage: "prepare-branch" }, { repository, run });
    expect(run).toHaveBeenCalledWith("git", checkoutMainArgs);
    expect(run).not.toHaveBeenCalledWith("gh", deleteArgs);
  });

  it("resets an ancestor branch from main without needing squash-merge cleanup", () => {
    const run = branchRunner({ ancestorStatus: 0 });
    verifyMechanismRefresh({ asset, stage: "prepare-branch" }, { repository, run });
    expect(run).toHaveBeenCalledWith("git", checkoutMainArgs);
    expect(run).not.toHaveBeenCalledWith("gh", deleteArgs);
  });

  it.each([
    { mergedLookupStatus: 1, error: "Merged mechanism refresh PR lookup failed" },
    { deleteStatus: 1, error: "Merged mechanism refresh branch deletion failed" },
    { trackingCleanupStatus: 1, error: "Merged mechanism refresh tracking ref cleanup failed" },
  ])("stops when cleanup cannot be proven or completed: $error", ({ error, ...options }) => {
    const run = branchRunner(options);
    expect(() => verifyMechanismRefresh({ asset, stage: "prepare-branch" }, { repository, run })).toThrow(error);
    expect(run).not.toHaveBeenCalledWith("git", checkoutMainArgs);
  });

  it("never cleans up on a failed ancestry inspection", () => {
    const run = branchRunner({ ancestorStatus: 128 });
    expect(() => verifyMechanismRefresh({ asset, stage: "prepare-branch" }, { repository, run }))
      .toThrow("Unowned mechanism refresh history");
    expect(run).not.toHaveBeenCalledWith("gh", deleteArgs);
  });

  it("grants the main-only cleanup job contents write with a step-scoped token", () => {
    const workflow = parseYaml(readFileSync(resolve(".github/workflows/protocol-api-mechanism-refresh.yml"), "utf8"));
    expect(workflow.permissions).toEqual({ contents: "read", "pull-requests": "read" });
    expect(workflow.jobs.refresh.permissions).toEqual({ contents: "write", "pull-requests": "read" });
    expect(workflow.jobs.refresh.if).toBe("${{ github.ref == 'refs/heads/main' }}");
    expect(workflow.jobs.refresh.env).toBeUndefined();
    const validation = workflow.jobs.refresh.steps.find((step: { name?: string }) => step.name === "Validate target branch ownership");
    expect(validation.env).toEqual({ ASSET_ID: "${{ matrix.asset }}", GH_TOKEN: "${{ github.token }}" });
    expect(validation.run).toBe(
      'node --import tsx scripts/ci/verify-mechanism-refresh-diff.ts --asset "$ASSET_ID" --stage validate-branch',
    );
  });
});
