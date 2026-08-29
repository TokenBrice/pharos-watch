import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch, mockFetchStrict } from "@shared/test-utils/mock-fetch";

import { loadPublicDatasetLiveInputs, testExports } from "../maintenance/generate-public-datasets";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
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
        circulating: { ethereum: 1_000_000 },
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

function makeEvent(pendingReason: string | null) {
  return {
    id: 42,
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

function makeCoverageSentinel(snapshotDate: string) {
  return {
    ...makeEvent(null),
    id: 43,
    startedAt: testExports.cutoffSecForSnapshotDate(snapshotDate) - 60,
  };
}

describe("generate-public-datasets", () => {
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
    const { stderr } = await execFileAsync(
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
    ).catch((error: unknown) => {
      const err = error as { stderr?: string };
      return { stderr: err.stderr ?? "" };
    });

    expect(stderr).toContain("No public dataset API source configured");
  });

  it("preserves checked-in mirrors during release when the configured live source is blocked", async () => {
    const { stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "scripts/maintenance/generate-public-datasets.ts"],
      {
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
    );

    expect(stderr).toContain("preserving checked-in public dataset mirrors");
  });

  it("uses today's immutable snapshot when it is already sealed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-16T12:30:00.000Z"));
    mockFetchStrict([
      { match: "https://api.example.test/api/snapshots/2026-05-16.json", body: makeEnvelope("2026-05-16") },
      {
        match: "https://api.example.test/api/depeg-events?limit=1000",
        body: { events: [makeEvent("large-cap"), makeCoverageSentinel("2026-05-16")] },
      },
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
      {
        match: "https://api.example.test/api/depeg-events?limit=1000",
        body: { events: [makeEvent("large-cap"), makeCoverageSentinel("2026-05-15")] },
      },
    ]);

    const inputs = await loadPublicDatasetLiveInputs("https://api.example.test", "2026-05-16");
    const specs = testExports.buildTopicSpecs(inputs.envelope, inputs.depegEvents, inputs.effectiveSnapshotDate, {
      historical: false,
    });

    expect(inputs.effectiveSnapshotDate).toBe("2026-05-15");
    expect(inputs.asOfISO).toBe("2026-05-17T06:40:00.000Z");
    expect(specs.find((spec) => spec.topic === "top-stablecoins")?.rows).toHaveLength(1);
    expect(specs.find((spec) => spec.topic === "depeg-history")?.rows).toHaveLength(1);
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
        return [
          "https://stablecoin-dashboard.pages.dev/_site-data/snapshots/2026-05-16.json",
          "https://stablecoin-dashboard.pages.dev/_site-data/depeg-events?limit=1000",
        ].includes(request.url);
      },
      respond: (request) => request.url.endsWith("/_site-data/snapshots/2026-05-16.json")
        ? { body: makeEnvelope("2026-05-16") }
        : { body: { events: [makeEvent("large-cap"), makeCoverageSentinel("2026-05-16")] } },
    }], { requireMatch: true });

    const inputs = await loadPublicDatasetLiveInputs("https://stablecoin-dashboard.pages.dev/_site-data", "2026-05-16");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://stablecoin-dashboard.pages.dev/_site-data/snapshots/2026-05-16.json",
      expect.anything(),
    );
    expect(inputs.effectiveSnapshotDate).toBe("2026-05-16");
    expect(inputs.depegEvents).toHaveLength(2);
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
    expect(specs.find((spec) => spec.topic === "depeg-history")?.methodologyLabel).toBe("depeg-dews v6.0");
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

  it("paginates depeg events to exhaustion before projecting the rolling window", async () => {
    const oldEvent = {
      ...makeEvent(null),
      id: 2,
      startedAt: testExports.cutoffSecForSnapshotDate("2026-05-16") - 60,
    };
    const fetchMock = mockFetchStrict([
      { match: "https://api.example.test/api/snapshots/2026-05-16.json", body: makeEnvelope("2026-05-16") },
      { match: "https://api.example.test/api/depeg-events?limit=1000", body: { events: [makeEvent(null)], nextCursor: "page-2" } },
      { match: "https://api.example.test/api/depeg-events?limit=1000&cursor=page-2", body: { events: [oldEvent], nextCursor: "page-3" } },
      { match: "https://api.example.test/api/depeg-events?limit=1000&cursor=page-3", body: { events: [] } },
    ]);

    const inputs = await loadPublicDatasetLiveInputs("https://api.example.test", "2026-05-16");
    const rows = testExports.projectDepegHistory(inputs.depegEvents, inputs.effectiveSnapshotDate);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/api/depeg-events?limit=1000&cursor=page-2",
      expect.anything(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/api/depeg-events?limit=1000&cursor=page-3",
      expect.anything(),
    );
    expect(inputs.depegEvents).toHaveLength(2);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(42);
  });

  it("does not treat an old projected timestamp as the raw-order pagination boundary", async () => {
    const fetchMock = mockFetchStrict([
      { match: "https://api.example.test/api/snapshots/2026-05-16.json", body: makeEnvelope("2026-05-16") },
      {
        match: "https://api.example.test/api/depeg-events?limit=1000",
        body: { events: [makeCoverageSentinel("2026-05-16")], nextCursor: "page-2" },
      },
      { match: "https://api.example.test/api/depeg-events?limit=1000&cursor=page-2", body: { events: [makeEvent(null)] } },
    ]);

    const inputs = await loadPublicDatasetLiveInputs("https://api.example.test", "2026-05-16");
    const rows = testExports.projectDepegHistory(inputs.depegEvents, inputs.effectiveSnapshotDate);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/api/depeg-events?limit=1000&cursor=page-2",
      expect.anything(),
    );
    expect(inputs.depegEvents).toHaveLength(2);
    expect(rows.map((row) => row.id)).toEqual([42]);
  });

  it("fails live generation when a required source fetch fails", async () => {
    mockFetchStrict([
      { match: "https://api.example.test/api/snapshots/2026-05-16.json", body: makeEnvelope("2026-05-16") },
      { match: "https://api.example.test/api/depeg-events?limit=1000", body: { error: "unavailable" }, status: 503 },
    ]);

    await expect(loadPublicDatasetLiveInputs("https://api.example.test", "2026-05-16")).rejects.toThrow(
      "Unable to fetch depeg events",
    );
  });

  it("rejects a depeg event response that does not cover the rolling export window", async () => {
    mockFetchStrict([
      { match: "https://api.example.test/api/snapshots/2026-05-16.json", body: makeEnvelope("2026-05-16") },
      { match: "https://api.example.test/api/depeg-events?limit=1000", body: { events: [makeEvent(null)] } },
    ]);

    await expect(loadPublicDatasetLiveInputs("https://api.example.test", "2026-05-16")).rejects.toThrow(
      "does not cover the 90-day export window",
    );
  });

  it("does not drop confirmed depeg events that retain pendingReason provenance", () => {
    const rows = testExports.projectDepegHistory([makeEvent("low-confidence")], "2026-05-16");

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(42);
  });

  it("uses a stable event id tiebreak for same-second depeg history rows", () => {
    const later = { ...makeEvent(null), id: 3, startedAt: Date.UTC(2026, 4, 15) / 1000 };
    const tiedHighId = { ...makeEvent(null), id: 9 };
    const tiedLowId = { ...makeEvent(null), id: 2 };

    const rows = testExports.projectDepegHistory([tiedHighId, later, tiedLowId], "2026-05-16");

    expect(rows.map((row) => row.id)).toEqual([3, 2, 9]);
  });

  it("uses source coverage instead of a volatile fixed floor for rolling depeg history", () => {
    expect(() => testExports.validateTopicRowFloor("depeg-history", [makeEvent(null)])).not.toThrow();
    expect(() =>
      testExports.validateDepegHistoryCoverage([makeEvent(null), makeCoverageSentinel("2026-05-16")], "2026-05-16"),
    ).not.toThrow();
  });

  it("accepts source coverage exactly at the rolling cutoff", () => {
    const snapshotDate = "2026-05-16";
    const eventAtCutoff = {
      ...makeEvent(null),
      startedAt: testExports.cutoffSecForSnapshotDate(snapshotDate),
    };

    expect(() => testExports.validateDepegHistoryCoverage([eventAtCutoff], snapshotDate)).not.toThrow();
    expect(testExports.projectDepegHistory([eventAtCutoff], snapshotDate)).toHaveLength(1);
  });

  it("excludes depeg events that start after the UTC snapshot day", () => {
    const snapshotDate = "2026-05-16";
    const eventAtDayEnd = {
      ...makeEvent(null),
      id: 44,
      startedAt: testExports.snapshotEndSecForDate(snapshotDate),
    };
    const eventAfterSnapshot = {
      ...makeEvent(null),
      id: 45,
      startedAt: testExports.snapshotEndSecForDate(snapshotDate) + 1,
    };

    expect(
      testExports.projectDepegHistory([eventAtDayEnd, eventAfterSnapshot], snapshotDate).map((row) => row.id),
    ).toEqual([44]);
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

  it("rejects checked depeg-history mirrors below the artifact floor", async () => {
    const root = await makeRoot();
    const datasetsDir = path.join(root, "datasets");
    const topicDir = path.join(datasetsDir, "depeg-history");
    await mkdir(topicDir, { recursive: true });
    const redirectsPath = await writeTopicRedirects(root, "depeg-history");
    await writeFile(path.join(topicDir, "2026-05-16.csv"), "# Pharos pharos.watch\nid\n42\n");
    await writeFile(
      path.join(topicDir, "2026-05-16.json"),
      JSON.stringify({ _meta: { endpoint: "depeg-history", rowCount: 1 }, rows: [{ id: "42" }] }, null, 2),
    );
    await writeFile(path.join(topicDir, "2026-05-16.ndjson"), '{"_meta":{"endpoint":"depeg-history"}}\n{"id":"42"}\n');

    expect(testExports.checkTopic("depeg-history", artifactDirs(datasetsDir, redirectsPath))).toEqual({
      ok: false,
      reason: expect.stringContaining("rowCount 1 below required floor 300"),
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
