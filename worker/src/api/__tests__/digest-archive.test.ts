import { describe, it, expect } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { makeDigestRow } from "./helpers/fixtures";
import { handleDigestArchive } from "../digest-archive";

describe("handleDigestArchive", () => {
  it("returns 200 with empty digests when no data", async () => {
    const db = mockD1();
    const res = await handleDigestArchive(db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { digests: unknown[] };
    expect(body.digests).toEqual([]);
  });

  it("returns 200 with digests array", async () => {
    const row = makeDigestRow({
      input_data: JSON.stringify({
        stabilityIndex: { score: 72, band: "Stable" },
        totalMcapUsd: 150e9,
      }),
    });
    const db = mockD1([{ match: "daily_digest", rows: [row] }]);
    const res = await handleDigestArchive(db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      digests: Array<{
        digestText: string;
        digestTitle: string | null;
        generatedAt: number;
        psiScore: number | null;
        psiBand: string | null;
        totalMcapUsd: number | null;
      }>;
    };
    expect(body.digests).toHaveLength(1);
    expect(body.digests[0]).toHaveProperty("digestText");
    expect(body.digests[0]).toHaveProperty("generatedAt");
    expect(body.digests[0].psiScore).toBe(72);
    expect(body.digests[0].psiBand).toBe("Stable");
    expect(body.digests[0].totalMcapUsd).toBe(150e9);
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
});
