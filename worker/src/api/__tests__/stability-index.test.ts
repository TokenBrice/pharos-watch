import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { afterEach, describe, it, expect } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { handleStabilityIndex } from "../stability-index";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { StabilityIndexResponseSchema } from "@shared/types/stability";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(fixtures.closeAll);

describe("handleStabilityIndex contract tests", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const yesterdayMidnight = nowSec - 86400 - (nowSec % 86400);

  const sampleRow = {
    stored_at: nowSec - 300,
    score: 72.5,
    band: "TREMOR",
    components: JSON.stringify({ severity: 12.5, breadth: 10.2, stressBreadth: 3.1, trend: -1.4 }),
    input_snapshot: JSON.stringify({ totalMcapUsd: 1e11, contributors: [] }),
    methodology_version: "3.0",
  };

  const historyRow = {
    computed_at: yesterdayMidnight,
    score: 71.0,
    band: "TREMOR",
    components: JSON.stringify({ severity: 14.2, breadth: 9.7, stressBreadth: 2.4, trend: -0.9 }),
    input_snapshot: null,
    methodology_version: "2.1",
  };

  // Order matters: "stability_index_samples" must come before "stability_index"
  // so the more specific match wins for sample queries.
  const db = mockD1([
    { match: "stability_index_samples", rows: [sampleRow], first: sampleRow },
    { match: "stability_index", rows: [historyRow] },
  ]);

  it("summary mode returns current + history without components in history", async () => {
    const url = new URL("https://x/api/stability-index");
    const res = await handleStabilityIndex(db, url);

    const body = await readJsonResponse(res, 200);

    expect(body).toHaveProperty("current");
    expect(body).toHaveProperty("history");
    expect(body).toHaveProperty("methodology");
    expect((body as { current: Record<string, unknown> }).current).toHaveProperty("score");
    expect((body as { current: Record<string, unknown> }).current).toHaveProperty("band");
    expect((body as { current: Record<string, unknown> }).current).toHaveProperty("components");
    expect((body as { current: Record<string, unknown> }).current).toHaveProperty("methodologyVersion");
    expect((body as { methodology: Record<string, unknown> }).methodology).toHaveProperty("version");
    expect((body as { methodology: Record<string, unknown> }).methodology).toHaveProperty("changelogPath");
    expect(body).toHaveProperty("history", [
      { date: yesterdayMidnight, score: 71, band: "TREMOR", methodologyVersion: "2.1" },
    ]);
  });

  it("detail mode includes components in history items", async () => {
    const url = new URL("https://x/api/stability-index?detail=true");
    const res = await handleStabilityIndex(db, url);

    const body = await readJsonResponse(res, 200);

    expect(body).toHaveProperty("current");
    expect(body).toHaveProperty("history");
    expect(body).toHaveProperty("methodology");
    const typedBody = body as { history: Record<string, unknown>[] };
    expect(typedBody.history).toEqual([{
      date: yesterdayMidnight, score: 71, band: "TREMOR", methodologyVersion: "2.1",
      components: { severity: 14.2, breadth: 9.7, stressBreadth: 2.4, trend: -0.9 },
    }]);
  });

  it("rejects malformed detail booleans instead of silently treating them as false", async () => {
    const res = await handleStabilityIndex(mockD1([]), new URL("https://x/api/stability-index?detail=yes"));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid detail: must be true or false" });
  });


  it("lazily fetches the latest history input snapshot only when no live sample exists", async () => {
    const fallbackSnapshot = {
      totalMcapUsd: 42_000_000_000,
      contributors: [{ stablecoinId: "usdc-circle", contribution: 3.2 }],
    };
    const db = mockD1([
      { match: "stability_index_samples", rows: [], first: null },
      {
        match: "SELECT input_snapshot FROM stability_index ORDER BY computed_at DESC LIMIT 1",
        rows: [{ input_snapshot: JSON.stringify(fallbackSnapshot) }],
        first: { input_snapshot: JSON.stringify(fallbackSnapshot) },
      },
      { match: "stability_index ORDER BY computed_at DESC", rows: [historyRow] },
    ]);

    const res = await handleStabilityIndex(db, new URL("https://x/api/stability-index"));

    const body = (await readJsonResponse(res, 200)) as {
      current: {
        computedAt: number;
        totalMcapUsd: number;
        contributors: Array<Record<string, unknown>>;
      };
    };
    expect(body.current.computedAt).toBe(historyRow.computed_at);
    expect(body.current.totalMcapUsd).toBe(fallbackSnapshot.totalMcapUsd);
    expect(body.current.contributors).toEqual(fallbackSnapshot.contributors);
    expect(
      db
        .getHistory()
        .filter((q) => /^SELECT input_snapshot FROM stability_index\b/i.test(q.sql)),
    ).toHaveLength(1);
  });

  it("reconstructs methodology version from timestamps when DB version is null", async () => {
    const legacySample = {
      stored_at: 1772068000, // PSI v1.3 window
      score: 68.4,
      band: "TREMOR",
      components: JSON.stringify({ severity: 20, breadth: 8, trend: 1 }),
      input_snapshot: JSON.stringify({ contributors: [] }),
      methodology_version: null,
    };

    const legacyHistory = {
      computed_at: 1772068000,
      score: 68.4,
      band: "TREMOR",
      components: JSON.stringify({ severity: 20, breadth: 8, trend: 1 }),
      input_snapshot: null,
      methodology_version: null,
    };

    const db = mockD1([
      { match: "stability_index_samples", rows: [legacySample], first: legacySample },
      { match: "stability_index", rows: [legacyHistory] },
    ]);

    const res = await handleStabilityIndex(db, new URL("https://x/api/stability-index"));
    const body = (await readJsonResponse(res, 200)) as {
      current: { methodologyVersion: string };
      history: Array<{ methodologyVersion: string }>;
      methodology: { version: string };
    };

    expect(body.current.methodologyVersion).toBe("1.3");
    expect(body.history[0]?.methodologyVersion).toBe("1.3");
    expect(body.methodology.version).toBe("1.3");
  });

  it("replaces an existing today row with the synthetic today average instead of duplicating it", async () => {
    const todayMidnight = nowSec - (nowSec % 86400);
    const db = mockD1([
      {
        match: "WHERE stored_at >= ?",
        rows: [],
        first: { avg: 80.6 },
      },
      {
        match: "WHERE stored_at > ?",
        rows: [],
        first: { avg: 79.8 },
      },
      {
        match: "stability_index_samples",
        rows: [sampleRow],
        first: sampleRow,
      },
      {
        match: "stability_index ORDER BY computed_at DESC",
        rows: [
          {
            computed_at: todayMidnight,
            score: 78.1,
            band: "STEADY",
            components: JSON.stringify({ severity: 10, breadth: 8, stressBreadth: 2, trend: 0.1 }),
            input_snapshot: null,
            methodology_version: "3.0",
          },
          historyRow,
        ],
      },
    ]);

    const res = await handleStabilityIndex(db, new URL("https://x/api/stability-index"));

    const body = (await readJsonResponse(res, 200)) as {
      history: Array<{ date: number; score: number; band: string }>;
    };

    expect(body.history.filter((point) => point.date === todayMidnight)).toEqual([
      { date: todayMidnight, score: 80.6, band: "STEADY", methodologyVersion: "3.0" },
    ]);
    expect(body.history).toHaveLength(2);
  });

  it("returns 503 when canonical current JSON fields are malformed", async () => {
    const malformedSample = {
      ...sampleRow,
      components: "{bad-components",
      input_snapshot: "{bad-snapshot",
    };

    const db = mockD1([
      { match: "stability_index_samples", rows: [malformedSample], first: malformedSample },
      { match: "stability_index", rows: [historyRow] },
    ]);

    const res = await handleStabilityIndex(db, new URL("https://x/api/stability-index"));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: "PSI current components payload is malformed",
    });
  });

  it.each([
    ["input_snapshot", "{bad-snapshot", "input snapshot"],
    ["input_snapshot", "[]", "input snapshot"],
    ["components", "[]", "components"],
  ])("rejects independently malformed %s: %s", async (field, value, label) => {
    const invalidSample = { ...sampleRow, [field]: value };
    const db = mockD1([
      { match: "stability_index_samples", rows: [invalidSample], first: invalidSample },
      { match: "stability_index", rows: [historyRow] },
    ]);
    const response = await handleStabilityIndex(db, new URL("https://x/api/stability-index"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: `PSI current ${label} payload is malformed` });
  });

  it("returns an empty history and null current when neither source exists", async () => {
    const db = mockD1([
      { match: "stability_index_samples", rows: [], first: null },
      { match: "stability_index", rows: [] },
    ]);
    const response = await handleStabilityIndex(db, new URL("https://x/api/stability-index"));
    expect(await readJsonResponse(response, 200)).toMatchObject({ current: null, history: [] });
  });

  it("detail mode drops malformed historical component rows and reports malformedRows", async () => {
    const malformedHistory = {
      ...historyRow,
      components: "{bad-history-components",
    };
    const db = mockD1([
      { match: "stability_index_samples", rows: [sampleRow], first: sampleRow },
      { match: "stability_index", rows: [malformedHistory] },
    ]);

    const res = await handleStabilityIndex(db, new URL("https://x/api/stability-index?detail=true"));

    const body = (await readJsonResponse(res, 200)) as {
      history: Array<{ components?: Record<string, unknown> }>;
      malformedRows: number;
    };

    expect(body.history).toEqual([]);
    expect(body.malformedRows).toBe(1);
  });

  it("surfaces degraded input flags when the stored PSI snapshot carries dependency failures", async () => {
    const degradedSample = {
      ...sampleRow,
      input_snapshot: JSON.stringify({
        totalMcapUsd: 1e11,
        contributors: [],
        dewsUnavailable: true,
        dewsFailureReason: "stress_signals unavailable",
      }),
    };
    const db = mockD1([
      { match: "stability_index_samples", rows: [degradedSample], first: degradedSample },
      { match: "stability_index", rows: [historyRow] },
    ]);

    const res = await handleStabilityIndex(db, new URL("https://x/api/stability-index"));

    const body = (await readJsonResponse(res, 200)) as {
      current: {
        inputDegradation?: {
          dewsUnavailable: boolean;
          dewsFailureReason: string | null;
          depegEventsUnavailable: boolean;
          depegEventsFailureReason: string | null;
        };
      };
    };

    expect(body.current.inputDegradation).toEqual({
      dewsUnavailable: true,
      dewsFailureReason: "stress_signals unavailable",
      depegEventsUnavailable: false,
      depegEventsFailureReason: null,
      openDepegNoPrice: false,
      openDepegsWithoutPrice: null,
    });
  });

  it("surfaces unpriced open depegs as input degradation, not as zero severity", async () => {
    const unpricedSample = {
      ...sampleRow,
      input_snapshot: JSON.stringify({
        totalMcapUsd: 1e11,
        contributors: [],
        depegCount: 0,
        openDepegsWithoutPrice: 2,
        degradedComponents: ["open-depeg-no-price"],
      }),
    };
    const db = mockD1([
      { match: "stability_index_samples", rows: [unpricedSample], first: unpricedSample },
      { match: "stability_index", rows: [historyRow] },
    ]);

    const res = await handleStabilityIndex(db, new URL("https://x/api/stability-index"));

    const body = (await readJsonResponse(res, 200)) as {
      current: { inputDegradation?: Record<string, unknown> };
    };

    expect(body.current.inputDegradation).toMatchObject({
      dewsUnavailable: false,
      depegEventsUnavailable: false,
      openDepegNoPrice: true,
      openDepegsWithoutPrice: 2,
    });
  });
});

describe("daily PSI stored provenance compatibility", () => {
  it("serves mixed all-day provenance and nullable components from stored rows in summary, detail, and current fallback", async () => {
    const { sqlite, db } = fixtures.open();
    const day = 1_772_755_200;
    const provenance = {
      aggregation: "all-day",
      sampleCount: 3,
      componentSampleCounts: { severity: 0, breadth: 3, stressBreadth: 1, trend: 2 },
      methodologyBreakdown: { "3.0": 2, "2.1": 1 },
    };
    const components = { severity: null, breadth: 0, stressBreadth: 4, trend: null };
    const insert = sqlite.prepare(`INSERT INTO stability_index
      (computed_at, score, band, components, input_snapshot, methodology_version)
      VALUES (?, ?, ?, ?, ?, ?)`);
    insert.run(day, 80, "STEADY", JSON.stringify(components), JSON.stringify({
      source: "daily-avg", ...provenance,
    }), "3.0");
    // Old snapshots retain their real version breakdown, but cannot invent component counts.
    insert.run(day - 86400, 90, "STEADY", JSON.stringify({ severity: 0, breadth: 0, trend: 0 }), JSON.stringify({
      source: "daily-avg", sampleCount: 2, methodologyBreakdown: { "2.1": 1, "3.0": 1 },
    }), "3.0");

    for (const detail of [false, true]) {
      const response = await handleStabilityIndex(db, new URL(`https://x/api/stability-index?detail=${detail}`));
      expect(response.status).toBe(200);
      const body = StabilityIndexResponseSchema.parse(await response.json());
      expect(body.current?.components).toEqual(components);
      expect(body.current?.componentsUnavailable).toEqual(["severity", "trend"]);
      expect(body.history[0].componentsUnavailable).toEqual(detail ? ["severity", "trend"] : ["severity"]);
      expect(body.current?.dailyProvenance).toEqual(provenance);
      expect(body.history[0].dailyProvenance).toEqual(provenance);
      expect(body.history[0].components).toEqual(detail ? components : undefined);
      expect(body.history[1].dailyProvenance).toEqual({
        aggregation: "all-day", sampleCount: 2, componentSampleCounts: null,
        methodologyBreakdown: { "2.1": 1, "3.0": 1 },
      });
    }
  });
});
