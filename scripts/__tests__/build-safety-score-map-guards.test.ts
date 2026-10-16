import type { Server } from "node:http";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeReportCardsV9Card, makeReportCardsV9PartialCard, makeReportCardsV9PipelineGapCard } from "@shared/test-utils/report-cards-v9";

import { runSafetyScoreMapCli, parseMapReportCards } from "../maintenance/build-safety-score-map";
import type { SafetyScoreV9CurrentCard } from "@shared/types/safety-score-v9-public";
import {
  makeSafetyMapPsiPayload,
  makeSafetyMapRatedCard,
  makeSafetyMapReportCardsResponse,
  makeSafetyMapStablecoinsPayload,
  startSafetyMapFixtureServer,
  withSafetyMapAdverseAttribution,
} from "./build-safety-score-map.test-support";

describe("Safety map availability semantics", () => {
  it("omits technical nulls without moving them into NR and preserves partial rated stones", () => {
    const partial = makeReportCardsV9PartialCard("backing", "B", { id: "partial" });
    const gap = makeReportCardsV9PipelineGapCard(null, "A", { id: "gap" });
    const response = makeSafetyMapReportCardsResponse({ cards: [gap, partial], fixtureId: "availability", methodologyVersion: "10.01", defaultUpdatedAt: 1790972280, asOfSec: 1790972280 });
    const result = parseMapReportCards(response);
    expect(result.cards.map(card => ({ id: card.id, grade: card.grade, score: card.score }))).toEqual([{ id: "partial", grade: partial.grade, score: partial.score }]);
  });
});

/**
 * Publication-safety guards for the Safety Score map generator (plan §11.2b).
 *
 * The generator runs unattended every day and publishes to a public URL, so the
 * failure that matters is not a crash — it is a successful exit that ships a
 * blank or malformed poster. Every guard below drives the exported
 * `runSafetyScoreMapCli` in-process against the same fixture server. Each fixture
 * is shaped to stop the run *before* the headless-Firefox render, so the suite
 * needs no browser and no credentials.
 */

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

function reportCardsPayload(): unknown {
  const updatedAt = Math.max(asOfSec, Math.floor(Date.now() / 1000));
  const canonicalCards: SafetyScoreV9CurrentCard[] = cards.map((card) => {
    if (card.score === null) {
      return makeReportCardsV9Card({
        id: card.id,
        score: null,
        grade: card.grade as SafetyScoreV9CurrentCard["grade"],
        ratingStatus: "not-rated",
        qualityScore: null,
        pegMultiplier: null,
        pegAdjustedScore: null,
        pillars: {
          backing: { score: null, aggregationDisposition: "included", causeGapRefs: [], limitedEvidenceCauses: ["U"], supportedComponentKeys: [], evidenceLevel: "insufficient", freshness: "unknown", components: [], reasons: [] },
          exit: { score: null, aggregationDisposition: "included", causeGapRefs: [], limitedEvidenceCauses: ["U"], supportedComponentKeys: [], evidenceLevel: "insufficient", freshness: "unknown", components: [], reasons: [] },
          control: { score: null, aggregationDisposition: "included", causeGapRefs: [], limitedEvidenceCauses: ["U"], supportedComponentKeys: [], evidenceLevel: "insufficient", freshness: "unknown", components: [], reasons: [] },
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
  ({ server, baseUrl } = await startSafetyMapFixtureServer({
    reportCardsPayload,
    stablecoinsPayload,
    psiPayload,
    publicationStatus: () => publicationStatus,
  }));
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
    rows.push({ id, symbol: `C${i}`, circulating: i >= count - unjoined ? {} : { peggedUSD: 1e11 * 0.4 ** i } });
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
 * Stage the fixture API state and output path.
 *
 * `stopBeforeRender` pre-writes a future-dated manifest at the output path. The
 * backwards-publish guard (§11.2b rule 5) then aborts the run *after* fetch,
 * input validation, join, layout and the composition linter have all passed but
 * *before* Firefox launches — so a test can assert "the run got this far"
 * without paying for a real render.
 */
function stageFixture(
  fixture: { cards: Card[]; assets: Asset[]; asOfSec?: number; methodologyVersion?: string },
  options: {
    stopBeforeRender?: boolean;
    publicationStatus?: string;
    psiComputedAt?: number;
  } = {},
): { pngPath: string; outDir: string } {
  cards = fixture.cards;
  assets = fixture.assets;
  asOfSec = fixture.asOfSec ?? Math.floor(Date.now() / 1000) - HOUR;
  psiComputedAt = options.psiComputedAt ?? Math.floor(Date.now() / 1000) - 5 * 60;
  methodologyVersion = fixture.methodologyVersion ?? "9.19";
  publicationStatus = options.publicationStatus ?? "current";

  const outDir = scratchDir("pharos-safety-map-test-");
  const pngPath = join(outDir, "map.png");
  if (options.stopBeforeRender) {
    writeFileSync(
      join(outDir, "map.manifest.json"),
      JSON.stringify({ renderedAt: new Date(Date.now() + HOUR * 1000).toISOString() }),
    );
  }
  return { pngPath, outDir };
}

/**
 * Run the generator in-process against the fixture API. Guard failures come
 * back as exit code 1 with the `[safety-score-map]`-prefixed message on
 * stderr, byte-for-byte what the spawned CLI prints.
 */
async function runGenerator(
  fixture: { cards: Card[]; assets: Asset[]; asOfSec?: number; methodologyVersion?: string },
  options: {
    stopBeforeRender?: boolean;
    publicationStatus?: string;
    psiComputedAt?: number;
  } = {},
): Promise<RunResult> {
  const { pngPath, outDir } = stageFixture(fixture, options);
  const stdout: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const status = await runSafetyScoreMapCli({
    argv: ["--out", pngPath],
    apiKey: "fixture-key",
    baseUrl,
    io: {
      log: (message) => stdout.push(message),
      warn: (message) => warnings.push(message),
      error: (message) => errors.push(message),
    },
  });
  return { status, stdout: stdout.join(""), stderr: `${warnings.join("")}${errors.join("")}`, pngPath, outDir };
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
    expect(run.stderr).toMatch(/Report-card response is malformed at asOfSec/);
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
    expect(run.stderr).not.toMatch(/Supply join coverage/);
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
    expect(run.stderr).toMatch(/coin-19: unavailable circulating supply — drawn at the size floor/);
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
    // The published list schema (CR-13) rejects negative aggregate buckets before the join.
    expect(run.stderr).toMatch(/Stablecoin response is malformed at peggedAssets\.0\.circulating\.peggedUSD/);
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
    expect(run.stderr).toMatch(/Report-card response is malformed at cards\.20\.grade/);
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
    expect(run.stderr).toMatch(/Report-card response is malformed/);
  });

  it("rejects an out-of-range score and a score-grade disagreement", async () => {
    const { cards: c, assets: a } = universe();
    c[0] = { id: c[0].id, score: 101, grade: "A+" };
    const run = await runGenerator({ cards: c, assets: a });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/Report-card response is malformed at cards\.0\.score/);

    c[0] = { id: c[0].id, score: 20, grade: "A+" };
    const disagreement = await runGenerator({ cards: c, assets: a });
    expect(disagreement.status).toBe(1);
    expect(disagreement.stderr).toMatch(/Report-card response is malformed/);
  });

  it("rejects duplicate report-card ids before the supply join", async () => {
    const { cards: c, assets: a } = universe();
    c.push({ ...c[0] });
    const run = await runGenerator({ cards: c, assets: a });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/Report-card response is malformed at cards/);
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
