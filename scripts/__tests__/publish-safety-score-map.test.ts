import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSafetyMapSummary,
  planSafetyMapPublication,
  publishSafetyMapPublication,
  renderSafetyMapPublication,
  type PublicationIo,
  type SafetyMapKvAdapter,
  type SafetyMapPublishState,
} from "../maintenance/publish-safety-score-map";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "pharos-safety-map-publish-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createIo(): PublicationIo & { output: string[]; text: string[] } {
  const text: string[] = [];
  const output: string[] = [];
  return {
    text,
    output,
    stdout: { write: (value) => text.push(value) },
    warning: (title, message) => text.push(`${title}: ${message}`),
    writeOutput: (name, value) => output.push(`${name}=${value}`),
  };
}

function validPreviousSnapshot(): Record<string, unknown> {
  const tiers = ["A", "B", "C", "D", "F"].map((tier) => ({
    tier,
    range: "0-100",
    count: tier === "A" ? 1 : 0,
    mcapUsd: tier === "A" ? 100 : 0,
    sharePct: tier === "A" ? 100 : 0,
    leaders: tier === "A"
      ? [{ symbol: "USD", score: 90, mcapUsd: 100 }]
      : [],
  }));
  return {
    date: "2026-07-26",
    publicationStatus: "current",
    counts: {
      graded: 1,
      notRated: 0,
      unjoined: 0,
      missingLogos: 0,
      byTier: { A: 1, B: 0, C: 0, D: 0, F: 0 },
    },
    mapSummary: {
      date: "2026-07-26",
      asOfSec: Date.UTC(2026, 6, 26, 8, 0, 0) / 1000,
      methodologyVersion: "9.43",
      gradedCount: 1,
      notRatedCount: 0,
      totalMcapUsd: 100,
      floorMcapByTier: { a: 1, other: 1 },
      tiers,
    },
    coins: [{ id: "usd", symbol: "USD", score: 90, grade: "A+", mcap: 100 }],
  };
}

class MockKvAdapter implements SafetyMapKvAdapter {
  readonly puts: Array<{ key: string; path: string }> = [];
  listings = new Map<string, string[]>();
  values = new Map<string, Buffer>();
  readbackOverride?: Buffer;

  async list(prefix: string): Promise<string[]> {
    return this.listings.get(prefix) ?? [];
  }

  async get(key: string): Promise<Buffer> {
    if (key.includes(".png") && this.readbackOverride) return this.readbackOverride;
    const value = this.values.get(key);
    if (!value) throw new Error(`missing mock value for ${key}`);
    return value;
  }

  async put(key: string, path: string): Promise<void> {
    this.puts.push({ key, path });
    this.values.set(key, readFileSync(path));
  }
}

function writeRenderedState(directory: string, overrides: Partial<SafetyMapPublishState> = {}): string {
  const pngPath = join(directory, "latest.png");
  const snapshotPath = join(directory, "latest.snapshot.json");
  const altPath = join(directory, "latest.alt.json");
  const manifestPath = join(directory, "kv-manifest.json");
  writeFileSync(pngPath, "png bytes");
  writeFileSync(snapshotPath, "snapshot bytes");
  writeFileSync(altPath, "alt bytes");
  writeFileSync(manifestPath, "manifest bytes");
  const state: SafetyMapPublishState = {
    phase: "rendered",
    eventName: "schedule",
    plannedAtSec: 1_785_283_200,
    alreadyPublished: false,
    hadManifest: false,
    deltaGuard: "ran",
    manifestPath,
    manifest: {
      date: "2026-07-27",
      asOfSec: 1_785_282_000,
      renderedAtSec: 1_785_283_200,
      edition: "daily",
      methodologyVersion: "9.44",
      counts: { graded: 42, notRated: 3 },
      bytes: { png: 9, alt: 9, snapshot: 14 },
    },
    ...overrides,
  };
  const statePath = join(directory, "publish-state.json");
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return statePath;
}

describe("Safety Map publication CLI", () => {
  it("publishes a fresh render in exact key order with the manifest last", async () => {
    const directory = temporaryDirectory();
    const statePath = writeRenderedState(directory);
    const adapter = new MockKvAdapter();

    const result = await publishSafetyMapPublication({ adapter, outDir: directory, statePath });

    expect(result.phase).toBe("published");
    expect(adapter.puts.map(({ key }) => key)).toEqual([
      "safety-map:snapshot:2026-07-27",
      "safety-map:snapshot:latest",
      "safety-map:alt:latest",
      "safety-map:2026-07-27.png",
      "safety-map:latest.png",
      "safety-map:latest.json",
    ]);
  });

  it("skips a scheduled same-day publication only while data is under six hours old", async () => {
    const directory = temporaryDirectory();
    const statePath = join(directory, "publish-state.json");
    const adapter = new MockKvAdapter();
    const nowSec = Date.UTC(2026, 6, 27, 8, 0, 0) / 1000;
    adapter.listings.set("safety-map:latest.json", ["safety-map:latest.json"]);
    adapter.values.set("safety-map:latest.json", Buffer.from(JSON.stringify({
      date: "2026-07-27",
      asOfSec: nowSec - (6 * 3600 - 1),
      renderedAtSec: nowSec - 100,
    })));
    const io = createIo();

    const result = await planSafetyMapPublication({ adapter, eventName: "schedule", io, nowSec, statePath });

    expect(result.alreadyPublished).toBe(true);
    expect(io.output).toContain("already_published=true");
    expect(adapter.puts).toEqual([]);

    adapter.values.set("safety-map:latest.json", Buffer.from(JSON.stringify({
      date: "2026-07-27",
      asOfSec: nowSec - 6 * 3600,
      renderedAtSec: nowSec - 100,
    })));
    const dryRunStatePath = join(directory, "dry-run-state.json");
    const boundary = await planSafetyMapPublication({ adapter, dryRun: true, eventName: "schedule", io, nowSec, statePath: dryRunStatePath });
    expect(boundary.alreadyPublished).toBe(false);
    expect(existsSync(dryRunStatePath)).toBe(false);
  });

  it("accepts an audited snapshot transition only on a manual run", async () => {
    const directory = temporaryDirectory();
    const statePath = join(directory, "publish-state.json");
    const adapter = new MockKvAdapter();
    const nowSec = Date.UTC(2026, 6, 27, 8, 0, 0) / 1000;
    adapter.listings.set("safety-map:snapshot:latest", ["safety-map:snapshot:latest"]);
    adapter.values.set("safety-map:snapshot:latest", Buffer.from(JSON.stringify(validPreviousSnapshot())));

    await expect(planSafetyMapPublication({
      acceptSnapshotTransition: true,
      adapter,
      eventName: "schedule",
      nowSec,
      statePath,
    })).rejects.toThrow("restricted to workflow_dispatch");

    const planned = await planSafetyMapPublication({
      acceptSnapshotTransition: true,
      adapter,
      eventName: "workflow_dispatch",
      nowSec,
      statePath,
    });
    expect(planned.acceptedSnapshotTransition).toBe(true);
    expect(planned.previousSnapshotPath).toBe(join(directory, "previous-snapshot.json"));

    let renderCommand = "";
    const rendered = await renderSafetyMapPublication({
      commandRunner: (command) => {
        renderCommand = command;
        writeFileSync(join(directory, "latest.png"), "png bytes");
        writeFileSync(join(directory, "latest.alt.json"), "alt bytes");
        writeFileSync(join(directory, "latest.snapshot.json"), JSON.stringify({
          date: "2026-07-27",
          asOfSec: nowSec - 60,
          renderedAtSec: nowSec,
          edition: "daily",
          methodologyVersion: "9.44",
          counts: { graded: 43, notRated: 2 },
        }));
        return 0;
      },
      outDir: directory,
      statePath,
    });

    expect(rendered.deltaGuard).toBe("accepted");
    expect(renderCommand).toContain(`--previous-snapshot '${join(directory, "previous-snapshot.json")}'`);
    expect(renderCommand).toContain("--accept-snapshot-transition");
  });

  it("refuses to publish behind the live manifest before the first write", async () => {
    const directory = temporaryDirectory();
    const statePath = writeRenderedState(directory, {
      hadManifest: true,
      priorManifest: { renderedAtSec: 1_785_283_201 },
    });
    const adapter = new MockKvAdapter();

    await expect(publishSafetyMapPublication({ adapter, outDir: directory, statePath }))
      .rejects.toThrow("Backwards publish refused");
    expect(adapter.puts).toEqual([]);
  });

  it("aborts after a dated PNG readback mismatch without touching latest PNG or manifest", async () => {
    const directory = temporaryDirectory();
    const statePath = writeRenderedState(directory);
    const adapter = new MockKvAdapter();
    adapter.readbackOverride = Buffer.from("corrupt readback");

    await expect(publishSafetyMapPublication({ adapter, outDir: directory, statePath }))
      .rejects.toThrow("failed SHA-256 readback comparison");
    expect(adapter.puts.map(({ key }) => key)).toEqual([
      "safety-map:snapshot:2026-07-27",
      "safety-map:snapshot:latest",
      "safety-map:alt:latest",
      "safety-map:2026-07-27.png",
    ]);
    expect(adapter.puts.some(({ key }) => key === "safety-map:latest.json")).toBe(false);
  });

  it("renders the published-key summary with the commit marker called out last", () => {
    const directory = temporaryDirectory();
    const state = JSON.parse(readFileSync(writeRenderedState(directory), "utf8")) as SafetyMapPublishState;
    state.phase = "published";

    const summary = buildSafetyMapSummary(state, "success");

    expect(summary).toContain("## Safety Map refresh — success");
    expect(summary).toContain("| Day-over-day delta guard | ran |");
    expect(summary).toContain("`safety-map:2026-07-27.png` — the URL the digest embeds");
    expect(summary.trimEnd().endsWith("`safety-map:latest.json` — manifest, written last")).toBe(true);
  });

  it("labels transient recovery and persistent delta rejection in the summary", () => {
    const directory = temporaryDirectory();
    const recovered = JSON.parse(readFileSync(writeRenderedState(directory, { deltaGuard: "recovered" }), "utf8")) as SafetyMapPublishState;
    expect(buildSafetyMapSummary(recovered, "success")).toContain("Transient rejection recovered");

    const persistent = JSON.parse(readFileSync(writeRenderedState(directory, { deltaGuard: "persistent", phase: "planned" }), "utf8")) as SafetyMapPublishState;
    expect(buildSafetyMapSummary(persistent, "failure")).toContain("Persistent delta rejection");
  });
});
