import { execFileSync } from "node:child_process";
import type * as ChildProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import {
  loadSafetyScoreV9RegistryRef,
  registrySnapshotFingerprint,
  verifyRegistrySnapshot,
} from "../lib/safety-score-v9-registry";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

const { execFileSync: actualExecFileSync } = await vi.importActual<typeof ChildProcess>("node:child_process");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const PACKAGE = JSON.stringify({ imports: { "#pharos-full-catalog": "./shared/lib/stablecoins/full-catalog.ts" } });

function writeFixture(root: string, path: string, content: string): void {
  const file = resolve(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(execFileSync).mockImplementation(actualExecFileSync);
});

describe("historical Safety Score registry package scope", () => {
  it("loads the archived catalog instead of the different current catalog and keeps fingerprint admission fail-closed", () => {
    const repositoryRoot = process.cwd();
    const directory = mkdtempSync(resolve(tmpdir(), "pharos-historical-registry-"));
    const currentRoot = resolve(directory, "current");
    const historicalRoot = resolve(directory, "historical");
    const currentCoin = { ...ACTIVE_STABLECOINS[0]!, name: "Current catalog fixture" };
    const historicalCoin = { ...ACTIVE_STABLECOINS[0]!, name: "Historical catalog fixture" };
    const currentRows = { activeStablecoins: [currentCoin], frozenStablecoins: [], deadStablecoins: [] };
    const historicalRows = { activeStablecoins: [historicalCoin], frozenStablecoins: [], deadStablecoins: [] };
    const fetch = vi.fn(() => { throw new Error("Registry fixture must not access the network"); });
    vi.stubGlobal("fetch", fetch);

    try {
      // The scratch archive is nested inside a caller package with a divergent catalog.
      writeFixture(currentRoot, "package.json", PACKAGE);
      writeFixture(currentRoot, "shared/lib/stablecoins/full-catalog.ts",
        `export const FULL_STABLECOINS = ${JSON.stringify([currentCoin])};`);
      symlinkSync(resolve(repositoryRoot, "node_modules"), resolve(currentRoot, "node_modules"));

      writeFixture(historicalRoot, "package.json", PACKAGE);
      writeFixture(historicalRoot, "shared/data/stablecoins/coins/fixture.json", JSON.stringify(historicalCoin));
      writeFixture(historicalRoot, "shared/lib/stablecoins/full-catalog.ts",
        "import coins from '../../data/stablecoins/coins.generated.json';\nexport const FULL_STABLECOINS = coins;");
      writeFixture(historicalRoot, "shared/lib/stablecoins/registry.ts",
        "import { FULL_STABLECOINS } from '#pharos-full-catalog';\nexport const ACTIVE_STABLECOINS = FULL_STABLECOINS;\nexport const FROZEN_STABLECOINS = [];");
      writeFixture(historicalRoot, "shared/lib/dead-stablecoins.ts", "export const DEAD_STABLECOINS = [];");
      writeFixture(historicalRoot, "shared/data/safety-score-v9/transfer-review-overlays-v1.json",
        '{"schemaVersion":1,"note":"Historical registry isolation fixture","reviews":[]}');
      writeFixture(historicalRoot, "scripts/maintenance/generate-stablecoin-per-coin-asset.ts",
        "import { readFileSync, writeFileSync } from 'node:fs';\nconst coin = JSON.parse(readFileSync('shared/data/stablecoins/coins/fixture.json', 'utf8'));\nwriteFileSync('shared/data/stablecoins/coins.generated.json', JSON.stringify([coin]));");
      expect(existsSync(resolve(historicalRoot, "shared/data/stablecoins/coins.generated.json"))).toBe(false);

      // Substitute local archive bytes for Git only; extraction, generation and Node/tsx
      // module resolution run for real. No Git mutations or network are needed.
      vi.spyOn(process, "cwd").mockReturnValue(currentRoot);
      vi.mocked(execFileSync).mockImplementation((file, args, options) => {
        if (file === "git" && args?.[0] === "rev-parse") return `${COMMIT}\n`;
        if (file === "git" && args?.[0] === "archive") {
          expect(args[1]).toBe(COMMIT);
          return actualExecFileSync("tar", ["-cf", "-", "-C", historicalRoot, ...args.slice(2)]);
        }
        return actualExecFileSync(file, args, options);
      });

      const snapshot = loadSafetyScoreV9RegistryRef(COMMIT.slice(0, 9));
      expect(snapshot.activeStablecoins).toEqual(historicalRows.activeStablecoins);
      expect(snapshot.fingerprint).toBe(registrySnapshotFingerprint(historicalRows));
      expect(snapshot.fingerprint).not.toBe(registrySnapshotFingerprint(currentRows));
      expect(verifyRegistrySnapshot(snapshot)).toBe(snapshot);
      expect(() => verifyRegistrySnapshot({ ...snapshot, fingerprint: registrySnapshotFingerprint(currentRows) }))
        .toThrow("Replay registry snapshot fingerprint does not match its rows");
      expect(fetch).not.toHaveBeenCalled();
      expect(readdirSync(resolve(currentRoot, "agents/v9-captures/registry-scratch"))).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
