import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DepegEventStoredSnapshotSchema, type DepegEvent, type DepegEventEntry } from "@shared/types/peg";
import {
  assertStaticDepegArchivePreserved,
  assignSlugs,
  findMissingStaticDepegArchiveSlugs,
  preserveStaticDepegArchiveEntries,
  runDepegSync,
} from "../maintenance/sync-depeg-events";
import { createTempRepoTracker } from "./helpers/test-state";
import { SnapshotIntegrityError } from "../lib/sync-from-api";
import { readDepegEventPageEntries, readDepegEventSnapshot } from "../../src/lib/depeg-event-snapshot";
import { buildDepegEventTitle } from "../../src/lib/depeg-event-display";
import { projectDepegHistory } from "../lib/public-dataset-projections";
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
    id: 1, stablecoinId: "usdc-circle", symbol: "USDC", pegType: "USD", direction: "below",
    peakDeviationBps: 300, startedAt: Date.UTC(2026, 4, 15) / 1000, endedAt: null,
    startPrice: 1, peakPrice: 0.97, recoveryPrice: null, pegReference: 1, source: "live",
    confirmationSources: "CoinGecko", pendingReason: null, closeReason: null, provenance: null, ...overrides,
  };
}

describe("sync-depeg-events", () => {
  function depegSyncFixture(apiUrl = "https://api.example.test") {
    const dataDir = makeRoot(), indexPath = join(dataDir, "index.json");
    return { dataDir, indexPath, args: ["--api-url", apiUrl, "--output", indexPath] };
  }
  const missingManifest = () => Response.json({ reason: "ledger-manifest-unavailable" }, { status: 503 });
  const eursIncident = () => event({ id: 91041, stablecoinId: "eurs-stasis", symbol: "EURS", pegType: "peggedEUR", peakDeviationBps: -775 });

  it("uses an unverified traversal when the first page has no manifest", async () => {
    const { dataDir, args } = depegSyncFixture();
    const fetchMock = vi.fn(async (url: string) => new URL(url).searchParams.has("ledgerGeneration")
      ? missingManifest()
      : Response.json({ events: [event()], total: 1, nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);
    await runDepegSync(args);
    expect(fetchMock.mock.calls.map(([url]) => new URL(url).searchParams.get("ledgerGeneration"))).toEqual(["latest", null]);
    expect(readDepegLedgerCapture(dataDir).ledgerProof).toBeUndefined();
    expect(readDepegLedgerCapture(dataDir).eventCount).toBe(1);
  });

  it("uses limit=5000 on site-api with 400 fallback to 1000, keeps public API at 1000, and honors PHAROS_DEPEG_SKIP_LEDGER_PROBE=1", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.map(([u]) => {
      const p = new URL(String(u)).searchParams;
      return `${p.get("limit")}:${p.get("ledgerGeneration") ?? "none"}`;
    });
    // site-api unpinned (after missing manifest): upgrades to 5000 across pages
    let f = depegSyncFixture("https://site-api.pharos.watch");
    let fetchMock = vi.fn(async (url: string) => {
      const p = new URL(url).searchParams;
      if (p.has("ledgerGeneration")) return missingManifest();
      return Response.json(p.has("cursor") ? { events: [event({ id: 2 })], total: 2, nextCursor: null } : { events: [event({ id: 1 })], total: 2, nextCursor: "p2" });
    });
    vi.stubGlobal("fetch", fetchMock);
    await runDepegSync(f.args);
    expect(calls(fetchMock)).toEqual(["1000:latest", "5000:none", "5000:none"]);
    // site-api rolled-back Worker rejecting limit=5000 with 400 falls back to 1000
    f = depegSyncFixture("https://site-api.pharos.watch");
    fetchMock = vi.fn(async (url: string) => {
      const p = new URL(url).searchParams;
      if (p.has("ledgerGeneration")) return missingManifest();
      if (p.get("limit") === "5000") return Response.json({ error: "Invalid limit" }, { status: 400 });
      return Response.json({ events: [event()], total: 1, nextCursor: null });
    });
    vi.stubGlobal("fetch", fetchMock);
    await runDepegSync(f.args);
    expect(calls(fetchMock)).toEqual(["1000:latest", "5000:none", "1000:none"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("falling back to limit=1000"));
    // PHAROS_DEPEG_SKIP_LEDGER_PROBE=1 skips the initial ledgerGeneration probe on site-api & public API
    vi.stubEnv("PHAROS_DEPEG_SKIP_LEDGER_PROBE", "1");
    for (const [host, expected] of [["https://site-api.pharos.watch", "5000:none"], ["https://api.pharos.watch", "1000:none"]] as const) {
      f = depegSyncFixture(host);
      fetchMock = vi.fn(async () => Response.json({ events: [event()], total: 1, nextCursor: null }));
      vi.stubGlobal("fetch", fetchMock);
      await runDepegSync(f.args);
      expect(calls(fetchMock)).toEqual([expected]);
    }
    // Public API without opt-out stays at 1000 even after missing manifest
    vi.stubEnv("PHAROS_DEPEG_SKIP_LEDGER_PROBE", "");
    f = depegSyncFixture("https://api.pharos.watch");
    fetchMock = vi.fn(async (url: string) => new URL(url).searchParams.has("ledgerGeneration")
      ? missingManifest() : Response.json({ events: [event()], total: 1, nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);
    await runDepegSync(f.args);
    expect(calls(fetchMock)).toEqual(["1000:latest", "1000:none"]);
  });

  it("fails a pinned continuation when its manifest vanishes, even with retained-data fallback", async () => {
    const { dataDir, args } = depegSyncFixture();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ events: [event()], total: 1 })));
    await runDepegSync(args);
    const ledgerProof = { generation: "a".repeat(64), coveredFromSec: 1, coveredThroughSec: 2_000_000_000 };
    const fetchMock = vi.fn(async (url: string) => new URL(url).searchParams.has("cursor")
      ? missingManifest()
      : Response.json({ events: Array.from({ length: 1000 }, (_, i) => event({ id: i + 1 })),
        ledgerProof, nextCursor: "next", totalExact: true, total: 1001 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(runDepegSync([...args, "--allow-existing-on-fetch-failure"])).rejects.toThrow(SnapshotIntegrityError);
    expect(fetchMock.mock.calls.map(([url]) => new URL(url).searchParams.get("ledgerGeneration")))
      .toEqual(["latest", ledgerProof.generation]);
    expect(readDepegLedgerCapture(dataDir).eventCount).toBe(1);
  });

  it("captures the corrected event while retaining its dedicated page in the index", async () => {
    const { dataDir, args } = depegSyncFixture();
    let peakDeviationBps = -600;
    const ledgerProof = { generation: "b".repeat(64), coveredFromSec: 1, coveredThroughSec: 2_000_000_000 };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      events: [event({ peakDeviationBps })], total: 1, totalExact: true, nextCursor: null, ledgerProof,
    })));
    await runDepegSync(args);
    peakDeviationBps = -100;
    await runDepegSync(args);
    const dataset = projectDepegHistory(readDepegEventSnapshot({ missing: "throw" }, dataDir), "2026-05-15");
    expect(dataset).toMatchObject([{ peakDeviationBps: -100 }]);
    expect(readDepegEventPageEntries(dataDir)).toMatchObject([{ slug: "usdc-2026-05-15", peakDeviationBps: -600 }]);
    expect(readDepegLedgerCapture(dataDir)).toMatchObject({ eventCount: 1, apiTotal: 1, ledgerProof });
  });

  it("publishes the current review and values at a retained same-event permalink", async () => {
    const { dataDir, args } = depegSyncFixture();
    let row = eursIncident();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ events: [row], total: 1 })));
    await runDepegSync(args);
    const [published] = readDepegEventPageEntries(dataDir);
    expect(buildDepegEventTitle(published, false)).toContain("7.75% Below Peg");

    row = { ...row, peakDeviationBps: -10, peakPrice: 0.999, provenance: { auditVerdict: "false_positive", pegScoreEligible: false } };
    await runDepegSync(args);

    const [corrected] = readDepegEventPageEntries(dataDir);
    expect(corrected).toMatchObject({
      id: published.id, slug: published.slug, peakDeviationBps: -10, peakPrice: 0.999,
      provenance: { auditVerdict: "false_positive", pegScoreEligible: false },
    });
    expect(buildDepegEventTitle(corrected, false)).toContain("0.10% Below Peg (Disputed)");
  });

  it("keeps the reviewed peak at its reserved URL through consolidation", async () => {
    const { dataDir, args } = depegSyncFixture();
    const original = eursIncident();
    const revised = event({ ...original, peakDeviationBps: -210, peakPrice: 0.979,
      provenance: { auditVerdict: "repaired", pegScoreEligible: true } });
    const representative = event({ ...revised, id: 91042, constituentEventCount: 2 });
    let row = original;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new URL(url).pathname.endsWith("/depeg-resolver")
      ? Response.json({ rows: [{
        eventId: original.id, stablecoinId: original.stablecoinId, direction: "below", incidentKey: "ddr2:eurs",
        live: { currentEventId: representative.id, eventState: "active" },
      }] })
      : Response.json({ events: [row], total: 1 })));
    await runDepegSync(args);
    const [published] = readDepegEventPageEntries(dataDir);
    expect(published.peakDeviationBps).toBe(-775);

    row = revised;
    await runDepegSync(args);
    row = representative;
    await runDepegSync(args);
    expect(readDepegEventSnapshot({ missing: "throw" }, dataDir)).toMatchObject([{ id: representative.id }]);
    expect(readDepegEventPageEntries(dataDir)).toMatchObject([{ ...revised, slug: published.slug }]);
  });

  const readOutputs = (dir: string) => ["index.json", "2026.json", "metadata/capture.json"].map((f) => readFileSync(join(dir, f), "utf8"));

  it("assigns deterministic slugs for same-coin same-day events", () => {
    expect(assignSlugs([event({ id: 2, direction: "above" }), event({ id: 1, direction: "below" })]).map((e) => e.slug))
      .toEqual(["usdc-2026-05-15-up", "usdc-2026-05-15-down"]);
  });

  it("reserves all existing collision slugs and assigns newcomers independently of input order", () => {
    const prior = assignSlugs([event({ id: 1 }), event({ id: 2, direction: "above" })]);
    const expanded = [...prior, event({ id: 3 }), event({ id: 4, stablecoinId: "another-usdc", direction: "above" })];
    const expected = { 1: "usdc-2026-05-15-down", 2: "usdc-2026-05-15-up", 3: "usdc-2026-05-15-down-3", 4: "usdc-2026-05-15-up-4" };
    for (const input of [expanded, [...expanded].reverse()]) {
      expect(Object.fromEntries(assignSlugs(input, prior).map((e) => [e.id, e.slug]))).toEqual(expected);
    }
    expect(() => assignSlugs([event({ stablecoinId: "different-coin" })], prior)).toThrow(SnapshotIntegrityError);
  });

  it("keeps published URLs and editorial keys across growing same-day captures and still rejects deletion", async () => {
    const { dataDir, indexPath, args } = depegSyncFixture();
    let apiEvents = [event({ peakDeviationBps: 800 })];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ events: apiEvents, total: apiEvents.length })));
    await runDepegSync(args);
    const shardPath = join(dataDir, "2026.json");
    const editorialKey = (JSON.parse(readFileSync(shardPath, "utf8")) as DepegEventEntry[])[0].slug;
    expect(editorialKey).toBe("usdc-2026-05-15");

    apiEvents = [event({ id: 2, direction: "above", peakDeviationBps: 900 }), ...apiEvents];
    await runDepegSync(args);
    let captured = DepegEventStoredSnapshotSchema.parse(JSON.parse(readFileSync(shardPath, "utf8")));
    expect(captured.find((e) => e.id === 1)?.slug).toBe(editorialKey);
    const secondKey = captured.find((e) => e.id === 2)?.slug;
    expect(secondKey).toBe("usdc-2026-05-15-up");

    apiEvents = [...apiEvents, event({ id: 3, peakDeviationBps: 700 }), event({ id: 4, stablecoinId: "another-usdc", peakDeviationBps: 800 })].reverse();
    await runDepegSync(args);
    captured = DepegEventStoredSnapshotSchema.parse(JSON.parse(readFileSync(shardPath, "utf8")));
    expect(captured.find((e) => e.id === 1)?.slug).toBe(editorialKey);
    expect(captured.find((e) => e.id === 2)?.slug).toBe(secondKey);
    expect(new Set(captured.map((e) => e.slug)).size).toBe(4);
    const routes = (JSON.parse(readFileSync(indexPath, "utf8")) as { slug: string }[]).map((e) => e.slug);
    expect(routes).toContain(editorialKey);
    expect(routes).toContain(secondKey);

    const bytes = readFileSync(shardPath, "utf8");
    apiEvents = [event({ id: 5, peakDeviationBps: 800 })];
    await expect(runDepegSync([...args, "--allow-existing-on-fetch-failure"])).rejects.toThrow("lost 4 published slug(s)");
    expect(readFileSync(shardPath, "utf8")).toBe(bytes);
  });

  it.each([
    { events: [event({ direction: "sideways" as DepegEvent["direction"] })] }, { events: [{ ...event(), peakDeviationBps: "800" }] },
    { events: [event({ endedAt: event().startedAt - 1 })] }, { events: [event({ startedAt: -1 })] },
    { events: "not-an-array" }, { nextCursor: 7 }, { nextCursor: "" }, { total: -1 }, { total: 1.5 }, { total: "1" }, null,
  ])("rejects corrupt response %j without touching archive bytes or capture metadata", async (invalidFields) => {
    const { dataDir, args } = depegSyncFixture();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ events: [event()] })));
    await runDepegSync(args);
    const before = readOutputs(dataDir);
    vi.stubGlobal("fetch", vi.fn(async () => invalidFields === null
      ? new Response("{invalid") : Response.json({ events: [event()], total: 1, ...invalidFields })));
    await expect(runDepegSync([...args, "--allow-existing-on-fetch-failure"])).rejects.toThrow(SnapshotIntegrityError);
    expect(readOutputs(dataDir)).toEqual(before);
  });

  it.each(["fetch", "index.json", "metadata/capture.json"])("limits retained-data fallback to before publication: %s", async (failure) => {
    const { dataDir, args } = depegSyncFixture();
    let apiEvents = [event({ peakDeviationBps: 800 })];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ events: apiEvents })));
    await runDepegSync(args);
    const shardPath = join(dataDir, "2026.json"), before = readFileSync(shardPath, "utf8");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    apiEvents = [event({ peakDeviationBps: 900 })];
    if (failure === "fetch") vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    else { const p = join(dataDir, failure); rmSync(p); mkdirSync(p); }

    const attempt = runDepegSync([...args, "--allow-existing-on-fetch-failure"]);
    if (failure === "fetch") {
      await expect(attempt).resolves.toBeUndefined();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("preserving existing"));
    } else {
      await expect(attempt).rejects.toMatchObject({ code: "EISDIR" });
      expect(warning).not.toHaveBeenCalled();
    }
    expect(readFileSync(shardPath, "utf8") !== before).toBe(failure === "metadata/capture.json");
  });

  it("round-trips legacy event fields through the shared stored schema", async () => {
    const { dataDir, args } = depegSyncFixture();
    const legacy = Object.fromEntries(Object.entries(event()).filter(([k]) => !["provenance", "confirmationSources", "pendingReason", "closeReason"].includes(k)));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ events: [legacy] })));
    await runDepegSync(args);
    const stored = DepegEventStoredSnapshotSchema.parse(JSON.parse(readFileSync(join(dataDir, "2026.json"), "utf8")));
    expect(stored[0]).toMatchObject({ id: 1, provenance: null, confirmationSources: null, pendingReason: null, closeReason: null });
    expect(readDepegLedgerCapture(dataDir).apiTotal).toBeNull();
  });

  it("refuses to remove a published static event even when total event count grows", () => {
    const published: DepegEventEntry = { ...event({ id: 1, peakDeviationBps: -800 }), slug: "usdc-2026-05-15" };
    const subthreshold: DepegEventEntry = { ...event({ id: 2, peakDeviationBps: -300, startedAt: Date.UTC(2026, 4, 16) / 1000 }), slug: "usdc-2026-05-16" };
    const replacement: DepegEventEntry = { ...event({ id: 3, peakDeviationBps: -300, startedAt: Date.UTC(2026, 4, 17) / 1000 }), slug: "usdc-2026-05-17" };
    const merged = preserveStaticDepegArchiveEntries([published], [subthreshold, replacement]);
    expect(findMissingStaticDepegArchiveSlugs([published], merged)).toEqual([published.slug]);
    expect(() => assertStaticDepegArchivePreserved([published], merged)).toThrow("Depeg static archive lost 1 published slug(s): usdc-2026-05-15");
  });

  it("allows subthreshold rows to disappear and supports an explicit reviewed override", () => {
    const subthreshold: DepegEventEntry = { ...event({ peakDeviationBps: -300 }), slug: "usdc-2026-05-15" };
    const published: DepegEventEntry = { ...event({ peakDeviationBps: -800 }), slug: "usdc-2026-05-15" };
    expect(preserveStaticDepegArchiveEntries([], [subthreshold])).toEqual([]);
    expect(() => assertStaticDepegArchivePreserved([published], [], true)).not.toThrow();
  });

  it("carries a published row forward when the live record becomes subthreshold", () => {
    const published: DepegEventEntry = { ...event({ id: 1, peakDeviationBps: -800 }), slug: "usdc-2026-05-15" };
    const reclassified: DepegEventEntry = { ...event({ id: 2, peakDeviationBps: -129 }), slug: "usdc-2026-05-15" };
    const replacement: DepegEventEntry = { ...event({ id: 3, peakDeviationBps: -600, startedAt: Date.UTC(2026, 4, 16) / 1000 }), slug: "usdc-2026-05-16" };
    const merged = preserveStaticDepegArchiveEntries([published], [reclassified, replacement]);
    expect(merged.find((e) => e.slug === published.slug)).toMatchObject({ id: published.id, peakDeviationBps: published.peakDeviationBps });
    expect(findMissingStaticDepegArchiveSlugs([published], merged)).toEqual([]);
    expect(() => assertStaticDepegArchivePreserved([published], merged)).not.toThrow();
    expect(() => assertStaticDepegArchivePreserved([published], preserveStaticDepegArchiveEntries([published], [replacement]))).toThrow("lost 1 published slug");
  });

  it.each(["https://api.example.test/_site-data", "https://api.example.test/_site-data/depeg-events"])("preserves consolidated member URLs using the release API environment %s", async (apiBase) => {
    const { dataDir, indexPath } = depegSyncFixture();
    const original = event({ id: 90453, stablecoinId: "usda-alpha-partner", symbol: "USDA", peakDeviationBps: -503, startedAt: 1783297163 });
    const representative = event({ ...original, id: 90773, peakDeviationBps: -129, constituentEventCount: 2 });
    const lineage = { rows: [{ eventId: original.id, stablecoinId: original.stablecoinId, direction: original.direction, incidentKey: "ddr2:usda", live: { currentEventId: representative.id, eventState: "active" } }] };
    let apiEvents = [original];
    const fetchMock = vi.fn(async (input: string) => new URL(input).pathname.endsWith("/depeg-resolver")
      ? Response.json(lineage) : Response.json({ events: apiEvents, total: apiEvents.length }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("DEPEG_EVENTS_API_URL", apiBase);
    const args = ["--output", indexPath];
    await runDepegSync(args);
    const shardPath = join(dataDir, "2026.json");
    const published = DepegEventStoredSnapshotSchema.parse(JSON.parse(readFileSync(shardPath, "utf8")))[0];
    expect(published.slug).toBe("usda-2026-07-06");

    apiEvents = [representative];
    for (let i = 0; i < 2; i++) {
      await runDepegSync(args);
      const captured = DepegEventStoredSnapshotSchema.parse(JSON.parse(readFileSync(shardPath, "utf8")));
      expect(captured.find((e) => e.id === original.id)).toBeUndefined();
      expect(captured.find((e) => e.id === representative.id)).toMatchObject({ slug: "usda-2026-07-06-down", peakDeviationBps: -129 });
      expect(JSON.parse(readFileSync(indexPath, "utf8"))).toEqual([expect.objectContaining({ slug: published.slug, retainedPage: published })]);
      expect(readDepegLedgerCapture(dataDir)).toMatchObject({ eventCount: 1, apiTotal: 1 });
    }
    expect(fetchMock.mock.calls.filter(([u]) => u.endsWith("/depeg-resolver")).map(([u]) => u)).toEqual(Array(2).fill("https://api.example.test/_site-data/depeg-resolver"));
    const before = readOutputs(dataDir);
    await runDepegSync([...args, "--dry-run"]);
    expect(readOutputs(dataDir)).toEqual(before);

    apiEvents = [event({ ...representative, id: 99999 })];
    await expect(runDepegSync([...args, "--allow-existing-on-fetch-failure"])).rejects.toThrow("lost 1 published slug(s): usda-2026-07-06");
    expect(readOutputs(dataDir)).toEqual(before);
  });

  it.each([
    { name: "unlinked matching onset", eventId: 3 }, { name: "absent representative", currentEventId: 3 },
    { name: "different incident coin", stablecoinId: "another-usdc" }, { name: "different incident direction", direction: "above" as const },
    { name: "inactive incident", eventState: "closed_pending_review" as const }, { name: "empty incident identity", incidentKey: "" },
    { name: "single-row representative", constituentEventCount: 1 }, { name: "different representative coin", representativeCoin: "another-usdc" },
    { name: "different representative direction", representativeDirection: "above" as const },
  ])("still rejects an unexplained missing slug: $name", (s) => {
    const previous = assignSlugs([event({ peakDeviationBps: -800 })]);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const current = assignSlugs([event({
      id: 2, peakDeviationBps: -129, constituentEventCount: s.constituentEventCount ?? 2,
      stablecoinId: s.representativeCoin ?? event().stablecoinId, direction: s.representativeDirection ?? "below",
    })], previous);
    const merged = preserveStaticDepegArchiveEntries(previous, current, [{
      eventId: s.eventId ?? 1, incidentKey: s.incidentKey ?? "ddr2:test",
      stablecoinId: s.stablecoinId ?? event().stablecoinId, direction: s.direction ?? "below",
      live: { currentEventId: s.currentEventId ?? 2, eventState: s.eventState ?? "active" },
    }]);
    expect(() => assertStaticDepegArchivePreserved(previous, merged)).toThrow("lost 1 published slug");
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('"slug":"usdc-2026-05-15"'));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('"reasons":['));
  });

  it.each(["malformed JSON", "invalid representative ID", "unrelated lineage"])("rejects %s incident lineage without changing outputs or capture metadata", async (scenario) => {
    const { dataDir, args } = depegSyncFixture();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ events: [event({ peakDeviationBps: -800 })], total: 1 })));
    await runDepegSync(args);
    const before = readOutputs(dataDir);
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      if (!new URL(input).pathname.endsWith("/depeg-resolver")) return Response.json({ events: [event({ id: 2, constituentEventCount: 2 })], total: 1 });
      return scenario === "malformed JSON" ? new Response("{invalid") : Response.json({
        rows: [{
          eventId: scenario === "unrelated lineage" ? 3 : 1, stablecoinId: event().stablecoinId, direction: "below", incidentKey: "ddr2:test",
          live: { currentEventId: scenario === "invalid representative ID" ? "2" : 2, eventState: "active" },
        }],
      });
    }));
    await expect(runDepegSync([...args, "--allow-existing-on-fetch-failure"])).rejects.toThrow(SnapshotIntegrityError);
    expect(readOutputs(dataDir)).toEqual(before);
  });

  it.each([false, true])("explains a rejected CI proxy input with constituent fields present=%s", async (hasConstituents) => {
    const { dataDir, indexPath } = depegSyncFixture();
    vi.stubEnv("DEPEG_EVENTS_API_URL", "https://stablecoin-dashboard.pages.dev/_site-data");
    vi.stubEnv("DEPEG_EVENTS_API_KEY", "");
    vi.stubEnv("SMOKE_API_KEY", "");
    const args = ["--output", indexPath];
    let apiEvents = [event({ peakDeviationBps: -800 })];
    const fetchMock = vi.fn(async (input: string) => new URL(input).pathname.endsWith("/depeg-resolver")
      ? Response.json({ rows: [] }) : Response.json({ events: apiEvents, total: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    await runDepegSync(args);
    const before = readOutputs(dataDir);
    apiEvents = [event({ id: 2, constituentEventCount: hasConstituents ? 2 : undefined })];
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(runDepegSync(args)).rejects.toThrow("lost 1 published slug");
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('"slug":"usdc-2026-05-15","eventId":1,"reasons":["incident-not-found"]'));
    if (hasConstituents) {
      expect(log).toHaveBeenCalledWith(expect.stringContaining("Incident lineage source: https://stablecoin-dashboard.pages.dev/_site-data/depeg-resolver; missing published IDs: 1"));
      expect(log).toHaveBeenCalledWith("[sync-depeg-events] Incident lineage: 0 resolver rows admitted");
    } else {
      expect(warning).toHaveBeenCalledWith("[sync-depeg-events] Incident lineage lookup skipped: no multi-constituent API rows");
      expect(fetchMock.mock.calls.some(([u]) => u.endsWith("/depeg-resolver"))).toBe(false);
    }
    expect(readOutputs(dataDir)).toEqual(before);
  });

  it("exhausts more than 20 full pages and writes the API's complete event total", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { dataDir, args } = depegSyncFixture(), total = 21_001;
    const ledgerProof = { generation: "a".repeat(64), coveredFromSec: 1, coveredThroughSec: 1_795_000_000 };
    const fetchMock = vi.fn(async (input: string) => {
      const url = new URL(input), offset = Number(url.searchParams.get("cursor") ?? 0);
      expect(url.searchParams.get("ledgerGeneration")).toBe(offset === 0 ? "latest" : ledgerProof.generation);
      const length = Math.min(1000, total - offset);
      const events = Array.from({ length }, (_, i) => event({ id: offset + i + 1, symbol: `T${offset + i + 1}`, startedAt: Date.UTC(2026, 4, 15) / 1000 - offset - i }));
      return Response.json({ events, total, totalExact: true, ledgerProof, nextCursor: offset + length < total ? String(offset + length) : null });
    });
    vi.stubGlobal("fetch", fetchMock);
    await runDepegSync(args);
    expect(fetchMock).toHaveBeenCalledTimes(22);
    const shard = JSON.parse(readFileSync(join(dataDir, "2026.json"), "utf8")) as DepegEvent[];
    expect(shard).toHaveLength(total);
    expect(new Set(shard.map((e) => e.id)).size).toBe(total);
    expect(shard.some((e) => e.id === total)).toBe(true);
    expect(readDepegLedgerCapture(dataDir)).toMatchObject({
      schemaVersion: 1, shardSource: "fetched-ledger", eventCount: total, apiTotal: total, ledgerProof,
      captureId: expect.stringMatching(/^sha256:[a-f0-9]{64}$/), sourceUrl: "https://api.example.test/api/depeg-events",
    });
  });

  it("throws at the safety ceiling with an outstanding cursor without replacing existing outputs or using fetch fallback", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { dataDir, args } = depegSyncFixture();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ events: [event()] })));
    await runDepegSync(args);
    const before = readOutputs(dataDir);
    const fetchMock = vi.fn(async () => Response.json({ events: [event()], nextCursor: "outstanding" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(runDepegSync([...args, "--allow-existing-on-fetch-failure"])).rejects.toThrow(SnapshotIntegrityError);
    expect(fetchMock).toHaveBeenCalledTimes(1000);
    expect(readOutputs(dataDir)).toEqual(before);
  });

  it("reconciles the total against every listed row, including reviewed disputes", async () => {
    const { dataDir, args } = depegSyncFixture();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ events: [event({ id: 1 }), event({ id: 2, provenance: { auditVerdict: "disputed" } })], total: 2, nextCursor: null })));
    await runDepegSync(args);
    const shard = JSON.parse(readFileSync(join(dataDir, "2026.json"), "utf8")) as DepegEvent[];
    expect(shard.map((e) => e.id).sort()).toEqual([1, 2]);
    expect(readDepegLedgerCapture(dataDir)).toMatchObject({ eventCount: 2, apiTotal: 2 });
  });

  it("rejects a cursor-exhausted response whose unique event count disagrees with the API total", async () => {
    const { indexPath, args } = depegSyncFixture();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ events: [event()], total: 2, nextCursor: null })));
    await expect(runDepegSync(args)).rejects.toThrow("collected 1 unique events but the API reported 2");
    expect(existsSync(indexPath)).toBe(false);
  });

  it("rejects a total changed by a continuation page without replacing capture metadata", async () => {
    const { dataDir, args } = depegSyncFixture();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ events: [event()], total: 1 })));
    await runDepegSync(args);
    const before = readOutputs(dataDir);
    let page = 0;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ events: [event({ id: ++page })], total: page === 1 ? 2 : 3, nextCursor: page === 1 ? "next" : null })));
    await expect(runDepegSync([...args, "--allow-existing-on-fetch-failure"])).rejects.toThrow(SnapshotIntegrityError);
    expect(readOutputs(dataDir)).toEqual(before);
  });

  it("rejects a ledger capture when a yearly shard has changed since observation", async () => {
    const { dataDir, args } = depegSyncFixture();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ events: [event()] })));
    await runDepegSync(args);
    expect(readDepegLedgerCapture(dataDir).eventCount).toBe(1);
    writeFileSync(join(dataDir, "2026.json"), `${JSON.stringify(assignSlugs([event({ peakPrice: 0.8 })]))}\n`);
    expect(() => readDepegLedgerCapture(dataDir)).toThrow("shards do not match their capture identity");
  });

  it("writes full UTC-year shards and changes only the affected shard for a new event", async () => {
    const { dataDir, indexPath, args } = depegSyncFixture();
    let apiEvents: DepegEvent[] = [
      event({ id: 1, peakDeviationBps: 300, startedAt: Date.UTC(2025, 4, 15) / 1000 }),
      event({ id: 2, peakDeviationBps: 800, startedAt: Date.UTC(2026, 4, 15) / 1000 }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ events: apiEvents })));
    await runDepegSync(args);
    const olderShardPath = join(dataDir, "2025.json"), currentShardPath = join(dataDir, "2026.json");
    const olderBefore = readFileSync(olderShardPath, "utf8"), currentBefore = readFileSync(currentShardPath, "utf8"), indexBefore = readFileSync(indexPath, "utf8");

    apiEvents = [...apiEvents, event({ id: 3, peakDeviationBps: 900, startedAt: Date.UTC(2026, 5, 17) / 1000 })];
    await runDepegSync(args);
    expect(readFileSync(olderShardPath, "utf8")).toBe(olderBefore);
    expect(readFileSync(currentShardPath, "utf8")).not.toBe(currentBefore);
    expect(readFileSync(indexPath, "utf8")).not.toBe(indexBefore);
    expect(JSON.parse(readFileSync(olderShardPath, "utf8"))).toHaveLength(1);
    expect(JSON.parse(readFileSync(currentShardPath, "utf8"))).toHaveLength(2);
    expect(JSON.parse(readFileSync(indexPath, "utf8"))).toHaveLength(2);
  });
});
