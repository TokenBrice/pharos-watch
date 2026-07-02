import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadPublicDatasetLiveInputs, testExports } from "../maintenance/generate-public-datasets";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function makeRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pharos-public-datasets-"));
  tempRoots.push(root);
  return root;
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
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

  it("uses the effective snapshot date after falling back to the latest snapshot", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith("/api/snapshots/2026-05-16.json")) {
        return jsonResponse({ error: "not found" }, { status: 404 });
      }
      if (href.endsWith("/api/snapshots/index")) {
        return jsonResponse({ snapshots: [{ snapshotDate: "2026-05-15" }] });
      }
      if (href.endsWith("/api/snapshots/2026-05-15.json")) {
        return jsonResponse(makeEnvelope("2026-05-15"));
      }
      if (href.endsWith("/api/depeg-events?limit=1000")) {
        return jsonResponse({ events: [makeEvent("large-cap")] });
      }
      return jsonResponse({ error: "unexpected" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

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
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith("/api/snapshots/2026-05-16.json") || href.endsWith("/api/snapshots/index")) {
        return jsonResponse({ error: "not found" }, { status: 404 });
      }
      if (href.endsWith("/api/stablecoins")) {
        return jsonResponse({ peggedAssets: makeEnvelope("2026-05-16").stablecoins });
      }
      if (href.endsWith("/api/report-cards")) {
        return jsonResponse({
          cards: [
            {
              id: "usdc-circle",
              overallGrade: "A",
              overallScore: 98,
              rawInputs: { pegScore: 99 },
            },
          ],
          updatedAt: 1_779_000_001,
        });
      }
      if (href.endsWith("/api/stress-signals")) {
        return jsonResponse({
          signals: { "usdc-circle": { score: 4, band: "CALM" } },
          updatedAt: 1_779_000_002,
        });
      }
      if (href.endsWith("/api/dex-liquidity")) {
        return jsonResponse({ "usdc-circle": { liquidityScore: 95, coverageClass: "deep" } });
      }
      if (href.endsWith("/api/depeg-events?limit=1000")) {
        return jsonResponse({ events: [makeEvent("low-confidence")] });
      }
      return jsonResponse({ error: "unexpected" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const inputs = await loadPublicDatasetLiveInputs("https://api.example.test", "2026-05-16");
    const specs = testExports.buildTopicSpecs(inputs.envelope, inputs.depegEvents, inputs.effectiveSnapshotDate);

    expect(inputs.effectiveSnapshotDate).toBe("2026-05-16");
    expect(inputs.asOfISO).toBe("2026-05-18T12:30:00.000Z");
    expect(specs.find((spec) => spec.topic === "top-stablecoins")?.rows).toHaveLength(1);
    const scoreRows = specs.find((spec) => spec.topic === "scores-latest")?.rows as Array<Record<string, unknown>>;
    expect(scoreRows).toHaveLength(1);
    expect(scoreRows[0]?.pegScore).toBe(99);
    expect(scoreRows[0]?.safetyScore).toBe(98);
    expect(specs.find((spec) => spec.topic === "depeg-history")?.rows).toHaveLength(1);
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

  it("paginates depeg events until the 90-day export window is covered", async () => {
    const oldEvent = {
      ...makeEvent(null),
      id: 2,
      startedAt: testExports.cutoffSecForSnapshotDate("2026-05-16") - 60,
    };
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith("/api/snapshots/2026-05-16.json")) {
        return jsonResponse(makeEnvelope("2026-05-16"));
      }
      if (href.endsWith("/api/depeg-events?limit=1000")) {
        return jsonResponse({ events: [makeEvent(null)], nextCursor: "page-2" });
      }
      if (href.endsWith("/api/depeg-events?limit=1000&cursor=page-2")) {
        return jsonResponse({ events: [oldEvent], nextCursor: "page-3" });
      }
      return jsonResponse({ error: "unexpected" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const inputs = await loadPublicDatasetLiveInputs("https://api.example.test", "2026-05-16");
    const rows = testExports.projectDepegHistory(inputs.depegEvents, inputs.effectiveSnapshotDate);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/api/depeg-events?limit=1000&cursor=page-2",
      expect.anything(),
    );
    expect(inputs.depegEvents).toHaveLength(2);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(42);
  });

  it("fails live generation when a required source fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const href = String(url);
        if (href.endsWith("/api/snapshots/2026-05-16.json")) {
          return jsonResponse(makeEnvelope("2026-05-16"));
        }
        if (href.endsWith("/api/depeg-events?limit=1000")) {
          return jsonResponse({ error: "unavailable" }, { status: 503 });
        }
        return jsonResponse({ error: "unexpected" }, { status: 500 });
      }),
    );

    await expect(loadPublicDatasetLiveInputs("https://api.example.test", "2026-05-16")).rejects.toThrow(
      "Unable to fetch depeg events",
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

  it("rejects empty live-backed dataset rows and checked artifacts", async () => {
    expect(() => testExports.validateTopicRowFloor("top-stablecoins", [])).toThrow("expected at least 1");

    const root = await makeRoot();
    const datasetsDir = path.join(root, "datasets");
    const sheetsDir = path.join(root, "sheets");
    const topicDir = path.join(datasetsDir, "top-stablecoins");
    await mkdir(topicDir, { recursive: true });
    await mkdir(sheetsDir, { recursive: true });
    await writeFile(path.join(topicDir, "latest.csv"), "# Pharos pharos.watch\nid\n");
    await writeFile(
      path.join(topicDir, "latest.json"),
      JSON.stringify({ _meta: { endpoint: "top-stablecoins", rowCount: 0 }, rows: [] }, null, 2),
    );
    await writeFile(path.join(topicDir, "latest.ndjson"), '{"_meta":{"endpoint":"top-stablecoins"}}\n');
    await writeFile(path.join(sheetsDir, "top-stablecoins.csv"), "# Pharos pharos.watch\nid\n");

    expect(testExports.checkTopic("top-stablecoins", { datasetsDir, sheetsDir })).toEqual({
      ok: false,
      reason: expect.stringContaining("rowCount 0 below required floor 1"),
    });
  });

});
