import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeReportCardsV9Card } from "@shared/test-utils/report-cards-v9";
import type { SafetyScoreV9CurrentCard } from "@shared/types/safety-score-v9-public";
import {
  makeSafetyMapPsiPayload,
  makeSafetyMapRatedCard,
  makeSafetyMapReportCardsResponse,
  makeSafetyMapStablecoinsPayload,
  withSafetyMapAdverseAttribution,
} from "./build-safety-score-map.test-support";

/**
 * Publication-safety guards for the Safety Score map generator (plan §11.2b).
 *
 * The generator runs unattended every day and publishes to a public URL, so the
 * failure that matters is not a crash — it is a successful exit that ships a
 * blank or malformed poster. Every guard below is asserted through the real CLI
 * against a fixture API, because the guards live inside `main()` and are not
 * individually exported. Each fixture is shaped to stop the run *before* the
 * headless-Firefox render, so the suite needs no browser and no credentials.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = "scripts/maintenance/build-safety-score-map.ts";
const HOUR = 3600;

interface Card {
  id: string;
  score: number | null;
  grade: string;
}
interface Asset {
  id: string;
  symbol: string;
  circulating?: Record<string, number>;
}

let cards: Card[] = [];
let assets: Asset[] = [];
let methodologyVersion = "9.19";
let asOfSec = 0;
let psiComputedAt = 0;
let publicationStatus = "current";
let server: Server;
let baseUrl = "";
let reportCardsPayloadOverride: unknown | undefined;
let stablecoinsPayloadOverride: unknown | undefined;
let psiPayloadOverride: unknown | undefined;

function resolvePayload(override: unknown, fallback: () => unknown): unknown {
  return typeof override === "function" ? (override as () => unknown)() : (override ?? fallback());
}

function reportCardsPayload(): unknown {
  const updatedAt = Math.max(asOfSec, Math.floor(Date.now() / 1000));
  const canonicalCards: SafetyScoreV9CurrentCard[] = cards.map((card) => {
    if (card.score === null) {
      return makeReportCardsV9Card({
        id: card.id,
        score: null,
        grade: card.grade as SafetyScoreV9CurrentCard["grade"],
        qualityScore: null,
        pegMultiplier: null,
        pegAdjustedScore: null,
        pillars: {
          backing: { score: null, evidenceLevel: "insufficient", freshness: "unknown", components: [], reasons: [] },
          exit: { score: null, evidenceLevel: "insufficient", freshness: "unknown", components: [], reasons: [] },
          control: { score: null, evidenceLevel: "insufficient", freshness: "unknown", components: [], reasons: [] },
        },
        weakestPillar: null,
        nrReasons: [{ code: "missing-pillar", message: "Fixture is not rated.", field: null, origin: "asset" }],
      });
    }
    const ratedCard = makeSafetyMapRatedCard(card);
    if (card.grade !== "D" && card.grade !== "F") return ratedCard;
    return withSafetyMapAdverseAttribution(ratedCard);
  });
  return makeSafetyMapReportCardsResponse({
    cards: canonicalCards,
    fixtureId: "safety-map-fixture",
    methodologyVersion,
    defaultUpdatedAt: updatedAt,
    asOfSec,
  });
}

function stablecoinsPayload(): unknown {
  return makeSafetyMapStablecoinsPayload(assets);
}

function psiPayload(): unknown {
  return makeSafetyMapPsiPayload({
    score: 94.3,
    band: "BEDROCK",
    avg24h: 93.8,
    avg24hBand: "BEDROCK",
    computedAt: psiComputedAt,
  }, psiComputedAt);
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const body =
      path === "/api/report-cards/v9"
        ? resolvePayload(reportCardsPayloadOverride, reportCardsPayload)
        : path === "/api/stablecoins"
          ? resolvePayload(stablecoinsPayloadOverride, stablecoinsPayload)
          : path === "/api/stability-index"
            ? resolvePayload(psiPayloadOverride, psiPayload)
          : null;
    if (!body) {
      res.writeHead(404).end("{}");
      return;
    }
    if (path === "/api/report-cards/v9") res.setHeader("X-Safety-Score-Status", publicationStatus);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (typeof address === "string" || address == null) throw new Error("fixture server did not bind a port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

const scratchDirs: string[] = [];
function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

/** A graded universe that lays out cleanly: 3 A, then gravel in B/C/D/F. */
function universe(options: { count?: number; unjoined?: number; notRated?: number } = {}): {
  cards: Card[];
  assets: Asset[];
} {
  const count = options.count ?? 20;
  const unjoined = options.unjoined ?? 0;
  const tiers = ["A", "A", "A", "B", "B", "B", "B", "C", "C", "C", "C", "D", "D", "D", "F", "F"];
  const gradeByTier: Record<string, { grade: string; score: number }> = {
    A: { grade: "A+", score: 90 },
    B: { grade: "B+", score: 77 },
    C: { grade: "C+", score: 62 },
    D: { grade: "D", score: 45 },
    F: { grade: "F", score: 20 },
  };
  const built: Card[] = [];
  const rows: Asset[] = [];
  for (let i = 0; i < count; i++) {
    const tier = tiers[i % tiers.length];
    const id = `coin-${String(i).padStart(2, "0")}`;
    built.push({ id, ...gradeByTier[tier] });
    // Supply decays steeply, as it really does: two giants anchor the bubble
    // scale and the tail is gravel. The unjoined coins are the smallest ones,
    // which is where a real supply-join gap lands.
    rows.push({ id, symbol: `C${i}`, circulating: { peggedUSD: i >= count - unjoined ? 0 : 1e11 * 0.4 ** i } });
  }
  for (let i = 0; i < (options.notRated ?? 0); i++) {
    built.push({ id: `nr-${i}`, score: null, grade: "NR" });
  }
  return { cards: built, assets: rows };
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  pngPath: string;
  outDir: string;
}

/**
 * Run the generator against the fixture API.
 *
 * `stopBeforeRender` pre-writes a future-dated manifest at the output path. The
 * backwards-publish guard (§11.2b rule 5) then aborts the run *after* fetch,
 * input validation, join, layout and the composition linter have all passed but
 * *before* Firefox launches — so a test can assert "the run got this far"
 * without paying for a real render.
 */
async function runGenerator(
  fixture: { cards: Card[]; assets: Asset[]; asOfSec?: number; methodologyVersion?: string },
  options: {
    args?: string[];
    stopBeforeRender?: boolean;
    publicationStatus?: string;
    psiComputedAt?: number;
    reportCardsPayload?: unknown;
    stablecoinsPayload?: unknown;
    psiPayload?: unknown;
  } = {},
): Promise<RunResult> {
  cards = fixture.cards;
  assets = fixture.assets;
  asOfSec = fixture.asOfSec ?? Math.floor(Date.now() / 1000) - HOUR;
  psiComputedAt = options.psiComputedAt ?? Math.floor(Date.now() / 1000) - 5 * 60;
  methodologyVersion = fixture.methodologyVersion ?? "9.19";
  publicationStatus = options.publicationStatus ?? "current";
  reportCardsPayloadOverride = options.reportCardsPayload;
  stablecoinsPayloadOverride = options.stablecoinsPayload;
  psiPayloadOverride = options.psiPayload;

  const outDir = scratchDir("pharos-safety-map-test-");
  const pngPath = join(outDir, "map.png");
  if (options.stopBeforeRender) {
    writeFileSync(
      join(outDir, "map.manifest.json"),
      JSON.stringify({ renderedAt: new Date(Date.now() + HOUR * 1000).toISOString() }),
    );
  }

  const child = spawn("npx", ["tsx", SCRIPT, "--out", pngPath, ...(options.args ?? [])], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PHAROS_API_BASE: baseUrl,
      PHAROS_API_KEY: "fixture-key",
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const status = await new Promise<number | null>((done) => child.on("close", done));
  return { status, stdout, stderr, pngPath, outDir };
}

/** Marker proving the run reached the pre-render stop, i.e. every guard passed. */
const REACHED_RENDER_GATE = /rendered in the future/;

describe("safety-score map — canonical publication provenance", () => {
  it("renders an aged report-card capture with its source timestamp intact", async () => {
    const run = await runGenerator(
      { ...universe(), asOfSec: Math.floor(Date.now() / 1000) - 49 * HOUR },
      { stopBeforeRender: true },
    );
    expect(run.stderr).toMatch(REACHED_RENDER_GATE);
  });

  it("renders a held canonical publication instead of re-auditing upstream health", async () => {
    const run = await runGenerator({ ...universe() }, { publicationStatus: "held", stopBeforeRender: true });
    expect(run.stderr).toMatch(REACHED_RENDER_GATE);
  });

  it("rejects a non-numeric capture clock rather than rendering an epoch-stamped poster", async () => {
    const run = await runGenerator({ ...universe(), asOfSec: Number.NaN });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/asOfSec must be a finite integer/);
  });

  it("refuses a stale PSI reading instead of publishing an old regime", async () => {
    const run = await runGenerator(universe(), {
      psiComputedAt: Math.floor(Date.now() / 1000) - 61 * 60,
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/PSI reading is 61\.\dm old \(must be under 60m\) — refusing to render a stale level/);
  });

  it("refuses a future-dated PSI reading", async () => {
    const run = await runGenerator(universe(), {
      psiComputedAt: Math.floor(Date.now() / 1000) + 5 * 60,
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/refusing to render a future-dated level/);
  });
});

describe("safety-score map — canonical API payload schemas", () => {
  it("rejects the former report-card subset DTO", async () => {
    const fixture = universe();
    const run = await runGenerator(fixture, {
      reportCardsPayload: { cards: fixture.cards, methodology: { version: "9.19" }, asOfSec: Math.floor(Date.now() / 1000) - HOUR },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/Report-card response is malformed/);
  });

  it("rejects the former stablecoin subset DTO", async () => {
    const fixture = universe();
    const run = await runGenerator(fixture, { stablecoinsPayload: { peggedAssets: fixture.assets } });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/Stablecoin response is malformed/);
  });

  it("rejects the former PSI subset DTO", async () => {
    const run = await runGenerator(universe(), {
      psiPayload: {
        current: { score: 94.3, band: "BEDROCK", computedAt: Math.floor(Date.now() / 1000) - 5 * 60 },
      },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/PSI response is malformed/);
  });
});

describe("safety-score map — the blank-poster cascade (§11.2b rule 8 / P0-5)", () => {
  // The original defect: an empty or unjoined list endpoint gives maxMcap = 0,
  // so k = Infinity and every radius is NaN. Every NaN comparison is false, the
  // layout therefore "fits", and a header-only poster shipped with exit code 0.
  it("fails loudly when the list endpoint returns no rows at all", async () => {
    const run = await runGenerator({ cards: universe().cards, assets: [] });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/Supply join coverage 0\.0% is below 95% \(20\/20 unjoined\)/);
    expect(existsSync(run.pngPath)).toBe(false);
  });

  it("fails loudly when every joined row carries zero circulating supply", async () => {
    const { cards: c, assets: a } = universe();
    const run = await runGenerator({ cards: c, assets: a.map((row) => ({ ...row, circulating: { peggedUSD: 0 } })) });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/Supply join coverage 0\.0%/);
    expect(existsSync(run.pngPath)).toBe(false);
  });

  it("refuses an empty graded census outright", async () => {
    const run = await runGenerator({ cards: [{ id: "nr-0", score: null, grade: "NR" }], assets: [] });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/No graded coins returned — refusing to render an empty map/);
  });
});

describe("safety-score map — join coverage guard", () => {
  it("fails below the 95% coverage floor", async () => {
    const run = await runGenerator(universe({ count: 20, unjoined: 2 }));
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/Supply join coverage 90\.0% is below 95% \(2\/20 unjoined\)/);
    expect(run.stderr).toMatch(/drawing floors, not data/);
  });

  it("warns per coin but proceeds at exactly the 95% floor", async () => {
    const run = await runGenerator(universe({ count: 20, unjoined: 1 }), { stopBeforeRender: true });
    expect(run.stderr).toMatch(/coin-19: zero circulating supply — drawn at the size floor/);
    expect(run.stderr).not.toMatch(/is below 95%/);
    expect(run.stderr).toMatch(REACHED_RENDER_GATE);
  });

  it("counts a graded card with no list row at all as unjoined", async () => {
    const { cards: c, assets: a } = universe({ count: 20 });
    const run = await runGenerator({ cards: c, assets: a.slice(0, 18) });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/\(2\/20 unjoined\)/);
    expect(run.stderr).toMatch(/coin-18: no list row/);
  });

  it("fails closed on a negative finite circulating bucket", async () => {
    const { cards: c, assets: a } = universe();
    a[0] = { ...a[0], circulating: { peggedUSD: -1 } };
    const run = await runGenerator({ cards: c, assets: a });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/Negative circulating supply for coin-00\.peggedUSD/);
    expect(existsSync(run.pngPath)).toBe(false);
  });
});

describe("safety-score map — grade-letter integrity", () => {
  it("throws on a grade letter outside A-F instead of silently counting it as not rated", async () => {
    const { cards: c, assets: a } = universe();
    c.push({ id: "coin-future", score: 50, grade: "G+" });
    a.push({ id: "coin-future", symbol: "GFUT", circulating: { peggedUSD: 1e9 } });
    const run = await runGenerator({ cards: c, assets: a });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/Unknown grade "G\+" for coin-future — the tier map \(A\/B\/C\/D\/F\) is out of date/);
    expect(existsSync(run.pngPath)).toBe(false);
  });

  it("accepts NR and null-score cards as the not-rated slice", async () => {
    const run = await runGenerator(universe({ notRated: 2 }), { stopBeforeRender: true });
    expect(run.stderr).not.toMatch(/Unknown grade/);
    expect(run.stderr).toMatch(REACHED_RENDER_GATE);
  });

  it("rejects an NR card with a non-null score before classification", async () => {
    const { cards: c, assets: a } = universe();
    c.push({ id: "coin-nr-scored", score: 71, grade: "NR" });
    const run = await runGenerator({ cards: c, assets: a }, { stopBeforeRender: true });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/Score\/grade disagreement for coin-nr-scored/);
  });

  it("rejects an out-of-range score and a score-grade disagreement", async () => {
    const { cards: c, assets: a } = universe();
    c[0] = { id: c[0].id, score: 101, grade: "A+" };
    const run = await runGenerator({ cards: c, assets: a });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/Invalid score for coin-00/);

    c[0] = { id: c[0].id, score: 20, grade: "A+" };
    const disagreement = await runGenerator({ cards: c, assets: a });
    expect(disagreement.status).toBe(1);
    expect(disagreement.stderr).toMatch(/Score\/grade disagreement for coin-00/);
  });

  it("rejects duplicate report-card ids before the supply join", async () => {
    const { cards: c, assets: a } = universe();
    c.push({ ...c[0] });
    const run = await runGenerator({ cards: c, assets: a });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/Duplicate report-card id "coin-00"/);
  });
});

describe("safety-score map — availability-first rendering", () => {
  it("fetches one canonical input set and has no historical movement gate", async () => {
    const fixture = universe({ count: 20 });
    const payload = makeSafetyMapStablecoinsPayload(fixture.assets);
    let stablecoinReads = 0;
    const run = await runGenerator(fixture, {
      stopBeforeRender: true,
      stablecoinsPayload: () => {
        stablecoinReads += 1;
        return payload;
      },
    });

    expect(stablecoinReads).toBe(1);
    expect(run.stdout).toMatch(/Fetching canonical data/);
    expect(run.stdout).toMatch(/Render input graded=20/);
    expect(run.stderr).toMatch(REACHED_RENDER_GATE);
  });
});
describe("safety-score map — backwards-publish guard (§11.2b rule 5)", () => {
  it("refuses to overwrite a manifest rendered in the future", async () => {
    const run = await runGenerator(universe(), { stopBeforeRender: true });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/was rendered in the future .* — refusing to publish backwards/);
    expect(existsSync(run.pngPath)).toBe(false);
  });
});

describe("safety-score map — CLI contract", () => {
  it("rejects an unknown edition", async () => {
    const run = await runGenerator(universe(), { args: ["--edition", "weekly"] });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/--edition must be "daily" or "monthly" \(got "weekly"\)/);
  });

  it("rejects a non-positive issue number", async () => {
    const run = await runGenerator(universe(), { args: ["--issue", "0"] });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/--issue must be a positive integer/);
  });

});
