/**
 * Corpus replay gate.
 *
 * Every registered adapter either replays a captured happy-path payload through
 * the shared harness — proving `validateAdapterOutput` passes and the emitted
 * `freshnessMode` is one the descriptor admits — or carries a reviewed
 * exemption reason. Each replayed adapter also proves that a malformed upstream
 * field surfaces as an error or a `degraded` warning rather than a plausible
 * but wrong snapshot.
 */
import { afterAll, describe, expect, it } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import { LIVE_RESERVE_ADAPTER_KEYS, type LiveReserveAdapterKey } from "@shared/types/live-reserves";
import { CORPUS_BACKLOG, CORPUS_CASES, CORPUS_NOT_REPLAYABLE, type AdapterCorpusCase } from "./adapter-corpus.test-support";
import { runAdapter } from "./reserve-adapter.test-support";

const caseEntries = Object.entries(CORPUS_CASES) as [LiveReserveAdapterKey, AdapterCorpusCase][];

// Highest raw upstream percentage drift (metadata.diag.rawSumDeviation) each
// replayed producer emits, so a corpus run doubles as a drift detector.
const rawSumDeviationByAdapter = new Map<LiveReserveAdapterKey, number>();

describe("adapter corpus replay", () => {
  it("routes every adapter key to a corpus case or a reviewed exemption", () => {
    const uncovered = LIVE_RESERVE_ADAPTER_KEYS.filter(
      (key) =>
        CORPUS_CASES[key] === undefined &&
        CORPUS_NOT_REPLAYABLE[key] === undefined &&
        CORPUS_BACKLOG[key] === undefined,
    );
    expect(uncovered, "add a corpus case or a CORPUS_NOT_REPLAYABLE/CORPUS_BACKLOG reason for these adapter keys").toEqual([]);

    const doubleBooked = Object.keys(CORPUS_CASES).filter(
      (key) => CORPUS_NOT_REPLAYABLE[key] !== undefined || CORPUS_BACKLOG[key] !== undefined,
    );
    expect(doubleBooked, "an adapter with a corpus case must not also be exempt").toEqual([]);

    const crossListed = Object.keys(CORPUS_NOT_REPLAYABLE).filter((key) => CORPUS_BACKLOG[key] !== undefined);
    expect(crossListed, "a structural exemption must not also be backlog debt").toEqual([]);

    const knownKeys = new Set<string>(LIVE_RESERVE_ADAPTER_KEYS);
    const stale = [
      ...Object.keys(CORPUS_CASES),
      ...Object.keys(CORPUS_NOT_REPLAYABLE),
      ...Object.keys(CORPUS_BACKLOG),
    ].filter((key) => !knownKeys.has(key));
    expect(stale, "corpus entries name adapter keys that no longer exist").toEqual([]);

    const backlogKeys = Object.keys(CORPUS_BACKLOG).sort();
    // Vitest swallows console.* on green runs; process.stdout.write lands the
    // debt report in the test output either way.
    process.stdout.write(
      `corpus backlog: ${backlogKeys.length} adapter(s) still owe a committed wire capture\n` +
        backlogKeys.map((key) => `  - ${key}`).join("\n") +
        "\n",
    );
  });

  it("gives every exemption a reason", () => {
    const empty = [...Object.entries(CORPUS_NOT_REPLAYABLE), ...Object.entries(CORPUS_BACKLOG)]
      .filter(([, reason]) => reason.trim().length < 20)
      .map(([key]) => key);
    expect(empty, "exemptions need a reviewed reason, not a placeholder").toEqual([]);
  });

  it.each(caseEntries)("%s replays its captured payload into an admissible snapshot", async (key, corpusCase) => {
    const { result } = await runAdapter(key, corpusCase.coinId, {
      network: corpusCase.network,
      nowSec: corpusCase.nowSec,
    });

    expect(result.slices.length).toBeGreaterThan(0);
    const rawSumDeviation = result.metadata?.diag?.rawSumDeviation;
    if (typeof rawSumDeviation === "number") {
      const previous = rawSumDeviationByAdapter.get(key);
      if (previous === undefined || rawSumDeviation > previous) {
        rawSumDeviationByAdapter.set(key, rawSumDeviation);
      }
    }
    const declaration = LIVE_RESERVE_ADAPTER_DEFINITIONS[key];
    const allowedFreshnessModes = "validation" in declaration
      ? declaration.validation.allowedFreshnessModes
      : undefined;
    if (allowedFreshnessModes && result.metadata?.freshnessMode) {
      expect(allowedFreshnessModes as readonly string[]).toContain(result.metadata.freshnessMode);
    }
  });

  it.each(caseEntries)("%s surfaces upstream shape drift instead of publishing it", async (key, corpusCase) => {
    const { drift } = corpusCase;
    const run = await runAdapter(key, corpusCase.coinId, {
      network: drift.network,
      nowSec: corpusCase.nowSec,
      validate: false,
    }).then(
      (value) => ({ status: "ok" as const, value }),
      (error: unknown) => ({ status: "error" as const, error }),
    );

    if (drift.outcome === "error") {
      expect(run.status, `${key}: ${drift.label} published a snapshot instead of failing`).toBe("error");
      return;
    }

    expect(run.status, `${key}: ${drift.label} threw; the corpus expects a degraded publication`).toBe("ok");
    if (run.status !== "ok") return;
    const warnings = [...(run.value.result.warnings ?? []), ...run.value.report.warnings];
    const degrading = warnings.filter((warning) => warning.effect === "degraded" || warning.effect === "fatal");
    expect(
      degrading.map((warning) => warning.code),
      `${key}: ${drift.label} published silently — no degraded warning`,
    ).not.toEqual([]);
  });

  afterAll(() => {
    const rows = [...rawSumDeviationByAdapter.entries()].sort(([left], [right]) => left.localeCompare(right));
    if (rows.length === 0) return;
    const table = rows
      .map(([adapter, max]) => `  ${adapter.padEnd(28)} ${max.toFixed(6)} pct-points`)
      .join("\n");
    // Vitest swallows console.* on green runs; process.stdout.write lands the
    // drift table in the test output either way.
    process.stdout.write(`adapter corpus rawSumDeviation (max per producer, replayed fixtures):\n${table}\n`);
  });
});
