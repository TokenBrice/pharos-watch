import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { describe, it, expect } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { EDITORIAL_STYLE_HASH, EDITORIAL_STYLE_VERSION } from "@shared/lib/editorial-style";
import { makeDigestRow } from "../../test-helpers/__shared/fixtures";
import { handleDigestArchive } from "../digest-archive";

describe("handleDigestArchive", () => {
  it("returns 200 with empty digests when no data", async () => {
    const db = mockD1([{ match: "FROM daily_digest", rows: [] }]);
    const res = await handleDigestArchive(db);
    const body = (await readJsonResponse(res, 200)) as { digests: unknown[] };
    expect(body.digests).toEqual([]);
  });

  it("returns 200 with digests array", async () => {
    const row = makeDigestRow({
      input_data: JSON.stringify({
        stabilityIndex: { score: 72, band: "Stable" },
        totalMcapUsd: 150e9,
        activeDepegCount: 1,
        topDepegs: [{ symbol: "PMUSD", bps: -5284, mcapUsd: 65_000_000 }],
        riskTape: [{ id: "risk-tape:depegs", label: "Depegs", value: "PMUSD 5284bps", tone: "critical" }],
        nextTriggers: [{
          id: "trigger:depeg:pmusd",
          label: "PMUSD depeg widening",
          metric: "depeg-bps",
          comparator: "abs-gte",
          thresholdLabel: "5500 bps off peg",
          thresholdValue: 5500,
          symbol: "PMUSD",
          rationale: "A wider deviation raises severity.",
          detail: "If PMUSD reaches 5500 bps off peg, severity rises.",
        }],
      }),
    });
    const db = mockD1([{ match: "daily_digest", rows: [row] }]);
    const res = await handleDigestArchive(db);
    const body = (await readJsonResponse(res, 200)) as {
      digests: Array<{
        digestText: string;
        digestTitle: string | null;
        generatedAt: number;
        psiScore: number | null;
        psiBand: string | null;
        totalMcapUsd: number | null;
        riskSignal: { symbol: string; bps: number; severity: string } | null;
        riskTape: unknown[] | null;
        nextTriggers: unknown[] | null;
      }>;
    };
    expect(body.digests).toHaveLength(1);
    expect(body.digests[0]).toHaveProperty("digestText");
    expect(body.digests[0]).toHaveProperty("generatedAt");
    expect(body.digests[0].psiScore).toBe(72);
    expect(body.digests[0].psiBand).toBe("Stable");
    expect(body.digests[0].totalMcapUsd).toBe(150e9);
    expect(body.digests[0].riskSignal).toMatchObject({ symbol: "PMUSD", bps: -5284, severity: "critical" });
    expect(body.digests[0].riskTape).toHaveLength(1);
    expect(body.digests[0].nextTriggers).toHaveLength(1);
  });

  it("projects editorial style provenance and marks legacy rows without rewriting them", async () => {
    const current = makeDigestRow({
      id: 2,
      generated_at: 2_000,
      digest_meta: JSON.stringify({
        editorialStyleVersion: EDITORIAL_STYLE_VERSION,
        editorialStyleHash: EDITORIAL_STYLE_HASH,
      }),
    });
    const legacy = makeDigestRow({
      id: 1,
      generated_at: 1_000,
      digest_meta: null,
    });
    const db = mockD1([{ match: "daily_digest", rows: [current, legacy] }]);
    const res = await handleDigestArchive(db);
    const body = (await res.json()) as {
      digests: Array<{
        editorialStyleVersion: string;
        editorialStyleHash: string;
      }>;
    };

    expect(body.digests[0]).toMatchObject({
      editorialStyleVersion: EDITORIAL_STYLE_VERSION,
      editorialStyleHash: EDITORIAL_STYLE_HASH,
    });
    expect(body.digests[1]).toMatchObject({
      editorialStyleVersion: "pre-policy",
      editorialStyleHash: "pre-policy",
    });
    expect(legacy.digest_meta).toBeNull();
  });

  it("handles missing input_data gracefully", async () => {
    const row = makeDigestRow({ input_data: null });
    const db = mockD1([{ match: "daily_digest", rows: [row] }]);
    const res = await handleDigestArchive(db);
    const body = (await res.json()) as { digests: Array<Record<string, unknown>> };
    expect(body.digests[0].psiScore).toBeNull();
    expect(body.digests[0].psiBand).toBeNull();
    expect(body.digests[0].totalMcapUsd).toBeNull();
  });

  it("includes X-Data-Age header", async () => {
    const row = makeDigestRow();
    const db = mockD1([{ match: "daily_digest", rows: [row] }]);
    const res = await handleDigestArchive(db);
    expect(res.headers.has("X-Data-Age")).toBe(true);
  });

  it("hides internal sentinel rows without shifting edition numbers", async () => {
    const now = Math.floor(Date.now() / 1000);
    const weekly1 = makeDigestRow({
      id: 1,
      generated_at: now - 3 * 86_400,
      digest_title: "First Weekly",
      digest_meta: JSON.stringify({ type: "weekly" }),
    });
    const sentinel = makeDigestRow({
      id: 2,
      generated_at: now - 2 * 86_400,
      digest_title: "__bluechip_replay_guard__",
      digest_text: "placeholder",
      digest_meta: JSON.stringify({ type: "weekly", internal: true }),
    });
    const weekly2 = makeDigestRow({
      id: 3,
      generated_at: now - 86_400,
      digest_title: "Second Public Weekly",
      digest_meta: JSON.stringify({ type: "weekly" }),
    });
    const db = mockD1([{ match: "daily_digest", rows: [weekly2, sentinel, weekly1] }]);
    const res = await handleDigestArchive(db);
    const body = (await res.json()) as {
      digests: Array<{ digestTitle: string | null; editionNumber: number; isInternal?: unknown }>;
    };
    expect(body.digests.map((d) => d.digestTitle)).toEqual(["Second Public Weekly", "First Weekly"]);
    // The hidden sentinel occupied weekly edition 2, so the later public
    // weekly keeps its published number 3.
    expect(body.digests.map((d) => d.editionNumber)).toEqual([3, 1]);
    expect(body.digests[0]).not.toHaveProperty("isInternal");
  });
});
