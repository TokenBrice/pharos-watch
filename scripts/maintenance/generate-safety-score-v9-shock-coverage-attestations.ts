import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { parseStrictCliArgs, runDirectCli, writeCliHelpIfRequested } from "../lib/cli-args.mjs";
import {
  collectShockCoverageCaptureSources,
  SHOCK_COVERAGE_REPLAY_ATTESTATIONS_PATH,
} from "./generate-safety-score-v9-shock-coverage-registry";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPLAY_TOOL_PATH = "scripts/maintenance/measure-cdp-shock-coverage.ts";

const USAGE = `Usage: npx tsx scripts/maintenance/generate-safety-score-v9-shock-coverage-attestations.ts [options]

Writes the replay attestations consumed by the shock-coverage measurement
registry. Journals whose sha256 already carries a passing attestation are
reused; every other journal is byte-replayed through
\`${REPLAY_TOOL_PATH} --replay\`. A journal that fails to replay aborts the run
without writing, so an unverified measurement can never become attested.

Options:
  --check      Fail instead of writing when the attestations file is stale
  -h, --help   Show this help`;

interface Attestation {
  journalPath: string;
  journalSha256: string;
  attestedAt: string;
  exactReplayPassed: boolean;
  callsConsumed: number;
  codePinsConsumed: number;
}

function loadPassingAttestations(path: string): Map<string, Attestation> {
  if (!existsSync(path)) return new Map();
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    attestedAt?: string;
    attestations?: (Omit<Attestation, "attestedAt"> & { attestedAt?: string })[];
  };
  const byKey = new Map<string, Attestation>();
  for (const attestation of parsed.attestations ?? []) {
    if (!attestation.exactReplayPassed) continue;
    // Entries written before per-journal dates existed inherit the file-level
    // run date they were attested under.
    const attestedAt = attestation.attestedAt ?? parsed.attestedAt;
    if (!attestedAt) continue;
    byKey.set(`${attestation.journalPath}@${attestation.journalSha256}`, {
      journalPath: attestation.journalPath,
      journalSha256: attestation.journalSha256,
      attestedAt,
      exactReplayPassed: attestation.exactReplayPassed,
      callsConsumed: attestation.callsConsumed,
      codePinsConsumed: attestation.codePinsConsumed,
    });
  }
  return byKey;
}

/** Byte-replays one journal through the existing producer CLI. Throws on divergence. */
function replayJournal(journalPath: string): void {
  const result = spawnSync("npx", ["tsx", REPLAY_TOOL_PATH, "--replay", journalPath], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Offline byte-replay failed for ${journalPath} (exit ${result.status}):\n${result.stderr || result.stdout}`,
    );
  }
  process.stdout.write(result.stdout);
}

export async function runShockCoverageReplayAttestationsCli(argv = process.argv.slice(2)): Promise<void> {
  const { values } = parseStrictCliArgs(argv, {
    options: { check: { type: "boolean" }, help: { type: "boolean", short: "h" } },
  });
  if (writeCliHelpIfRequested(values, USAGE)) return;

  const outPath = resolve(REPO_ROOT, SHOCK_COVERAGE_REPLAY_ATTESTATIONS_PATH);
  const cached = loadPassingAttestations(outPath);
  const attestations: Attestation[] = [];
  const runDate = new Date().toISOString().slice(0, 10);
  let replayed = 0;

  for (const source of collectShockCoverageCaptureSources(REPO_ROOT)) {
    const journalPath = String(source.summary.summary.journalPath ?? "");
    const journalSha256 = source.summary.sha256;
    if (!journalPath) throw new Error(`Missing journalPath in ${relative(REPO_ROOT, source.summaryPath)}`);
    const captureExists = existsSync(source.capturePath);
    if (captureExists) {
      const rawBytes = readFileSync(source.capturePath);
      const actualSha256 = createHash("sha256").update(rawBytes).digest("hex");
      if (actualSha256 !== journalSha256) {
        throw new Error(`Capture summary hash mismatch for ${journalPath}: ${actualSha256} !== ${journalSha256}`);
      }
      const reusable = cached.get(`${journalPath}@${journalSha256}`);
      if (reusable) {
        attestations.push(reusable);
        continue;
      }
      replayJournal(journalPath);
      replayed += 1;
      const journal = JSON.parse(rawBytes.toString("utf8")) as { calls?: unknown[]; codePins?: unknown[] };
      attestations.push({
        journalPath,
        journalSha256,
        attestedAt: runDate,
        exactReplayPassed: true,
        callsConsumed: journal.calls?.length ?? 0,
        codePinsConsumed: journal.codePins?.length ?? 0,
      });
      continue;
    }

    const reusable = cached.get(`${journalPath}@${journalSha256}`);
    if (!reusable) {
      throw new Error(`Capture ${journalSha256} expired: non-replayable`);
    }
    attestations.push(reusable);
  }

  attestations.sort((left, right) => (left.journalPath < right.journalPath ? -1 : 1));

  const previous = existsSync(outPath) ? readFileSync(outPath, "utf8") : null;
  const previousAttestedAt =
    previous === null ? null : ((JSON.parse(previous) as { attestedAt?: string }).attestedAt ?? null);
  // Hold the file-level attestedAt steady when nothing was replayed so the
  // artifact does not churn on every scheduled run. Per-entry attestedAt is
  // the load-bearing date; this field only records the latest replay run.
  const attestedAt = replayed === 0 && previousAttestedAt ? previousAttestedAt : runDate;

  const contents = `${JSON.stringify(
    {
      schemaVersion: 1,
      kind: "safety-score-v9-shock-coverage-replay-attestations",
      replayTool: { path: REPLAY_TOOL_PATH, version: "1", mode: "offline-byte-identical" },
      attestedAt,
      attestations,
    },
    null,
    2,
  )}\n`;

  if (previous === contents) {
    console.log(`[shock-attestations] Attestations are current (${attestations.length} journals).`);
    return;
  }
  if (values.check === true) {
    throw new Error(
      `Shock-coverage replay attestations are stale. Run \`npx tsx ${relative(REPO_ROOT, fileURLToPath(import.meta.url)).split(sep).join("/")}\`.`,
    );
  }
  writeFileSync(outPath, contents);
  console.log(`[shock-attestations] Wrote ${attestations.length} attestations (${replayed} replayed).`);
}

runDirectCli(import.meta.url, () => runShockCoverageReplayAttestationsCli(process.argv.slice(2)), {
  label: "generate-safety-score-v9-shock-coverage-attestations",
  usage: USAGE,
});
