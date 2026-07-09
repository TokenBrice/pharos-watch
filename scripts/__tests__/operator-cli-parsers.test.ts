import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { parseWorkerDeploymentArgs } from "../../.github/scripts/deploy-worker-version.mjs";
import { parseWorkflowWaitArgs } from "../../.github/scripts/wait-for-workflow-job.mjs";
import { parseWorkerDeployGuardArgs } from "../ci/guard-worker-deploy.mjs";
import { syncJson } from "../lib/sync-from-api";
import {
  backfillAiSummaryProvenance,
  parseAiSummaryBackfillArgs,
} from "../maintenance/backfill-ai-summary-provenance.mjs";
import { parseFreezeStablecoinArgs } from "../maintenance/freeze-stablecoin";
import { parseTelegramRegistrationArgs } from "../maintenance/register-telegram";
import { parsePagesRollbackArgs } from "../maintenance/rollback-pages-deployment.mjs";
import { parseDepegSyncArgs } from "../maintenance/sync-depeg-events";
import { parseDigestSyncArgs } from "../maintenance/sync-digests";
import { parseReleaseMarkerArgs } from "../maintenance/wait-pages-release-marker.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { force: true, recursive: true });
});

describe("priority operator CLI parsers", () => {
  it("preserves documented Telegram registration flags and dry-run alias", () => {
    expect(
      parseTelegramRegistrationArgs(
        ["--action", "commands", "--scope", "chat", "--chat-id", "-100123", "--check"],
        {},
      ),
    ).toMatchObject({
      action: "commands",
      chatId: "-100123",
      dryRun: true,
      scope: "chat",
    });
    expect(() => parseTelegramRegistrationArgs(["--scope", "chat"], {})).toThrow(
      "--scope chat requires --chat-id",
    );
    expect(() => parseTelegramRegistrationArgs(["--chat-id", "123"], {})).toThrow(
      "--chat-id requires --scope chat",
    );
    expect(() => parseTelegramRegistrationArgs(["--check", "--dry-run"], {})).toThrow(
      "cannot be used together",
    );
    expect(() => parseTelegramRegistrationArgs(["--action", "profile", "--webhook-base-url", "https://x.test"], {}))
      .toThrow("--webhook-base-url is only valid");
    expect(() => parseTelegramRegistrationArgs(["--scope", "chat", "--chat-id", "not-a-number"], {}))
      .toThrow("--chat-id must be an integer");
  });

  it("strictly parses digest and depeg sync controls", () => {
    expect(parseDigestSyncArgs(["--api-url", "https://api.test", "--output=data/d.json", "--dry-run"]))
      .toMatchObject({ apiUrl: "https://api.test", output: "data/d.json", dryRun: true });
    expect(parseDepegSyncArgs(["--allow-empty", "--dry-run"]))
      .toMatchObject({ allowEmpty: true, dryRun: true });
    expect(() => parseDigestSyncArgs(["--output"])).toThrow("argument missing");
    expect(() => parseDepegSyncArgs(["--allow-empty", "--allow-empty"])).toThrow(
      "may only be specified once",
    );
    expect(() => parseDigestSyncArgs(["--unknown"])).toThrow("Unknown option");
  });

  it("validates provenance backfill review inputs and real dates", () => {
    const env = {
      AI_SUMMARY_REVIEWED_AT: "2026-07-09",
      AI_SUMMARY_REVIEWED_BY: "@reviewer",
    };
    expect(parseAiSummaryBackfillArgs(["--model", "gpt-test", "--dry-run"], env)).toMatchObject({
      dryRun: true,
      model: "gpt-test",
      reviewedAt: "2026-07-09",
    });
    expect(() =>
      parseAiSummaryBackfillArgs([], { ...env, AI_SUMMARY_REVIEWED_AT: "2026-02-30" }),
    ).toThrow("real YYYY-MM-DD");
    expect(() => parseAiSummaryBackfillArgs(["--model", "one", "--model", "two"], env)).toThrow(
      "may only be specified once",
    );
  });

  it("requires exactly one freeze target and rejects option-like typos", () => {
    expect(parseFreezeStablecoinArgs(["--dry-run", "usdc-circle"])).toEqual({
      coinId: "usdc-circle",
      dryRun: true,
      help: false,
    });
    expect(() => parseFreezeStablecoinArgs([])).toThrow("exactly one <coinId>");
    expect(() => parseFreezeStablecoinArgs(["one", "two"])).toThrow("exactly one <coinId>");
    expect(() => parseFreezeStablecoinArgs(["--coin", "usdc-circle"])).toThrow("Unknown option");
  });

  it("strictly parses rollback and release-deploy guards", () => {
    expect(parsePagesRollbackArgs(["--dry-run"])).toEqual({ dryRun: true, help: false });
    expect(parseWorkerDeploymentArgs(["--version-id", "v1", "--name", "api", "--dry-run"]))
      .toMatchObject({ dryRun: true, name: "api", versionId: "v1" });
    expect(parseWorkerDeployGuardArgs(["--help"])).toEqual({ help: true });
    expect(() => parsePagesRollbackArgs(["--force"])).toThrow("Unknown option");
    expect(() => parseWorkerDeploymentArgs(["--dry-run=true"])).toThrow("does not take an argument");
    expect(() => parseWorkerDeployGuardArgs(["production"])).toThrow("Unexpected argument");
  });

  it("allows only the intentional repeated release-marker URL option", () => {
    expect(
      parseReleaseMarkerArgs([
        "--url", "https://one.test/marker.json",
        "--url=https://two.test/marker.json",
        "--attempts", "5",
        "--delay-ms", "0",
      ], {}),
    ).toMatchObject({ attempts: 5, delayMs: 0, urls: [
      "https://one.test/marker.json",
      "https://two.test/marker.json",
    ] });
    expect(() => parseReleaseMarkerArgs(["--attempts", "5x"], {})).toThrow("must be an integer");
    expect(() => parseReleaseMarkerArgs(["--marker", "one", "--marker", "two"], {})).toThrow(
      "may only be specified once",
    );
  });

  it("validates workflow-job polling options before network access", () => {
    expect(parseWorkflowWaitArgs(["--job", "validate / validate", "--attempts", "2", "--sleep-sec", "0"]))
      .toMatchObject({ attempts: 2, jobName: "validate / validate", sleepSec: 0 });
    expect(() => parseWorkflowWaitArgs([])).toThrow("--job is required");
    expect(() => parseWorkflowWaitArgs(["--job", "validate", "--attempts", "0"])).toThrow(
      "must be between",
    );
    expect(() => parseWorkflowWaitArgs(["--job", "one", "--job", "two"])).toThrow(
      "may only be specified once",
    );
  });
});

describe("operator dry-run mutation boundaries", () => {
  it("validates a sync payload without creating its output file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pharos-cli-sync-"));
    tempDirs.push(directory);
    const output = join(directory, "nested", "snapshot.json");

    const result = await syncJson({
      parse: async () => [{ id: 1 }],
      write: false,
      writeTo: pathToFileURL(output),
    });

    expect(result).toMatchObject({ entries: [{ id: 1 }], outputFile: output, written: false });
    expect(existsSync(output)).toBe(false);
  });

  it("keeps the provenance transformation pure and skips curated entries", () => {
    const input = {
      curated: { authoredBy: "human", text: "kept", title: "Curated", updatedAt: "2026-07-01" },
      pending: { text: "body", title: "Pending", updatedAt: "2026-07-02" },
    };
    const result = backfillAiSummaryProvenance(input, {
      model: "gpt-test",
      reviewedAt: "2026-07-09",
      reviewedBy: "@reviewer",
    });

    expect(result).toMatchObject({ skipped: 1, updated: 1 });
    expect(result.data.curated.authoredBy).toBe("human");
    expect(result.data.pending).toMatchObject({
      authoredBy: "ai",
      factsAsOf: "2026-07-02",
      model: "gpt-test",
    });
  });
});
