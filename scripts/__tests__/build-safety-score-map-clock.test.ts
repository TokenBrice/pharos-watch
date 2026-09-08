import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

// Real-browser integration owns emitted dates and meaningful rendered geometry.
// Deterministic rollover coverage requires an import-safe publication seam.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = "scripts/maintenance/build-safety-score-map.ts";
const HOUR = 3600;

const utcDate = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);

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
  const updatedAt = capturedAtSec + HOUR;
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
      if (path === "/api/report-cards/v9") res.setHeader("X-Safety-Score-Status", "held");
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
    "renders an aged held publication without rewriting provenance or diverging artifact dates",
    { timeout: 120_000 },
    async ({ onTestFinished }) => {
      const outDir = mkdtempSync(join(tmpdir(), "pharos-safety-map-render-"));
      onTestFinished(() => rmSync(outDir, { recursive: true, force: true }));
      const pngPath = join(outDir, "map.png");
      const child = spawn(process.execPath, ["--import", "tsx", SCRIPT, "--out", pngPath], {
        cwd: REPO_ROOT,
        env: { ...process.env, PHAROS_API_BASE: baseUrl, PHAROS_API_KEY: "fixture-key" },
      });
      onTestFinished(async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const closed = new Promise<void>((done) => child.once("close", () => done()));
        child.kill("SIGKILL");
        await closed;
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += String(chunk)));
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      const status = await new Promise<number | null>((done, reject) => {
        child.once("error", reject);
        child.once("close", done);
      });

      expect(status, `${stdout}\n${stderr}`).toBe(0);
      expect(existsSync(pngPath)).toBe(true);

      const read = (suffix: string) => JSON.parse(readFileSync(join(outDir, `map${suffix}`), "utf8"));
      const manifest = read(".manifest.json");
      const alt = read(".alt.json");
      const svg = readFileSync(join(outDir, "map.svg"), "utf8");

      // Rule 7: `date` is the UTC date of `renderedAtSec`, in every artifact.
      expect(manifest.date).toBe(utcDate(manifest.renderedAtSec));
      expect(alt.date).toBe(manifest.date);
      expect(manifest.mapSummary.date).toBe(manifest.date);
      expect(manifest.renderedAt).toBe(new Date(manifest.renderedAtSec * 1000).toISOString());

      // The capture clock is carried through untouched and is a *different* UTC
      // day, so a run that confused the two would be caught here.
      expect(manifest.asOfSec).toBe(capturedAtSec);
      expect(alt.asOfSec).toBe(capturedAtSec);
      expect(utcDate(capturedAtSec)).not.toBe(manifest.date);
      expect(alt.altText).toContain(`data as of ${utcDate(capturedAtSec)}`);
      expect(alt.psi).toEqual({ score: 93.8, band: "BEDROCK", basis: "24H AVG", computedAt: expect.any(Number) });
      expect(alt.altText).toContain("PSI 93.8 · BEDROCK · 24H AVG at render time");

      expect(manifest.counts.graded).toBe(cards.length);
      expect(manifest.publicationStatus).toBe("held");
      expect(manifest.updatedAt).toBe(updatedAt);
      expect(manifest.mapSummary.floorMcapByTier.a).toBeGreaterThan(manifest.mapSummary.floorMcapByTier.other);
      expect(manifest.mapSummary.tiers).toHaveLength(5);
      expect(svg.match(/data-band-zone="[ABCDF]"/g)).toHaveLength(new Set(cards.map((card) => String(card.grade).charAt(0))).size);
      expect(svg.match(/<image /g)).toHaveLength(cards.length); // 11 coin logos + the brand mark
      expect(svg.match(/data-annotation-id=/g)).toHaveLength(3);
      expect(svg).toContain('data-annotation-id="grade-key"');
      expect(svg).toContain('data-annotation-id="supply-mass-rail"');
      expect(svg).toContain('data-annotation-id="footer-encoding"');
      expect(svg).toContain('data-grade-rim="coin-11"');
      expect(svg.match(/data-mass-tier=/g)).toHaveLength(5);
      const massBars = [...svg.matchAll(/data-mass-tier="[A-F]" data-track-width="([^"]+)" data-tier-mcap="([^"]+)" data-total-mcap="([^"]+)" x="[^"]+" y="[^"]+" width="([^"]+)"/g)];
      expect(massBars).toHaveLength(5);
      for (const match of massBars) {
        const [, track, tierMcap, allMcap, width] = match.map(Number);
        expect(width).toBeCloseTo((tierMcap / allMcap) * track, 12);
      }
    },
  );
});
