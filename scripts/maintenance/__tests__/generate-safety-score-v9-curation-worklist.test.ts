import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SCRIPT = resolve(REPO_ROOT, "scripts/maintenance/generate-safety-score-v9-curation-worklist.mjs");

type Reason = { code: string; path: string };

function replayWith(reasons: Reason[]) {
  return {
    pipeline: {
      candidate: {
        cards: [
          {
            id: "usdt-tether",
            grade: "B+",
            score: 77,
            nrReasons: [],
          },
        ],
      },
      evaluatedSet: {
        assets: [
          {
            assetId: "usdt-tether",
            scoreInput: {
              pillars: {
                backing: { reasons },
                exit: { reasons: [] },
                control: { reasons: [] },
              },
              peg: { reasons: [] },
              dependencyReasons: [],
            },
            backing: { archetype: "fiat-cash", contributions: [] },
            stressState: { exitPortfolio: { circulatingUsd: 1_000_000_000 } },
          },
        ],
      },
    },
  };
}

function runWorklist(script: string, replay: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "pharos-curation-worklist-test-"));
  const replayPath = join(dir, "replay.json");
  writeFileSync(replayPath, JSON.stringify(replay));
  const result = spawnSync(process.execPath, [script, "--replay", replayPath], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  rmSync(dir, { recursive: true, force: true });
  return result;
}

describe("Safety Score v9 curation worklist routing", () => {
  it("emits stale audited composition with refresh-specific remediation", () => {
    const result = runWorklist(
      SCRIPT,
      replayWith([{ code: "stale-audited-reserve-composition", path: "backing.reserves" }]),
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("RESV-usdt-tether");
    expect(result.stdout).toContain("stale-audited-reserve-composition");
    expect(result.stdout).toContain("refresh reserves[] and compositionAsOf from the newest independent attestation");
  });

  it("fails loudly with the curation-owned code when its stream route is removed", () => {
    const brokenScript = join(mkdtempSync(join(tmpdir(), "pharos-curation-worklist-broken-")), "generator.mjs");
    const source = readFileSync(SCRIPT, "utf8");
    writeFileSync(brokenScript, source.replace('      "missing-reserve-composition",\n', ""));

    try {
      const result = runWorklist(brokenScript, replayWith([]));
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("missing-reserve-composition");
    } finally {
      rmSync(dirname(brokenScript), { recursive: true, force: true });
    }
  });

  it("keeps ordinary non-curation reasons silently unmapped", () => {
    const result = runWorklist(
      SCRIPT,
      replayWith([{ code: "bounded-mechanism-review", path: "backing.mechanism" }]),
    );

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("bounded-mechanism-review");
  });
});
