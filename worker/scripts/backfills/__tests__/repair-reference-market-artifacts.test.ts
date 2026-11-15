import { afterEach, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { makeDepegRow } from "../../../src/test-helpers/__shared/fixtures";
import { seedPsiEvent } from "../../../src/api/__tests__/psi-replay.test-support";
import { handleRepairReferenceMarketArtifacts } from "../repair-reference-market-artifacts";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => { vi.useRealTimers(); fixtures.closeAll(); });

it("deletes unlinked closure artifacts and corrects each PSI day once from its samples", async () => {
  vi.useFakeTimers();
  const { sqlite, db } = fixtures.open();
  // Saturday 2026-11-14 12:00 UTC; FX reopens Sunday 23:00 (1_794_783_600).
  for (const [id, ended_at] of [[1, 1_794_785_400], [2, 1_794_956_400], [3, 1_794_785_400]] as const) {
    seedPsiEvent(sqlite, { confirmation_sources: null, pending_reason: null,
      ...makeDepegRow({ id, stablecoin_id: `eur-${id}`, peg_type: "peggedEUR", started_at: 1_794_657_600, ended_at, peak_deviation_bps: -300 }) });
  }
  sqlite.prepare("INSERT INTO depeg_resolver_incident_event_links (incident_key, event_id, relation, linked_at) VALUES ('ddr2:x', 3, 'observed', 1)").run();
  sqlite.prepare("INSERT INTO stability_index (computed_at, score, band, components, input_snapshot) VALUES (1794614400, 88.4, 'STEADY', ?, ?)")
    .run(JSON.stringify({ severity: 5.58, breadth: 6, stressBreadth: 0, trend: 0 }), JSON.stringify({ source: "daily-avg", sampleCount: 1 }));
  // Sunday was rebuilt by a replay that already applied the rule: marked, never corrected again.
  sqlite.prepare("INSERT INTO stability_index (computed_at, score, band, components, input_snapshot) VALUES (1794700800, 95, 'STEADY', '{}', ?)")
    .run(JSON.stringify({ referenceMarketRule: true }));
  sqlite.prepare("INSERT INTO stability_index_samples (stored_at, score, band, components, input_snapshot) VALUES (1794661200, 90, 'STEADY', '{}', ?)")
    .run(JSON.stringify({ contributors: [{ id: "eur-1", bps: -300, mcapUsd: 4e9, ageDays: 0 }], totalMcapUsd: 3e11, mcap7dChangePct: 0, dewsStressBreadth: 0 }));
  const run = async () => (await handleRepairReferenceMarketArtifacts({ db, url: new URL("https://pharos.watch/?limit=5") })).json();

  vi.setSystemTime(1_794_785_400_000); // Sunday 23:30, inside the reopen grace
  expect(await run()).toMatchObject({ processed: 1, results: [{ status: "waiting-for-daily-rows" }] });
  vi.setSystemTime(1_795_176_000_000); // Friday 2026-11-20, after the reopen grace
  expect(await run()).toMatchObject({ processed: 1, results: [{
    status: "applied", deleted: [1], locked: [{ id: 3, artifact: true, incidentKey: "ddr2:x" }],
    days: [{ day: 1_794_614_400, method: "samples", previous: 88.4, score: 100 }, { day: 1_794_700_800, method: "replayed-with-rule", previous: 95 }],
  }] });
  expect(sqlite.prepare("SELECT id, started_at FROM depeg_events ORDER BY id").all()).toEqual([
    { id: 2, started_at: 1_794_657_600 }, { id: 3, started_at: 1_794_657_600 },
  ]);
  expect(await run()).toMatchObject({ processed: 0, results: [] });
});
