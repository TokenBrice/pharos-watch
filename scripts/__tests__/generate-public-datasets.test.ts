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

const { buildPublicDatasetCurrentModule, buildPublicDatasetRedirectBlock, buildTopicSpecs, buildTopicArtifacts, checkTopic, checkAllTopics, projectScoresLatest, projectDepegHistory, validateDepegHistorySourceShard, validateDepegHistoryCoverage, validateScoresLatestDisplayProjection, validateTopicRowFloor } = testExports;
const DATE = "2026-05-16";
const AS_OF = "2026-05-16T10:00:00.000Z";
const SNAPSHOT_URL = "https://api.example.test/api/snapshots/2026-05-16.json";
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

function artifactDirs(root: string) {
  return {
    datasetsDir: path.join(root, "public/datasets"),
    redirectsPath: path.join(root, "public/_redirects"),
    currentDatasetModulePath: path.join(root, "src/lib/datasets/public-dataset-current.ts"),
  };
}

async function writeArtifacts(
  dirs: ReturnType<typeof artifactDirs>, topic: string,
  artifacts: Record<string, string>, date = DATE,
) {
  const topicDir = path.join(dirs.datasetsDir, topic);
  await mkdir(topicDir, { recursive: true });
  for (const [extension, contents] of Object.entries(artifacts)) {
    await writeFile(path.join(topicDir, `${date}.${extension}`), contents);
  }
}

async function topicWorkspace(topic: string, rowCount: number, rows: unknown[]) {
  const dirs = await writeBundle(await makeRoot());
  await writeArtifacts(dirs, topic, { json: JSON.stringify({ _meta: { endpoint: topic, rowCount }, rows }, null, 2) });
  return dirs;
}

function legacyProjection(snapshotDate = DATE) {
  return {
    version: 2, snapshotDate, capturedAtSec: 1_779_000_000,
    sourceSnapshotPath: `/api/snapshots/${snapshotDate}.json`, safety: null,
    safetyUnavailableReason: "legacy-source-metadata-unavailable",
    openEvidence: null, openEvidenceUnavailableReason: "safety-publication-unavailable",
  };
}

async function writeBundle(root: string, date = DATE) {
  const dirs = artifactDirs(root);
  for (const file of [dirs.redirectsPath, dirs.currentDatasetModulePath]) await mkdir(path.dirname(file), { recursive: true });
  await writeFile(dirs.redirectsPath, buildPublicDatasetRedirectBlock(date));
  await writeFile(dirs.currentDatasetModulePath, buildPublicDatasetCurrentModule(date));
  for (const [topic, count] of [["top-stablecoins", 493], ["depeg-history", 0], ["scores-latest", 493], ["peg-mechanism-distribution", 99]] as const) {
    await writeArtifacts(dirs, topic, buildTopicArtifacts({
      topic, rows: Array.from({ length: count }, (_, id) => ({ id })),
      columns: [{ header: "id", accessor: (row) => row.id }], methodologyLabel: "fixture",
      displayProjection: legacyProjection(date),
    }, AS_OF), date);
  }
  return dirs;
}

function runGenerator(root: string, args: string[] = [], env: Partial<NodeJS.ProcessEnv> = {}) {
  return execFileAsync(process.execPath, ["--import", "tsx", "scripts/maintenance/generate-public-datasets.ts", ...args], {
    cwd: root, timeout: 15_000,
    env: { ...process.env, API_BASE_URL: "", SMOKE_API_BASE: "", PUBLIC_DATASETS_API_URL: "",
      PUBLIC_DATASETS_DATE: DATE, PUBLIC_DATASETS_REQUIRE_API: "", PUBLIC_DATASETS_ALLOW_STUB: "", PUBLIC_DATASETS_ALLOW_EXISTING_ON_FETCH_FAILURE: "",
      PAGES_RELEASE_ALLOW_EXISTING_DATA_ON_FETCH_FAILURE: "", ...env },
  });
}

function makeEnvelope(snapshotDate = DATE) {
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

// Nonzero documentation counts would also require matching documentationCauseGaps.
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

function makeCurrentEnvelope(snapshotDate = DATE) {
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

function withReport(reportCards: ReturnType<typeof makeReportCardsV9Response>) {
  return { ...makeCurrentEnvelope(), reportCards, safetyScoreIdentity: reportCards.safetyScoreIdentity };
}

type TopicInputs = Parameters<typeof buildTopicSpecs>;

function specFor(
  topic: string,
  envelope: TopicInputs[0] = makeEnvelope(),
  events: TopicInputs[1] = [],
  options: TopicInputs[3] = {},
) {
  return buildTopicSpecs(envelope, events, envelope?.snapshotDate ?? DATE, options)
    .find((spec) => spec.topic === topic)!;
}

const depegRows = (events: Parameters<typeof projectDepegHistory>[0]) => projectDepegHistory(events, DATE);
const parseLines = (text: string) => text.trim().split("\n").map((line) => JSON.parse(line));
const readMeta = (text: string) => JSON.parse(text.split("\n")[0]!);
const csvLines = (text: string) => text.trimEnd().split("\n").filter((line) => !line.startsWith("#"));
const artifactsFor = (spec: ReturnType<typeof specFor>) => buildTopicArtifacts(spec, AS_OF);
function render(spec: ReturnType<typeof specFor>, asOf = AS_OF) {
  const artifacts = buildTopicArtifacts(spec, asOf);
  return { artifacts, json: JSON.parse(artifacts.json), ndjsonMeta: readMeta(artifacts.ndjson) };
}
const loadInputs = () => loadPublicDatasetLiveInputs("https://api.example.test", DATE);

function makeEvent(pendingReason: string | null) {
  return {
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
  it("preserves supply null/zero and appends reason after existing columns", () => {
    const envelope = makeEnvelope();
    const base = envelope.stablecoins[0];
    envelope.stablecoins = [
      { ...base, id: "unknown", circulating: {} },
      { ...base, id: "zero", circulating: { peggedUSD: 0 } },
      { ...base, id: "known", circulating: { peggedUSD: 100 } },
    ];
    const spec = specFor("top-stablecoins", envelope);
    expect(spec.rows).toEqual([
      ["known", 100, null], ["zero", 0, null], ["unknown", null, "absent"],
    ].map(([id, circulatingUsd, supplyUnavailableReason]) => expect.objectContaining({ id, circulatingUsd, supplyUnavailableReason })));
    const { artifacts, json } = render(spec);
    expect(json.data ?? json.rows).toEqual(spec.rows);
    const lines = parseLines(artifacts.ndjson);
    expect(lines).toContainEqual(expect.objectContaining({ id: "unknown", circulatingUsd: null, supplyUnavailableReason: "absent" }));
    const csv = csvLines(artifacts.csv);
    expect(csv[0].split(",")).toEqual([
      "id", "symbol", "name", "pegType", "pegMechanism", "price", "circulatingUsd",
      "chainCount", "chains", "supplyUnavailableReason", "supplyProvenance",
    ]);
    for (const [id, supply, reason] of [["unknown", "", "absent"], ["zero", "0", ""]]) {
      expect(csv.find((line) => line.startsWith(`${id},`))?.split(",")).toEqual([
        id, "USDC", "USD Coin", "peggedUSD", "fiat-backed", "1", supply, "1", "ethereum", reason, "",
      ]);
    }
  });

  it.each([
    { label: "string 6.57", versions: { pricingPipeline: "6.57" }, recorded: true },
    { label: "string 6.55", versions: { pricingPipeline: "6.55" }, recorded: true },
    { label: "pre-guard 6.54", versions: { pricingPipeline: "6.54" }, recorded: false },
    { label: "missing Pricing key", versions: { safetyScore: "10.34" }, recorded: false },
    { label: "malformed version", versions: { pricingPipeline: "six" }, recorded: false },
  ])("records guard-less provenance only on guard-capable envelopes ($label) (K-031)", ({ versions, recorded }) => {
    const envelope = makeEnvelope();
    envelope.methodologyVersions = versions;
    const base = envelope.stablecoins[0];
    envelope.stablecoins = [{ ...base, circulating: { peggedUSD: 100 }, supplySource: "defillama" } as typeof base];
    const spec = specFor("top-stablecoins", envelope);
    expect(spec.rows[0]).toMatchObject({
      supplyProvenance: recorded ? { supplySource: "defillama", supplyObservedAt: null, supplyChainGuard: null } : null,
    });
  });

  it("preserves legacy partial guards and clocks in all formats", () => {
    const envelope = makeEnvelope();
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
    const spec = specFor("top-stablecoins", envelope);
    const expected = { supplySource: null, supplyObservedAt: 1_778_990_000, supplyChainGuard: guard };
    expect(spec.rows[0]).toMatchObject({ circulatingUsd: 97_000, supplyProvenance: expected });
    const { artifacts, json } = render(spec);
    expect((json.data ?? json.rows)[0].supplyProvenance).toEqual(expected);
    const row = parseLines(artifacts.ndjson).find((line) => line.id === "usdc-circle");
    expect(row.supplyProvenance).toEqual(expected);
    expect(artifacts.csv).toContain(`"${JSON.stringify(row.supplyProvenance).replace(/"/g, '""')}"`);
  });

  it.each([
    {
      topic: "depeg-history",
      header: "id,stablecoinId,symbol,direction,peakDeviationBps,startedAtISO,endedAtISO,durationSec,startPrice,peakPrice,recoveryPrice,pegReference,source,auditVerdict,retired",
    },
    {
      topic: "scores-latest",
      header: "stablecoinId,symbol,pegScore,safetyScore,safetyGrade,dewsScore,dewsBand,liquidityScore,coverageClass,ratingStatus,safetyDisplay,dewsComputedAt,liquidityUpdatedAt,liquidityUnavailableReason,liquidityMethodologyVersion",
    },
    {
      topic: "peg-mechanism-distribution",
      header: "mechanismArchetype,mechanismLabel,pegReferenceId,jurisdiction,coinCount",
    },
  ])("preserves $topic CSV column order", ({ topic, header }) => {
    const specs = buildTopicSpecs(makeEnvelope(), [makeEvent(null)], DATE, { depegCapture: makeCapture(1) });
    const spec = specs.find((item) => item.topic === topic)!;
    const artifacts = artifactsFor(spec);
    expect(csvLines(artifacts.csv)[0]).toBe(header);
  });

  it("rewrites latest and Sheets aliases directly with status 200", () => {
    const block = buildPublicDatasetRedirectBlock("2026-07-08");

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

  it.each([
    ["uses today's sealed snapshot", false],
    ["uses the latest sealed snapshot before today is sealed", true],
  ] as const)("%s", async (_, fallback) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-16T12:30:00.000Z"));
    mockFetchStrict([
      { match: SNAPSHOT_URL, body: fallback ? { error: "not found" } : makeEnvelope(), status: fallback ? 404 : 200 },
      ...(fallback ? [
        { match: "https://api.example.test/api/snapshots/index", body: { snapshots: [{ snapshotDate: "2026-05-15" }] } },
        { match: "https://api.example.test/api/snapshots/2026-05-15.json", body: makeEnvelope("2026-05-15") },
      ] : []),
    ]);
    const inputs = await loadInputs();
    expect(inputs.effectiveSnapshotDate).toBe(fallback ? "2026-05-15" : "2026-05-16");
    if (fallback) {
      const specs = buildTopicSpecs(inputs.envelope, inputs.depegEvents, inputs.effectiveSnapshotDate, { historical: false });
      expect(inputs.asOfISO).toBe("2026-05-17T06:40:00.000Z");
      expect(specs.find((spec) => spec.topic === "top-stablecoins")?.rows).toHaveLength(1);
      expect(specs.find((spec) => spec.topic === "depeg-history")?.rows.length).toBeGreaterThan(0);
    } else expect(inputs.envelope.snapshotDate).toBe("2026-05-16");
  });

  it.each([
    ["rejects current generation without a sealed snapshot", "2026-05-16", false,
      "today's snapshot or the latest sealed snapshot"],
    ["requires the exact historical snapshot", "2026-05-18", false, "the exact dated snapshot"],
    ["rejects fetched snapshots outside the envelope schema", "2026-05-18", true, "the exact dated snapshot"],
  ] as const)("%s", async (_, today, malformed, reason) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${today}T12:30:00Z`));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockFetchStrict([
      { match: SNAPSHOT_URL, body: malformed ? { ...makeEnvelope(), stablecoins: "not-an-array" } : { error: "not found" }, status: malformed ? 200 : 404 },
      ...(today === DATE ? [{ match: "https://api.example.test/api/snapshots/index", body: { error: "not found" }, status: 404 }] : []),
    ]);
    await expect(loadInputs()).rejects.toThrow(`API-backed public dataset generation requires ${reason}`);
    if (malformed) expect(warning).toHaveBeenCalledWith(expect.stringContaining("invalid public snapshot envelope"));
  });

  it("fetches release inputs through site-data without service credentials", async () => {
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
      respond: () => ({ body: makeEnvelope() }),
    }], { requireMatch: true });

    const inputs = await loadPublicDatasetLiveInputs("https://stablecoin-dashboard.pages.dev/_site-data", "2026-05-16");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://stablecoin-dashboard.pages.dev/_site-data/snapshots/2026-05-16.json",
      expect.anything(),
    );
    expect(inputs.effectiveSnapshotDate).toBe("2026-05-16");
    expect(inputs.depegEvents.map((event) => event.id)).toEqual([42, 43]);
  });

  it.each([
    ["keeps legacy Safety scores separate from peg scores",
      { score: 88, grade: "B" }, { pegScore: null, safetyScore: 88, safetyGrade: "B" }],
    ["prefers explicit Safety scores over legacy aliases",
      { safetyScore: 0, score: 88, overall: 99, safetyGrade: "F", grade: "A" }, { stablecoinId: "usdc-circle", safetyScore: 0, safetyGrade: "F" }],
  ] as const)("%s", (_, scores, expected) => {
    const rows = specFor("scores-latest", { ...makeEnvelope(), reportCards: { scores: { "usdc-circle": scores } } }).rows;
    expect(rows).toEqual([expect.objectContaining(expected)]);
  });

  it("sorts zero ahead of missing scores and ignores unmatched joins", () => {
    const base = makeEnvelope();
    const envelope = {
      ...base,
      stablecoins: ["missing", "zero", "high"].map((id) => ({ ...base.stablecoins[0]!, id })),
      reportCards: { cards: [{ id: "zero", score: 0, grade: "F" }, { id: "high", score: 88, grade: "B" }] },
      dews: [{ stablecoinId: "high", score: 4, band: "normal" }, { stablecoinId: "unmatched", score: 99, band: "danger" }],
      liquidity: [{ stablecoinId: "zero", liquidityScore: 0, coverageClass: "thin" }],
    };
    const rows = specFor("scores-latest", envelope)?.rows;
    const empty = {
      symbol: "USDC", pegScore: null, safetyScore: null, safetyGrade: null, dewsScore: null, dewsBand: null,
      liquidityScore: null, coverageClass: null, ratingStatus: null, safetyDisplay: null, dewsComputedAt: null,
      liquidityUpdatedAt: null, liquidityUnavailableReason: null, liquidityMethodologyVersion: null,
    };
    expect(rows).toEqual([
      { ...empty, stablecoinId: "high", safetyScore: 88, safetyGrade: "B", dewsScore: 4, dewsBand: "normal" },
      { ...empty, stablecoinId: "zero", safetyScore: 0, safetyGrade: "F", liquidityScore: 0, coverageClass: "thin" },
      { ...empty, stablecoinId: "missing" },
    ]);
  });

  it("emits JSON/NDJSON projection and one CSV preamble", () => {
    const envelope = makeCurrentEnvelope();
    const spec = specFor("scores-latest", envelope);

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

    const { artifacts, json, ndjsonMeta } = render(spec);
    expect(json._meta.asOfISO).toBe(AS_OF);
    expect(json._meta.displayProjection).toEqual(spec.displayProjection);
    expect(ndjsonMeta._meta.displayProjection).toEqual(spec.displayProjection);
    // A second comment would collapse Sheets IMPORTDATA into one cell.
    expect(artifacts.csv.split("\n").filter((line) => line.startsWith("#"))).toHaveLength(1);
    expect(artifacts.csv).not.toContain("Display projection");
    expect(artifacts.csv).not.toContain('"version":2');
    expect(csvLines(artifacts.csv)[0]?.split(",")).toEqual(
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

  it("retains rated cards with missing market/liquidity data", () => {
    const response = makeReportCardsV9Response({
      cards: [
        makeV9Card({ id: "usdc-circle", score: 88, grade: "A+" }),
        makeV9Card({ id: "usdt-tether", score: 86, grade: "A" }),
      ],
    });
    const envelope = withReport(response);
    const rows = specFor("scores-latest", envelope)?.rows as Array<Record<string, unknown>>;

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

  it("preserves liquidity rejection reasons and methodology versions", () => {
    const envelope = makeCurrentEnvelope();
    const row = projectScoresLatest({
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

  it("rejects accepted IDs absent from market and registry", () => {
    const response = makeReportCardsV9Response({
      cards: [makeV9Card({ id: "ghost-coin", score: 88, grade: "A+" })],
    });
    const envelope = withReport(response);
    expect(() => buildTopicSpecs(envelope, [], DATE)).toThrow(
      "neither a market row nor a tracked registry identity",
    );
  });

  it("rejects Safety identity mismatches and future publication clocks", () => {
    const envelope = makeCurrentEnvelope();
    expect(() => projectScoresLatest({
      ...envelope,
      safetyScoreIdentity: {
        ...envelope.reportCards.safetyScoreIdentity,
        publicationGenerationId: "another-publication",
      },
    })).toThrow("identity does not match");
    expect(() => projectScoresLatest({
      ...envelope,
      generatedAt: envelope.reportCards.updatedAt - 1,
    })).toThrow("clocks do not precede the snapshot collection clock");
  });

  it("preserves pipeline gaps and grade holds without NR/provisional", () => {
    const gradeHold = { rawGrade: "A", heldFromGenerationId: "v9-publication-prior" } as const;
    for (const [card, expected, held] of [
      [makeReportCardsV9PipelineGapCard("control", "A", { id: "usdc-circle" }), {
        safetyScore: null, safetyGrade: null, ratingStatus: "pipeline-gap",
        safetyDisplay: { partialEvidence: expect.objectContaining({ reasonCode: "partial-evidence-pipeline-gap" }) },
      }, false],
      [makeV9Card({ id: "usdc-circle", score: 84, grade: "A-", gradeHold }), {
        safetyScore: 84, safetyGrade: "A-", safetyDisplay: { gradeHold },
      }, true],
    ] as const) {
      const row = projectScoresLatest(withReport(makeReportCardsV9Response({ cards: [card] }))).rows[0]!;
      expect(row).toMatchObject(expected);
      if (held) expect(row.safetyDisplay).not.toHaveProperty("provisional");
    }
  });

  it.each([
    ["exports legacy-unavailable metadata for old envelopes", false],
    ["marks unsupported historical Safety schemas unavailable", true],
  ] as const)("%s", (_, historical) => {
    const base = makeCurrentEnvelope();
    const spec = specFor("scores-latest", historical
      ? { ...base, reportCards: { ...base.reportCards, schemaVersion: 7 } } : makeEnvelope(), [], { historical });
    if (historical) {
      expect(spec.displayProjection).toMatchObject({ safety: null, safetyUnavailableReason: "legacy-source-metadata-unavailable",
        openEvidence: null, openEvidenceUnavailableReason: "safety-publication-unavailable" });
      expect(spec.rows[0]).toMatchObject({ ratingStatus: null, safetyScore: 88 });
    } else {
      expect(spec.displayProjection).toEqual(legacyProjection());
      expect(spec.rows[0]).toMatchObject({ ratingStatus: null, safetyDisplay: null, liquidityUnavailableReason: null });
    }
  });

  it("retains report8 archive facts on historical dates only", () => {
    const envelope = makeCurrentEnvelope();
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
    const spec = specFor("scores-latest", archivedEnvelope, undefined, { historical: true });

    expect(spec.displayProjection).toMatchObject({
      version: 2,
      safety: {
        asOfSec: envelope.reportCards.asOfSec,
        publishedAtSec: envelope.reportCards.updatedAt,
        completeness: envelope.reportCards.completeness,
      },
      safetyUnavailableReason: null,
      openEvidence: null,
      openEvidenceUnavailableReason: "open-evidence-unavailable",
    });
    expect(spec.rows[0]).toMatchObject({
      stablecoinId: "usdc-circle",
      symbol: "USDC",
      safetyScore: 88,
      safetyGrade: "A+",
      ratingStatus: "rated",
      dewsScore: 4,
      safetyDisplay: { nrReasons: [], reasonCodes: [], partialEvidence: null },
    });

    expect(() => projectScoresLatest(archivedEnvelope, { historical: false }))
      .toThrow("invalid V9 Safety publication");
  });

  it("requires a valid projection on the current scores alias", async () => {
    const rows = Array.from({ length: 493 }, (_, index) => ({ stablecoinId: `coin-${index}` }));
    const dirs = await topicWorkspace("scores-latest", 493, rows);
    expect(checkTopic("scores-latest", dirs)).toEqual({
      ok: false, reason: expect.stringContaining("displayProjection is missing or invalid"),
    });

    const projection = legacyProjection();
    await writeArtifacts(dirs, "scores-latest", {
      json: JSON.stringify({ _meta: { endpoint: "scores-latest", rowCount: 493, displayProjection: projection }, rows }, null, 2),
    });
    expect(checkTopic("scores-latest", dirs)).toEqual({ ok: true });
    for (const [patch, reason] of [
      [{ snapshotDate: "2026-05-15" }, "expected 2026-05-16"],
      [{ version: 1 }, "displayProjection is missing or invalid"],
      [{ openEvidence: { semantics: "open-question-v1", totals: { questions: 4, open: 1, issuer: 1, documentation: 1, obligations: 6 } } }, "missing or invalid"],
      [{ openEvidenceUnavailableReason: "open-evidence-unavailable" }, "counts and their unavailable reason disagree"],
    ]) {
      expect(validateScoresLatestDisplayProjection({ ...projection, ...patch as object }, DATE))
        .toEqual({ ok: false, reason: expect.stringContaining(reason as string) });
    }
  });

  it("checks generated v2 projection and open-evidence counts", async () => {
    const base = makeEnvelope();
    const stablecoins = Array.from({ length: 493 }, (_, index) => ({
      ...base.stablecoins[0]!,
      id: `coin-${index}`,
      symbol: `S${index}`,
    }));
    const publication = makeReportCardsV9Response({
      cards: [makeV9Card({ id: "coin-0", score: 88, grade: "A+" })],
      openEvidence: makeOpenEvidence("coin-0"),
    });
    const spec = specFor("scores-latest", {
      ...base,
      version: 2,
      stablecoins,
      safetyScoreIdentity: publication.safetyScoreIdentity,
      reportCards: publication,
    });
    const artifacts = artifactsFor(spec);

    const dirs = await writeBundle(await makeRoot());
    await writeArtifacts(dirs, "scores-latest", artifacts);
    expect(checkTopic("scores-latest", dirs)).toEqual({ ok: true });
    const json = JSON.parse(artifacts.json);
    const ndjsonMeta = readMeta(artifacts.ndjson);
    expect(json._meta.displayProjection.openEvidence).toEqual({
      semantics: "open-question-v1",
      totals: { questions: 3, open: 1, issuer: 2, documentation: 0, obligations: 6 },
    });
    expect(json._meta.displayProjection.openEvidenceUnavailableReason).toBeNull();
    expect(ndjsonMeta._meta.displayProjection).toEqual(json._meta.displayProjection);
  });

  it.each([
    ["projects report9 without an open-evidence block", false],
    ["marks explicit report9 missing counts unavailable", true],
  ] as const)("%s", (_, explicit) => {
    const envelope = makeCurrentEnvelope();
    const reportCards = explicit
      ? { ...envelope.reportCards, openEvidence: null, openEvidenceUnavailableReason: "publication-predates-open-evidence" as const }
      : makeReportCardsV9Response({ cards: [makeV9Card({ id: "usdc-circle", score: 88, grade: "A+" })] });
    const spec = specFor("scores-latest", withReport(reportCards));
    expect(spec.rows[0]).toMatchObject({ stablecoinId: "usdc-circle", safetyScore: 88, safetyGrade: "A+" });
    expect(spec.displayProjection).toMatchObject({
      version: 2, openEvidence: null, openEvidenceUnavailableReason: "open-evidence-unavailable",
      ...(explicit ? { safety: expect.objectContaining({ asOfSec: envelope.reportCards.asOfSec }) } : {}),
    });
  });

  it("projects envelope peg metadata and methodology", () => {
    const envelope = {
      ...makeEnvelope(),
      methodologyVersions: { reportCard: "7.25", dews: "6.0", liquidityScore: "5.6" },
    };

    const specs = buildTopicSpecs(envelope, [], "2026-05-16", { historical: true });
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

  it("warns on approximated legacy peg metadata", () => {
    const coin = makeEnvelope().stablecoins[0]!;
    const { mechanismArchetype, pegReferenceId, jurisdiction, ...legacyCoin } = coin;
    void mechanismArchetype;
    void pegReferenceId;
    void jurisdiction;
    const envelope = { ...makeEnvelope(), stablecoins: [legacyCoin] };
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const pegSpec = specFor("peg-mechanism-distribution", envelope, undefined, { historical: true });

    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("using current catalog metadata as an approximation"),
    );
    expect(pegSpec?.metadataStatus).toBe("approximated");
    expect(pegSpec?.metadataNote).toContain("legacy snapshot 2026-05-16");
    warning.mockRestore();
  });

  it("exports later depeg revisions with ledger provenance", async () => {
    const snapshotClock = AS_OF;
    const envelope = { ...makeEnvelope(), generatedAt: Date.parse(snapshotClock) / 1000 };
    const laterRecoveredEvent = {
      ...makeEvent(null),
      startedAt: Date.parse("2026-05-16T09:00:00Z") / 1000,
      endedAt: Date.parse("2026-05-18T09:00:00Z") / 1000,
      peakDeviationBps: 900,
      peakPrice: 0.91,
    };
    vi.mocked(depegSnapshot.readDepegEventSnapshot).mockReturnValue([laterRecoveredEvent, makeCoverageSentinel()]);
    mockFetchStrict([{ match: SNAPSHOT_URL, body: envelope }]);
    const inputs = await loadInputs();
    const specs = buildTopicSpecs(inputs.envelope, inputs.depegEvents, inputs.effectiveSnapshotDate, {
      historical: true,
      depegCapture: inputs.depegCapture,
    });
    const spec = specs.find((spec) => spec.topic === "depeg-history")!;
    const { artifacts, json, ndjsonMeta } = render(spec, inputs.asOfISO);

    expect(json.rows).toEqual([expect.objectContaining({
      id: "42",
      endedAtISO: "2026-05-18T09:00:00.000Z",
      durationSec: 172800,
      recoveryPrice: 1,
      peakDeviationBps: 900,
      peakPrice: 0.91,
    })]);
    const ledgerMeta = {
      asOfISO: inputs.depegCapture.observedAtISO, sourceGeneration: inputs.depegCapture.captureId,
      windowSnapshotAsOfISO: snapshotClock,
    };
    expect(json._meta).toMatchObject({
      ...ledgerMeta, sourceObservationStartedAtISO: inputs.depegCapture.observationStartedAtISO,
      methodologyLabel: "depeg-dews v7.0", freshnessContract: expect.stringContaining("retrospective windowed event history"),
    });
    expect(ndjsonMeta._meta).toMatchObject(ledgerMeta);
    expect(JSON.parse(artifacts.ndjson.split("\n")[1]!).id).toBe("42");
    expect(artifacts.csv).toContain(`As of: ${inputs.depegCapture.observedAtISO}`);
    expect(artifacts.csv).toContain(`Source generation: ${inputs.depegCapture.captureId}`);
    expect(artifacts.csv).toContain("retrospective windowed event history");
    expect(artifacts.csv).not.toContain("point-in-time sample");
    const market = buildTopicArtifacts(specs.find((spec) => spec.topic === "top-stablecoins")!, inputs.asOfISO);
    expect(JSON.parse(market.json)._meta.asOfISO).toBe(snapshotClock);
  });

  it("rejects depeg exports without ledger provenance", () => {
    const spec = specFor("depeg-history", undefined, [makeEvent(null)]);
    expect(() => artifactsFor(spec)).toThrow(
      "require captured event-ledger provenance",
    );
  });

  it("loads full local shards before filtering the depeg window", async () => {
    vi.mocked(depegSnapshot.readDepegEventSnapshot).mockRestore();
    const fetchMock = mockFetchStrict([
      { match: SNAPSHOT_URL, body: makeEnvelope() },
    ]);

    const inputs = await loadInputs();
    const rows = projectDepegHistory(inputs.depegEvents, inputs.effectiveSnapshotDate);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(inputs.depegEvents.length).toBeGreaterThan(1000);
    expect(rows.length).toBeGreaterThan(0);
  });


  it("retains confirmed depegs with pendingReason provenance", () => {
    const rows = depegRows([makeEvent("low-confidence")]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(42);
  });

  it.each([
    ["exports reviewed depeg disputes", "auditVerdict", "disputed", null,
      { provenance: { auditVerdict: "disputed" as const, pegScoreEligible: false, updatedAt: 1_792_568_092 } }],
    ["exports depeg retirement in rows and columns", "retired", true, false,
      { stablecoinId: "bean-beanstalk", symbol: "BEAN", retired: true as const }],
  ] as const)("%s", (_, field, present, absent, patch) => {
    const event = { ...makeEvent(null), ...patch };
    expect(depegRows([event])[0]?.[field]).toBe(present);
    expect(depegRows([makeEvent(null)])[0]?.[field]).toBe(absent);
    if (field === "retired") {
      const artifacts = artifactsFor(specFor("depeg-history", undefined, [event], { depegCapture: makeCapture(1) }));
      expect(JSON.parse(artifacts.json).rows[0].retired).toBe(true);
      expect(artifacts.csv.split("\n")[1]).toContain("retired");
      expect(artifacts.csv).toContain(",true\n");
    }
  });

  it("requires the requested-year source shard", () => {
    expect(() => validateDepegHistorySourceShard("2030-05-16")).toThrow(
      "no 2030 shard",
    );
  });

  it("enforces independent 90-day UTC window boundaries", () => {
    const times = ["2026-02-14T23:59:59Z", "2026-02-15T00:00:00Z", "2026-02-15T00:00:01Z",
      "2026-05-16T23:59:58Z", "2026-05-16T23:59:59Z", "2026-05-17T00:00:00Z"];
    const events = times.map((time, id) => ({ ...makeEvent(null), id, startedAt: Date.parse(time) / 1000 }));
    expect(depegRows(events).map((row) => row.id)).toEqual([4, 3, 2, 1]);
    expect(() => validateDepegHistoryCoverage([events[1]!], "2026-05-16")).not.toThrow();
    expect(() => validateDepegHistoryCoverage([events[2]!], "2026-05-16")).toThrow("does not cover");
  });

  it.each([
    ["rejects empty live rows and checked artifacts", "top-stablecoins", 0,
      "rowCount 0 below required floor 493"],
    ["rejects rowCount/rows mismatches", "depeg-history", 300,
      "rowCount 300 does not match rows length 0"],
  ] as const)("%s", async (_, topic, count, reason) => {
    expect(() => validateTopicRowFloor("top-stablecoins", [])).toThrow("expected at least 493");
    const dirs = await topicWorkspace(topic, count, []);
    for (const mode of [false, true]) expect(checkAllTopics(dirs, mode)).toEqual({ ok: false, reason: expect.stringContaining(reason) });
  });
});


describe("PR mirror integrity mode", () => {
  it.each([
    [DATE, 0, true], [DATE, 2, true], [DATE, 3, true],
    ["2026-02-30", 0, false], ["2026-13-01", 0, false], ["2026-05-17", 0, false],
  ] as const)("checks %s at age %s without writing", async (date, age, valid) => {
    const root = await makeRoot();
    const dirs = await writeBundle(root, date);
    const before = await datasetBytes(root);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse("2026-05-16T12:00:00Z") + age * 86_400_000));
    expect(checkAllTopics(dirs).ok).toBe(valid && age <= 2);
    expect(checkAllTopics(dirs, true).ok).toBe(valid);
    if (!valid) for (const mode of [false, true]) expect(checkAllTopics(dirs, mode).reason).toContain("valid non-future");
    expect(await datasetBytes(root)).toEqual(before);
  });

  it.each([
    ["redirect", "redirects", " 200\n", " 301\n", "200 rewrite"],
    ["Sheets chain", "redirects", "/sheets/top-stablecoins.csv /datasets/top-stablecoins/2026-05-16.csv", "/sheets/top-stablecoins.csv /datasets/top-stablecoins/latest.csv", "rewrite directly"],
    ...["csv", "json", "ndjson"].map((ext) => [`${ext} preamble`, ext, "", "broken", "missing preamble"] as const),
    ["rowCount type", "json", '"rowCount": 493', '"rowCount": "493"', "numeric _meta.rowCount"],
    ["projection", "scores", '"version": 2', '"version": 1', "displayProjection"],
    ["module mismatch", "module", "", "wrong", "does not match"],
    ["module missing", "module", "", null, "missing"],
    ["artifact missing", "csv", "", null, "missing"],
  ] as const)("retains %s validation in both modes", async (_, file, from, to, reason) => {
    const root = await makeRoot();
    const dirs = await writeBundle(root);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-16T12:00:00Z"));
    const target = file === "redirects" ? dirs.redirectsPath : file === "module" ? dirs.currentDatasetModulePath
      : path.join(dirs.datasetsDir, file === "scores" ? "scores-latest" : "top-stablecoins", `${DATE}.${file === "scores" ? "json" : file}`);
    if (to === null) await rm(target);
    else await writeFile(target, from ? (await readFile(target, "utf8")).replace(from, to) : to);
    for (const mode of [false, true]) expect(checkAllTopics(dirs, mode)).toMatchObject({ ok: false, reason: expect.stringContaining(reason) });
  });

  it("keeps CLI checks read-only and generation/fallback strict", async () => {
    const root = await makeRoot();
    await copyDatasetWorkspace(root);
    const dirs = await writeBundle(root, "2000-01-01");
    expect(checkAllTopics(dirs, true)).toEqual({ ok: true });
    expect(checkAllTopics(dirs).reason).toContain("no more than 2 days old");
    const before = await datasetBytes(root);
    const checked = await runGenerator(root, ["--check", "--integrity-only"]);
    expect(checked.stdout).toContain("integrity passed");
    expect(checked.stdout).not.toContain("are current");
    for (const [args, env, reason] of [
      [["--integrity-only"], {}, "requires --check"],
      [["--check"], {}, "no more than 2 days old"],
      [[], { PUBLIC_DATASETS_REQUIRE_API: "1" }, "No public dataset API source configured"],
      [[], {}, "no more than 2 days old"],
      [[], { PUBLIC_DATASETS_API_URL: "http://127.0.0.1:9", PAGES_RELEASE_ALLOW_EXISTING_DATA_ON_FETCH_FAILURE: "1" }, "checked-in mirrors are not current: .*no more than 2 days old"],
    ] as const) {
      await expect(runGenerator(root, [...args], env)).rejects.toMatchObject({ code: 1, stderr: expect.stringMatching(reason) });
      expect(await datasetBytes(root)).toEqual(before);
    }
  });
});
