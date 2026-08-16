import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch, mockFetchStrict } from "../../worker/src/test-helpers/__shared/mock-fetch";

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
  it("fails closed when no API source is configured outside explicit stub mode", async () => {
    const { stderr } = await execFileAsync(
      path.join(process.cwd(), "node_modules/.bin/tsx"),
      ["scripts/maintenance/generate-public-datasets.ts"],
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
      path.join(process.cwd(), "node_modules/.bin/tsx"),
      ["scripts/maintenance/generate-public-datasets.ts"],
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

  it("uses the effective snapshot date after falling back to the latest snapshot", async () => {
    mockFetchStrict([
      { match: "https://api.example.test/api/snapshots/2026-05-16.json", body: { error: "not found" }, status: 404 },
      { match: "https://api.example.test/api/snapshots/index", body: { snapshots: [{ snapshotDate: "2026-05-15" }] } },
      { match: "https://api.example.test/api/snapshots/2026-05-15.json", body: makeEnvelope("2026-05-15") },
      {
        match: "https://api.example.test/api/depeg-events?limit=1000",
        body: { events: [makeEvent("large-cap"), makeCoverageSentinel("2026-05-15")] },
      },
    ]);

    const inputs = await loadPublicDatasetLiveInputs("https://api.example.test", "2026-05-16");
    const specs = testExports.buildTopicSpecs(inputs.envelope, inputs.depegEvents, inputs.effectiveSnapshotDate);

    expect(inputs.effectiveSnapshotDate).toBe("2026-05-15");
    expect(inputs.asOfISO).toBe("2026-05-17T06:40:00.000Z");
    expect(specs.find((spec) => spec.topic === "top-stablecoins")?.rows).toHaveLength(1);
    expect(specs.find((spec) => spec.topic === "depeg-history")?.rows).toHaveLength(1);
  });

  it("can build real mirrors from current live endpoints before snapshot routes exist", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T12:30:00.000Z"));
    mockFetchStrict([
      { match: "https://api.example.test/api/snapshots/2026-05-16.json", body: { error: "not found" }, status: 404 },
      { match: "https://api.example.test/api/snapshots/index", body: { error: "not found" }, status: 404 },
      { match: "https://api.example.test/api/stablecoins", body: { peggedAssets: makeEnvelope("2026-05-16").stablecoins } },
      {
        match: "https://api.example.test/api/report-cards/v9",
        body: {
          cards: [
            {
              id: "usdc-circle",
              grade: "A",
              score: 98,
            },
          ],
          updatedAt: 1_779_000_001,
        },
      },
      {
        match: "https://api.example.test/api/stress-signals",
        body: {
          signals: { "usdc-circle": { score: 4, band: "CALM" } },
          updatedAt: 1_779_000_002,
        },
      },
      { match: "https://api.example.test/api/dex-liquidity", body: { "usdc-circle": { liquidityScore: 95, coverageClass: "deep" } } },
      {
        match: "https://api.example.test/api/depeg-events?limit=1000",
        body: { events: [makeEvent("low-confidence"), makeCoverageSentinel("2026-05-16")] },
      },
    ]);

    const inputs = await loadPublicDatasetLiveInputs("https://api.example.test", "2026-05-16");
    const specs = testExports.buildTopicSpecs(inputs.envelope, inputs.depegEvents, inputs.effectiveSnapshotDate);

    expect(inputs.effectiveSnapshotDate).toBe("2026-05-16");
    expect(inputs.asOfISO).toBe("2026-05-18T12:30:00.000Z");
    expect(specs.find((spec) => spec.topic === "top-stablecoins")?.rows).toHaveLength(1);
    const scoreRows = specs.find((spec) => spec.topic === "scores-latest")?.rows as Array<Record<string, unknown>>;
    expect(scoreRows).toHaveLength(1);
    expect(scoreRows[0]?.pegScore).toBeNull();
    expect(scoreRows[0]?.safetyScore).toBe(98);
    expect(specs.find((spec) => spec.topic === "depeg-history")?.rows).toHaveLength(1);
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

  it("rejects empty live-backed dataset rows and checked artifacts", async () => {
    expect(() => testExports.validateTopicRowFloor("top-stablecoins", [])).toThrow("expected at least 493");

    const root = await makeRoot();
    const datasetsDir = path.join(root, "datasets");
    const topicDir = path.join(datasetsDir, "top-stablecoins");
    await mkdir(topicDir, { recursive: true });
    await writeFile(path.join(topicDir, "latest.csv"), "# Pharos pharos.watch\nid\n");
    await writeFile(
      path.join(topicDir, "latest.json"),
      JSON.stringify({ _meta: { endpoint: "top-stablecoins", rowCount: 0 }, rows: [] }, null, 2),
    );
    await writeFile(path.join(topicDir, "latest.ndjson"), '{"_meta":{"endpoint":"top-stablecoins"}}\n');

    expect(testExports.checkTopic("top-stablecoins", { datasetsDir })).toEqual({
      ok: false,
      reason: expect.stringContaining("rowCount 0 below required floor 493"),
    });
  });

  it("rejects checked depeg-history mirrors below the artifact floor", async () => {
    const root = await makeRoot();
    const datasetsDir = path.join(root, "datasets");
    const topicDir = path.join(datasetsDir, "depeg-history");
    await mkdir(topicDir, { recursive: true });
    await writeFile(path.join(topicDir, "latest.csv"), "# Pharos pharos.watch\nid\n42\n");
    await writeFile(
      path.join(topicDir, "latest.json"),
      JSON.stringify({ _meta: { endpoint: "depeg-history", rowCount: 1 }, rows: [{ id: "42" }] }, null, 2),
    );
    await writeFile(path.join(topicDir, "latest.ndjson"), '{"_meta":{"endpoint":"depeg-history"}}\n{"id":"42"}\n');

    expect(testExports.checkTopic("depeg-history", { datasetsDir })).toEqual({
      ok: false,
      reason: expect.stringContaining("rowCount 1 below required floor 300"),
    });
  });

  it("rejects checked artifacts whose JSON rowCount does not match rows length", async () => {
    const root = await makeRoot();
    const datasetsDir = path.join(root, "datasets");
    const topicDir = path.join(datasetsDir, "depeg-history");
    await mkdir(topicDir, { recursive: true });
    await writeFile(path.join(topicDir, "latest.csv"), "# Pharos pharos.watch\nid\n");
    await writeFile(
      path.join(topicDir, "latest.json"),
      JSON.stringify({ _meta: { endpoint: "depeg-history", rowCount: 300 }, rows: [] }, null, 2),
    );
    await writeFile(path.join(topicDir, "latest.ndjson"), '{"_meta":{"endpoint":"depeg-history"}}\n');

    expect(testExports.checkTopic("depeg-history", { datasetsDir })).toEqual({
      ok: false,
      reason: expect.stringContaining("rowCount 300 does not match rows length 0"),
    });
  });
});
