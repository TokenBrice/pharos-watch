import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  makeSafetyMapPsiPayload,
  makeSafetyMapRatedCard,
  makeSafetyMapReportCardsResponse,
  makeSafetyMapStablecoinsPayload,
  withSafetyMapAdverseAttribution,
} from "./build-safety-score-map.test-support";

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
    // alt.json, snapshot.json, manifest.json, and snapshot.mapSummary — one each, all runDate.
    expect(dateFields).toEqual(["date: runDate", "date: runDate", "date: runDate", "date: runDate"]);
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
  const fixtureIds = [
    "usdt-tether",
    "usdc-circle",
    "dai-makerdao",
    "frax-frax",
    "tusd-trueusd",
    "lusd-liquity",
    "fei-fei",
    "usdp-paxos",
    "gusd-gemini",
    "usde-ethena",
    "usd1-world-liberty-financial",
    "coin-11",
  ];
  const cards = ([
    ["A+", 90],
    ["A", 84],
    ["A-", 81],
    ["F", 20],
    ["F", 25],
    ["F", 30],
    ["F", 35],
    ["F", 10],
    ["F", 15],
    ["F", 18],
    ["F", 22],
    ["F", 28],
  ] satisfies Array<[string, number]>).map(([grade, score], i) => ({ id: fixtureIds[i], score, grade }));
  const peggedAssets = cards.map((card, i) => ({
    id: card.id,
    symbol: `C${i}`,
    circulating: { peggedUSD: 1e11 * 0.2 ** i },
  }));

  function reportCardsPayload(): unknown {
    const updatedAt = Math.floor(Date.now() / 1000);
    const canonicalCards = cards.map((card) => {
      const ratedCard = makeSafetyMapRatedCard(card);
      if (card.grade !== "F") return ratedCard;
      return withSafetyMapAdverseAttribution(ratedCard);
    }).sort((left, right) => left.id.localeCompare(right.id));
    return makeSafetyMapReportCardsResponse({
      cards: canonicalCards,
      fixtureId: "safety-map-clock-fixture",
      methodologyVersion: "9.19",
      defaultUpdatedAt: updatedAt,
      asOfSec: capturedAtSec,
    });
  }

  function stablecoinsPayload(): unknown {
    return makeSafetyMapStablecoinsPayload(peggedAssets);
  }

  function psiPayload(): unknown {
    const computedAt = Math.floor(Date.now() / 1000) - 5 * 60;
    return makeSafetyMapPsiPayload({
      score: 94.3,
      band: "BEDROCK",
      avg24h: 93.8,
      avg24hBand: "BEDROCK",
      computedAt,
    }, computedAt);
  }

  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = (req.url ?? "").split("?")[0];
      const body =
        path === "/api/report-cards/v9"
          ? reportCardsPayload()
          : path === "/api/stablecoins"
            ? stablecoinsPayload()
            : path === "/api/stability-index"
              ? psiPayload()
              : null;
      if (!body) {
        res.writeHead(404).end("{}");
        return;
      }
      if (path === "/api/report-cards/v9") res.setHeader("X-Safety-Score-Status", "current");
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
      expect(status, `${stdout}\n${stderr}`).toBe(0);
      expect(existsSync(pngPath)).toBe(true);

      const read = (suffix: string) => JSON.parse(readFileSync(join(outDir, `map${suffix}`), "utf8"));
      const snapshot = read(".snapshot.json");
      const manifest = read(".manifest.json");
      const alt = read(".alt.json");
      const svg = readFileSync(join(outDir, "map.svg"), "utf8");

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
      expect(alt.psi).toEqual({ score: 93.8, band: "BEDROCK", basis: "24H AVG", computedAt: expect.any(Number) });
      expect(alt.altText).toContain("PSI 93.8 · BEDROCK · 24H AVG at render time");

      // The census the next run's delta guard will read back.
      expect(snapshot.counts.graded).toBe(cards.length);
      expect(snapshot.coins).toHaveLength(cards.length);
      expect(snapshot.publicationStatus).toBe("current");
      expect(snapshot.mapSummary.floorMcapByTier.a).toBeGreaterThan(snapshot.mapSummary.floorMcapByTier.other);
      expect(snapshot.mapSummary.tiers).toHaveLength(5);
      expect(alt.altText).toContain("five discrete grade bands: A at the centre, then B, C, D, and F outward");
      expect(alt.altText).toContain("orbit = grade band, not a continuous score");
      expect(alt.altText).toContain("assets below those thresholds share a fixed presence marker");
      expect(svg.match(/<polygon\b/g)).toHaveLength(1); // masthead cap only; no rank polygon
      expect(svg).toContain('data-masthead-lockup="true" data-lockup-x="64" data-lockup-y="4" data-lockup-w="714" data-lockup-h="78" data-mark-size="72"');
      expect(svg.match(/data-band-zone="[ABCDF]"/g)).toHaveLength(new Set(cards.map((card) => String(card.grade).charAt(0))).size);
      expect(svg).toContain('stroke-width="7" stroke-opacity="0.045"');
      expect(svg).toContain('stroke-width="1.15" stroke-opacity="0.24"');
      expect(svg).not.toContain('stroke-dasharray="2.2 1.8"');
      expect(svg.match(/<image /g)).toHaveLength(cards.length); // 11 coin logos + the brand mark
      expect(svg.match(/fill="#07111f"\/>/g)).toHaveLength(1); // one high-contrast missing-logo plate
      expect(svg.match(/data-annotation-id=/g)).toHaveLength(3);
      expect(svg).toContain('data-annotation-id="grade-key"');
      expect(svg).toContain('data-annotation-id="supply-mass-rail"');
      expect(svg).toContain('data-annotation-id="footer-encoding"');
      expect(svg).toContain("inner -&gt; safer");
      expect(svg).toContain('data-psi-status="true" data-psi-band="BEDROCK" data-psi-score="93.8" data-psi-basis="24H AVG" data-psi-color="#22c55e"');
      expect(svg).toContain('data-psi-band-marker="true"');
      expect(svg).not.toContain("SAFETY GRAVITATES INWARD");
      expect(svg).not.toContain("SIZE FLOOR");
      expect(svg).not.toContain("LANES ");
      expect(svg).toContain('data-logo-id="usdt-tether" data-plate="none"');
      expect(svg).not.toContain('data-logo-plate="usdt-tether"');
      expect(svg).not.toContain('data-grade-rim="usdt-tether"');
      expect(svg).toContain('data-logo-plate="usdc-circle"');
      expect(svg).toContain('data-grade-rim="usdc-circle"');
      expect(svg).toContain('data-grade-rim="coin-11"');
      expect(svg.match(/data-mass-tier=/g)).toHaveLength(5);
      expect(svg).toContain('stroke-dasharray="9 5"');
      expect(svg).toContain('stroke-dasharray="2 4"');
      expect(svg).toContain('stroke-dasharray="12 4 2 4"');
      const massBars = [...svg.matchAll(/data-mass-tier="[A-F]" data-track-width="([^"]+)" data-tier-mcap="([^"]+)" data-total-mcap="([^"]+)" x="[^"]+" y="[^"]+" width="([^"]+)"/g)];
      expect(massBars).toHaveLength(5);
      for (const match of massBars) {
        const [, track, tierMcap, allMcap, width] = match.map(Number);
        expect(width).toBeCloseTo((tierMcap / allMcap) * track, 12);
      }
    },
  );
});
