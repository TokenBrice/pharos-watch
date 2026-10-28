import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { PUBLIC_RPC_URLS, SUPPLY_RPC_DEFAULTS } from "@shared/lib/chain-rpc-registry";
import { jsonResponse } from "@shared/test-utils/mock-fetch";
import {
  BLOCK_MAX_AGE_SEC,
  compareHypercoreUsdc,
  DIVERGENCE_THRESHOLD,
  PUBLISHED_MAX_AGE_SEC,
  readPublishedHypercoreUsdc,
  renderHypercoreReport,
  runHypercoreUsdcCheck,
} from "../maintenance/check-hypercore-usdc";

vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async () => {}) }));

const NOW = 1_793_199_000;
const input = () => ({ published: 100, supply: 80, escrow: 20, publishedAt: NOW - 600, blockTimestamps: [NOW, NOW, NOW, NOW], now: NOW });
const payload = (coin: Record<string, unknown> = {}) => ({
  _meta: { updatedAt: NOW - 600 },
  peggedAssets: [{ id: "usdc-circle", supplySource: "defillama", chainCirculating: { "Hyperliquid L1": { current: 100 } }, ...coin }],
});
const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
interface RpcRequest { method: string; params: unknown[] }

function mockFetch(override?: (url: string, request: RpcRequest | null) => Response | undefined) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const request = init?.body ? JSON.parse(String(init.body)) as RpcRequest : null;
    const custom = override?.(url, request);
    if (custom) return custom;
    if (!request) return jsonResponse(payload());
    const isArbitrum = url === PUBLIC_RPC_URLS.arbitrum;
    let result: unknown;
    if (request.method === "eth_chainId") result = isArbitrum ? "0xa4b1" : "0x3e7";
    else if (request.method === "eth_getBlockByNumber") result = { number: "0x100", timestamp: `0x${NOW.toString(16)}` };
    else if (request.method === "eth_call") {
      const data = (request.params[0] as { data: string }).data;
      result = data === "0x313ce567" ? word(6n) : word(isArbitrum ? 20_000_000n : 80_000_000n);
    } else throw new Error(`Unexpected method ${request.method}`);
    return jsonResponse({ jsonrpc: "2.0", id: 1, result });
  });
}

afterEach(() => vi.restoreAllMocks());

describe("HyperCore USDC comparison", () => {
  it.each([98, 100, 102])("accepts aggregate %s, including exact threshold boundaries", aggregate => {
    expect(compareHypercoreUsdc({ ...input(), supply: aggregate - 20 })).toMatchObject({ status: "healthy", ratio: aggregate / 100 });
  });

  it.each([97.999, 102.001])("reports aggregate %s outside the threshold", aggregate => {
    expect(compareHypercoreUsdc({ ...input(), supply: aggregate - 20 })).toMatchObject({ status: "divergence", reason: "aggregate-outside-threshold" });
  });

  it("retains explicit zero and the configured threshold", () => {
    expect(DIVERGENCE_THRESHOLD).toBe(0.02);
    expect(compareHypercoreUsdc({ ...input(), supply: 0, escrow: 0 })).toMatchObject({ status: "divergence", ratio: 0 });
    expect(compareHypercoreUsdc({ ...input(), supply: 100, escrow: 0 })).toMatchObject({ status: "healthy", ratio: 1 });
  });

  it.each([{ published: 0 }, { published: -1 }, { published: NaN }, { supply: -1 }, { escrow: Infinity }])("withholds invalid amounts %j", change => {
    expect(compareHypercoreUsdc({ ...input(), ...change })).toEqual({ status: "unavailable", reason: "invalid-amount" });
  });

  it("accepts inclusive freshness budgets", () => {
    expect(compareHypercoreUsdc({ ...input(), publishedAt: NOW - PUBLISHED_MAX_AGE_SEC, blockTimestamps: Array(4).fill(NOW - BLOCK_MAX_AGE_SEC) })).toMatchObject({ status: "healthy" });
  });

  it.each([0, NaN, NOW + 61, NOW - PUBLISHED_MAX_AGE_SEC - 1])("withholds published clock %s", publishedAt => {
    expect(compareHypercoreUsdc({ ...input(), publishedAt })).toEqual({ status: "unavailable", reason: "published-clock-stale-or-invalid" });
  });

  it.each([[], [NOW], [NOW, NOW, NOW, 0], [NOW, NOW, NOW, NOW + 61], [NOW, NOW, NOW, NOW - BLOCK_MAX_AGE_SEC - 1]].map(blockTimestamps => ({ blockTimestamps })))("withholds incomplete or stale block clocks %j", ({ blockTimestamps }) => {
    expect(compareHypercoreUsdc({ ...input(), blockTimestamps })).toEqual({ status: "unavailable", reason: "block-clock-stale-or-invalid" });
  });
});

describe("Published HyperCore bucket admission", () => {
  it("reads the current USD bucket without price multiplication and keeps its source clock", () => {
    expect(readPublishedHypercoreUsdc(payload({ price: 0.5 }))).toMatchObject({ amount: 100, observedAt: NOW - 600, clock: "_meta.updatedAt", bucket: "Hyperliquid L1" });
    expect(readPublishedHypercoreUsdc(payload({ supplyObservedAt: NOW - 1200 }))).toMatchObject({ observedAt: NOW - 1200 });
  });

  it.each([
    { chainCirculating: { "Hyperliquid L1": { current: null } } },
    { chainCirculating: { "Hyperliquid L1": { current: 100 }, hyperliquid: { current: 100 } } },
    { chainCirculating: { "Hyperliquid L1": { current: 100 }, HyperEVM: { current: 0 } } },
    { supplyRestored: true }, { supplyUnavailableReason: "failed" }, { supplySource: "coingecko" }, { supplyObservedAt: null },
  ])("rejects incomplete or changed evidence %j", coin => {
    expect(() => readPublishedHypercoreUsdc(payload(coin))).toThrow();
  });

  it("rejects missing clocks, missing coin and duplicate coin identities", () => {
    expect(() => readPublishedHypercoreUsdc({ ...payload(), _meta: {} })).toThrow("published-clock-unavailable");
    expect(() => readPublishedHypercoreUsdc({ ...payload(), peggedAssets: [] })).toThrow("published-usdc-missing");
    const data = payload();
    data.peggedAssets.push(data.peggedAssets[0]);
    expect(() => readPublishedHypercoreUsdc(data)).toThrow("published-usdc-missing");
  });

  it.each([
    { generationAt: NOW + 3600, supplyObservedAt: NOW },
    { generationAt: NOW, supplyObservedAt: NOW + 3600 },
  ])("rejects a future source clock instead of hiding it with the other clock", ({ generationAt, supplyObservedAt }) => {
    vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    expect(() => readPublishedHypercoreUsdc({ ...payload({ supplyObservedAt }), _meta: { updatedAt: generationAt } })).toThrow();
  });
});

describe("HyperCore live-read orchestration (offline)", () => {
  it("uses eleven reads, latest calls, verified decimals, and records bracket clocks", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    const fetchImpl = mockFetch();
    const report = await runHypercoreUsdcCheck("test-key", fetchImpl as typeof fetch);
    expect(report).toMatchObject({ status: "healthy", ratio: 1, failures: [], hyperevm: { amount: 80, decimals: 6, before: { number: 256, timestamp: NOW }, after: { number: 256, timestamp: NOW } }, arbitrum: { amount: 20, decimals: 6 } });
    expect(fetchImpl).toHaveBeenCalledTimes(11);
    const metadata = JSON.parse(readFileSync("shared/data/stablecoins/coins/usdc-circle.json", "utf8")) as {
      contracts: Array<{ chain: string; address: string; decimals: number }>;
    };
    const hyperevm = metadata.contracts.find(contract => contract.chain === "hyperevm");
    const arbitrum = metadata.contracts.find(contract => contract.chain === "arbitrum");
    expect(hyperevm?.decimals).toBe(6);
    expect(arbitrum?.decimals).toBe(6);
    const calls: unknown[][] = [];
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(init?.redirect).toBe("error");
      const headers = new Headers(init?.headers);
      expect(headers.get("X-API-Key")).toBe(url.startsWith("https://api.pharos.watch/") ? "test-key" : null);
      if (init?.body) {
        const request = JSON.parse(String(init.body)) as RpcRequest;
        if (request.method === "eth_call") calls.push(request.params);
      }
    }
    expect(calls).toEqual([
      [{ to: hyperevm?.address, data: "0x313ce567" }, "latest"],
      [{ to: hyperevm?.address, data: "0x18160ddd" }, "latest"],
      [{ to: arbitrum?.address, data: "0x313ce567" }, "latest"],
      [{ to: arbitrum?.address, data: "0x70a082310000000000000000000000002df1c51e09aecf9cacb7bc98cb1742757f163df7" }, "latest"],
    ]);
    const body = renderHypercoreReport(report, "https://github.com/example/repo/actions/runs/1");
    expect(body).toContain("Due: 2026-10-28");
    expect(body).toContain("## Check");
    expect(body).toContain("https://github.com/example/repo/actions/runs/1");
    expect(body).toContain('"ratio": 1');
    expect(body).toContain("does not isolate HyperCore");
  });

  it("retries the entire HyperEVM read on the reviewed fallback and names failed provenance", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    const fetchImpl = mockFetch(url => url === SUPPLY_RPC_DEFAULTS.hyperevm.rpcUrl ? new Response("unavailable", { status: 503 }) : undefined);
    const report = await runHypercoreUsdcCheck("test-key", fetchImpl as typeof fetch);
    expect(report).toMatchObject({ status: "healthy", hyperevm: { rpc: SUPPLY_RPC_DEFAULTS.hyperevm.fallbackRpcUrl, failedAttempts: [expect.stringContaining("http-503")] } });
    expect(fetchImpl).toHaveBeenCalledTimes(12);
  });

  it.each(["decimals", "rpc-error", "http-error", "malformed-word"])("withholds divergence on %s", async failure => {
    vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    const fetchImpl = mockFetch((url, request) => {
      if (url !== PUBLIC_RPC_URLS.arbitrum || request?.method !== "eth_call") return;
      if (failure === "http-error") return new Response("unavailable", { status: 503 });
      if (failure === "rpc-error") return jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "unavailable" } });
      if (failure === "malformed-word") return jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x" });
      return jsonResponse({ jsonrpc: "2.0", id: 1, result: word(18n) });
    });
    const report = await runHypercoreUsdcCheck("test-key", fetchImpl as typeof fetch);
    expect(report).toMatchObject({ status: "unavailable", reason: "required-read-failed", arbitrum: null });
    expect(report.failures).toHaveLength(1);
    expect(report).not.toHaveProperty("ratio");
  });

  it("withholds stale upstream evidence even when the observed aggregate would diverge", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    const fetchImpl = mockFetch((_url, request) => !request ? jsonResponse({ ...payload({ chainCirculating: { "Hyperliquid L1": { current: 1 } } }), _meta: { updatedAt: NOW - PUBLISHED_MAX_AGE_SEC - 1 } }) : undefined);
    expect(await runHypercoreUsdcCheck("test-key", fetchImpl as typeof fetch)).toMatchObject({ status: "unavailable", reason: "published-clock-stale-or-invalid" });
  });
});

describe("HyperCore workflow issue lifecycle (offline)", () => {
  it.each([
    { status: "healthy", issue: "", repeats: 1, creates: 0, edits: 0, closes: 0, comments: 0 },
    { status: "healthy", issue: "42", repeats: 2, creates: 0, edits: 0, closes: 1, comments: 1 },
    { status: "healthy", issue: "42", repeats: 2, creates: 0, edits: 0, closes: 2, comments: 1, failClose: true },
    { status: "divergence", issue: "", repeats: 2, creates: 1, edits: 1, closes: 0, comments: 0 },
    { status: "divergence", issue: "42", repeats: 1, creates: 0, edits: 1, closes: 0, comments: 0 },
    { status: "unavailable", issue: "42", repeats: 1, creates: 0, edits: 0, closes: 0, comments: 0 },
  ])("reconciles $status with existing issue '$issue'", testCase => {
    const workflow = parseYaml(readFileSync(".github/workflows/hypercore-usdc-cross-check.yml", "utf8")) as {
      jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
    };
    const shell = workflow.jobs["cross-check"].steps.find(step => step.name === "Reconcile divergence issue")?.run;
    expect(shell).toBeTypeOf("string");
    const dir = mkdtempSync(join(tmpdir(), "hypercore-issue-test-"));
    const log = join(dir, "gh.log");
    const issue = join(dir, "issue");
    try {
      writeFileSync(join(dir, "hypercore-usdc.json"), JSON.stringify({ status: testCase.status }));
      writeFileSync(join(dir, "hypercore-usdc.md"), "Offline evidence");
      writeFileSync(issue, JSON.stringify({ number: testCase.issue, comments: "", failClose: testCase.failClose ?? false }));
      writeFileSync(join(dir, "gh"), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_TEST_LOG, args.join(' ') + '\\n');
const state = JSON.parse(fs.readFileSync(process.env.GH_TEST_ISSUE_FILE, 'utf8'));
let exit = 0;
switch (args.slice(0, 2).join(' ')) {
  case 'issue list': console.log(state.number); break;
  case 'issue view': console.log('Original divergence evidence'); break;
  case 'issue create': state.number = '42'; break;
  case 'issue comment': state.comments += fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8'); break;
  case 'issue close':
    if (state.failClose) { state.failClose = false; exit = 1; }
    else state.number = '';
    break;
  default:
    if (args[0] === 'api') console.log(state.comments);
}
fs.writeFileSync(process.env.GH_TEST_ISSUE_FILE, JSON.stringify(state));
process.exitCode = exit;
`, { mode: 0o755 });
      for (let i = 0; i < testCase.repeats; i++) {
        writeFileSync(join(dir, "hypercore-usdc.md"), "Offline evidence");
        const result = spawnSync("bash", ["-c", shell!], { encoding: "utf8", env: {
          ...process.env, PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir, GH_REPO: "example/repo", GH_TEST_LOG: log, GH_TEST_ISSUE_FILE: issue,
        } });
        expect(result.status, result.stderr).toBe(testCase.status === "unavailable" || (testCase.failClose && i === 0) ? 1 : 0);
      }
      const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
      for (const [verb, count] of [["create", testCase.creates], ["edit", testCase.edits], ["close", testCase.closes], ["comment", testCase.comments]] as const) {
        expect(calls.filter(call => call.startsWith(`issue ${verb} `))).toHaveLength(count);
      }
      if (testCase.status === "unavailable") expect(calls).toEqual([]);
      if (testCase.status === "divergence") expect(calls.find(call => /^issue (create|edit) /.test(call))).toContain("ops:followup");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
