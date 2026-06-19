import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { scanCronAbortContract } = await import("../ci/check-cron-abort-contract.mjs") as {
  scanCronAbortContract: (
    roots?: string[],
    cwd?: string,
  ) => {
    scannedFiles: string[];
    violations: Array<{ file: string; line: number; code: string; text: string }>;
  };
};

const tempRoots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pharos-cron-abort-contract-"));
  tempRoots.push(root);
  return root;
}

function writeFixture(root: string, relPath: string, source: string): void {
  const target = join(root, relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, source.trimStart(), "utf8");
}

function scan(root: string) {
  return scanCronAbortContract(undefined, root);
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("check-cron-abort-contract", () => {
  it("rejects leased cron callbacks that drop the scheduled AbortSignal", () => {
    const root = makeRoot();
    writeFixture(root, "worker/src/handlers/scheduled/run.ts", `
      import { runLeasedCron } from "../../lib/cron-runtime";

      export function scheduled(db: D1Database) {
        return runLeasedCron(db, "fixture", async () => {
          return { itemCount: 1 };
        });
      }
    `);

    const report = scan(root);

    expect(report.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing-cron-signal", file: "worker/src/handlers/scheduled/run.ts" }),
      ]),
    );
  });

  it("scans cron-reachable worker lib helpers for dropped fetch signals", () => {
    const root = makeRoot();
    writeFixture(root, "worker/src/cron/job.ts", `
      import { helperDropsSignal } from "../lib/helper-drops-signal";

      export async function run(signal?: AbortSignal) {
        await helperDropsSignal(signal);
      }
    `);
    writeFixture(root, "worker/src/lib/helper-drops-signal.ts", `
      export async function helperDropsSignal(signal?: AbortSignal) {
        await fetch("https://example.com");
      }
    `);

    const report = scan(root);

    expect(report.scannedFiles.some((file) => file.endsWith("worker/src/lib/helper-drops-signal.ts"))).toBe(true);
    expect(report.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "dropped-fetch-signal", file: "worker/src/lib/helper-drops-signal.ts" }),
      ]),
    );
  });

  it("rejects long async loops in signal-aware functions without an abort checkpoint", () => {
    const root = makeRoot();
    writeFixture(root, "worker/src/cron/loop.ts", `
      export async function run(signal?: AbortSignal) {
        for (const item of [1, 2, 3]) {
          await work(item);
          await work(item + 1);
          await work(item + 2);
          await work(item + 3);
          await work(item + 4);
          await work(item + 5);
          await work(item + 6);
          await work(item + 7);
          await work(item + 8);
          await work(item + 9);
        }
      }

      async function work(_value: number) {}
    `);

    const report = scan(root);

    expect(report.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "loop-missing-abort-check", file: "worker/src/cron/loop.ts" }),
      ]),
    );
  });

  it("accepts propagated signals and explicit loop abort checkpoints", () => {
    const root = makeRoot();
    writeFixture(root, "worker/src/cron/valid.ts", `
      import { throwIfAborted } from "../lib/abort";
      import { batchExecute } from "../lib/db";
      import { fetchWithRetry } from "../lib/fetch-retry";

      export async function run(db: D1Database, signal?: AbortSignal) {
        await fetch("https://example.com", { signal });
        await fetchWithRetry("https://example.com/2", { signal });
        await batchExecute(db, [], { signal });

        for (const item of [1, 2, 3]) {
          throwIfAborted(signal);
          await fetchWithRetry(String(item), { signal });
          await fetchWithRetry(String(item + 1), { signal });
          await fetchWithRetry(String(item + 2), { signal });
          await fetchWithRetry(String(item + 3), { signal });
          await fetchWithRetry(String(item + 4), { signal });
          await fetchWithRetry(String(item + 5), { signal });
          await fetchWithRetry(String(item + 6), { signal });
          await fetchWithRetry(String(item + 7), { signal });
          await fetchWithRetry(String(item + 8), { signal });
          await fetchWithRetry(String(item + 9), { signal });
        }
      }
    `);

    const report = scan(root);

    expect(report.violations).toEqual([]);
  });
});
