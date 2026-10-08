import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAdmissionAuditCli } from "../audit-mint-burn-conservation-admission";
import { MINT_BURN_CONFIGS } from "../../src/lib/mint-burn-contracts";
import reviewedSidecar from "../../src/lib/mint-burn-conservation-reviewed.json";
import { renderMintBurnConservationRuntime } from "../../../scripts/maintenance/generate-mint-burn-conservation-runtime";
import type { ReviewedConservationEntry } from "../../src/lib/mint-burn-conservation";

const config = MINT_BURN_CONFIGS.find((item) => item.stablecoinId === "gusd-gemini")!;
const reviewed = reviewedSidecar.entries.find((item) => item.stablecoinId === config.stablecoinId)!;
const directories: string[] = [];
const word = (value: number) => `0x${value.toString(16).padStart(64, "0")}`;

beforeEach(() => {
  vi.stubEnv("ALCHEMY_API_KEY", "test-only");
  vi.spyOn(process, "loadEnvFile").mockImplementation(() => undefined);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

interface AdmissionFixture {
  directory: string;
  semanticDir: string;
  sidecarPath: string;
  runtimePath: string;
  semanticPath: string;
  review: typeof reviewed & { configDecimals: number; semanticVerdict: string };
}

function fixture(): AdmissionFixture {
  const directory = mkdtempSync(join(tmpdir(), "pharos-conservation-cli-"));
  directories.push(directory);
  const semanticDir = join(directory, "semantic");
  mkdirSync(semanticDir);
  const sidecarPath = join(directory, "reviewed.json");
  const runtimePath = join(directory, "runtime.json");
  writeFileSync(sidecarPath, JSON.stringify(reviewedSidecar));
  writeFileSync(runtimePath, "runtime-sentinel");
  const review = { ...reviewed, configDecimals: config.decimals, semanticVerdict: "standard-transfer" };
  const semanticPath = join(semanticDir, `${config.stablecoinId}__${config.chain.chainId}-${config.contractAddress.toLowerCase()}.json`);
  writeFileSync(semanticPath, JSON.stringify(review));
  return { directory, semanticDir, sidecarPath, runtimePath, semanticPath, review };
}

// Real audit orchestration, with deterministic JSON-RPC wire responses. The
// resulting journal is then replayed through the CLI's request-keyed reader.
function installRpcFixture(failingSecondWindow = false) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = JSON.parse(await request.text()) as { id: number; method: string; params: unknown[] } | { id: number; method: string; params: unknown[] }[];
    const reply = (call: { id: number; method: string; params: unknown[] }) => {
      let result: unknown;
      if (call.method === "eth_getBlockByNumber") {
        const block = Number(call.params[0]);
        result = { number: `0x${block.toString(16)}`, timestamp: `0x${(1000 + block).toString(16)}`, hash: word(block) };
      } else if (call.method === "eth_call") {
        const pin = call.params[1] as { blockHash: string };
        result = word(failingSecondWindow && pin.blockHash === word(98) ? 101 : 100);
      } else if (call.method === "eth_getLogs") {
        result = [];
      } else {
        throw new Error(`Unexpected fixture method ${call.method}`);
      }
      return { jsonrpc: "2.0", id: call.id, result };
    };
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(reply) : reply(body)), { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

async function seedJournal(f: AdmissionFixture, second = false, fail = false) {
  installRpcFixture(fail);
  const out = join(f.directory, "seed");
  const run = runAdmissionAuditCli([
    "--ids", config.stablecoinId, "--out", out, "--to-block", "102", "--window-blocks", "2",
    ...(second ? ["--second-window-to", "98"] : []),
  ], f);
  if (fail) await expect(run).rejects.toThrow("audited window(s) not ok");
  else await run;
  return join(out, "journal.jsonl");
}

function replayArgs(f: AdmissionFixture, journal: string, extra: string[] = []) {
  return ["--ids", config.stablecoinId, "--out", join(f.directory, "replay"), "--replay", journal, ...extra];
}
function draftArgs(f: AdmissionFixture) {
  return ["--semantic-dir", f.semanticDir, "--emit-sidecar-draft"];
}
function draft(f: AdmissionFixture): ReviewedConservationEntry[] {
  return JSON.parse(readFileSync(join(f.directory, "replay", "sidecar-draft.json"), "utf8"));
}

describe("conservation admission CLI journal and write boundary", () => {
  it("replays the original bytes and record without credentials, network, semantics, or implicit merge", async () => {
    const f = fixture();
    const journal = await seedJournal(f);
    const network = vi.fn(() => { throw new Error("Replay reached network"); });
    vi.stubGlobal("fetch", network);
    vi.stubEnv("ALCHEMY_API_KEY", "");
    const before = readFileSync(f.sidecarPath, "utf8");
    await runAdmissionAuditCli(replayArgs(f, journal), f);
    expect(network).not.toHaveBeenCalled();
    const bytes = readFileSync(journal, "utf8");
    expect(readFileSync(join(f.directory, "replay", "journal.jsonl"), "utf8")).toBe(bytes);
    const filename = `${config.chain.chainId}-${config.contractAddress.toLowerCase()}.json`;
    expect(readFileSync(join(f.directory, "replay", filename), "utf8")).toBe(readFileSync(join(f.directory, "seed", filename), "utf8"));
    expect(JSON.parse(readFileSync(join(f.directory, "replay", filename), "utf8")).journalSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(existsSync(join(f.directory, "replay", "sidecar-draft.json"))).toBe(false);
    expect(readFileSync(f.sidecarPath, "utf8")).toBe(before);
    expect(readFileSync(f.runtimePath, "utf8")).toBe("runtime-sentinel");
  });

  it("drafts complete passing windows without merging", async () => {
    const f = fixture();
    const journal = await seedJournal(f, true);
    const before = readFileSync(f.sidecarPath, "utf8");
    await runAdmissionAuditCli(replayArgs(f, journal, draftArgs(f)), f);
    expect(draft(f)).toHaveLength(1);
    expect(draft(f)[0]).toMatchObject({ disposition: "admitted", decimals: config.decimals, invariant: "transfer-supply" });
    expect(draft(f)[0].windows).toHaveLength(2);
    expect(readFileSync(f.sidecarPath, "utf8")).toBe(before);
    expect(readFileSync(f.runtimePath, "utf8")).toBe("runtime-sentinel");
  });

  it("does not admit a passing first window when the disjoint second window fails", async () => {
    const f = fixture();
    const journal = await seedJournal(f, true, true);
    const before = readFileSync(f.sidecarPath, "utf8");
    await expect(runAdmissionAuditCli(replayArgs(f, journal, draftArgs(f)), f)).rejects.toThrow("audited window(s) not ok");
    expect(draft(f)).toEqual([]);
    expect(readFileSync(f.sidecarPath, "utf8")).toBe(before);
    await expect(runAdmissionAuditCli(replayArgs(f, journal, [...draftArgs(f), "--merge-into-sidecar"]), f)).rejects.toThrow("no sidecar entries to merge");
    expect(readFileSync(f.runtimePath, "utf8")).toBe("runtime-sentinel");
  });

  it.each([
    { chainId: "wrong-chain" }, { stablecoinId: "wrong-id" },
    { address: word(999).slice(0, 42) }, { configDecimals: config.decimals + 1 },
  ])("rejects semantic identity mismatch %j before output or merge", async (mismatch) => {
    const f = fixture();
    const journal = await seedJournal(f);
    writeFileSync(f.semanticPath, JSON.stringify({ ...f.review, ...mismatch }));
    const before = readFileSync(f.sidecarPath, "utf8");
    await expect(runAdmissionAuditCli(replayArgs(f, journal, [...draftArgs(f), "--merge-into-sidecar"]), f)).rejects.toThrow("identity does not match the config");
    expect(existsSync(join(f.directory, "replay"))).toBe(false);
    expect(readFileSync(f.sidecarPath, "utf8")).toBe(before);
  });

  it("keeps unknown semantic verdicts pending even after a passing replay", async () => {
    const f = fixture();
    const journal = await seedJournal(f);
    writeFileSync(f.semanticPath, JSON.stringify({ ...f.review, semanticVerdict: "unproven-law" }));
    await runAdmissionAuditCli(replayArgs(f, journal, draftArgs(f)), f);
    expect(draft(f)).toEqual([]);
  });

  it("retains explicit unsupported evidence without manufacturing passing windows", async () => {
    const f = fixture();
    const journal = await seedJournal(f);
    writeFileSync(f.semanticPath, JSON.stringify({ ...f.review, semanticVerdict: "unsupported", unsupportedReason: "rebasing-supply-without-events" }));
    await expect(runAdmissionAuditCli(replayArgs(f, journal, [...draftArgs(f), "--merge-into-sidecar"]), f)).rejects.toThrow("audited window(s) not ok");
    expect(draft(f)[0]).toMatchObject({ disposition: "unsupported", unsupportedReason: "rebasing-supply-without-events", windows: [] });
    // Explicit merge precedes the aggregate audit exit; unsupported evidence is
    // a reviewed exclusion, not a claim that an audit passed.
    const merged = JSON.parse(readFileSync(f.sidecarPath, "utf8"));
    expect(merged.entries.find((entry: ReviewedConservationEntry) => entry.stablecoinId === config.stablecoinId)).toMatchObject(draft(f)[0]);
    expect(readFileSync(f.runtimePath, "utf8")).toBe(renderMintBurnConservationRuntime(merged));
  });

  it("never admits or merges a failed replay with missing RPC exchanges", async () => {
    const f = fixture();
    const journal = await seedJournal(f);
    const missing = join(f.directory, "missing-exchanges.jsonl");
    writeFileSync(missing, `${readFileSync(journal, "utf8").split("\n")[0]}\n`);
    const before = readFileSync(f.sidecarPath, "utf8");
    const network = vi.fn(() => { throw new Error("Replay reached network"); });
    vi.stubGlobal("fetch", network);
    await expect(runAdmissionAuditCli(replayArgs(f, missing, [...draftArgs(f), "--merge-into-sidecar"]), f)).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
    expect(draft(f)).toEqual([]);
    expect(readFileSync(f.sidecarPath, "utf8")).toBe(before);
    expect(readFileSync(f.runtimePath, "utf8")).toBe("runtime-sentinel");
  });

  it("requires explicit draft intent before merge and leaves destinations untouched", async () => {
    const f = fixture();
    await expect(runAdmissionAuditCli(["--ids", config.stablecoinId, "--out", join(f.directory, "replay"), "--merge-into-sidecar"], f)).rejects.toThrow("requires --emit-sidecar-draft");
    expect(existsSync(join(f.directory, "replay"))).toBe(false);
    expect(readFileSync(f.runtimePath, "utf8")).toBe("runtime-sentinel");
  });

  it("explicitly replaces one identity and regenerates the byte-exact runtime projection", async () => {
    const f = fixture();
    const journal = await seedJournal(f);
    const previous = { version: 1, entries: reviewedSidecar.entries.map((entry) => entry.stablecoinId === config.stablecoinId ? { ...entry, decimals: config.decimals + 1 } : entry) };
    writeFileSync(f.sidecarPath, JSON.stringify(previous));
    await runAdmissionAuditCli(replayArgs(f, journal, [...draftArgs(f), "--merge-into-sidecar"]), f);
    const merged = JSON.parse(readFileSync(f.sidecarPath, "utf8"));
    expect(merged.entries).toHaveLength(previous.entries.length);
    expect(merged.entries.filter((entry: ReviewedConservationEntry) => entry.stablecoinId === config.stablecoinId)).toEqual(draft(f));
    for (const entry of previous.entries.filter((item) => item.stablecoinId !== config.stablecoinId)) expect(merged.entries).toContainEqual(entry);
    expect(readFileSync(f.runtimePath, "utf8")).toBe(renderMintBurnConservationRuntime(merged));
  });
});
