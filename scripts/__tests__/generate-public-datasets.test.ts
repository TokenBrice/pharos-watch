import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockFetch, mockFetchStrict } from "@shared/test-utils/mock-fetch";

import { loadPublicDatasetLiveInputs, testExports } from "../maintenance/generate-public-datasets";
import { makeReportCardsV9Response, makeV9Card } from "@/test/fixtures/safety-score-v9";
import { makeReportCardsV9PipelineGapCard } from "@shared/test-utils/report-cards-v9";
import type { V9OpenEvidence } from "@shared/types/safety-score-v9-public";
import * as depegSnapshot from "../../src/lib/depeg-event-snapshot";
import { copyDatasetWorkspace, datasetBytes } from "./generate-public-datasets.test-support";
import * as depegCapture from "../lib/depeg-ledger-capture";
import { DEPEG_DEWS_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/constants";

beforeEach(() => {
  vi.spyOn(depegSnapshot, "readDepegEventSnapshot").mockImplementation(() => [makeEvent(null), makeCoverageSentinel()]);
  vi.spyOn(depegCapture, "readDepegLedgerCapture").mockImplementation(() => makeCapture(
    depegSnapshot.readDepegEventSnapshot({ missing: "throw" }).length,
  ));
});

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function makeRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pharos-public-datasets-"));
  tempRoots.push(root);
  return root;
}

async function writeTopicRedirects(root: string, topic: string, snapshotDate = "2026-05-16") {
  const redirectsPath = path.join(root, "_redirects");
  await writeFile(
    redirectsPath,
    [
      `/datasets/${topic}/latest.csv /datasets/${topic}/${snapshotDate}.csv 200`,
      `/datasets/${topic}/latest.json /datasets/${topic}/${snapshotDate}.json 200`,
      `/datasets/${topic}/latest.ndjson /datasets/${topic}/${snapshotDate}.ndjson 200`,
      `/sheets/${topic}.csv /datasets/${topic}/${snapshotDate}.csv 200`,
      "",
    ].join("\n"),
  );
  return redirectsPath;
}

function artifactDirs(datasetsDir: string, redirectsPath: string) {
  return {
    datasetsDir,
    redirectsPath,
    currentDatasetModulePath: path.join(path.dirname(datasetsDir), "public-dataset-current.ts"),
  };
}

function makeEnvelope(snapshotDate: string) {
  return {
    snapshotDate,
    generatedAt: 1_779_000_000,
    methodologyVersions: {},
    stablecoins: [
      {
        id: "usdc-circle",
        name: "USD Coin",
        symbol: "USDC",
        pegType: "peggedUSD",
        pegMechanism: "fiat-backed",
        price: 1,
        circulating: { ethereum: 1_000_000 } as Record<string, number>,
        chains: ["ethereum"],
        mechanismArchetype: "fiat-cash",
        pegReferenceId: "usdc-circle",
        jurisdiction: { country: "United States" },
      },
    ],
    reportCards: { scores: { "usdc-circle": { pegScore: 99, safetyGrade: "A" } } },
    dews: [{ stablecoinId: "usdc-circle", score: 4, band: "normal" }],
    liquidity: [{ stablecoinId: "usdc-circle", liquidityScore: 95, coverageClass: "deep" }],
  };
}

/**
 * The publication schema-8 `openEvidence` block a frozen API-9 envelope carries:
 * three disjoint buckets whose questions reconcile. Documentation stays empty
 * because a non-zero datum would also require `documentationCauseGaps` to
 * resolve through this fixture's gap tables.
 */
function makeOpenEvidence(cardId = "usdc-circle"): V9OpenEvidence {
  return {
    semantics: "open-question-v1",
    totals: { questions: 3, open: 1, issuer: 2, documentation: 0, obligations: 6 },
    owners: [{ responsibility: "unresearched", questions: 1, obligations: 2 }],
    // Rows are canonical: unique and sorted by bucket, then code.
    reasons: [
      { code: "material-reserve-slice-unstructured", bucket: "issuer", questions: 2, obligations: 4 },
      { code: "unresolved-control-identity", bucket: "open", questions: 1, obligations: 2 },
    ],
    documentation: { questions: 0, datums: 0, facts: 0, reasons: [] },
    issuer: { questions: 2, assets: 1, oldestReviewedAtSec: 1_752_000_000, newestReviewedAtSec: 1_752_500_000 },
    byCard: [{
      id: cardId,
      openBucketQuestionsCarried: 1,
      inheritedOpenBucketQuestionsCarried: 0,
      openBucketObligationsCarried: 2,
      documentationObligationsCarried: 0,
    }],
  };
}

function makeCurrentEnvelope(snapshotDate: string) {
  const response = makeReportCardsV9Response({
    cards: [makeV9Card({ id: "usdc-circle", score: 88, grade: "A+" })],
    openEvidence: makeOpenEvidence(),
  });
  return {
    ...makeEnvelope(snapshotDate),
    version: 2,
    safetyScoreIdentity: response.safetyScoreIdentity,
    reportCards: response,
    dews: [{ stablecoinId: "usdc-circle", computedAt: 1_778_900_000, score: 4, band: "normal" }],
    liquidity: [{
      stablecoinId: "usdc-circle",
      liquidityScore: 95,
      coverageClass: "deep",
      updatedAt: 1_778_900_100,
      unavailableReason: null,
      methodologyVersion: "6.98",
    }],
  };
}

function makeEvent(pendingReason: string | null) {  return {
    id: 42,
    slug: "usdc-circle-2026-05-14",
    stablecoinId: "usdc-circle",
    symbol: "USDC",
    pegType: "USD",
    direction: "below" as const,
    peakDeviationBps: 300,
    startedAt: Date.UTC(2026, 4, 14) / 1000,
    endedAt: Date.UTC(2026, 4, 15) / 1000,
    startPrice: 1,
    peakPrice: 0.97,
    recoveryPrice: 1,
    pegReference: 1,
    source: "live" as const,
    confirmationSources: "CoinGecko",
    pendingReason,
    closeReason: null,
    provenance: null,
  };
}

function makeCoverageSentinel() {
  return {
    ...makeEvent(null),
    id: 43,
    startedAt: Date.parse("2026-02-13T23:59:00Z") / 1000,
  };
}

function makeCapture(eventCount = 2): depegCapture.DepegLedgerCapture {
  return {
    schemaVersion: 1,
    captureId: `sha256:${"a".repeat(64)}`,
    observationStartedAtISO: "2026-05-19T10:00:00.000Z",
    observedAtISO: "2026-05-19T10:01:00.000Z",
    sourceUrl: "https://api.example.test/api/depeg-events",
    methodologyVersionLabel: "v7.0",
    eventCount,
    apiTotal: eventCount,
  };
}

describe("generate-public-datasets", () => {
  it("appends the supply reason without shifting existing CSV columns and preserves null versus zero", () => {
    const envelope = makeEnvelope("2026-05-16");
    const base = envelope.stablecoins[0];
    envelope.stablecoins = [
      { ...base, id: "unknown", circulating: {} },
      { ...base, id: "zero", circulating: { peggedUSD: 0 } },
      { ...base, id: "known", circulating: { peggedUSD: 100 } },
    ];
    const spec = testExports.buildTopicSpecs(envelope, [], "2026-05-16").find((item) => item.topic === "top-stablecoins")!;
    expect(spec.rows).toEqual([
      expect.objectContaining({ id: "known", circulatingUsd: 100, supplyUnavailableReason: null }),
      expect.objectContaining({ id: "zero", circulatingUsd: 0, supplyUnavailableReason: null }),
      expect.objectContaining({ id: "unknown", circulatingUsd: null, supplyUnavailableReason: "absent" }),
    ]);
    const artifacts = testExports.buildTopicArtifacts(spec, "2026-05-16T10:00:00.000Z");
    const json = JSON.parse(artifacts.json);
    expect(json.data ?? json.rows).toEqual(spec.rows);
    const lines = artifacts.ndjson.trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toContainEqual(expect.objectContaining({ id: "unknown", circulatingUsd: null, supplyUnavailableReason: "absent" }));
    const csvLines = artifacts.csv.trimEnd().split("\n").filter((line) => !line.startsWith("#"));
    expect(csvLines[0].split(",")).toEqual([
      "id", "symbol", "name", "pegType", "pegMechanism", "price", "circulatingUsd",
      "chainCount", "chains", "supplyUnavailableReason", "supplyProvenance",
    ]);
    expect(csvLines.find((line) => line.startsWith("unknown,"))?.split(",")).toEqual([
      "unknown", "USDC", "USD Coin", "peggedUSD", "fiat-backed", "1", "", "1", "ethereum", "absent", "",
    ]);
    expect(csvLines.find((line) => line.startsWith("zero,"))?.split(",")).toEqual([
      "zero", "USDC", "USD Coin", "peggedUSD", "fiat-backed", "1", "0", "1", "ethereum", "", "",
    ]);
  });

  it.each([
    { label: "string 6.57", versions: { pricingPipeline: "6.57" }, recorded: true },
    { label: "string 6.55", versions: { pricingPipeline: "6.55" }, recorded: true },
    { label: "pre-guard 6.54", versions: { pricingPipeline: "6.54" }, recorded: false },
    { label: "missing Pricing key", versions: { safetyScore: "10.34" }, recorded: false },
    { label: "malformed version", versions: { pricingPipeline: "six" }, recorded: false },
  ])("records guard-less dataset provenance only for a guard-capable envelope ($label) (K-031)", ({ versions, recorded }) => {
    const envelope = makeEnvelope("2026-05-16");
    envelope.methodologyVersions = versions;
    const base = envelope.stablecoins[0];
    envelope.stablecoins = [{ ...base, circulating: { peggedUSD: 100 }, supplySource: "defillama" } as typeof base];
    const spec = testExports.buildTopicSpecs(envelope, [], "2026-05-16").find((item) => item.topic === "top-stablecoins")!;
    expect(spec.rows[0]).toMatchObject({
      supplyProvenance: recorded ? { supplySource: "defillama", supplyObservedAt: null, supplyChainGuard: null } : null,
    });
  });

  it("keeps an explicit partial guard and its original clocks in JSON, NDJSON and CSV, even on a legacy envelope", () => {
    const envelope = makeEnvelope("2026-05-16");
    const guard = {
      reason: "supply-chain-dropout", status: "chains-unavailable", partialCoverage: true, quarantinedSince: 1_778_000_000,
      chains: [{
        chainId: "hyperevm", chainLabel: "HyperEVM", listCurrentUsd: 0, baselineUsd: 3_000,
        baselineObservedAt: 1_777_900_000, baselineSource: "state", resolution: "unavailable",
      }],
    };
    const base = envelope.stablecoins[0];
    envelope.stablecoins = [
      { ...base, circulating: { peggedUSD: 97_000 }, supplyObservedAt: 1_778_990_000, supplyChainGuard: guard } as typeof base,
    ];
    const spec = testExports.buildTopicSpecs(envelope, [], "2026-05-16").find((item) => item.topic === "top-stablecoins")!;
    const expected = { supplySource: null, supplyObservedAt: 1_778_990_000, supplyChainGuard: guard };
    expect(spec.rows[0]).toMatchObject({ circulatingUsd: 97_000, supplyProvenance: expected });
    const artifacts = testExports.buildTopicArtifacts(spec, "2026-05-16T10:00:00.000Z");
    const json = JSON.parse(artifacts.json);
    expect((json.data ?? json.rows)[0].supplyProvenance).toEqual(expected);
    const ndjsonRow = artifacts.ndjson.trim().split("\n").map((line) => JSON.parse(line)).find((line) => line.id === "usdc-circle");
    expect(ndjsonRow.supplyProvenance).toEqual(expected);
    const row = spec.rows[0];
    if (row == null || typeof row !== "object" || !("supplyProvenance" in row)) {
      throw new Error("Expected a top-stablecoins row with supply provenance");
    }
    expect(artifacts.csv).toContain(`"${JSON.stringify(row.supplyProvenance).replace(/"/g, '""')}"`);
  });

  it.each([
    {
      topic: "depeg-history",
      header: "id,stablecoinId,symbol,direction,peakDeviationBps,startedAtISO,endedAtISO,durationSec,startPrice,peakPrice,recoveryPrice,pegReference,source,auditVerdict",
    },
    {
      topic: "scores-latest",
      header: "stablecoinId,symbol,pegScore,safetyScore,safetyGrade,dewsScore,dewsBand,liquidityScore,coverageClass,ratingStatus,safetyDisplay,dewsComputedAt,liquidityUpdatedAt,liquidityUnavailableReason,liquidityMethodologyVersion",
    },
    {
      topic: "peg-mechanism-distribution",
      header: "mechanismArchetype,mechanismLabel,pegReferenceId,jurisdiction,coinCount",
    },
  ])("preserves the existing $topic CSV column order", ({ topic, header }) => {
    const specs = testExports.buildTopicSpecs(makeEnvelope("2026-05-16"), [makeEvent(null)], "2026-05-16", {
      depegCapture: makeCapture(1),
    });
    const spec = specs.find((item) => item.topic === topic)!;
    const artifacts = testExports.buildTopicArtifacts(spec, "2026-05-16T10:00:00.000Z");
    expect(artifacts.csv.split("\n").find((line) => !line.startsWith("#"))).toBe(header);
  });

  it("generates direct 200 rewrites for latest datasets and Sheets CSV aliases", () => {
    const block = testExports.buildPublicDatasetRedirectBlock("2026-07-08");

    expect(block.match(/^\/datasets\/.+ 200$/gm)).toHaveLength(12);
    expect(block.match(/^\/sheets\/.+ 200$/gm)).toHaveLength(4);
    expect(block).toContain(
      "/datasets/top-stablecoins/latest.json /datasets/top-stablecoins/2026-07-08.json 200",
    );
    expect(block).toContain(
      "/sheets/top-stablecoins.csv /datasets/top-stablecoins/2026-07-08.csv 200",
    );
    expect(block).not.toContain("/datasets/top-stablecoins/latest.csv 301");
  });

  it("fails closed when no API source is configured outside explicit stub mode", async () => {
    await expect(execFileAsync(
      process.execPath,
      ["--import", "tsx", "scripts/maintenance/generate-public-datasets.ts"],
      {
        env: {
          ...process.env,
          API_BASE_URL: "",
          PUBLIC_DATASETS_ALLOW_STUB: "",
          PUBLIC_DATASETS_API_URL: "",
          PUBLIC_DATASETS_REQUIRE_API: "1",
          SMOKE_API_BASE: "",
        },
      },
    )).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("No public dataset API source configured"),
    });
  });

  it("fails a stale release but preserves checked-in mirrors when the configured live source is blocked", async () => {
    const root = await makeRoot();
    await copyDatasetWorkspace(root);
    // Force the copied workspace to be stale regardless of the repo's current mirror date.
    const redirectsPath = path.join(root, "public/_redirects");
    const staleRedirects = (await readFile(redirectsPath, "utf8")).replace(/\/(\d{4}-\d{2}-\d{2})\.(csv|json|ndjson) 200/g, "/2026-05-16.$2 200");
    await writeFile(redirectsPath, staleRedirects);
    const before = await datasetBytes(root);
    await expect(execFileAsync(
      process.execPath,
      ["--import", "tsx", "scripts/maintenance/generate-public-datasets.ts"],
      {
        cwd: root,
        env: {
          ...process.env,
          API_BASE_URL: "",
          PAGES_RELEASE_ALLOW_EXISTING_DATA_ON_FETCH_FAILURE: "1",
          PUBLIC_DATASETS_ALLOW_STUB: "",
          PUBLIC_DATASETS_API_URL: "http://127.0.0.1:9",
          PUBLIC_DATASETS_DATE: "2026-05-16",
          PUBLIC_DATASETS_REQUIRE_API: "1",
          SMOKE_API_BASE: "",
        },
        timeout: 15_000,
      },
    )).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("checked-in mirrors are not current"),
    });

    expect(await datasetBytes(root)).toEqual(before);
  });

  it("uses today's immutable snapshot when it is already sealed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-16T12:30:00.000Z"));
    mockFetchStrict([
      { match: "https://api.example.test/api/snapshots/2026-05-16.json", body: makeEnvelope("2026-05-16") },
    ]);

    const inputs = await loadPublicDatasetLiveInputs("https://api.example.test", "2026-05-16");

    expect(inputs.effectiveSnapshotDate).toBe("2026-05-16");
    expect(inputs.envelope.snapshotDate).toBe("2026-05-16");
  });

  it("uses the latest immutable snapshot when today's snapshot is not yet sealed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-16T12:30:00.000Z"));
    mockFetchStrict([
      {
        match: "https://api.example.test/api/snapshots/2026-05-16.json",
        body: { error: "not found" },
        status: 404,
      },
      { match: "https://api.example.test/api/snapshots/index", body: { snapshots: [{ snapshotDate: "2026-05-15" }] } },
      { match: "https://api.example.test/api/snapshots/2026-05-15.json", body: makeEnvelope("2026-05-15") },
    ]);

    const inputs = await loadPublicDatasetLiveInputs("https://api.example.test", "2026-05-16");
    const specs = testExports.buildTopicSpecs(inputs.envelope, inputs.depegEvents, inputs.effectiveSnapshotDate, {
      historical: false,
    });

    expect(inputs.effectiveSnapshotDate).toBe("2026-05-15");
    expect(inputs.asOfISO).toBe("2026-05-17T06:40:00.000Z");
    expect(specs.find((spec) => spec.topic === "top-stablecoins")?.rows).toHaveLength(1);
    expect(specs.find((spec) => spec.topic === "depeg-history")?.rows.length).toBeGreaterThan(0);
  });

  it("fails current-date generation when no immutable snapshot exists", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-16T12:30:00.000Z"));
    mockFetchStrict([
      {
        match: "https://api.example.test/api/snapshots/2026-05-16.json",
        body: { error: "not found" },
        status: 404,
      },
      { match: "https://api.example.test/api/snapshots/index", body: { error: "not found" }, status: 404 },
    ]);

    await expect(loadPublicDatasetLiveInputs("https://api.example.test", "2026-05-16")).rejects.toThrow(
      "API-backed public dataset generation requires today's snapshot or the latest sealed snapshot",
    );
  });

  it("requires the exact immutable snapshot for a historical snapshot date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T12:30:00.000Z"));
    mockFetchStrict([
      {
        match: "https://api.example.test/api/snapshots/2026-05-16.json",
        body: { error: "not found" },
        status: 404,
      },
    ]);

    await expect(loadPublicDatasetLiveInputs("https://api.example.test", "2026-05-16")).rejects.toThrow(
      "API-backed public dataset generation requires the exact dated snapshot",
    );
  });

  it("rejects a fetched snapshot that fails the shared envelope schema", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T12:30:00.000Z"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockFetchStrict([{
      match: "https://api.example.test/api/snapshots/2026-05-16.json",
      body: { ...makeEnvelope("2026-05-16"), stablecoins: "not-an-array" },
    }]);

    await expect(loadPublicDatasetLiveInputs("https://api.example.test", "2026-05-16")).rejects.toThrow(
      "API-backed public dataset generation requires the exact dated snapshot",
    );
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("invalid public snapshot envelope"),
    );
  });

  it("can fetch release inputs through the site-data lane without exposing service credentials", async () => {
    vi.stubEnv("PUBLIC_DATASETS_API_KEY", "public-key");
    vi.stubEnv("SITE_API_SHARED_SECRET", "site-secret");
    const fetchMock = mockFetch([{
      match: (request) => {
        const headers = request.headers;
        expect(headers.get("Origin")).toBe("https://pharos.watch");
        expect(headers.has("X-API-Key")).toBe(false);
        expect(headers.has("X-Pharos-Site-Proxy-Secret")).toBe(false);
        return request.url === "https://stablecoin-dashboard.pages.dev/_site-data/snapshots/2026-05-16.json";
      },
      respond: () => ({ body: makeEnvelope("2026-05-16") }),
    }], { requireMatch: true });

    const inputs = await loadPublicDatasetLiveInputs("https://stablecoin-dashboard.pages.dev/_site-data", "2026-05-16");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://stablecoin-dashboard.pages.dev/_site-data/snapshots/2026-05-16.json",
      expect.anything(),
    );
    expect(inputs.effectiveSnapshotDate).toBe("2026-05-16");
    expect(inputs.depegEvents.map((event) => event.id)).toEqual([42, 43]);
  });

  it("preserves snapshot report-card safety scores without reusing them as peg scores", () => {
    const envelope = {
      ...makeEnvelope("2026-05-16"),
      reportCards: { scores: { "usdc-circle": { score: 88, grade: "B" } } },
    };

    const specs = testExports.buildTopicSpecs(envelope, [], "2026-05-16");
    const scoreRows = specs.find((spec) => spec.topic === "scores-latest")?.rows as Array<Record<string, unknown>>;

    expect(scoreRows).toHaveLength(1);
    expect(scoreRows[0]?.pegScore).toBeNull();
    expect(scoreRows[0]?.safetyScore).toBe(88);
    expect(scoreRows[0]?.safetyGrade).toBe("B");
  });

  it("projects current cards and keeps zero ahead of missing scores without unmatched joins", () => {
    const base = makeEnvelope("2026-05-16");
    const envelope = {
      ...base,
      stablecoins: ["missing", "zero", "high"].map((id) => ({ ...base.stablecoins[0]!, id })),
      reportCards: { cards: [{ id: "zero", score: 0, grade: "F" }, { id: "high", score: 88, grade: "B" }] },
      dews: [{ stablecoinId: "high", score: 4, band: "normal" }, { stablecoinId: "unmatched", score: 99, band: "danger" }],
      liquidity: [{ stablecoinId: "zero", liquidityScore: 0, coverageClass: "thin" }],
    };
    const rows = testExports.buildTopicSpecs(envelope, [], "2026-05-16").find((spec) => spec.topic === "scores-latest")?.rows;
    expect(rows).toEqual([
      { stablecoinId: "high", symbol: "USDC", pegScore: null, safetyScore: 88, safetyGrade: "B", dewsScore: 4, dewsBand: "normal", liquidityScore: null, coverageClass: null, ratingStatus: null, safetyDisplay: null, dewsComputedAt: null, liquidityUpdatedAt: null, liquidityUnavailableReason: null, liquidityMethodologyVersion: null },
      { stablecoinId: "zero", symbol: "USDC", pegScore: null, safetyScore: 0, safetyGrade: "F", dewsScore: null, dewsBand: null, liquidityScore: 0, coverageClass: "thin", ratingStatus: null, safetyDisplay: null, dewsComputedAt: null, liquidityUpdatedAt: null, liquidityUnavailableReason: null, liquidityMethodologyVersion: null },
      { stablecoinId: "missing", symbol: "USDC", pegScore: null, safetyScore: null, safetyGrade: null, dewsScore: null, dewsBand: null, liquidityScore: null, coverageClass: null, ratingStatus: null, safetyDisplay: null, dewsComputedAt: null, liquidityUpdatedAt: null, liquidityUnavailableReason: null, liquidityMethodologyVersion: null },
    ]);
  });

  it("prefers explicit safety scores over legacy score and overall aliases", () => {
    const envelope = {
      ...makeEnvelope("2026-05-16"),
      reportCards: { scores: { "usdc-circle": { safetyScore: 0, score: 88, overall: 99, safetyGrade: "F", grade: "A" } } },
    };
    expect(testExports.buildTopicSpecs(envelope, [], "2026-05-16").find((spec) => spec.topic === "scores-latest")?.rows)
      .toEqual([expect.objectContaining({ stablecoinId: "usdc-circle", safetyScore: 0, safetyGrade: "F" })]);
  });

  it("emits the versioned display projection in JSON and NDJSON but not the CSV preamble", () => {
    const envelope = makeCurrentEnvelope("2026-05-16");
    const spec = testExports.buildTopicSpecs(envelope, [], "2026-05-16").find((item) => item.topic === "scores-latest")!;

    expect(spec.displayProjection).toMatchObject({
      version: 2,
      snapshotDate: "2026-05-16",
      capturedAtSec: envelope.generatedAt,
      sourceSnapshotPath: "/api/snapshots/2026-05-16.json",
      safetyUnavailableReason: null,
      safety: {
        identity: envelope.reportCards.safetyScoreIdentity,
        asOfSec: envelope.reportCards.asOfSec,
        publishedAtSec: envelope.reportCards.updatedAt,
        sourceGenerations: envelope.reportCards.source.sourceGenerations,
        publicationHealth: envelope.reportCards.publicationHealth,
        completeness: envelope.reportCards.completeness,
      },
      openEvidence: {
        semantics: "open-question-v1",
        totals: envelope.reportCards.openEvidence!.totals,
      },
      openEvidenceUnavailableReason: null,
    });

    const artifacts = testExports.buildTopicArtifacts(spec, "2026-05-16T10:00:00.000Z");
    const json = JSON.parse(artifacts.json);
    const ndjsonMeta = JSON.parse(artifacts.ndjson.split("\n")[0]!);
    expect(json._meta.asOfISO).toBe("2026-05-16T10:00:00.000Z");
    expect(json._meta.displayProjection).toEqual(spec.displayProjection);
    expect(ndjsonMeta._meta.displayProjection).toEqual(spec.displayProjection);
    // Sheets IMPORTDATA reads only the leading `#` preamble; a second comment
    // line would fold the whole CSV into one cell. The appended row columns do
    // stay, because they are ordinary escaped fields.
    expect(artifacts.csv.split("\n").filter((line) => line.startsWith("#"))).toHaveLength(1);
    expect(artifacts.csv).not.toContain("Display projection");
    expect(artifacts.csv).not.toContain('"version":2');
    expect(artifacts.csv.split("\n").find((line) => !line.startsWith("#"))?.split(",")).toEqual(
      expect.arrayContaining([
        "ratingStatus",
        "safetyDisplay",
        "dewsComputedAt",
        "liquidityUpdatedAt",
        "liquidityUnavailableReason",
        "liquidityMethodologyVersion",
      ]),
    );
    expect(json.rows).toEqual([expect.objectContaining({
      stablecoinId: "usdc-circle",
      ratingStatus: "rated",
      safetyDisplay: { nrReasons: [], reasonCodes: [], partialEvidence: null },
      dewsComputedAt: 1_778_900_000,
      liquidityUpdatedAt: 1_778_900_100,
      liquidityUnavailableReason: null,
      liquidityMethodologyVersion: "6.98",
    })]);
  });

  it("keeps rated cards absent from the market feed and marks their missing liquidity source", () => {
    const base = makeCurrentEnvelope("2026-05-16");
    const response = makeReportCardsV9Response({
      cards: [
        makeV9Card({ id: "usdc-circle", score: 88, grade: "A+" }),
        makeV9Card({ id: "usdt-tether", score: 86, grade: "A" }),
      ],
    });
    const envelope = {
      ...base,
      safetyScoreIdentity: response.safetyScoreIdentity,
      reportCards: response,
    };
    const rows = testExports.buildTopicSpecs(envelope, [], "2026-05-16")
      .find((spec) => spec.topic === "scores-latest")?.rows as Array<Record<string, unknown>>;

    expect(rows.map((row) => row.stablecoinId)).toEqual(["usdc-circle", "usdt-tether"]);
    expect(rows[1]).toMatchObject({
      symbol: "USDT",
      safetyScore: 86,
      safetyGrade: "A",
      ratingStatus: "rated",
      liquidityScore: null,
      liquidityUnavailableReason: "source-row-missing",
    });
  });

  it("preserves a recorded liquidity rejection reason and the row's methodology version", () => {
    const envelope = makeCurrentEnvelope("2026-05-16");
    const row = testExports.projectScoresLatest({
      ...envelope,
      liquidity: [{
        stablecoinId: "usdc-circle",
        liquidityScore: null,
        coverageClass: null,
        updatedAt: 1_778_900_100,
        unavailableReason: "invalid-coverage-evidence",
        methodologyVersion: "6.97",
      }],
    }).rows[0]!;
    expect(row).toMatchObject({
      liquidityScore: null,
      coverageClass: null,
      liquidityUpdatedAt: 1_778_900_100,
      liquidityUnavailableReason: "invalid-coverage-evidence",
      liquidityMethodologyVersion: "6.97",
    });
  });

  it("rejects accepted card IDs that are neither market rows nor tracked assets", () => {    const base = makeCurrentEnvelope("2026-05-16");
    const response = makeReportCardsV9Response({
      cards: [makeV9Card({ id: "ghost-coin", score: 88, grade: "A+" })],
    });
    const envelope = { ...base, safetyScoreIdentity: response.safetyScoreIdentity, reportCards: response };
    expect(() => testExports.buildTopicSpecs(envelope, [], "2026-05-16")).toThrow(
      "neither a market row nor a tracked registry identity",
    );
  });

  it("rejects mismatched Safety identities and publication clocks that postdate collection", () => {
    const envelope = makeCurrentEnvelope("2026-05-16");
    expect(() => testExports.projectScoresLatest({
      ...envelope,
      safetyScoreIdentity: {
        ...envelope.reportCards.safetyScoreIdentity,
        publicationGenerationId: "another-publication",
      },
    })).toThrow("identity does not match");
    expect(() => testExports.projectScoresLatest({
      ...envelope,
      generatedAt: envelope.reportCards.updatedAt - 1,
    })).toThrow("clocks do not precede the snapshot collection clock");
  });

  it("preserves pipeline-gap, grade-hold and provisional facts without inventing NR", () => {
    const base = makeCurrentEnvelope("2026-05-16");
    const pipelineGap = makeReportCardsV9Response({
      cards: [makeReportCardsV9PipelineGapCard("control", "A", { id: "usdc-circle" })],
    });
    const gapRow = testExports.projectScoresLatest({
      ...base,
      safetyScoreIdentity: pipelineGap.safetyScoreIdentity,
      reportCards: pipelineGap,
    }).rows[0]!;
    expect(gapRow).toMatchObject({
      safetyScore: null,
      safetyGrade: null,
      ratingStatus: "pipeline-gap",
      safetyDisplay: { partialEvidence: expect.objectContaining({ reasonCode: "partial-evidence-pipeline-gap" }) },
    });

    const held = makeReportCardsV9Response({
      cards: [makeV9Card({
        id: "usdc-circle",
        score: 84,
        grade: "A-",
        gradeHold: { rawGrade: "A", heldFromGenerationId: "v9-publication-prior" },
      })],
    });
    const heldRow = testExports.projectScoresLatest({
      ...base,
      safetyScoreIdentity: held.safetyScoreIdentity,
      reportCards: held,
    }).rows[0]!;
    expect(heldRow).toMatchObject({
      safetyScore: 84,
      safetyGrade: "A-",
      safetyDisplay: {
        gradeHold: { rawGrade: "A", heldFromGenerationId: "v9-publication-prior" },
      },
    });
    expect(heldRow.safetyDisplay).not.toHaveProperty("provisional");
  });

  it("exports an explicit legacy-unavailable display projection for old envelopes", () => {
    const spec = testExports.buildTopicSpecs(makeEnvelope("2026-05-16"), [], "2026-05-16")
      .find((item) => item.topic === "scores-latest")!;
    expect(spec.displayProjection).toEqual({
      version: 2,
      snapshotDate: "2026-05-16",
      capturedAtSec: 1_779_000_000,
      sourceSnapshotPath: "/api/snapshots/2026-05-16.json",
      safety: null,
      safetyUnavailableReason: "legacy-source-metadata-unavailable",
      openEvidence: null,
      openEvidenceUnavailableReason: "safety-publication-unavailable",
    });
    expect((spec.rows[0] as Record<string, unknown>).ratingStatus).toBeNull();
    expect((spec.rows[0] as Record<string, unknown>).safetyDisplay).toBeNull();
    expect((spec.rows[0] as Record<string, unknown>).liquidityUnavailableReason).toBeNull();
  });

  it("falls back to unavailable Safety metadata for a historical publication under an older schema", () => {
    const envelope = makeCurrentEnvelope("2026-05-16");
    const spec = testExports.buildTopicSpecs({
      ...envelope,
      reportCards: { ...envelope.reportCards, schemaVersion: 7 },
    }, [], "2026-05-16", { historical: true }).find((item) => item.topic === "scores-latest")!;
    expect(spec.displayProjection).toMatchObject({
      safety: null,
      safetyUnavailableReason: "legacy-source-metadata-unavailable",
      openEvidence: null,
      openEvidenceUnavailableReason: "safety-publication-unavailable",
    });
    expect((spec.rows[0] as Record<string, unknown>).ratingStatus).toBeNull();
    expect((spec.rows[0] as Record<string, unknown>).safetyScore).toBe(88);
  });

  it("reads archived report8 Safety publications for dated rows instead of dropping them", () => {
    const envelope = makeCurrentEnvelope("2026-05-16");
    const {
      openEvidence: _openEvidence,
      openEvidenceUnavailableReason: _unavailableReason,
      ...archived
    } = envelope.reportCards;
    void _openEvidence;
    void _unavailableReason;
    const archivedEnvelope = {
      ...envelope,
      reportCards: { ...archived, schemaVersion: 8 },
    };
    const spec = testExports.buildTopicSpecs(
      archivedEnvelope,
      [],
      "2026-05-16",
      { historical: true },
    ).find((item) => item.topic === "scores-latest")!;

    expect(spec.displayProjection).toMatchObject({
      version: 2,
      safety: {
        asOfSec: envelope.reportCards.asOfSec,
        publishedAtSec: envelope.reportCards.updatedAt,
        completeness: envelope.reportCards.completeness,
      },
      safetyUnavailableReason: null,
      // A report8 archive predates the counts; it never renders as zero.
      openEvidence: null,
      openEvidenceUnavailableReason: "open-evidence-unavailable",
    });
    // Archived card facts are projected, not replaced by the legacy null columns.
    expect(spec.rows[0]).toMatchObject({
      stablecoinId: "usdc-circle",
      symbol: "USDC",
      safetyScore: 88,
      safetyGrade: "A+",
      ratingStatus: "rated",
      dewsScore: 4,
      safetyDisplay: { nrReasons: [], reasonCodes: [], partialEvidence: null },
    });

    // The archive shape is historical-only: a live build still refuses report8.
    expect(() => testExports.projectScoresLatest(archivedEnvelope, { historical: false }))
      .toThrow("invalid V9 Safety publication");
  });

  it("reads a report9 publication with the same scores-latest projection", () => {
    const envelope = makeCurrentEnvelope("2026-05-16");
    const reportCards = makeReportCardsV9Response({
      cards: [makeV9Card({ id: "usdc-circle", score: 88, grade: "A+" })],
    });
    const spec = testExports.buildTopicSpecs({
      ...envelope,
      safetyScoreIdentity: reportCards.safetyScoreIdentity,
      reportCards,
    }, [], "2026-05-16").find((item) => item.topic === "scores-latest")!;
    expect(spec.rows[0]).toMatchObject({ stablecoinId: "usdc-circle", safetyScore: 88, safetyGrade: "A+" });
    // Report9 without a supplied block is the retained pre-cutover pair: v2 says so.
    expect(spec.displayProjection).toMatchObject({
      version: 2,
      openEvidence: null,
      openEvidenceUnavailableReason: "open-evidence-unavailable",
    });
  });

  it("admits old dated score artifacts but requires the projection on the current alias target", async () => {
    const root = await makeRoot();
    const datasetsDir = path.join(root, "datasets");
    const topicDir = path.join(datasetsDir, "scores-latest");
    await mkdir(topicDir, { recursive: true });
    const redirectsPath = await writeTopicRedirects(root, "scores-latest");
    const rows = Array.from({ length: 493 }, (_, index) => ({ stablecoinId: `coin-${index}` }));
    await writeFile(path.join(topicDir, "2026-05-16.csv"), "# Pharos pharos.watch\nstablecoinId\n");
    await writeFile(
      path.join(topicDir, "2026-05-16.ndjson"),
      '{"_meta":{"endpoint":"scores-latest"}}\n',
    );
    await writeFile(
      path.join(topicDir, "2026-05-16.json"),
      JSON.stringify({ _meta: { endpoint: "scores-latest", rowCount: 493 }, rows }, null, 2),
    );
    expect(testExports.checkTopic("scores-latest", artifactDirs(datasetsDir, redirectsPath))).toEqual({
      ok: false,
      reason: expect.stringContaining("displayProjection is missing or invalid"),
    });

    const projection = {
      version: 2,
      snapshotDate: "2026-05-16",
      capturedAtSec: 1_779_000_000,
      sourceSnapshotPath: "/api/snapshots/2026-05-16.json",
      safety: null,
      safetyUnavailableReason: "legacy-source-metadata-unavailable",
      openEvidence: null,
      openEvidenceUnavailableReason: "safety-publication-unavailable",
    };
    await writeFile(
      path.join(topicDir, "2026-05-16.json"),
      JSON.stringify({ _meta: { endpoint: "scores-latest", rowCount: 493, displayProjection: projection }, rows }, null, 2),
    );
    expect(testExports.checkTopic("scores-latest", artifactDirs(datasetsDir, redirectsPath))).toEqual({ ok: true });
    expect(testExports.validateScoresLatestDisplayProjection({
      ...projection,
      snapshotDate: "2026-05-15",
    }, "2026-05-16")).toEqual({ ok: false, reason: expect.stringContaining("expected 2026-05-16") });

    // A pre-v2 projection and a block that claims counts without a source are
    // integrity failures, not a silent return to the old contract.
    expect(testExports.validateScoresLatestDisplayProjection({ ...projection, version: 1 }, "2026-05-16"))
      .toEqual({ ok: false, reason: expect.stringContaining("displayProjection is missing or invalid") });
    expect(testExports.validateScoresLatestDisplayProjection({
      ...projection,
      openEvidence: { semantics: "open-question-v1", totals: { questions: 4, open: 1, issuer: 1, documentation: 1, obligations: 6 } },
    }, "2026-05-16")).toEqual({ ok: false, reason: expect.stringContaining("missing or invalid") });
    expect(testExports.validateScoresLatestDisplayProjection({
      ...projection,
      openEvidenceUnavailableReason: "open-evidence-unavailable",
    }, "2026-05-16")).toEqual({ ok: false, reason: expect.stringContaining("counts and their unavailable reason disagree") });
  });

  it("checks a generated v2 projection built from a schema-8 publication", async () => {
    const base = makeEnvelope("2026-05-16");
    const stablecoins = Array.from({ length: 493 }, (_, index) => ({
      ...base.stablecoins[0]!,
      id: `coin-${index}`,
      symbol: `S${index}`,
    }));
    const publication = makeReportCardsV9Response({
      cards: [makeV9Card({ id: "coin-0", score: 88, grade: "A+" })],
      openEvidence: makeOpenEvidence("coin-0"),
    });
    const spec = testExports.buildTopicSpecs({
      ...base,
      version: 2,
      stablecoins,
      safetyScoreIdentity: publication.safetyScoreIdentity,
      reportCards: publication,
    }, [], "2026-05-16").find((item) => item.topic === "scores-latest")!;
    const artifacts = testExports.buildTopicArtifacts(spec, "2026-05-16T10:00:00.000Z");

    const root = await makeRoot();
    const datasetsDir = path.join(root, "datasets");
    const topicDir = path.join(datasetsDir, "scores-latest");
    await mkdir(topicDir, { recursive: true });
    const redirectsPath = await writeTopicRedirects(root, "scores-latest");
    await writeFile(path.join(topicDir, "2026-05-16.csv"), artifacts.csv);
    await writeFile(path.join(topicDir, "2026-05-16.ndjson"), artifacts.ndjson);
    await writeFile(path.join(topicDir, "2026-05-16.json"), artifacts.json);

    expect(testExports.checkTopic("scores-latest", artifactDirs(datasetsDir, redirectsPath))).toEqual({ ok: true });
    const json = JSON.parse(artifacts.json);
    const ndjsonMeta = JSON.parse(artifacts.ndjson.split("\n")[0]!);
    expect(json._meta.displayProjection.openEvidence).toEqual({
      semantics: "open-question-v1",
      totals: { questions: 3, open: 1, issuer: 2, documentation: 0, obligations: 6 },
    });
    expect(json._meta.displayProjection.openEvidenceUnavailableReason).toBeNull();
    expect(ndjsonMeta._meta.displayProjection).toEqual(json._meta.displayProjection);
  });

  it("keeps a report9 publication without open-evidence counts visible as unavailable", () => {
    const envelope = makeCurrentEnvelope("2026-05-16");
    const spec = testExports.buildTopicSpecs({
      ...envelope,
      reportCards: {
        ...envelope.reportCards,
        openEvidence: null,
        openEvidenceUnavailableReason: "publication-predates-open-evidence",
      },
    }, [], "2026-05-16").find((item) => item.topic === "scores-latest")!;

    expect(spec.displayProjection).toMatchObject({
      version: 2,
      safety: expect.objectContaining({ asOfSec: envelope.reportCards.asOfSec }),
      openEvidence: null,
      openEvidenceUnavailableReason: "open-evidence-unavailable",
    });
  });

  it("projects peg metadata and methodology versions from the snapshot envelope", () => {
    const envelope = {
      ...makeEnvelope("2026-05-16"),
      methodologyVersions: { reportCard: "7.25", dews: "6.0", liquidityScore: "5.6" },
    };

    const specs = testExports.buildTopicSpecs(envelope, [], "2026-05-16", { historical: true });
    const pegRows = specs.find((spec) => spec.topic === "peg-mechanism-distribution")?.rows as Array<Record<string, unknown>>;

    expect(pegRows).toEqual([{
      mechanismArchetype: "fiat-cash",
      mechanismLabel: "Custodial Cash and Cash-Equivalents",
      pegReferenceId: "usdc-circle",
      jurisdiction: "United States",
      coinCount: 1,
    }]);
    expect(specs.find((spec) => spec.topic === "top-stablecoins")?.methodologyLabel).toBe("safety-score v7.25");
    expect(specs.find((spec) => spec.topic === "depeg-history")?.methodologyLabel).toBe(`depeg-dews ${DEPEG_DEWS_METHODOLOGY_VERSION_LABEL}`);
    expect(specs.find((spec) => spec.topic === "scores-latest")?.methodologyLabel).toBe(
      "safety-score v7.25 | dews v6.0 | liquidity v5.6",
    );
  });

  it("marks legacy peg metadata as approximated and warns explicitly", () => {
    const coin = makeEnvelope("2026-05-16").stablecoins[0]!;
    const { mechanismArchetype, pegReferenceId, jurisdiction, ...legacyCoin } = coin;
    void mechanismArchetype;
    void pegReferenceId;
    void jurisdiction;
    const envelope = { ...makeEnvelope("2026-05-16"), stablecoins: [legacyCoin] };
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const pegSpec = testExports
      .buildTopicSpecs(envelope, [], "2026-05-16", { historical: true })
      .find((spec) => spec.topic === "peg-mechanism-distribution");

    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("using current catalog metadata as an approximation"),
    );
    expect(pegSpec?.metadataStatus).toBe("approximated");
    expect(pegSpec?.metadataNote).toContain("legacy snapshot 2026-05-16");
    warning.mockRestore();
  });

  it("labels later recovery and worsened peaks as retrospective ledger state rather than the dated snapshot's as-of state", async () => {
    const snapshotClock = "2026-05-16T10:00:00.000Z";
    const envelope = { ...makeEnvelope("2026-05-16"), generatedAt: Date.parse(snapshotClock) / 1000 };
    const laterRecoveredEvent = {
      ...makeEvent(null),
      startedAt: Date.parse("2026-05-16T09:00:00Z") / 1000,
      endedAt: Date.parse("2026-05-18T09:00:00Z") / 1000,
      peakDeviationBps: 900,
      peakPrice: 0.91,
    };
    vi.mocked(depegSnapshot.readDepegEventSnapshot).mockReturnValue([laterRecoveredEvent, makeCoverageSentinel()]);
    mockFetchStrict([{ match: "https://api.example.test/api/snapshots/2026-05-16.json", body: envelope }]);
    const inputs = await loadPublicDatasetLiveInputs("https://api.example.test", "2026-05-16");
    const specs = testExports.buildTopicSpecs(inputs.envelope, inputs.depegEvents, inputs.effectiveSnapshotDate, {
      historical: true,
      depegCapture: inputs.depegCapture,
    });
    const spec = specs.find((spec) => spec.topic === "depeg-history")!;
    const artifacts = testExports.buildTopicArtifacts(spec, inputs.asOfISO);
    const json = JSON.parse(artifacts.json);
    const ndjsonMeta = JSON.parse(artifacts.ndjson.split("\n")[0]!);

    expect(json.rows).toEqual([expect.objectContaining({
      id: "42",
      endedAtISO: "2026-05-18T09:00:00.000Z",
      durationSec: 172800,
      recoveryPrice: 1,
      peakDeviationBps: 900,
      peakPrice: 0.91,
    })]);
    expect(json._meta).toMatchObject({
      asOfISO: inputs.depegCapture.observedAtISO,
      windowSnapshotAsOfISO: snapshotClock,
      sourceGeneration: inputs.depegCapture.captureId,
      sourceObservationStartedAtISO: inputs.depegCapture.observationStartedAtISO,
      methodologyLabel: "depeg-dews v7.0",
      freshnessContract: expect.stringContaining("retrospective windowed event history"),
    });
    expect(ndjsonMeta._meta).toMatchObject({
      asOfISO: inputs.depegCapture.observedAtISO,
      sourceGeneration: inputs.depegCapture.captureId,
      windowSnapshotAsOfISO: snapshotClock,
    });
    expect(JSON.parse(artifacts.ndjson.split("\n")[1]!).id).toBe("42");
    expect(artifacts.csv).toContain(`As of: ${inputs.depegCapture.observedAtISO}`);
    expect(artifacts.csv).toContain(`Source generation: ${inputs.depegCapture.captureId}`);
    expect(artifacts.csv).toContain("retrospective windowed event history");
    expect(artifacts.csv).not.toContain("point-in-time sample");
    const market = testExports.buildTopicArtifacts(specs.find((spec) => spec.topic === "top-stablecoins")!, inputs.asOfISO);
    expect(JSON.parse(market.json)._meta.asOfISO).toBe(snapshotClock);
  });

  it("refuses to publish depeg state without ledger-capture provenance", () => {
    const spec = testExports.buildTopicSpecs(makeEnvelope("2026-05-16"), [makeEvent(null)], "2026-05-16")
      .find((spec) => spec.topic === "depeg-history")!;
    expect(() => testExports.buildTopicArtifacts(spec, "2026-05-16T10:00:00.000Z")).toThrow(
      "require captured event-ledger provenance",
    );
  });

  it("loads depeg events from the full local shard corpus before projecting the rolling window", async () => {
    vi.mocked(depegSnapshot.readDepegEventSnapshot).mockRestore();
    const fetchMock = mockFetchStrict([
      { match: "https://api.example.test/api/snapshots/2026-05-16.json", body: makeEnvelope("2026-05-16") },
    ]);

    const inputs = await loadPublicDatasetLiveInputs("https://api.example.test", "2026-05-16");
    const rows = testExports.projectDepegHistory(inputs.depegEvents, inputs.effectiveSnapshotDate);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(inputs.depegEvents.length).toBeGreaterThan(1000);
    expect(rows.length).toBeGreaterThan(0);
  });


  it("does not drop confirmed depeg events that retain pendingReason provenance", () => {
    const rows = testExports.projectDepegHistory([makeEvent("low-confidence")], "2026-05-16");

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(42);
  });

  it("carries a reviewed audit dispute into the depeg-history rows", () => {
    const disputed = {
      ...makeEvent(null),
      provenance: { auditVerdict: "disputed" as const, pegScoreEligible: false, updatedAt: 1_792_568_092 },
    };

    expect(testExports.projectDepegHistory([disputed], "2026-05-16")[0]?.auditVerdict).toBe("disputed");
    expect(testExports.projectDepegHistory([makeEvent(null)], "2026-05-16")[0]?.auditVerdict).toBeNull();
  });

  it("requires a source shard for the requested snapshot year", () => {
    expect(() => testExports.validateDepegHistorySourceShard("2030-05-16")).toThrow(
      "no 2030 shard",
    );
  });

  it("includes only the independently specified 90-day UTC window boundaries", () => {
    const times = ["2026-02-14T23:59:59Z", "2026-02-15T00:00:00Z", "2026-02-15T00:00:01Z",
      "2026-05-16T23:59:58Z", "2026-05-16T23:59:59Z", "2026-05-17T00:00:00Z"];
    const events = times.map((time, id) => ({ ...makeEvent(null), id, startedAt: Date.parse(time) / 1000 }));
    expect(testExports.projectDepegHistory(events, "2026-05-16").map((row) => row.id)).toEqual([4, 3, 2, 1]);
    expect(() => testExports.validateDepegHistoryCoverage([events[1]!], "2026-05-16")).not.toThrow();
    expect(() => testExports.validateDepegHistoryCoverage([events[2]!], "2026-05-16")).toThrow("does not cover");
  });

  it("rejects empty live-backed dataset rows and checked artifacts", async () => {
    expect(() => testExports.validateTopicRowFloor("top-stablecoins", [])).toThrow("expected at least 493");

    const root = await makeRoot();
    const datasetsDir = path.join(root, "datasets");
    const topicDir = path.join(datasetsDir, "top-stablecoins");
    await mkdir(topicDir, { recursive: true });
    const redirectsPath = await writeTopicRedirects(root, "top-stablecoins");
    await writeFile(path.join(topicDir, "2026-05-16.csv"), "# Pharos pharos.watch\nid\n");
    await writeFile(
      path.join(topicDir, "2026-05-16.json"),
      JSON.stringify({ _meta: { endpoint: "top-stablecoins", rowCount: 0 }, rows: [] }, null, 2),
    );
    await writeFile(path.join(topicDir, "2026-05-16.ndjson"), '{"_meta":{"endpoint":"top-stablecoins"}}\n');

    expect(testExports.checkTopic("top-stablecoins", artifactDirs(datasetsDir, redirectsPath))).toEqual({
      ok: false,
      reason: expect.stringContaining("rowCount 0 below required floor 493"),
    });
  });

  it("rejects checked artifacts whose JSON rowCount does not match rows length", async () => {
    const root = await makeRoot();
    const datasetsDir = path.join(root, "datasets");
    const topicDir = path.join(datasetsDir, "depeg-history");
    await mkdir(topicDir, { recursive: true });
    const redirectsPath = await writeTopicRedirects(root, "depeg-history");
    await writeFile(path.join(topicDir, "2026-05-16.csv"), "# Pharos pharos.watch\nid\n");
    await writeFile(
      path.join(topicDir, "2026-05-16.json"),
      JSON.stringify({ _meta: { endpoint: "depeg-history", rowCount: 300 }, rows: [] }, null, 2),
    );
    await writeFile(path.join(topicDir, "2026-05-16.ndjson"), '{"_meta":{"endpoint":"depeg-history"}}\n');

    expect(testExports.checkTopic("depeg-history", artifactDirs(datasetsDir, redirectsPath))).toEqual({
      ok: false,
      reason: expect.stringContaining("rowCount 300 does not match rows length 0"),
    });
  });
});
