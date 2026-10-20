import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DepegEventStoredSnapshotSchema, type DepegEvent, type DepegEventEntry } from "@shared/types/market";
import {
  assertStaticDepegArchivePreserved,
  assignSlugs,
  findMissingStaticDepegArchiveSlugs,
  preserveStaticDepegArchiveEntries,
  runDepegSync,
} from "../maintenance/sync-depeg-events";
import { createTempRepoTracker } from "./helpers/test-state";
import { SnapshotIntegrityError } from "../lib/sync-from-api";
import { readDepegLedgerCapture } from "../lib/depeg-ledger-capture";

const { cleanup, makeRoot } = createTempRepoTracker("depeg-event-shards-test");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  cleanup();
});

function event(overrides: Partial<DepegEvent> = {}): DepegEvent {
  return {
    id: 1,
    stablecoinId: "usdc-circle",
    symbol: "USDC",
    pegType: "USD",
    direction: "below",
    peakDeviationBps: 300,
    startedAt: Date.UTC(2026, 4, 15) / 1000,
    endedAt: null,
    startPrice: 1,
    peakPrice: 0.97,
    recoveryPrice: null,
    pegReference: 1,
    source: "live",
    confirmationSources: "CoinGecko",
    pendingReason: null,
    closeReason: null,
    provenance: null,
    ...overrides,
  };
}

describe("sync-depeg-events", () => {
  it("assigns deterministic slugs for same-coin same-day events", () => {
    const entries = assignSlugs([event({ id: 2, direction: "above" }), event({ id: 1, direction: "below" })]);

    expect(entries.map((entry) => entry.slug)).toEqual(["usdc-2026-05-15-up", "usdc-2026-05-15-down"]);
  });

  it("reserves all existing collision slugs and assigns newcomers independently of input order", () => {
    const prior = assignSlugs([event({ id: 1 }), event({ id: 2, direction: "above" })]);
    const newcomers = [
      event({ id: 3 }),
      event({ id: 4, stablecoinId: "another-usdc", direction: "above" }),
    ];
    const expanded = [...prior, ...newcomers];
    const expected = {
      1: "usdc-2026-05-15-down",
      2: "usdc-2026-05-15-up",
      3: "usdc-2026-05-15-down-3",
      4: "usdc-2026-05-15-up-4",
    };
    for (const input of [expanded, [...expanded].reverse()]) {
      const assigned = assignSlugs(input, prior);
      expect(Object.fromEntries(assigned.map((entry) => [entry.id, entry.slug]))).toEqual(expected);
    }
    expect(() => assignSlugs([event({ stablecoinId: "different-coin" })], prior))
      .toThrow(SnapshotIntegrityError);
  });

  it("keeps published URLs and editorial keys across growing same-day captures and still rejects deletion", async () => {
    const dataDir = makeRoot();
    const indexPath = join(dataDir, "index.json");
    let apiEvents = [event({ peakDeviationBps: 800 })];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ events: apiEvents, total: apiEvents.length })));
    const args = ["--api-url", "https://api.example.test", "--output", indexPath];
    await runDepegSync(args);
    const shardPath = join(dataDir, "2026.json");
    const published = JSON.parse(readFileSync(shardPath, "utf8")) as DepegEventEntry[];
    const editorialKey = published[0].slug;
    expect(editorialKey).toBe("usdc-2026-05-15");

    apiEvents = [event({ id: 2, direction: "above", peakDeviationBps: 900 }), ...apiEvents];
    await runDepegSync(args);
    let captured = DepegEventStoredSnapshotSchema.parse(JSON.parse(readFileSync(shardPath, "utf8")));
    expect(captured.find((entry) => entry.id === 1)?.slug).toBe(editorialKey);
    const secondKey = captured.find((entry) => entry.id === 2)?.slug;
    expect(secondKey).toBe("usdc-2026-05-15-up");

    apiEvents = [...apiEvents, event({ id: 3, peakDeviationBps: 700 }),
      event({ id: 4, stablecoinId: "another-usdc", peakDeviationBps: 800 })].reverse();
    await runDepegSync(args);
    captured = DepegEventStoredSnapshotSchema.parse(JSON.parse(readFileSync(shardPath, "utf8")));
    expect(captured.find((entry) => entry.id === 1)?.slug).toBe(editorialKey);
    expect(captured.find((entry) => entry.id === 2)?.slug).toBe(secondKey);
    expect(new Set(captured.map((entry) => entry.slug)).size).toBe(4);
    const routes = JSON.parse(readFileSync(indexPath, "utf8")) as { slug: string }[];
    expect(routes.map((entry) => entry.slug)).toContain(editorialKey);
    expect(routes.map((entry) => entry.slug)).toContain(secondKey);

    const bytes = readFileSync(shardPath, "utf8");
    apiEvents = [event({ id: 5, peakDeviationBps: 800 })];
    await expect(runDepegSync([...args, "--allow-existing-on-fetch-failure"]))
      .rejects.toThrow("lost 4 published slug(s)");
    expect(readFileSync(shardPath, "utf8")).toBe(bytes);
  });

  it.each([
    { events: [event({ direction: "sideways" as DepegEvent["direction"] })] },
    { events: [{ ...event(), peakDeviationBps: "800" }] },
    { events: [event({ endedAt: event().startedAt - 1 })] },
    { events: [event({ startedAt: -1 })] },
    { events: "not-an-array" },
    { nextCursor: 7 },
    { nextCursor: "" },
    { total: -1 },
    { total: 1.5 },
    { total: "1" },
    null,
  ])("rejects corrupt response %j without touching archive bytes or capture metadata", async (invalidFields) => {
    const dataDir = makeRoot();
    const indexPath = join(dataDir, "index.json");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ events: [event()] })));
    const args = ["--api-url", "https://api.example.test", "--output", indexPath];
    await runDepegSync(args);
    const paths = [indexPath, join(dataDir, "2026.json"), join(dataDir, "metadata/capture.json")];
    const before = paths.map((path) => readFileSync(path, "utf8"));
    vi.stubGlobal("fetch", vi.fn(async () => invalidFields === null
      ? new Response("{invalid")
      : Response.json({ events: [event()], total: 1, ...invalidFields })));
    await expect(runDepegSync([...args, "--allow-existing-on-fetch-failure"]))
      .rejects.toThrow(SnapshotIntegrityError);
    expect(paths.map((path) => readFileSync(path, "utf8"))).toEqual(before);
  });

  it("round-trips legacy event fields through the shared stored schema", async () => {
    const dataDir = makeRoot();
    const legacy = Object.fromEntries(Object.entries(event()).filter(
      ([key]) => !["provenance", "confirmationSources", "pendingReason", "closeReason"].includes(key),
    ));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ events: [legacy] })));
    await runDepegSync(["--api-url", "https://api.example.test", "--output", join(dataDir, "index.json")]);
    const stored = DepegEventStoredSnapshotSchema.parse(JSON.parse(readFileSync(join(dataDir, "2026.json"), "utf8")));
    expect(stored[0]).toMatchObject({ id: 1, provenance: null, confirmationSources: null, pendingReason: null, closeReason: null });
    expect(readDepegLedgerCapture(dataDir).apiTotal).toBeNull();
  });

  it("refuses to remove a published static event even when total event count grows", () => {
    const published: DepegEventEntry = { ...event({ id: 1, peakDeviationBps: -800 }), slug: "usdc-2026-05-15" };
    const subthreshold: DepegEventEntry = {
      ...event({ id: 2, peakDeviationBps: -300, startedAt: Date.UTC(2026, 4, 16) / 1000 }),
      slug: "usdc-2026-05-16",
    };
    const replacement: DepegEventEntry = {
      ...event({ id: 3, peakDeviationBps: -300, startedAt: Date.UTC(2026, 4, 17) / 1000 }),
      slug: "usdc-2026-05-17",
    };

    expect(
      findMissingStaticDepegArchiveSlugs(
        [published, subthreshold],
        [subthreshold, replacement],
      ),
    ).toEqual([published.slug]);
    expect(() =>
      assertStaticDepegArchivePreserved(
        [published, subthreshold],
        [subthreshold, replacement],
      ),
    ).toThrow("Depeg static archive lost 1 published slug(s): usdc-2026-05-15");
  });

  it("allows subthreshold rows to disappear and supports an explicit reviewed override", () => {
    const subthreshold: DepegEventEntry = { ...event({ peakDeviationBps: -300 }), slug: "usdc-2026-05-15" };
    const published: DepegEventEntry = { ...event({ peakDeviationBps: -800 }), slug: "usdc-2026-05-15" };

    expect(() => assertStaticDepegArchivePreserved([subthreshold], [])).not.toThrow();
    expect(() => assertStaticDepegArchivePreserved([published], [], true)).not.toThrow();
  });

  it("carries a published row forward when the live record becomes subthreshold", () => {
    const published: DepegEventEntry = { ...event({ id: 1, peakDeviationBps: -800 }), slug: "usdc-2026-05-15" };
    const reclassified: DepegEventEntry = { ...event({ id: 2, peakDeviationBps: -129 }), slug: "usdc-2026-05-15" };
    const replacement: DepegEventEntry = {
      ...event({ id: 3, peakDeviationBps: -600, startedAt: Date.UTC(2026, 4, 16) / 1000 }),
      slug: "usdc-2026-05-16",
    };

    const merged = preserveStaticDepegArchiveEntries(
      [published],
      [reclassified, replacement],
    );

    expect(merged.find((entry) => entry.slug === published.slug)).toMatchObject({
      id: published.id,
      peakDeviationBps: published.peakDeviationBps,
    });
    expect(findMissingStaticDepegArchiveSlugs([published], merged)).toEqual([]);
    expect(() => assertStaticDepegArchivePreserved([published], merged)).not.toThrow();
    const deleted = preserveStaticDepegArchiveEntries([published], [replacement]);
    expect(() => assertStaticDepegArchivePreserved([published], deleted)).toThrow("lost 1 published slug");
  });

  it.each([
    "https://api.example.test/_site-data",
    "https://api.example.test/_site-data/depeg-events",
  ])("preserves consolidated member URLs using the release API environment %s", async (apiBase) => {
    const dataDir = makeRoot();
    const indexPath = join(dataDir, "index.json");
    const original = event({
      id: 90453, stablecoinId: "usda-alpha-partner", symbol: "USDA", peakDeviationBps: -503,
      startedAt: 1783297163,
    });
    const representative = event({
      ...original, id: 90773, peakDeviationBps: -129, constituentEventCount: 2,
    });
    const lineage = {
      rows: [{
        eventId: original.id, stablecoinId: original.stablecoinId, direction: original.direction,
        incidentKey: "ddr2:usda", live: { currentEventId: representative.id, eventState: "active" },
      }],
    };
    let apiEvents = [original];
    const fetchMock = vi.fn(async (input: string) => new URL(input).pathname.endsWith("/depeg-resolver")
      ? Response.json(lineage)
      : Response.json({ events: apiEvents, total: apiEvents.length }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("DEPEG_EVENTS_API_URL", apiBase);
    const args = ["--output", indexPath];
    await runDepegSync(args);
    const shardPath = join(dataDir, "2026.json");
    const published = DepegEventStoredSnapshotSchema.parse(JSON.parse(readFileSync(shardPath, "utf8")))[0];
    expect(published.slug).toBe("usda-2026-07-06");

    apiEvents = [representative];
    for (let capture = 0; capture < 2; capture++) {
      await runDepegSync(args);
      const captured = DepegEventStoredSnapshotSchema.parse(JSON.parse(readFileSync(shardPath, "utf8")));
      expect(captured.find((entry) => entry.id === original.id)).toEqual(published);
      expect(captured.find((entry) => entry.id === representative.id)).toMatchObject({
        slug: "usda-2026-07-06-down", peakDeviationBps: -129,
      });
      expect(JSON.parse(readFileSync(indexPath, "utf8"))).toEqual([expect.objectContaining({ slug: published.slug })]);
      expect(readDepegLedgerCapture(dataDir)).toMatchObject({ eventCount: 2, apiTotal: 1 });
    }
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/depeg-resolver")).map(([url]) => url))
      .toEqual(Array(2).fill("https://api.example.test/_site-data/depeg-resolver"));
    const paths = [indexPath, shardPath, join(dataDir, "metadata/capture.json")];
    const before = paths.map((path) => readFileSync(path, "utf8"));
    await runDepegSync([...args, "--dry-run"]);
    expect(paths.map((path) => readFileSync(path, "utf8"))).toEqual(before);

    apiEvents = [event({ ...representative, id: 99999 })];
    await expect(runDepegSync([...args, "--allow-existing-on-fetch-failure"]))
      .rejects.toThrow("lost 1 published slug(s): usda-2026-07-06");
    expect(paths.map((path) => readFileSync(path, "utf8"))).toEqual(before);
  });

  it.each([
    { name: "unlinked matching onset", eventId: 3 },
    { name: "absent representative", currentEventId: 3 },
    { name: "different incident coin", stablecoinId: "another-usdc" },
    { name: "different incident direction", direction: "above" as const },
    { name: "inactive incident", eventState: "closed_pending_review" as const },
    { name: "empty incident identity", incidentKey: "" },
    { name: "single-row representative", constituentEventCount: 1 },
    { name: "different representative coin", representativeCoin: "another-usdc" },
    { name: "different representative direction", representativeDirection: "above" as const },
  ])("still rejects an unexplained missing slug: $name", (scenario) => {
    const previous = assignSlugs([event({ peakDeviationBps: -800 })]);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const current = assignSlugs([event({
      id: 2, peakDeviationBps: -129, constituentEventCount: scenario.constituentEventCount ?? 2,
      stablecoinId: scenario.representativeCoin ?? event().stablecoinId,
      direction: scenario.representativeDirection ?? "below",
    })], previous);
    const merged = preserveStaticDepegArchiveEntries(previous, current, [{
      eventId: scenario.eventId ?? 1,
      incidentKey: scenario.incidentKey ?? "ddr2:test",
      stablecoinId: scenario.stablecoinId ?? event().stablecoinId,
      direction: scenario.direction ?? "below",
      live: { currentEventId: scenario.currentEventId ?? 2, eventState: scenario.eventState ?? "active" },
    }]);
    expect(() => assertStaticDepegArchivePreserved(previous, merged)).toThrow("lost 1 published slug");
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('"slug":"usdc-2026-05-15"'));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('"reasons":['));
  });

  it.each(["malformed JSON", "invalid representative ID", "unrelated lineage"])(
    "rejects %s incident lineage without changing outputs or capture metadata",
    async (scenario) => {
      const dataDir = makeRoot();
      const indexPath = join(dataDir, "index.json");
      const args = ["--api-url", "https://api.example.test", "--output", indexPath];
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ events: [event({ peakDeviationBps: -800 })], total: 1 })));
      await runDepegSync(args);
      const paths = [indexPath, join(dataDir, "2026.json"), join(dataDir, "metadata/capture.json")];
      const before = paths.map((path) => readFileSync(path, "utf8"));
      vi.stubGlobal("fetch", vi.fn(async (input: string) => {
        if (!new URL(input).pathname.endsWith("/depeg-resolver")) {
          return Response.json({ events: [event({ id: 2, constituentEventCount: 2 })], total: 1 });
        }
        return scenario === "malformed JSON" ? new Response("{invalid") : Response.json({
          rows: [{
            eventId: scenario === "unrelated lineage" ? 3 : 1,
            stablecoinId: event().stablecoinId, direction: "below", incidentKey: "ddr2:test",
            live: { currentEventId: scenario === "invalid representative ID" ? "2" : 2, eventState: "active" },
          }],
        });
      }));
      await expect(runDepegSync([...args, "--allow-existing-on-fetch-failure"])).rejects.toThrow(SnapshotIntegrityError);
      expect(paths.map((path) => readFileSync(path, "utf8"))).toEqual(before);
    },
  );

  it.each([false, true])("explains a rejected CI proxy input with constituent fields present=%s", async (hasConstituents) => {
    const dataDir = makeRoot();
    const indexPath = join(dataDir, "index.json");
    vi.stubEnv("DEPEG_EVENTS_API_URL", "https://stablecoin-dashboard.pages.dev/_site-data");
    vi.stubEnv("DEPEG_EVENTS_API_KEY", "");
    vi.stubEnv("SMOKE_API_KEY", "");
    const args = ["--output", indexPath];
    let apiEvents = [event({ peakDeviationBps: -800 })];
    const fetchMock = vi.fn(async (input: string) => new URL(input).pathname.endsWith("/depeg-resolver")
      ? Response.json({ rows: [] })
      : Response.json({ events: apiEvents, total: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    await runDepegSync(args);
    const paths = [indexPath, join(dataDir, "2026.json"), join(dataDir, "metadata/capture.json")];
    const before = paths.map((path) => readFileSync(path, "utf8"));
    apiEvents = [event({ id: 2, constituentEventCount: hasConstituents ? 2 : undefined })];
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(runDepegSync(args)).rejects.toThrow("lost 1 published slug");
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(
      '"slug":"usdc-2026-05-15","eventId":1,"reasons":["incident-not-found"]',
    ));
    if (hasConstituents) {
      expect(log).toHaveBeenCalledWith(expect.stringContaining(
        "Incident lineage source: https://stablecoin-dashboard.pages.dev/_site-data/depeg-resolver; missing published IDs: 1",
      ));
      expect(log).toHaveBeenCalledWith("[sync-depeg-events] Incident lineage: 0 resolver rows admitted");
    } else {
      expect(warning).toHaveBeenCalledWith(
        "[sync-depeg-events] Incident lineage lookup skipped: no multi-constituent API rows",
      );
      expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/depeg-resolver"))).toBe(false);
    }
    expect(paths.map((path) => readFileSync(path, "utf8"))).toEqual(before);
  });

  it("exhausts more than 20 full pages and writes the API's complete event total", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const root = makeRoot();
    const indexPath = join(root, "data/depeg-events/index.json");
    const total = 21_001;
    const fetchMock = vi.fn((input: string) => {
      const url = new URL(input);
      const offset = Number(url.searchParams.get("cursor") ?? 0);
      const length = Math.min(1000, total - offset);
      const events = Array.from({ length }, (_, index) => event({
        id: offset + index + 1,
        symbol: `T${offset + index + 1}`,
        startedAt: Date.UTC(2026, 4, 15) / 1000 - offset - index,
      }));
      return Promise.resolve(new Response(JSON.stringify({
        events,
        total,
        nextCursor: offset + length < total ? String(offset + length) : null,
      })));
    });
    vi.stubGlobal("fetch", fetchMock);

    await runDepegSync(["--api-url", "https://api.example.test", "--output", indexPath]);

    expect(fetchMock).toHaveBeenCalledTimes(22);
    const shard = JSON.parse(readFileSync(join(root, "data/depeg-events/2026.json"), "utf8")) as DepegEvent[];
    expect(shard).toHaveLength(total);
    expect(new Set(shard.map((entry) => entry.id)).size).toBe(total);
    expect(shard.some((entry) => entry.id === total)).toBe(true);
    expect(readDepegLedgerCapture(join(root, "data/depeg-events"))).toMatchObject({
      schemaVersion: 1,
      eventCount: total,
      apiTotal: total,
      captureId: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      sourceUrl: "https://api.example.test/api/depeg-events",
    });
  });

  it("throws at the safety ceiling with an outstanding cursor without replacing existing outputs or using fetch fallback", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const root = makeRoot();
    const indexPath = join(root, "data/depeg-events/index.json");
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ events: [event()] })))));
    await runDepegSync(["--api-url", "https://api.example.test", "--output", indexPath]);
    const shardPath = join(root, "data/depeg-events/2026.json");
    const originalIndex = readFileSync(indexPath, "utf8");
    const originalShard = readFileSync(shardPath, "utf8");
    const originalCapture = readFileSync(join(root, "data/depeg-events/metadata/capture.json"), "utf8");
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      events: [event()],
      nextCursor: "outstanding",
    }))));
    vi.stubGlobal("fetch", fetchMock);

    await expect(runDepegSync([
      "--api-url", "https://api.example.test", "--output", indexPath,
      "--allow-existing-on-fetch-failure",
    ])).rejects.toThrow(SnapshotIntegrityError);

    expect(fetchMock).toHaveBeenCalledTimes(1000);
    expect(readFileSync(indexPath, "utf8")).toBe(originalIndex);
    expect(readFileSync(shardPath, "utf8")).toBe(originalShard);
    expect(readFileSync(join(root, "data/depeg-events/metadata/capture.json"), "utf8")).toBe(originalCapture);
  });

  it("rejects a cursor-exhausted response whose unique event count disagrees with the API total", async () => {
    const root = makeRoot();
    const indexPath = join(root, "data/depeg-events/index.json");
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      events: [event()], total: 2, nextCursor: null,
    })))));

    await expect(runDepegSync([
      "--api-url", "https://api.example.test", "--output", indexPath,
    ])).rejects.toThrow("collected 1 unique events but the API reported 2");
    expect(existsSync(indexPath)).toBe(false);
  });

  it("rejects a total changed by a continuation page without replacing capture metadata", async () => {
    const dataDir = makeRoot();
    const indexPath = join(dataDir, "index.json");
    const args = ["--api-url", "https://api.example.test", "--output", indexPath];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ events: [event()], total: 1 })));
    await runDepegSync(args);
    const paths = [indexPath, join(dataDir, "2026.json"), join(dataDir, "metadata/capture.json")];
    const before = paths.map((path) => readFileSync(path, "utf8"));
    let page = 0;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      events: [event({ id: ++page })], total: page === 1 ? 2 : 3, nextCursor: page === 1 ? "next" : null,
    })));
    await expect(runDepegSync([...args, "--allow-existing-on-fetch-failure"]))
      .rejects.toThrow(SnapshotIntegrityError);
    expect(paths.map((path) => readFileSync(path, "utf8"))).toEqual(before);
  });


  it("rejects a ledger capture when a yearly shard has changed since observation", async () => {
    const root = makeRoot();
    const dataDir = join(root, "data/depeg-events");
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ events: [event()] })))));
    await runDepegSync(["--api-url", "https://api.example.test", "--output", join(dataDir, "index.json")]);
    expect(readDepegLedgerCapture(dataDir).eventCount).toBe(1);
    writeFileSync(join(dataDir, "2026.json"), `${JSON.stringify(assignSlugs([event({ peakPrice: 0.8 })]))}\n`);

    expect(() => readDepegLedgerCapture(dataDir)).toThrow("shards do not match their capture identity");
  });

  it("writes full UTC-year shards and changes only the affected shard for a new event", async () => {
    const root = makeRoot();
    const indexPath = join(root, "data/depeg-events/index.json");
    const older = event({ id: 1, peakDeviationBps: 300, startedAt: Date.UTC(2025, 4, 15) / 1000 });
    const current = event({ id: 2, peakDeviationBps: 800, startedAt: Date.UTC(2026, 4, 15) / 1000 });
    let apiEvents: DepegEvent[] = [older, current];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ events: apiEvents }), { status: 200 }))),
    );

    await runDepegSync(["--api-url", "https://api.example.test", "--output", indexPath]);
    const olderShardPath = join(root, "data/depeg-events/2025.json");
    const currentShardPath = join(root, "data/depeg-events/2026.json");
    const olderShardBefore = readFileSync(olderShardPath, "utf8");
    const currentShardBefore = readFileSync(currentShardPath, "utf8");
    const indexBefore = readFileSync(indexPath, "utf8");

    apiEvents = [
      ...apiEvents,
      event({ id: 3, peakDeviationBps: 900, startedAt: Date.UTC(2026, 5, 17) / 1000 }),
    ];
    await runDepegSync(["--api-url", "https://api.example.test", "--output", indexPath]);

    expect(readFileSync(olderShardPath, "utf8")).toBe(olderShardBefore);
    expect(readFileSync(currentShardPath, "utf8")).not.toBe(currentShardBefore);
    expect(readFileSync(indexPath, "utf8")).not.toBe(indexBefore);
    expect(JSON.parse(readFileSync(olderShardPath, "utf8"))).toHaveLength(1);
    expect(JSON.parse(readFileSync(currentShardPath, "utf8"))).toHaveLength(2);
    expect(JSON.parse(readFileSync(indexPath, "utf8"))).toHaveLength(2);
  });
});
