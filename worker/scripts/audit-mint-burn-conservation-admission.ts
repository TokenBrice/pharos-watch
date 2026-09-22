#!/usr/bin/env node
/**
 * Mint/burn conservation admission audit (2026-09-22 expansion plan, P2).
 *
 * Runs the production conservation audit — pooled boundary pre-pass
 * (`fetchConservationBoundaries`) + `completeMintBurnConservationAudit` + the
 * production `fetchAlchemyLogs` with the same topic filters the config scan
 * builds — over a frozen window for every config of the requested stablecoin
 * ids. Every JSON-RPC exchange is journaled to <out>/journal.jsonl with URLs
 * redacted to origin + chain path (never the API key); `--replay` re-derives
 * the same records offline from a journal. With `--semantic-dir` the script
 * merges reviewer semantic verdicts with the audited windows into
 * reviewed-identity sidecar entries.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { MintBurnConservationRecord } from "@shared/types/status";
import {
  assertCliUsage,
  CliUsageError,
  parseCliInteger,
  parseStrictCliArgs,
  requireCliString,
  runCliEntrypoint,
  writeCliHelpIfRequested,
} from "../../scripts/lib/cli-args.mjs";
import { MINT_BURN_CONFIGS } from "../src/lib/mint-burn-contracts";
import type { MintBurnContractConfig, MintBurnEventDef } from "../src/lib/mint-burn-contracts";
import { buildAlchemyUrl, fetchAlchemyLogs, getAlchemyBlockNumber } from "../src/lib/alchemy-logs";
import type { AlchemyLogEntry } from "../src/lib/alchemy-logs";
import { eventDefTopicFilters } from "../src/cron/mint-burn/sync-config";
import { fetchEvmRpcBatchDetailed } from "../src/lib/evm-rpc";
import {
  completeMintBurnConservationAudit,
  fetchConservationBoundaries,
  resolveMintBurnConservationEligibility,
  reviewedConservationIdentityKey,
  validateReviewedConservationEntry,
  type ConservationBoundaryRequest,
  type MintBurnConservationEligibilityResolver,
  type ReviewedConservationEntry,
  type ReviewedConservationIdentity,
  type ReviewedConservationWindow,
} from "../src/lib/mint-burn-conservation";

const USAGE = `Usage: npm run audit:mint-burn-conservation-admission -- --ids <csv> --out <dir> [options]

Audits the raw-token conservation equation (mint - burn = totalSupply delta) for
every MINT_BURN_CONFIGS config of the requested stablecoin ids over a frozen
window, using the production audit path. Credentials: ALCHEMY_API_KEY (env or
ignored root .env.local).

Options:
  --ids <csv>              Comma-separated stablecoin ids (required)
  --out <dir>              Output directory (required)
  --to-block <n>           Frozen window end; default: chain head minus 64
  --window-seconds <n>     Window length by wall-clock time; default 86400. The
                           window starts after the last block whose timestamp is
                           <= (toBlock timestamp - windowSeconds), located by
                           binary search on eth_getBlockByNumber
  --window-blocks <n>      Explicit block-count window; overrides --window-seconds
  --second-window-to <n|auto>  Audit a second, disjoint window. "auto" ends it
                           immediately before the primary window's first block
  --semantic-dir <dir>     Reviewer semantic files <id>__<chain>-<address>.json
  --emit-sidecar-draft     Write <out>/sidecar-draft.json from semantic files +
                           audited windows (requires --semantic-dir)
  --merge-into-sidecar     Replace same-identity entries in the committed
                           sidecar with the draft (requires --emit-sidecar-draft)
  --replay <journal.jsonl> Serve all RPC responses from a journal (no network)
                           and reproduce the original run's records
  -h, --help               Show this help`;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../..");
const SIDECAR_PATH = resolve(SCRIPT_DIR, "../src/lib/mint-burn-conservation-reviewed.json");
const DEFAULT_WINDOW_SECONDS = 86_400;
const HEAD_CONFIRMATION_BLOCKS = 64;
const AUDIT_BUDGET_LIMIT = 4_096;

interface AuditWindow {
  fromBlock: number;
  toBlock: number;
}

interface ChainWindows {
  primary: AuditWindow;
  second: AuditWindow | null;
}

interface JournalExchange {
  kind: "exchange";
  url: string;
  method: string;
  requestBody: string | null;
  status: number;
  responseBody: string | null;
}

interface JournalRunHeader {
  kind: "run";
  checkedAt: number;
  windowSeconds: number;
  windowBlocks: number | null;
  secondWindowTo: number | "auto" | null;
  windows: Record<string, { fromBlock: number; toBlock: number; secondFromBlock: number | null; secondToBlock: number | null }>;
}

interface SemanticReview {
  chainId: string;
  stablecoinId: string;
  address: string;
  configDecimals: number;
  identity: ReviewedConservationIdentity;
  supplyPaths: unknown;
  unpairedPaths: unknown;
  totalSupplyView: { isStoredSum?: boolean; [field: string]: unknown };
  zeroRecipientTransferReverts: boolean | null;
  zeroRecipientTransferBurns: boolean | null;
  semanticVerdict: string;
  unsupportedReason: string | null;
  identityIssue: string | null;
  notes: string | null;
  reviewedAt: string;
  reviewer: string;
}

interface ConfigAudit {
  config: MintBurnContractConfig;
  window: AuditWindow;
  record: MintBurnConservationRecord;
}

/** Origin + chain path only; the trailing credential path segment is dropped. */
function redactRpcUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.search = "";
    url.hash = "";
    const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
    if (segments.length > 0) segments.pop();
    return `${url.origin}${segments.length > 0 ? `/${segments.join("/")}` : ""}/`;
  } catch {
    return "unparseable-url";
  }
}

function requestBodyText(init: RequestInit | undefined): string | null {
  return typeof init?.body === "string" ? init.body : null;
}

function exchangeKey(method: string, url: string, requestBody: string | null): string {
  return `${method}\u0000${url}\u0000${requestBody ?? ""}`;
}

function installJournalingFetch(onExchange: (exchange: JournalExchange) => void): void {
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = redactRpcUrl(request.url);
    const method = request.method;
    const requestBody = requestBodyText(init);
    const response = await originalFetch(request);
    const responseBody = await response.clone().text().catch(() => null);
    onExchange({ kind: "exchange", url, method, requestBody, status: response.status, responseBody });
    return response;
  }) as typeof fetch;
}

function installReplayingFetch(journalExchanges: readonly JournalExchange[], onExchange: (exchange: JournalExchange) => void): void {
  const pending = new Map<string, JournalExchange[]>();
  for (const exchange of journalExchanges) {
    const key = exchangeKey(exchange.method, exchange.url, exchange.requestBody);
    const queue = pending.get(key);
    if (queue) queue.push(exchange);
    else pending.set(key, [exchange]);
  }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = redactRpcUrl(request.url);
    const requestBody = requestBodyText(init);
    const queue = pending.get(exchangeKey(request.method, url, requestBody));
    const exchange = queue?.shift();
    if (!exchange) {
      throw new Error(`journal replay miss: no unused entry for ${request.method} ${url}`);
    }
    onExchange(exchange);
    return new Response(exchange.responseBody ?? "", { status: exchange.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

async function fetchBlockTimestamp(rpcUrl: string, block: number, budget: { count: number; limit: number }): Promise<number | null> {
  budget.count++;
  const result = await fetchEvmRpcBatchDetailed(undefined,
    [{ method: "eth_getBlockByNumber", params: [`0x${block.toString(16)}`, false] }],
    { extraRpcUrls: [rpcUrl], maxRetries: 0, timeoutMs: 30_000 });
  const header = result && result.errors.length === 0 ? result.results[0] : null;
  if (header === null || header === undefined || typeof header !== "object" || !("timestamp" in header) ||
    typeof header.timestamp !== "string" || !/^0x[0-9a-f]+$/i.test(header.timestamp)) return null;
  return Number(BigInt(header.timestamp));
}

/**
 * Last block with timestamp <= target, by binary search over eth_getBlockByNumber.
 * Block timestamps are non-decreasing, so the usual ordered-search invariant applies.
 */
async function findBlockAtOrBefore(rpcUrl: string, toBlock: number, target: number,
  budget: { count: number; limit: number }): Promise<number | null> {
  let lo = 0;
  let hi = toBlock;
  while (lo < hi) {
    const mid = lo + ((hi - lo + 1) >> 1);
    const timestamp = await fetchBlockTimestamp(rpcUrl, mid, budget);
    if (timestamp === null) return null;
    if (timestamp <= target) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

async function resolveWindow(rpcUrl: string, toBlock: number, windowSeconds: number, windowBlocks: number | null,
  budget: { count: number; limit: number }): Promise<AuditWindow | null> {
  if (windowBlocks !== null) {
    const fromBlock = toBlock - windowBlocks + 1;
    return fromBlock >= 1 ? { fromBlock, toBlock } : null;
  }
  const toTimestamp = await fetchBlockTimestamp(rpcUrl, toBlock, budget);
  if (toTimestamp === null) return null;
  const target = toTimestamp - windowSeconds;
  if (target < 0) return null;
  const boundary = await findBlockAtOrBefore(rpcUrl, toBlock, target, budget);
  if (boundary === null) return null;
  const fromBlock = boundary + 1;
  return fromBlock <= toBlock ? { fromBlock, toBlock } : null;
}

function parseSemanticReview(path: string, config: MintBurnContractConfig): SemanticReview {
  assertCliUsage(existsSync(path), `missing semantic file ${path}`);
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  assertCliUsage(typeof parsed === "object" && parsed !== null, `semantic file ${path} is not a JSON object`);
  // Validate the fields the disposition logic reads directly; reviewer-authored evidence
  // fields are validated downstream by validateReviewedConservationEntry on the built entry.
  assertCliUsage("chainId" in parsed && "stablecoinId" in parsed && "address" in parsed && "configDecimals" in parsed &&
    "semanticVerdict" in parsed && "identity" in parsed && "reviewedAt" in parsed && "reviewer" in parsed,
    `semantic file ${path} is missing required fields`);
  const review = parsed as SemanticReview;
  assertCliUsage(
    review.chainId === config.chain.chainId && review.stablecoinId === config.stablecoinId &&
      typeof review.address === "string" && review.address.toLowerCase() === config.contractAddress.toLowerCase() &&
      review.configDecimals === config.decimals,
    `semantic file ${path} identity does not match the config`,
  );
  assertCliUsage(typeof review.semanticVerdict === "string" && review.semanticVerdict.length > 0,
    `semantic file ${path} has no semanticVerdict`);
  assertCliUsage(typeof review.identity === "object" && review.identity !== null,
    `semantic file ${path} has no identity block`);
  assertCliUsage(review.semanticVerdict !== "unsupported" || typeof review.unsupportedReason === "string",
    `semantic file ${path} is unsupported without an unsupportedReason`);
  assertCliUsage(typeof review.reviewedAt === "string" && typeof review.reviewer === "string",
    `semantic file ${path} is missing reviewedAt/reviewer`);
  assertCliUsage(review.supplyPaths === undefined || Array.isArray(review.supplyPaths),
    `semantic file ${path} has malformed supplyPaths`);
  assertCliUsage(review.unpairedPaths === undefined || Array.isArray(review.unpairedPaths),
    `semantic file ${path} has malformed unpairedPaths`);
  return review;
}

function candidateEntryFor(review: SemanticReview | undefined, config: MintBurnContractConfig): ReviewedConservationEntry {
  const base = { chainId: config.chain.chainId, stablecoinId: config.stablecoinId,
    address: config.contractAddress.toLowerCase(), decimals: config.decimals };
  if (review?.semanticVerdict === "unsupported") {
    return { ...base, disposition: "unsupported", unsupportedReason: review.unsupportedReason, eventSet: "transfer" };
  }
  if (review?.semanticVerdict === "needs-review" &&
    (review.identity?.sourceVerified === false || review.identity?.proxy?.implementationSourceVerified === false)) {
    return { ...base, disposition: "unsupported", unsupportedReason: "unverified-implementation-source", eventSet: "transfer" };
  }
  return { ...base, disposition: "admitted", unsupportedReason: null, eventSet: "transfer" };
}

function sidecarWindowFromRecord(record: MintBurnConservationRecord, journalSha256: string): ReviewedConservationWindow {
  // Only invoked for `ok` records, whose boundary and arithmetic fields are present by construction.
  return {
    fromBlock: record.fromBlock ?? 0,
    fromBlockHash: record.fromBlockHash ?? "",
    fromTimestamp: record.fromTimestamp ?? 0,
    toBlock: record.toBlock ?? 0,
    toBlockHash: record.toBlockHash ?? "",
    toTimestamp: record.toTimestamp ?? 0,
    mintRaw: record.mintRaw ?? "0",
    burnRaw: record.burnRaw ?? "0",
    supplyDeltaRaw: record.supplyDeltaRaw ?? "0",
    residualRaw: record.residualRaw ?? "0",
    logCount: record.logCount ?? 0,
    journalSha256,
  };
}

function writeSummary(outDir: string, audits: readonly ConfigAudit[]): void {
  const counts = new Map<MintBurnContractConfig, number>();
  for (const { config } of audits) counts.set(config, (counts.get(config) ?? 0) + 1);
  const multiWindow = [...counts.values()].some((count) => count > 1);
  const header = multiWindow
    ? "| id | address | window | status | reason | mintRaw | burnRaw | supplyDeltaRaw | residualRaw | logCount |"
    : "| id | address | status | reason | mintRaw | burnRaw | supplyDeltaRaw | residualRaw | logCount |";
  const divider = multiWindow
    ? "| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |"
    : "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |";
  const seen = new Map<MintBurnContractConfig, number>();
  const rows: string[] = [];
  for (const { config, window, record } of audits) {
    const occurrence = seen.get(config) ?? 0;
    seen.set(config, occurrence + 1);
    const label = multiWindow ? `w${occurrence + 1}` : null;
    rows.push(`| ${config.stablecoinId} | ${config.contractAddress.toLowerCase()}${label === null ? "" : ` | ${label}`} | ` +
      `${record.status} | ${record.reason ?? ""} | ${record.mintRaw ?? ""} | ${record.burnRaw ?? ""} | ` +
      `${record.supplyDeltaRaw ?? ""} | ${record.residualRaw ?? ""} | ${record.logCount ?? ""} |`);
  }
  writeFileSync(join(outDir, "summary.md"), ["# Mint/burn conservation admission audit", "", header, divider, ...rows, ""].join("\n"));
}

function buildSidecarEntry(review: SemanticReview, config: MintBurnContractConfig, disposition: "admitted" | "unsupported",
  windows: ReviewedConservationWindow[]): ReviewedConservationEntry {
  const entry: ReviewedConservationEntry = {
    chainId: config.chain.chainId,
    stablecoinId: config.stablecoinId,
    address: config.contractAddress.toLowerCase(),
    decimals: config.decimals,
    disposition,
    unsupportedReason: disposition === "unsupported" ? review.unsupportedReason : null,
    eventSet: "transfer",
    invariant: "transfer-supply",
    identity: review.identity,
    supplyPaths: Array.isArray(review.supplyPaths) ? review.supplyPaths : [],
    unpairedPaths: Array.isArray(review.unpairedPaths) ? review.unpairedPaths : [],
    totalSupplyView: review.totalSupplyView,
    zeroRecipientTransferReverts: review.zeroRecipientTransferReverts ?? null,
    zeroRecipientTransferBurns: review.zeroRecipientTransferBurns ?? null,
    identityIssue: review.identityIssue ?? null,
    notes: review.notes ?? null,
    windows,
    reviewedAt: review.reviewedAt,
    reviewer: review.reviewer,
  };
  const problems = validateReviewedConservationEntry(entry);
  if (problems.length > 0) {
    throw new Error(`refusing structurally invalid sidecar entry:\n${problems.join("\n")}`);
  }
  return entry;
}

function mergeEntriesIntoSidecar(entries: readonly ReviewedConservationEntry[]): void {
  assertCliUsage(entries.length > 0, "no sidecar entries to merge");
  const existing: unknown = JSON.parse(readFileSync(SIDECAR_PATH, "utf8"));
  const previous = Array.isArray((existing as { entries?: unknown }).entries)
    ? ((existing as { entries: ReviewedConservationEntry[] }).entries) : [];
  // Same chain + stablecoin + address is one identity: a decimals change replaces, never duplicates.
  const byIdentity = new Map(previous.map((entry) =>
    [`${entry.chainId}\u0000${entry.stablecoinId}\u0000${entry.address.toLowerCase()}`, entry]));
  for (const entry of entries) {
    byIdentity.set(`${entry.chainId}\u0000${entry.stablecoinId}\u0000${entry.address.toLowerCase()}`, entry);
  }
  const merged = [...byIdentity.values()].sort((a, b) =>
    a.chainId < b.chainId ? -1 : a.chainId > b.chainId ? 1 :
      a.stablecoinId < b.stablecoinId ? -1 : a.stablecoinId > b.stablecoinId ? 1 :
        a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
  writeFileSync(SIDECAR_PATH, `${JSON.stringify({ version: 1, entries: merged }, null, 2)}\n`);
}

async function runAdmissionAuditCli(argv: readonly string[]): Promise<void> {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      ids: { type: "string" },
      "to-block": { type: "string" },
      "window-seconds": { type: "string" },
      "window-blocks": { type: "string" },
      "second-window-to": { type: "string" },
      out: { type: "string" },
      "semantic-dir": { type: "string" },
      "emit-sidecar-draft": { type: "boolean" },
      replay: { type: "string" },
      "merge-into-sidecar": { type: "boolean" },
    },
    conflicts: [["replay", "to-block"], ["replay", "second-window-to"], ["window-blocks", "window-seconds"]],
  });
  if (writeCliHelpIfRequested(values, USAGE, process.stdout)) return;

  const ids = requireCliString(values.ids, "--ids").split(",").map((id) => id.trim()).filter(Boolean);
  assertCliUsage(ids.length > 0, "--ids requires at least one stablecoin id");
  const outDir = requireCliString(values.out, "--out");
  const toBlockArg = values["to-block"] != null
    ? parseCliInteger(String(values["to-block"]), { name: "--to-block", min: 1 }) : null;
  const windowSeconds = values["window-seconds"] != null
    ? parseCliInteger(String(values["window-seconds"]), { name: "--window-seconds", min: 1 }) : DEFAULT_WINDOW_SECONDS;
  const windowBlocks = values["window-blocks"] != null
    ? parseCliInteger(String(values["window-blocks"]), { name: "--window-blocks", min: 1 }) : null;
  const secondWindowArg = values["second-window-to"] != null ? String(values["second-window-to"]) : null;
  const secondWindowTo = secondWindowArg === "auto" ? "auto" as const
    : secondWindowArg != null ? parseCliInteger(secondWindowArg, { name: "--second-window-to", min: 1 }) : null;
  const semanticDir = values["semantic-dir"] != null ? String(values["semantic-dir"]) : null;
  const emitSidecarDraft = values["emit-sidecar-draft"] === true;
  const mergeIntoSidecar = values["merge-into-sidecar"] === true;
  const replayPath = values.replay != null ? String(values.replay) : null;
  assertCliUsage(!emitSidecarDraft || semanticDir != null, "--emit-sidecar-draft requires --semantic-dir");
  assertCliUsage(!mergeIntoSidecar || emitSidecarDraft, "--merge-into-sidecar requires --emit-sidecar-draft");

  const configs: MintBurnContractConfig[] = [];
  for (const id of ids) {
    const matches = MINT_BURN_CONFIGS.filter((config) => config.stablecoinId === id);
    assertCliUsage(matches.length > 0, `no MINT_BURN_CONFIGS entry for id ${id}`);
    configs.push(...matches);
  }
  configs.sort((a, b) => a.chain.chainId < b.chain.chainId ? -1 : a.chain.chainId > b.chain.chainId ? 1 :
    a.stablecoinId < b.stablecoinId ? -1 : a.stablecoinId > b.stablecoinId ? 1 :
      a.contractAddress.toLowerCase() < b.contractAddress.toLowerCase() ? -1 : 1);

  const envFile = resolve(REPO_ROOT, ".env.local");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const alchemyApiKey = process.env.ALCHEMY_API_KEY?.trim();
  // Replay never reaches the network; a placeholder only shapes the redacted match URL.
  const apiKeyForUrls = alchemyApiKey != null && alchemyApiKey.length > 0
    ? alchemyApiKey : replayPath !== null ? "replay-no-network" : null;
  assertCliUsage(apiKeyForUrls !== null, "ALCHEMY_API_KEY not found in env or .env.local");

  const rpcUrlByChain = new Map<string, string>();
  for (const chainId of new Set(configs.map((config) => config.chain.chainId))) {
    const url = buildAlchemyUrl(chainId, apiKeyForUrls);
    assertCliUsage(url !== null, `no Alchemy endpoint for chain ${chainId}`);
    rpcUrlByChain.set(chainId, url!);
  }

  const reviews = new Map<string, SemanticReview>();
  if (semanticDir !== null) {
    for (const config of configs) {
      const path = resolve(semanticDir, `${config.stablecoinId}__${config.chain.chainId}-${config.contractAddress.toLowerCase()}.json`);
      reviews.set(reviewedConservationIdentityKey(config.chain.chainId, config.stablecoinId, config.contractAddress, config.decimals),
        parseSemanticReview(path, config));
    }
  }
  // Candidate identities are audited through the same production gate shape the committed
  // sidecar will apply once merged; only the entry source differs.
  const eligibility: MintBurnConservationEligibilityResolver = (config) => resolveMintBurnConservationEligibility(
    candidateEntryFor(reviews.get(reviewedConservationIdentityKey(config.chain.chainId, config.stablecoinId, config.contractAddress, config.decimals)), config),
    config);

  const exchanges: JournalExchange[] = [];
  let replayHeader: JournalRunHeader | null = null;
  let replayedJournal: string | null = null;
  if (replayPath !== null) {
    assertCliUsage(existsSync(replayPath), `journal not found: ${replayPath}`);
    replayedJournal = readFileSync(replayPath, "utf8");
    const parsed = replayedJournal.split("\n").filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as JournalExchange | JournalRunHeader);
    const first = parsed[0];
    if (!(first && first.kind === "run")) {
      throw new CliUsageError(`journal ${replayPath} has no run header`);
    }
    replayHeader = first;
    installReplayingFetch(parsed.filter((line): line is JournalExchange => line.kind === "exchange"),
      (exchange) => exchanges.push(exchange));
  } else {
    installJournalingFetch((exchange) => exchanges.push(exchange));
  }

  const budget = { count: 0, limit: AUDIT_BUDGET_LIMIT };
  let checkedAt: number;
  const windowsByChain = new Map<string, ChainWindows>();
  if (replayHeader !== null) {
    checkedAt = replayHeader.checkedAt;
    for (const chainId of rpcUrlByChain.keys()) {
      const stored = replayHeader.windows[chainId];
      assertCliUsage(stored != null, `journal header has no window for chain ${chainId}`);
      windowsByChain.set(chainId, {
        primary: { fromBlock: stored.fromBlock, toBlock: stored.toBlock },
        second: stored.secondToBlock !== null && stored.secondFromBlock !== null
          ? { fromBlock: stored.secondFromBlock, toBlock: stored.secondToBlock } : null,
      });
    }
  } else {
    checkedAt = Math.floor(Date.now() / 1000);
    for (const [chainId, rpcUrl] of rpcUrlByChain) {
      let toBlock = toBlockArg;
      if (toBlock === null) {
        const head = await getAlchemyBlockNumber(rpcUrl, budget);
        assertCliUsage(head !== null, `chain head unavailable for ${chainId}`);
        toBlock = head! - HEAD_CONFIRMATION_BLOCKS;
        assertCliUsage(toBlock >= 1, `derived window end below genesis for ${chainId}`);
      }
      const primary = await resolveWindow(rpcUrl, toBlock, windowSeconds, windowBlocks, budget);
      assertCliUsage(primary !== null, `could not resolve a window for ${chainId}`);
      let second: AuditWindow | null = null;
      if (secondWindowTo !== null) {
        const secondTo = secondWindowTo === "auto" ? primary!.fromBlock - 1 : secondWindowTo;
        second = await resolveWindow(rpcUrl, secondTo, windowSeconds, windowBlocks, budget);
        assertCliUsage(second !== null, `could not resolve the second window for ${chainId}`);
        assertCliUsage(second!.toBlock < primary!.fromBlock || second!.fromBlock > primary!.toBlock,
          "the second window must be disjoint from the primary window");
      }
      windowsByChain.set(chainId, { primary: primary!, second });
    }
  }

  const windowsOf = (config: MintBurnContractConfig): AuditWindow[] => {
    const chain = windowsByChain.get(config.chain.chainId)!;
    return chain.second === null ? [chain.primary] : [chain.primary, chain.second];
  };
  const boundaryKey = (config: MintBurnContractConfig, window: AuditWindow): string =>
    `${reviewedConservationIdentityKey(config.chain.chainId, config.stablecoinId, config.contractAddress, config.decimals)}#${window.fromBlock}-${window.toBlock}`;

  const boundaryRequests: ConservationBoundaryRequest[] = [];
  for (const config of configs) {
    for (const window of windowsOf(config)) {
      boundaryRequests.push({ key: boundaryKey(config, window), config, fromBlock: window.fromBlock, toBlock: window.toBlock });
    }
  }
  const boundaries = await fetchConservationBoundaries({ requests: boundaryRequests, rpcUrlByChain, budget, checkedAt, eligibility });

  const audits: ConfigAudit[] = [];
  for (const config of configs) {
    const rpcUrl = rpcUrlByChain.get(config.chain.chainId)!;
    for (const window of windowsOf(config)) {
      const batches: Array<{ eventDef: MintBurnEventDef; logs: AlchemyLogEntry[] }> = [];
      let complete = true;
      for (const eventDef of config.events) {
        const fetched = await fetchAlchemyLogs(rpcUrl, config.contractAddress, eventDefTopicFilters(eventDef),
          window.fromBlock, window.toBlock, budget);
        if (!fetched || !fetched.complete || fetched.scannedToBlock < window.toBlock) complete = false;
        if (fetched) batches.push({ eventDef, logs: fetched.logs });
      }
      audits.push({
        config,
        window,
        record: completeMintBurnConservationAudit({
          config, logs: batches, fromBlock: window.fromBlock, toBlock: window.toBlock, checkedAt,
          complete, boundary: boundaries.get(boundaryKey(config, window)), eligibility,
        }),
      });
    }
  }

  mkdirSync(outDir, { recursive: true });
  const runHeader: JournalRunHeader = {
    kind: "run", checkedAt, windowSeconds, windowBlocks,
    secondWindowTo: secondWindowTo,
    windows: Object.fromEntries([...windowsByChain].map(([chainId, chain]) => [chainId, {
      fromBlock: chain.primary.fromBlock, toBlock: chain.primary.toBlock,
      secondFromBlock: chain.second?.fromBlock ?? null, secondToBlock: chain.second?.toBlock ?? null,
    }])),
  };
  const journalContent = replayedJournal ??
    `${[runHeader, ...exchanges].map((line) => JSON.stringify(line)).join("\n")}\n`;
  writeFileSync(join(outDir, "journal.jsonl"), journalContent);
  const journalSha256 = createHash("sha256").update(journalContent, "utf8").digest("hex");

  const auditsByConfig = new Map<MintBurnContractConfig, ConfigAudit[]>();
  for (const audit of audits) {
    const group = auditsByConfig.get(audit.config);
    if (group) group.push(audit);
    else auditsByConfig.set(audit.config, [audit]);
  }
  for (const [config, group] of auditsByConfig) {
    const [primary, ...rest] = group;
    writeFileSync(join(outDir, `${config.chain.chainId}-${config.contractAddress.toLowerCase()}.json`), `${JSON.stringify({
      config: {
        stablecoinId: config.stablecoinId, chainId: config.chain.chainId,
        address: config.contractAddress.toLowerCase(), decimals: config.decimals, symbol: config.symbol,
      },
      window: { fromBlock: primary.window.fromBlock, toBlock: primary.window.toBlock },
      record: primary.record,
      journalSha256,
      ...(rest.length > 0 ? { secondWindow: { fromBlock: rest[0]!.window.fromBlock, toBlock: rest[0]!.window.toBlock }, secondRecord: rest[0]!.record } : {}),
    }, null, 2)}\n`);
  }
  writeSummary(outDir, audits);

  if (emitSidecarDraft) {
    const entries: ReviewedConservationEntry[] = [];
    const pending: string[] = [];
    for (const [config, group] of auditsByConfig) {
      const review = reviews.get(reviewedConservationIdentityKey(config.chain.chainId, config.stablecoinId, config.contractAddress, config.decimals))!;
      const allOk = group.length > 0 && group.every(({ record }) => record.status === "ok");
      if (review.semanticVerdict === "standard-transfer" && allOk) {
        entries.push(buildSidecarEntry(review, config, "admitted",
          group.map(({ record }) => sidecarWindowFromRecord(record, journalSha256))));
      } else if (review.semanticVerdict === "unsupported" ||
        (review.semanticVerdict === "needs-review" &&
          (review.identity?.sourceVerified === false || review.identity?.proxy?.implementationSourceVerified === false))) {
        const reason = review.semanticVerdict === "unsupported"
          ? review.unsupportedReason : "unverified-implementation-source";
        entries.push(buildSidecarEntry({ ...review, unsupportedReason: reason }, config, "unsupported", []));
      } else {
        pending.push(`${config.stablecoinId} ${config.contractAddress.toLowerCase()} ` +
          `(semanticVerdict=${review.semanticVerdict}, records=${group.map(({ record }) => record.status).join("/")})`);
      }
    }
    writeFileSync(join(outDir, "sidecar-draft.json"), `${JSON.stringify(entries, null, 2)}\n`);
    process.stdout.write(`sidecar draft: ${entries.filter((entry) => entry.disposition === "admitted").length} admitted, ` +
      `${entries.filter((entry) => entry.disposition === "unsupported").length} unsupported, ${pending.length} pending\n`);
    for (const item of pending) process.stdout.write(`pending: ${item}\n`);
    if (mergeIntoSidecar) {
      mergeEntriesIntoSidecar(entries);
      process.stdout.write(`merged ${entries.length} entr${entries.length === 1 ? "y" : "ies"} into ${SIDECAR_PATH}\n`);
    }
  }

  const failing = audits.filter(({ record }) => record.status !== "ok");
  if (failing.length > 0) {
    throw new Error(`${failing.length} audited window(s) not ok:\n${failing.map(({ config, window, record }) =>
      `  ${config.stablecoinId} ${config.contractAddress.toLowerCase()} [${window.fromBlock}-${window.toBlock}]: ` +
      `${record.status}${record.reason ? ` (${record.reason})` : ""}`).join("\n")}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCliEntrypoint(() => runAdmissionAuditCli(process.argv.slice(2)), {
    label: "audit:mint-burn-conservation-admission",
    usage: USAGE,
  });
}
