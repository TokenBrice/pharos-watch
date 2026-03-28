import { describe, it, expect } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { handleStabilityIndex } from "../stability-index";

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

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toHaveProperty("current");
    expect(body).toHaveProperty("history");
    expect(body).toHaveProperty("methodology");
    expect((body as { current: Record<string, unknown> }).current).toHaveProperty("score");
    expect((body as { current: Record<string, unknown> }).current).toHaveProperty("band");
    expect((body as { current: Record<string, unknown> }).current).toHaveProperty("components");
    expect((body as { current: Record<string, unknown> }).current).toHaveProperty("methodologyVersion");
    expect((body as { methodology: Record<string, unknown> }).methodology).toHaveProperty("version");
    expect((body as { methodology: Record<string, unknown> }).methodology).toHaveProperty("changelogPath");
    expect(Array.isArray((body as { history: unknown[] }).history)).toBe(true);
  });

  it("detail mode includes components in history items", async () => {
    const url = new URL("https://x/api/stability-index?detail=true");
    const res = await handleStabilityIndex(db, url);

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toHaveProperty("current");
    expect(body).toHaveProperty("history");
    expect(body).toHaveProperty("methodology");
    const typedBody = body as { history: Record<string, unknown>[] };
    expect(Array.isArray(typedBody.history)).toBe(true);
    // Detail mode adds components to history items
    if (typedBody.history.length > 0) {
      expect(typedBody.history[0]).toHaveProperty("components");
      expect(typedBody.history[0]).toHaveProperty("methodologyVersion");
    }
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
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
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
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
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
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      history: Array<{ components?: Record<string, unknown> }>;
      malformedRows: number;
    };

    expect(body.history).toEqual([]);
    expect(body.malformedRows).toBe(1);
  });
});
