import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types";
import type { DepegEventEntry } from "@shared/types/market";
import {
  admitDepegLedger,
  buildStablecoinDetailHistorySnapshot,
  readAdmittedDepegLedger,
  STABLECOIN_DETAIL_HISTORY_PILOT_IDS,
} from "../stablecoin-detail-history-snapshot";
import {
  depegLedgerCaptureId,
  DEPEG_LEDGER_CAPTURE_RELATIVE_PATH,
} from "../../../scripts/lib/depeg-ledger-capture";

const CAPTURE_ID = `sha256:${"a".repeat(64)}`;
const CAPTURE_STARTED_AT = "2026-10-17T23:57:51.608Z";
const CAPTURE_OBSERVED_AT = "2026-10-17T23:58:10.527Z";
const CAPTURE_NOW_SECONDS = Math.floor(Date.parse("2026-10-28T00:00:00Z") / 1000);
const NO_PERMANENT_PAGES: ReadonlySet<string> = new Set();

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

function makeCoin(overrides: Partial<Pick<StablecoinMeta, "id" | "symbol" | "status">> & {
  navToken?: boolean;
} = {}) {
  const { navToken = false, ...coinOverrides } = overrides;
  return {
    id: "usdt-tether",
    symbol: "USDT",
    status: "active" as const,
    flags: { navToken } as StablecoinMeta["flags"],
    ...coinOverrides,
  };
}

function makeEntry(overrides: Partial<DepegEventEntry> = {}): DepegEventEntry {
  return {
    id: 1,
    stablecoinId: "usdt-tether",
    symbol: "USDT",
    pegType: "peggedUSD",
    direction: "below",
    peakDeviationBps: -120,
    startedAt: 1_700_000_000,
    endedAt: 1_700_086_400,
    startPrice: 0.99,
    peakPrice: 0.988,
    recoveryPrice: 1,
    pegReference: 1,
    source: "backfill",
    constituentEventCount: 1,
    confirmationSources: null,
    pendingReason: null,
    closeReason: "recovered-primary",
    priceCoverage: null,
    provenance: null,
    slug: "usdt-2023-11-14",
    ...overrides,
  };
}

function makeLedger(entries: readonly DepegEventEntry[], overrides: { eventCount?: number } = {}) {
  return admitDepegLedger({
    entries,
    capture: {
      schemaVersion: 1,
      captureId: CAPTURE_ID,
      observationStartedAtISO: CAPTURE_STARTED_AT,
      observedAtISO: CAPTURE_OBSERVED_AT,
      sourceUrl: "https://api.pharos.watch/api/depeg-events",
      methodologyVersionLabel: "v6.34",
      eventCount: overrides.eventCount ?? entries.length,
      apiTotal: overrides.eventCount ?? entries.length,
    },
    nowSeconds: CAPTURE_NOW_SECONDS,
  });
}

function build(
  entries: readonly DepegEventEntry[],
  {
    coin = makeCoin(),
    permanentPageSlugs = NO_PERMANENT_PAGES,
  }: {
    coin?: ReturnType<typeof makeCoin>;
    permanentPageSlugs?: ReadonlySet<string>;
  } = {},
) {
  return buildStablecoinDetailHistorySnapshot({
    coin,
    permanentPageSlugs,
    ledger: makeLedger(entries),
  });
}

async function makeCaptureDir(entries: readonly DepegEventEntry[], captureOverrides: Record<string, unknown> = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pharos-depeg-ledger-"));
  tempDirs.push(dir);
  await writeFile(path.join(dir, "2023.json"), JSON.stringify(entries));
  await mkdir(path.join(dir, "metadata"), { recursive: true });
  await writeFile(path.join(dir, DEPEG_LEDGER_CAPTURE_RELATIVE_PATH), JSON.stringify({
    schemaVersion: 1,
    captureId: depegLedgerCaptureId(dir),
    observationStartedAtISO: CAPTURE_STARTED_AT,
    observedAtISO: CAPTURE_OBSERVED_AT,
    sourceUrl: "https://api.pharos.watch/api/depeg-events",
    methodologyVersionLabel: "v6.34",
    eventCount: entries.length,
    apiTotal: entries.length,
    ...captureOverrides,
  }));
  return dir;
}

describe("stablecoin detail history snapshot", () => {
  it("counts only non-disputed archived incidents while still displaying the disputed rows", () => {
    const entries = [
      makeEntry({ id: 1, provenance: { auditVerdict: "disputed" } }),
      makeEntry({ id: 2, provenance: { auditVerdict: "false_positive" } }),
      makeEntry({ id: 3, provenance: { auditVerdict: "confirmed" } }),
      makeEntry({ id: 4, provenance: null }),
    ];
    const snapshot = build(entries);

    expect(snapshot).not.toBeNull();
    expect(snapshot!.recordedCount).toBe(2);
    expect(snapshot!.events.map((event) => event.id)).toEqual([4, 3, 2, 1]);
    expect(snapshot!.events.map((event) => event.provenance?.auditVerdict)).toEqual([
      undefined, "confirmed", "false_positive", "disputed",
    ]);
  });

  it("keeps the full per-coin ledger total while displaying the newest six", () => {
    const entries = Array.from({ length: 8 }, (_, index) => makeEntry({
      id: index + 1,
      startedAt: 1_700_000_000, // every event shares a clock, so id breaks the tie
    }));
    const snapshot = build(entries);

    expect(snapshot).not.toBeNull();
    expect(snapshot!.recordedCount).toBe(8);
    expect(snapshot!.events).toHaveLength(6);
    expect(snapshot!.events.map((event) => event.id)).toEqual([8, 7, 6, 5, 4, 3]);
    expect(snapshot!.earliestStartedAt).toBe(1_700_000_000);
    expect(snapshot!.latestStartedAt).toBe(1_700_000_000);
    expect(snapshot!.coverage).toBe("retained-ledger");
    expect(snapshot!.sourceGeneration).toBe(CAPTURE_ID);
    expect(snapshot!.capturedFrom).toBe(Math.floor(Date.parse(CAPTURE_STARTED_AT) / 1000));
    expect(snapshot!.capturedAt).toBe(Math.floor(Date.parse(CAPTURE_OBSERVED_AT) / 1000));
  });

  it("orders newest first with a stable id tie-break", () => {
    const snapshot = build([
      makeEntry({ id: 5, startedAt: 1_700_000_000 }),
      makeEntry({ id: 9, startedAt: 1_700_000_000 }),
      makeEntry({ id: 7, startedAt: 1_700_086_400 }),
    ]);
    expect(snapshot!.events.map((event) => event.id)).toEqual([7, 9, 5]);
  });

  it("returns null for a successfully read empty per-coin set", () => {
    const snapshot = build([makeEntry({ stablecoinId: "usdc-circle", symbol: "USDC" })]);
    expect(snapshot).toBeNull();
  });

  it.each([
    ["NAV", makeCoin({ navToken: true })],
    ["pre-launch", makeCoin({ status: "pre-launch" })],
    ["frozen", makeCoin({ status: "frozen" })],
    ["quarantined", makeCoin({ status: "quarantined" })],
    ["delisted", makeCoin({ status: "delisted" })],
    ["outside the pilot", makeCoin({ id: "usds-sky", symbol: "USDS" })],
  ] as const)("returns null for %s lifecycles", (_label, coin) => {
    expect(build([makeEntry()], { coin })).toBeNull();
  });

  it("keeps exactly the five pilot IDs", () => {
    expect([...STABLECOIN_DETAIL_HISTORY_PILOT_IDS].sort()).toEqual([
      "dai-makerdao",
      "fdusd-first-digital",
      "tusd-trueusd",
      "usdc-circle",
      "usdt-tether",
    ]);
  });

  it.each([
    ["open", { id: 1, endedAt: null }],
    ["recovered", { id: 2, closeReason: "recovered-primary" }],
    ["legacy_recovered", { id: 3, closeReason: null, recoveryPrice: 0.999 }],
    ["coverage_lost", { id: 4, closeReason: "coverage-lost-supply" }],
    ["superseded", { id: 5, closeReason: "superseded-direction" }],
    ["orphan", { id: 6, closeReason: "orphan-tracking-removed" }],
    ["unknown_closed", { id: 7, closeReason: null, recoveryPrice: null }],
  ] as const)("classifies %s through the shared closure authority", (closure, overrides) => {
    const snapshot = build([makeEntry(overrides)]);
    expect(snapshot!.events[0].closure).toBe(closure);
  });

  it("keeps an open record's duration null instead of measuring against build time", () => {
    const snapshot = build([makeEntry({ endedAt: null })]);
    expect(snapshot!.events[0].durationSeconds).toBeNull();
  });

  it("keeps a closed record's duration inside the ledger clock", () => {
    const snapshot = build([makeEntry({ startedAt: 1_700_000_000, endedAt: 1_700_003_600 })]);
    expect(snapshot!.events[0].durationSeconds).toBe(3_600);
  });

  it("links only events that own a permanent page", () => {
    const snapshot = build([
      makeEntry({ id: 1, slug: "usdt-2023-03-11" }),
      makeEntry({ id: 2, slug: "usdt-thin-fragment", startedAt: 1_699_000_000 }),
    ], { permanentPageSlugs: new Set(["usdt-2023-03-11"]) });
    const [linked, unlinked] = snapshot!.events;
    expect(linked.href).toBe("/depeg/usdt-2023-03-11/");
    expect(unlinked.href).toBeNull();
  });

  it("carries available provenance and coverage without inventing absent fields", () => {
    const snapshot = build([
      makeEntry({
        id: 1,
        provenance: { sourceKind: "dex", auditVerdict: "confirmed" },
        priceCoverage: {
          intervals: [[1_700_000_000, 1_700_003_600]],
          atParIntervals: [],
          lastObservationKind: "trusted-off-peg",
          lastTrustedObservationAt: 1_700_003_600,
          gapStartedAt: null,
        },
      }),
      makeEntry({ id: 2, provenance: null, priceCoverage: null, startedAt: 1_699_000_000 }),
    ]);
    const [withEvidence, withoutEvidence] = snapshot!.events;
    expect(withEvidence.provenance).toEqual({ sourceKind: "dex", auditVerdict: "confirmed" });
    expect(withEvidence.coverage).toEqual({ lastObservationKind: "trusted-off-peg", intervalCount: 1 });
    expect(withoutEvidence.provenance).toBeNull();
    expect(withoutEvidence.coverage).toBeNull();
  });
});

describe("depeg ledger admission", () => {
  it("rejects a capture whose declared event count does not match the parsed shards", () => {
    expect(() => makeLedger([makeEntry()], { eventCount: 2 })).toThrow(/declares 2 records but 1/);
  });

  it("rejects duplicate incident ids", () => {
    expect(() => makeLedger([makeEntry({ id: 1 }), makeEntry({ id: 1 })])).toThrow(/duplicate incident id 1/);
  });

  it("rejects an event that starts after the capture clock", () => {
    expect(() => makeLedger([makeEntry({ startedAt: CAPTURE_NOW_SECONDS + 60 })])).toThrow(/starts after the capture clock/);
  });

  it("rejects a future capture clock", () => {
    expect(() => admitDepegLedger({
      entries: [makeEntry()],
      capture: {
        schemaVersion: 1,
        captureId: CAPTURE_ID,
        observationStartedAtISO: "2099-01-01T00:00:00.000Z",
        observedAtISO: "2099-01-01T00:00:10.000Z",
        sourceUrl: "https://api.pharos.watch/api/depeg-events",
        methodologyVersionLabel: "v6.34",
        eventCount: 1,
        apiTotal: 1,
      },
      nowSeconds: CAPTURE_NOW_SECONDS,
    })).toThrow(/future/);
  });

  it("verifies the capture hash against the exact shard bytes", async () => {
    const entries = [makeEntry()];
    const dir = await makeCaptureDir(entries);
    const admitted = readAdmittedDepegLedger({
      dataDir: dir,
      entries,
      nowSeconds: CAPTURE_NOW_SECONDS,
    });
    expect(admitted.capture.captureId).toBe(depegLedgerCaptureId(dir));
  });

  it("rejects a capture identity that does not match the shard bytes", async () => {
    const entries = [makeEntry()];
    const dir = await makeCaptureDir(entries, { captureId: `sha256:${"0".repeat(64)}` });
    expect(() => readAdmittedDepegLedger({
      dataDir: dir,
      entries,
      nowSeconds: CAPTURE_NOW_SECONDS,
    })).toThrow(/capture identity/);
  });

  it("rejects malformed capture metadata", async () => {
    const entries = [makeEntry()];
    const dir = await makeCaptureDir(entries);
    await writeFile(path.join(dir, DEPEG_LEDGER_CAPTURE_RELATIVE_PATH), "{not json");
    expect(() => readAdmittedDepegLedger({
      dataDir: dir,
      entries,
      nowSeconds: CAPTURE_NOW_SECONDS,
    })).toThrow();
  });
});
