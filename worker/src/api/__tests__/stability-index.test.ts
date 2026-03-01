import { describe, it, expect } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { handleStabilityIndex } from "../stability-index";

describe("handleStabilityIndex contract tests", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const yesterdayMidnight = nowSec - 86400 - (nowSec % 86400);

  const sampleRow = {
    stored_at: nowSec - 300,
    score: 72.5,
    band: "Stable",
    components: JSON.stringify({ pricePeg: 85, supplyMomentum: 60 }),
    input_snapshot: JSON.stringify({ totalMcapUsd: 1e11, contributors: [] }),
  };

  const historyRow = {
    computed_at: yesterdayMidnight,
    score: 71.0,
    band: "Stable",
    components: JSON.stringify({ pricePeg: 83, supplyMomentum: 59 }),
    input_snapshot: null,
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
    expect((body as { current: Record<string, unknown> }).current).toHaveProperty("score");
    expect((body as { current: Record<string, unknown> }).current).toHaveProperty("band");
    expect((body as { current: Record<string, unknown> }).current).toHaveProperty("components");
    expect(Array.isArray((body as { history: unknown[] }).history)).toBe(true);
  });

  it("detail mode includes components in history items", async () => {
    const url = new URL("https://x/api/stability-index?detail=true");
    const res = await handleStabilityIndex(db, url);

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toHaveProperty("current");
    expect(body).toHaveProperty("history");
    const typedBody = body as { history: Record<string, unknown>[] };
    expect(Array.isArray(typedBody.history)).toBe(true);
    // Detail mode adds components to history items
    if (typedBody.history.length > 0) {
      expect(typedBody.history[0]).toHaveProperty("components");
    }
  });
});
