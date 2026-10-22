import { DatabaseSync } from "node:sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { DigestArchiveResponseSchema } from "@shared/types/digest";
import { PUBLIC_STATIC_ROUTES } from "../../routes/public-routes";
import { createEdgeCacheContext } from "../../handlers/http/edge-cache";
import { makeExecutionContext, readJsonResponse } from "../../test-helpers/__shared/auth";
import { describe, it, expect, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTempRepo } from "../../../../scripts/__tests__/helpers/test-state";
import { findMissingDigestArchiveDates, runDigestSync } from "../../../../scripts/maintenance/sync-digests";
import type { DigestContentEntry } from "@shared/types/digest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { EDITORIAL_STYLE_HASH, EDITORIAL_STYLE_VERSION } from "@shared/lib/editorial-style";
import { makeDigestRow } from "../../test-helpers/__shared/fixtures";
import { handleDigestArchive } from "../digest-archive";
import { handleDailyDigest } from "../daily-digest";

it("forwards history/cursors through the lazy route and traverses tied timestamps at a stable insertion horizon", async () => {
  const { sqlite, db } = createLatestSchemaSqlite();
  try {
    const insert = sqlite.prepare("INSERT INTO daily_digest (digest_text, generated_at, input_data, digest_meta) VALUES (?, ?, '{}', ?)");
    for (let edition = 1; edition <= 400; edition++) {
      insert.run(`Daily ${edition}`, 1_700_000_000 + Math.floor((edition - 1) / 2), null);
    }
    insert.run("Hidden", 1_699_999_999, '{"internal":true,"type":"weekly"}');
    const route = PUBLIC_STATIC_ROUTES.find((entry) => entry.endpoint.key === "digest-archive")!;
    const load = async (cursor: string | null) => {
      const url = new URL("https://api.example.com/api/digest-archive?history=all");
      if (cursor) url.searchParams.set("cursor", cursor);
      expect(createEdgeCacheContext(new Request(url), url).cacheKey.url).toBe(url.toString());
      const response = await route.handler({
        url, db, request: new Request(url), trustedAdmin: false,
        execCtx: makeExecutionContext().ctx,
      });
      expect(response.status).toBe(200);
      return DigestArchiveResponseSchema.parse(await response.json());
    };
    const first = await load(null);
    expect(first.digests).toHaveLength(365);
    expect(first.pagination).toMatchObject({ total: 401, scanned: 365 });
    expect(first.pagination?.nextCursor).toEqual(expect.any(String));
    // Neither a newer publication nor a later backdated insert belongs to this run.
    insert.run("Concurrent newest", 1_800_000_000, null);
    insert.run("Concurrent backdated", 1_700_000_000, null);
    const second = await load(first.pagination!.nextCursor);
    expect(second.pagination).toEqual({
      horizon: first.pagination!.horizon, total: 401, scanned: 401, nextCursor: null,
    });
    const archive = [...first.digests, ...second.digests];
    expect(archive.map((row) => row.digestText)).toEqual(
      Array.from({ length: 400 }, (_, index) => `Daily ${400 - index}`),
    );
    expect(archive.map((row) => row.editionNumber)).toEqual(
      Array.from({ length: 400 }, (_, index) => 400 - index),
    );
    // A deletion inside the captured history must not look like a complete page.
    sqlite.prepare("DELETE FROM daily_digest WHERE digest_text = 'Daily 1'").run();
    const continuation = new URL("https://api.example.com/api/digest-archive?history=all");
    continuation.searchParams.set("cursor", first.pagination!.nextCursor!);
    const interrupted = await handleDigestArchive(db, continuation);
    expect(interrupted.status).toBe(409);
    expect(interrupted.headers.get("Cache-Control")).toBe("no-store");
  } finally {
    sqlite.close();
  }
});

it.each(["?cursor=1.2.3.4.5", "?history=all&cursor=bad", "?history=all&cursor=1.1.1.1.1", "?history=partial"])(
  "rejects invalid archive traversal parameters %s",
  async (query) => {
    const response = await handleDigestArchive(mockD1([]), new URL(`https://api.example.com/api/digest-archive${query}`));
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  },
);

it.each([false, true])("matches raw-input archive output and diagnostics with bounded D1 bytes (history=%s)", async (completeHistory) => {
  const sqlite = new DatabaseSync(":memory:");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  // Both handler calls derive X-Data-Age from the wall clock; freeze Date so a
  // second boundary between them cannot make the comparison flake.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
  try {
    sqlite.exec(`CREATE TABLE daily_digest (
      digest_text TEXT NOT NULL, digest_title TEXT, generated_at INTEGER NOT NULL,
      digest_extended TEXT, input_data TEXT, digest_meta TEXT
    )`);
    const unused = "unused capture evidence ".repeat(800);
    const depeg = { symbol: "RISK", bps: -6_000, currentBps: -5_500, mcapUsd: 20_000_000 };
    const daily = {
      stabilityIndex: { score: 72, band: "Stable" },
      totalMcapUsd: 100e9,
      supplyCoverage: { complete: true, observedCount: 2, unavailableCount: 0 },
      topDepegs: [depeg],
      riskTape: [{ id: "risk-tape:depegs", label: "Depegs", value: "RISK 5500bps", tone: "critical" }],
      nextTriggers: [],
      forwardLookOutcomes: [],
      unused,
    };
    const weekly = {
      totalMcapUsd: 100e9,
      dailyDigests: [
        null, false, 7, "not an entry", [],
        { date: "ignored", inputData: null },
        { date: "ignored", inputData: [] },
        { date: "2026-10-18", inputData: { ...daily, activeDepegCount: 4 } },
        // Equal candidates keep their stored order; the first day's count/date win.
        { date: "2026-10-19", inputData: { ...daily, activeDepegCount: 5 } },
        { date: "2026-10-20", inputData: {
          topDepegs: [{ symbol: "WATCH", bps: -1_000, mcapUsd: 1e12 }], unused,
        } },
      ],
      unused,
    };
    const fixtures: Array<{ name: string; input: string | null; meta?: string }> = [];
    for (const activeDepegCount of [undefined, null, 0, 2, false, true, "2", [], { unknown: true }]) {
      fixtures.push({
        name: `daily-count-${JSON.stringify(activeDepegCount)}`,
        input: JSON.stringify({ ...daily, activeDepegCount }),
      });
      fixtures.push({
        name: `weekly-count-${JSON.stringify(activeDepegCount)}`,
        input: JSON.stringify({ dailyDigests: [{ date: false, inputData: { ...daily, activeDepegCount } }] }),
        meta: '{"type":"weekly"}',
      });
    }
    fixtures.push(
      { name: "weekly-candidates", input: JSON.stringify(weekly), meta: '{"type":"weekly"}' },
      { name: "daily-precedence", input: JSON.stringify({ ...weekly, topDepegs: [] }) },
      { name: "wrong-types", input: JSON.stringify({
        stabilityIndex: false, totalMcapUsd: "100", supplyCoverage: null,
        topDepegs: {}, dailyDigests: {}, riskTape: true, nextTriggers: null, forwardLookOutcomes: "bad",
      }) },
      { name: "empty-object", input: "{}" },
      {
        name: "duplicate-daily-keys",
        input: `{"activeDepegCount":1,"activeDepegCount":2,"topDepegs":[],"topDepegs":${JSON.stringify([depeg])}}`,
      },
      {
        name: "duplicate-weekly-keys",
        input: `{"dailyDigests":[],"dailyDigests":[{"date":"first","date":"last","inputData":{},"inputData":{"activeDepegCount":1,"activeDepegCount":3,"topDepegs":${JSON.stringify([depeg])}}}]}`,
        meta: '{"type":"weekly"}',
      },
      {
        name: "extreme-number",
        input: `{"activeDepegCount":1e999,"topDepegs":${JSON.stringify([depeg])}}`,
      },
      ...[null, "", " ", "{bad json", "null", "true", "12", '"scalar"', "[]"].map((input, index) => ({
        name: `malformed-or-root-${index}`, input,
      })),
      { name: "internal", input: JSON.stringify(daily), meta: '{"internal":true}' },
      { name: "blocked", input: JSON.stringify(daily), meta: '{"qualityGate":"blocked","styleGateMode":"enforce"}' },
    );
    for (let index = fixtures.length; index < 270; index++) {
      fixtures.push({
        name: `capture-${index}`,
        input: JSON.stringify(index % 7 === 0 ? weekly : daily),
        meta: index % 7 === 0 ? '{"type":"weekly"}' : undefined,
      });
    }
    const insert = sqlite.prepare("INSERT INTO daily_digest VALUES (?, ?, ?, NULL, ?, ?)");
    fixtures.forEach((fixture, index) => insert.run(
      fixture.name, fixture.name, 1_700_000_000 + index, fixture.input, fixture.meta ?? null,
    ));
    let projectedRows: Record<string, unknown>[] = [];
    const db = createSqliteD1(sqlite, {
      onAll: (sql) => { projectedRows = sqlite.prepare(sql).all(); },
    });
    const url = new URL(`https://api.example.com/api/digest-archive${completeHistory ? "?history=all" : ""}`);
    const projectedResponse = await handleDigestArchive(db, url);
    const projected = await projectedResponse.json() as {
      digests: Array<{ digestTitle: string; riskSignal: Record<string, unknown> | null }>;
    };
    const projectedWarnings = warn.mock.calls.map(([message]) => JSON.parse(String(message)) as { message: string });
    warn.mockClear();
    // Exercise the unchanged response mapper with the pre-projection D1 payload.
    const rawRows = projectedRows.map((row) => ({
      ...row,
      input_data: fixtures[Number(row.archive_id) - 1].input,
    }));
    const rawResponse = await handleDigestArchive(mockD1([{ match: "FROM daily_digest", rows: rawRows }]), url);
    expect(projected).toEqual(await rawResponse.json());
    expect(projectedResponse.headers.get("X-Data-Age")).toBe(rawResponse.headers.get("X-Data-Age"));
    const rawWarnings = warn.mock.calls.map(([message]) => JSON.parse(String(message)) as { message: string });
    expect(projectedWarnings.map((entry) => entry.message)).toEqual(rawWarnings.map((entry) => entry.message));
    expect(projectedWarnings.filter((entry) => entry.message.includes("reason=json-parse-failed"))).toHaveLength(3);
    expect(projectedWarnings.filter((entry) => entry.message.includes("reason=invalid-shape"))).toHaveLength(4);
    const byTitle = new Map(projected.digests.map((row) => [row.digestTitle, row]));
    expect(byTitle.get("daily-count-undefined")?.riskSignal).not.toHaveProperty("activeCount");
    expect(byTitle.get("daily-count-null")?.riskSignal).toHaveProperty("activeCount", null);
    expect(byTitle.get("weekly-candidates")?.riskSignal).toMatchObject({
      symbol: "RISK", bps: -5_500, date: "2026-10-18", activeCount: 4,
    });
    expect(byTitle.get("daily-precedence")?.riskSignal).toBeNull();
    expect(byTitle.get("duplicate-daily-keys")?.riskSignal).toHaveProperty("activeCount", 2);
    expect(byTitle.get("duplicate-weekly-keys")?.riskSignal).toMatchObject({ activeCount: 3, date: "last" });
    expect(byTitle.get("extreme-number")?.riskSignal).toHaveProperty("activeCount", null);
    expect(byTitle.has("internal")).toBe(false);
    expect(byTitle.has("blocked")).toBe(false);
    // Bound the actual row payload crossing D1, not merely the public response.
    const projectedBytes = Buffer.byteLength(JSON.stringify(projectedRows));
    const rawBytes = Buffer.byteLength(JSON.stringify(rawRows));
    expect(projectedBytes).toBeLessThan(rawBytes / 10);
    expect(projectedBytes).toBeLessThan(1_000_000);
    expect(JSON.stringify(projectedRows)).not.toContain(unused);
  } finally {
    vi.useRealTimers();
    warn.mockRestore();
    sqlite.close();
  }
});

describe("handleDigestArchive", () => {
  it("returns 200 with empty digests when no data", async () => {
    const db = mockD1([{ match: "FROM daily_digest", rows: [] }]);
    const res = await handleDigestArchive(db);
    const body = (await readJsonResponse(res, 200)) as { digests: unknown[] };
    expect(body.digests).toEqual([]);
    expect(body).not.toHaveProperty("pagination");
    const history = await handleDigestArchive(db, new URL("https://api.example.com/api/digest-archive?history=all"));
    expect(await history.json()).toMatchObject({
      digests: [], pagination: { horizon: 0, total: 0, scanned: 0, nextCursor: null },
    });
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

  it.each([
    [0, { complete: false, observedCount: 0, unavailableCount: 2 }, null],
    [100e9, { complete: false, observedCount: 1, unavailableCount: 1 }, 100e9],
    [100e9, undefined, 100e9],
    [0, { complete: true, observedCount: 2, unavailableCount: 0 }, 0],
    [100e9, { complete: true, observedCount: 2, unavailableCount: 1 }, 100e9],
  ])("projects validated coverage while keeping legacy proof absent", async (totalMcapUsd, supplyCoverage, expectedAmount) => {
    const db = mockD1([{ match: "daily_digest", rows: [makeDigestRow({
      input_data: JSON.stringify({ totalMcapUsd, supplyCoverage }),
    })] }]);
    const body = DigestArchiveResponseSchema.parse(await (await handleDigestArchive(db)).json());
    expect(body.digests[0].totalMcapUsd).toBe(expectedAmount);
    if (supplyCoverage && !(supplyCoverage.complete && supplyCoverage.unavailableCount > 0)) {
      expect(body.digests[0].supplyCoverage).toEqual(supplyCoverage);
    } else {
      expect(body.digests[0]).not.toHaveProperty("supplyCoverage");
    }
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
    const db = mockD1([{ match: "daily_digest", rows: [
      { ...weekly2, edition_number: 3 },
      { ...sentinel, edition_number: 2 },
      { ...weekly1, edition_number: 1 },
    ] }]);
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

  it("excludes enforced blocked rows from archive, latest reads and both kinds' edition numbers", async () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec(`CREATE TABLE daily_digest (
        digest_text TEXT NOT NULL, digest_title TEXT, generated_at INTEGER NOT NULL,
        digest_extended TEXT, input_data TEXT, digest_meta TEXT
      )`);
      const insert = sqlite.prepare("INSERT INTO daily_digest VALUES (?, ?, ?, NULL, '{}', ?)");
      for (const kind of ["daily", "weekly"]) {
        insert.run(`${kind} first`, `${kind} first`, 1, JSON.stringify({ type: kind }));
        insert.run(`${kind} blocked`, `${kind} blocked`, 2, JSON.stringify({
          type: kind, qualityGate: "blocked", styleGateMode: "enforce",
          editorialStyleGate: { mode: "enforce", firstPassWouldBlock: true },
        }));
        insert.run(`${kind} second`, `${kind} second`, 3, JSON.stringify({ type: kind }));
      }
      const db = createSqliteD1(sqlite);
      const archive = await (await handleDigestArchive(db)).json() as {
        digests: Array<{ digestText: string; editionNumber: number }>;
      };
      expect(archive.digests).toHaveLength(4);
      expect(archive.digests.map((row) => row.digestText)).not.toContain("daily blocked");
      expect(archive.digests.map((row) => row.digestText)).not.toContain("weekly blocked");
      expect(archive.digests.filter((row) => row.digestText.endsWith("second")).map((row) => row.editionNumber)).toEqual([2, 2]);
      const latest = await (await handleDailyDigest(db)).json();
      expect(latest).toMatchObject({ digest: "daily second", editionNumber: 2 });
    } finally {
      sqlite.close();
    }
  });

  it("keeps published edition numbers stable after the archive exceeds its response window", async () => {
    async function loadEditions(rowCount: number): Promise<Map<string, number>> {
      const sqlite = new DatabaseSync(":memory:");
      try {
        sqlite.exec(`
          CREATE TABLE daily_digest (
            digest_text TEXT NOT NULL,
            digest_title TEXT,
            generated_at INTEGER NOT NULL,
            digest_extended TEXT,
            input_data TEXT,
            digest_meta TEXT
          )
        `);
        const insert = sqlite.prepare(`
          INSERT INTO daily_digest (
            digest_text, digest_title, generated_at, digest_extended, input_data, digest_meta
          ) VALUES (?, ?, ?, NULL, '{}', NULL)
        `);
        sqlite.exec("BEGIN");
        for (let edition = 1; edition <= rowCount; edition += 1) {
          insert.run(`Digest ${edition}`, `Edition ${edition}`, edition);
        }
        sqlite.exec("COMMIT");

        const body = await (await handleDigestArchive(createSqliteD1(sqlite))).json() as {
          digests: Array<{ digestTitle: string; editionNumber: number }>;
        };
        return new Map(body.digests.map((digest) => [digest.digestTitle, digest.editionNumber]));
      } finally {
        sqlite.close();
      }
    }

    const editionsAt300 = await loadEditions(300);
    const editionsAt400 = await loadEditions(400);
    const sharedEditions = [...editionsAt300].filter(([title]) => editionsAt400.has(title));

    expect(sharedEditions).toHaveLength(265);
    expect(editionsAt400.size).toBe(365);
    for (const [title, editionNumber] of sharedEditions) {
      expect(editionsAt400.get(title)).toBe(editionNumber);
    }
    expect(editionsAt400.get("Edition 36")).toBe(36);
  });
});

it("projects the actual final served model without substituting the requested model", async () => {
  const db = mockD1([{ match: "daily_digest", rows: [
    makeDigestRow({ id: 2, digest_meta: JSON.stringify({ llm: { model: "requested", attempts: [{ servedModel: "first" }, { servedModel: "claude-sonnet-5" }] } }) }),
    makeDigestRow({ id: 1, digest_meta: JSON.stringify({ llm: { model: "requested", attempts: [{ servedModel: null }] } }) }),
  ] }]);
  const body = await (await handleDigestArchive(db)).json() as { digests: { llm?: { servedModel: string } }[] };
  expect(body.digests[0].llm).toEqual({ servedModel: "claude-sonnet-5" });
  expect(body.digests[1].llm).toBeUndefined();
});

it("credits the model that produced the copy when a heavy audit attempt ran last", async () => {
  const db = mockD1([{ match: "daily_digest", rows: [
    makeDigestRow({ id: 1, digest_meta: JSON.stringify({ llm: { model: "requested", copyServedModel: "claude-opus-5-5", attempts: [{ servedModel: "claude-opus-5-5" }, { servedModel: null }] } }) }),
  ] }]);
  const body = await (await handleDigestArchive(db)).json() as { digests: { llm?: { servedModel: string } }[] };
  expect(body.digests[0].llm).toEqual({ servedModel: "claude-opus-5-5" });
});
// This API-plus-mirror test belongs on the Worker side of ADR-2: scripts
// must not import Worker handlers merely to exercise the full traversal.
it("refreshes more than 365 editions from the API without losing permanent slugs", async () => {
  await withTempRepo("digest-archive-sync", {}, async (root) => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const output = join(root, "digests.json");
      const start = Date.parse("2025-01-01") / 1000;
      const previous: DigestContentEntry[] = Array.from({ length: 400 }, (_, index) => ({
        date: new Date((start + index * 86_400) * 1000).toISOString().slice(0, 10),
        generatedAt: start + index * 86_400, editionNumber: index + 1,
        title: `Edition ${index + 1}`, text: "Summary", extended: "", digestType: "daily",
      }));
      writeFileSync(output, JSON.stringify(previous));
      const insert = sqlite.prepare("INSERT INTO daily_digest (digest_text, generated_at, input_data) VALUES (?, ?, '{}')");
      for (let index = 0; index <= 400; index++) insert.run(`Edition ${index + 1}`, start + index * 86_400);
      const requests: URL[] = [];
      vi.stubGlobal("fetch", vi.fn(async (input: string) => {
        const url = new URL(input);
        requests.push(url);
        return handleDigestArchive(db, url);
      }));
      await runDigestSync(["--api-url", "https://api.example.com", "--output", output]);
      const current = JSON.parse(readFileSync(output, "utf8")) as DigestContentEntry[];
      expect(current).toHaveLength(401);
      expect(findMissingDigestArchiveDates(previous, current)).toEqual([]);
      expect(current[0]).toMatchObject({ date: "2026-02-05", editionNumber: 401, text: "Edition 401" });
      expect(current[current.length - 1]).toMatchObject({ date: "2025-01-01", editionNumber: 1 });
      expect(requests).toHaveLength(2);
      expect(requests[1].searchParams.get("cursor")).toEqual(expect.any(String));
    } finally {
      sqlite.close();
      vi.unstubAllGlobals();
    }
  });
});
