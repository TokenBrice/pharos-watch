import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The `date` / `renderedAtSec` invariant (plan §11.2b rule 7).
 *
 * Archive naming keys off the run date (UTC); the visible stamp keys off
 * `asOfSec`. One hoisted clock read feeds both `date` and `renderedAtSec`, so
 * they agree by construction. A refactor that reintroduces a second `Date.now()`
 * would only break on a run straddling UTC midnight — at 07:20 UTC in
 * production, months later. These tests pin it here instead:
 *
 *  - the structural pin below fails immediately on a second clock read;
 *  - the emitted-artifact test proves the shipped triple actually agrees, and
 *    is the only coverage of the exit-0 first-run bootstrap path.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE_PATH = resolve(REPO_ROOT, "scripts/maintenance/build-safety-score-map.ts");
const SCRIPT = "scripts/maintenance/build-safety-score-map.ts";
const HOUR = 3600;

const utcDate = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);

describe("clock discipline — structural pin on the generator source", () => {
  const source = readFileSync(SOURCE_PATH, "utf8");

  it("reads the wall clock exactly once for output naming", () => {
    expect(source.match(/const renderedAtSec = Math\.floor\(Date\.now\(\) \/ 1000\);/g)).toHaveLength(1);
  });

  it("derives the run date from renderedAtSec rather than from a fresh clock read", () => {
    expect(source).toMatch(/const runDate = new Date\(renderedAtSec \* 1000\)\.toISOString\(\)\.slice\(0, 10\);/);
    expect(source.match(/const runDate =/g)).toHaveLength(1);
  });

  it("never re-reads the clock after renderedAtSec is fixed", () => {
    // Everything after this point — naming, the backwards-publish check, the
    // render, and all three emitted files — must share the hoisted read. The
    // backwards-publish comparison is the sole permitted later `Date.now()`.
    const tail = source.slice(source.indexOf("const renderedAtSec ="));
    const laterClockReads = tail.match(/Date\.now\(\)/g) ?? [];
    expect(laterClockReads).toHaveLength(2); // the hoisted read itself + the backwards-publish comparison
    expect(tail).toMatch(/Date\.parse\(previous\.renderedAt\) > Date\.now\(\)/);
    expect(tail).not.toMatch(/Math\.floor\(Date\.now\(\) \/ 1000\)[\s\S]*Math\.floor\(Date\.now\(\) \/ 1000\)/);
  });

  it("stamps every emitted artifact with the same runDate value", () => {
    const tail = source.slice(source.indexOf("const renderedAtSec ="));
    const dateFields = tail.match(/\bdate: [A-Za-z.]+/g) ?? [];
    // alt.json, snapshot.json, manifest.json — one each, all runDate.
    expect(dateFields).toEqual(["date: runDate", "date: runDate", "date: runDate"]);
    expect(tail).toMatch(/renderedAt: new Date\(renderedAtSec \* 1000\)\.toISOString\(\)/);
  });
});

// A real render needs headless Firefox. Skipped rather than failed where the
// browser is not installed (the PR gate does not install it by default).
let firefoxInstalled = false;
try {
  const { firefox } = await import("playwright");
  firefoxInstalled = existsSync(firefox.executablePath());
} catch {
  firefoxInstalled = false;
}

describe.skipIf(!firefoxInstalled)("clock discipline — emitted artifacts (full render)", () => {
  let server: Server;
  let baseUrl = "";
  // Deliberately on an earlier UTC day than the run: the archive must key off
  // the run date while the poster stamp keeps the capture date.
  const capturedAtSec = Math.floor(Date.now() / 1000) - 30 * HOUR;
  const cards = Array.from({ length: 12 }, (_, i) => ({
    id: `coin-${String(i).padStart(2, "0")}`,
    score: 92 - i * 3,
    grade: (["A+", "A", "B+", "B", "C+", "C", "D+", "D", "F", "F", "B", "C"] as const)[i],
  }));
  const peggedAssets = cards.map((card, i) => ({
    id: card.id,
    symbol: `C${i}`,
    circulating: { peggedUSD: 1e11 * 0.4 ** i },
  }));

  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = (req.url ?? "").split("?")[0];
      const body =
        path === "/api/report-cards/v9"
          ? { cards, methodology: { version: "9.19" }, asOfSec: capturedAtSec }
          : path === "/api/stablecoins"
            ? { peggedAssets }
            : null;
      if (!body) {
        res.writeHead(404).end("{}");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (typeof address === "string" || address == null) throw new Error("fixture server did not bind a port");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  it(
    "renders a first run with no previous snapshot (exit 0) and stamps date, renderedAtSec and asOfSec consistently",
    { timeout: 120_000 },
    async () => {
      const outDir = mkdtempSync(join(tmpdir(), "pharos-safety-map-render-"));
      const pngPath = join(outDir, "map.png");
      const child = spawn("npx", ["tsx", SCRIPT, "--out", pngPath], {
        cwd: REPO_ROOT,
        env: { ...process.env, PHAROS_API_BASE: baseUrl, PHAROS_API_KEY: "fixture-key" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += String(chunk)));
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      const status = await new Promise<number | null>((done) => child.on("close", done));

      // The bootstrap path: a missing delta baseline warns, it does not fail.
      expect(`${stdout}${stderr}`).toMatch(/No --previous-snapshot supplied — day-over-day delta guard skipped/);
      expect(status).toBe(0);
      expect(existsSync(pngPath)).toBe(true);

      const read = (suffix: string) => JSON.parse(readFileSync(join(outDir, `map${suffix}`), "utf8"));
      const snapshot = read(".snapshot.json");
      const manifest = read(".manifest.json");
      const alt = read(".alt.json");

      // Rule 7: `date` is the UTC date of `renderedAtSec`, in every artifact.
      expect(snapshot.date).toBe(utcDate(snapshot.renderedAtSec));
      expect(manifest.date).toBe(utcDate(manifest.renderedAtSec));
      expect(alt.date).toBe(snapshot.date);
      expect(manifest.renderedAtSec).toBe(snapshot.renderedAtSec);
      expect(manifest.renderedAt).toBe(new Date(manifest.renderedAtSec * 1000).toISOString());

      // The capture clock is carried through untouched and is a *different* UTC
      // day, so a run that confused the two would be caught here.
      expect(snapshot.asOfSec).toBe(capturedAtSec);
      expect(manifest.asOfSec).toBe(capturedAtSec);
      expect(alt.asOfSec).toBe(capturedAtSec);
      expect(utcDate(capturedAtSec)).not.toBe(snapshot.date);
      expect(alt.altText).toContain(`data as of ${utcDate(capturedAtSec)}`);

      // The census the next run's delta guard will read back.
      expect(snapshot.counts.graded).toBe(cards.length);
      expect(snapshot.coins).toHaveLength(cards.length);
    },
  );
});
