import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { DigestPromoResponseSchema } from "@shared/types/digest";
import { getEndpointDefinitionByKey, getProbePaths } from "@shared/lib/api-endpoints";
import { handleDailyDigest } from "../daily-digest";
import { handleDigestArchive } from "../digest-archive";
import { handleDigestPromo } from "../digest-promo";

const databases: DatabaseSync[] = [];

function createDigestDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  databases.push(sqlite);
  sqlite.exec(`CREATE TABLE daily_digest (
    digest_text TEXT NOT NULL, digest_title TEXT, generated_at INTEGER NOT NULL,
    digest_extended TEXT, input_data TEXT, digest_meta TEXT
  )`);
  const insert = sqlite.prepare("INSERT INTO daily_digest VALUES (?, ?, ?, ?, '{}', ?)");
  return { sqlite, db: createSqliteD1(sqlite), insert };
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
});

describe("handleDigestPromo", () => {
  it("registers a dedicated strict site-only GET without public or operator probes", () => {
    expect(getEndpointDefinitionByKey("digest-promo")).toMatchObject({
      path: "/api/digest-promo",
      methods: ["GET"],
      publicApiAccess: "site-only",
      siteDataAccess: "allowed",
      strictContract: true,
    });
    for (const group of ["public", "admin", "manual"] as const) {
      expect(getProbePaths(group)).not.toContain("/api/digest-promo");
    }
  });

  it("bounds daily titles after numbering the full history and matches existing displayed editions", async () => {
    const { db, insert } = createDigestDatabase();
    const start = Date.parse("2025-01-01T08:05:00Z") / 1000;
    for (let index = 1; index <= 400; index += 1) {
      insert.run(`Text ${index}`, `Title ${index}`, start + index * 86400, "Unused extended body", null);
    }
    insert.run("Hidden", "Hidden", start + 400 * 86400 + 1, null, JSON.stringify({ internal: true }));
    insert.run("Blocked", "Blocked", start + 400 * 86400 + 2, null, JSON.stringify({ qualityGate: "blocked" }));
    insert.run("Weekly", "Weekly", start + 400 * 86400 + 3, null, JSON.stringify({ type: "weekly" }));

    const response = await handleDigestPromo(db);
    expect(response.status).toBe(200);
    const promo = DigestPromoResponseSchema.parse(await response.json());
    const daily = await (await handleDailyDigest(db)).json() as { editionNumber: number; generatedAt: number; digestTitle: string };
    const archive = await (await handleDigestArchive(db)).json() as {
      digests: { digestTitle: string; editionNumber: number; generatedAt: number; digestType: string }[];
    };
    const previous = archive.digests
      .filter((entry) => entry.digestType !== "weekly" && entry.editionNumber !== daily.editionNumber && entry.generatedAt !== daily.generatedAt)
      .slice(0, 2);

    expect(promo.latest).toMatchObject({ digestTitle: daily.digestTitle, editionNumber: daily.editionNumber, generatedAt: daily.generatedAt, excerpt: "Text 400" });
    expect(promo.latest?.editionNumber).toBe(401);
    expect(promo.previousEditions.map(({ digestTitle, editionNumber, generatedAt }) => ({ digestTitle, editionNumber, generatedAt })))
      .toEqual(previous.map(({ digestTitle, editionNumber, generatedAt }) => ({ digestTitle, editionNumber, generatedAt })));
    expect(promo.previousEditions.map((entry) => entry.editionNumber)).toEqual([399, 398]);
    expect(promo.latest?.slug).toBe(new Date(daily.generatedAt * 1000).toISOString().slice(0, 10));
    expect(Object.keys(promo.previousEditions[0]).sort()).toEqual(["digestTitle", "editionNumber", "generatedAt", "slug"]);
    expect(response.headers.get("X-Data-Age")).not.toBeNull();
  });

  it("retains internal numbering gaps without exposing internal or blocked titles", async () => {
    const { db, insert } = createDigestDatabase();
    insert.run("First", "First", 1, null, null);
    insert.run("Internal", "Internal", 2, null, JSON.stringify({ internal: "true" }));
    insert.run("Blocked", "Blocked", 3, null, JSON.stringify({ qualityGate: "blocked" }));
    insert.run("Second", "Second", 4, null, null);
    insert.run("Third", "Third", 5, null, null);
    const promo = DigestPromoResponseSchema.parse(await (await handleDigestPromo(db)).json());
    expect(promo.latest).toMatchObject({ digestTitle: "Third", editionNumber: 4 });
    expect(promo.previousEditions.map((entry) => [entry.digestTitle, entry.editionNumber])).toEqual([["Second", 3], ["First", 1]]);
  });

  it("uses only the first nonempty extended paragraph when the short text is blank", async () => {
    const { db, insert } = createDigestDatabase();
    insert.run(" \n ", null, 1, "\n\n First   paragraph.\n\nSecond paragraph.", null);
    const promo = DigestPromoResponseSchema.parse(await (await handleDigestPromo(db)).json());
    expect(promo.latest).toMatchObject({ digestTitle: null, excerpt: "First paragraph." });
    expect(promo.previousEditions).toEqual([]);
  });

  it("reads bodies only for the latest visible edition, outside the numbering window", async () => {
    const { sqlite, insert } = createDigestDatabase();
    for (let index = 1; index <= 4; index++) insert.run(`Copy ${index}`, `Title ${index}`, index, "Large prior body".repeat(10_000), null);
    let selectedSql = "";
    const db = createSqliteD1(sqlite, { onAll: (sql) => { selectedSql = sql; } });
    const response = await handleDigestPromo(db);
    expect(response.status).toBe(200);
    const selected = sqlite.prepare(selectedSql).all();
    expect(selected).toHaveLength(3);
    expect(selected[0]).toMatchObject({ digest_text: "Copy 4" });
    expect(selected.slice(1)).toEqual([
      expect.objectContaining({ digest_text: null, digest_extended: null, digest_title: "Title 3" }),
      expect.objectContaining({ digest_text: null, digest_extended: null, digest_title: "Title 2" }),
    ]);
    expect(selectedSql.slice(0, selectedSql.indexOf("), visible AS"))).not.toMatch(/digest_text|digest_extended/);
  });

  it("keeps a successfully empty projection unavailable without inventing a producer clock", async () => {
    const { db } = createDigestDatabase();
    const response = await handleDigestPromo(db);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ latest: null, previousEditions: [] });
    expect(response.headers.has("X-Data-Age")).toBe(false);
  });

  it("returns a reasoned uncached failure instead of an empty success on failed reads", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = mockD1([{ match: "FROM daily_digest", rows: [], throwError: new Error("read failed") }]);
    const response = await handleDigestPromo(db);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "Digest promo unavailable", reason: "digest-promo-unavailable" });
  });

  it("does not admit invalid edition metadata as a successful projection", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = mockD1([{ match: "FROM daily_digest", rows: [{
      digest_title: "Invalid", digest_text: "Copy", digest_extended: null,
      generated_at: 1, edition_number: 0, daily_count: 0,
    }] }]);
    const response = await handleDigestPromo(db);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ reason: "digest-promo-unavailable" });
  });

  it("rejects projection responses exceeding the prior-edition bound before cache admission", () => {
    const edition = { digestTitle: "Title", editionNumber: 1, generatedAt: 1, slug: "1970-01-01" };
    expect(DigestPromoResponseSchema.safeParse({ latest: null, previousEditions: [edition, edition, edition] }).success).toBe(false);
  });
});
