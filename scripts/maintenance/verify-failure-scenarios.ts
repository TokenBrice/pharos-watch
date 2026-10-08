import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createPublicClient, ExecutionRevertedError, fallback, http } from "viem";
import type { Transport } from "viem";
import { bsc, mainnet } from "viem/chains";
import { z } from "zod";
import { FailureScenariosByIdSchema } from "@shared/lib/failure-scenarios";
import { FAILURE_SCENARIO_CHECKS } from "@shared/lib/failure-scenario-checks";
import type {
  ScenarioCheckContext, ScenarioCheckVerdict, ScenarioDocument, ScenarioDocumentBaselines,
} from "@shared/lib/failure-scenario-checks";
import {
  assertCliUsage, parseCliInteger, parseStrictCliArgs, runDirectCli, writeCliHelpIfRequested,
} from "../lib/cli-args.mjs";

const USAGE = `Usage: npm run verify:failure-scenarios -- [--coin <id>] [--block <n>] [--json] [--refresh-documents]
Read-only monthly drift report; never edits or approves scenarios.
Default: every registered coin, including drafts, pinned to each chain's head at startup.
--block pins the same numeric height on every required chain (heights are chain-local).
--refresh-documents explicitly records fetched source fingerprints after maintainer review.
Exit 0: no decisive changed/unchecked falsifier (unavailable still needs human review).
Exit 1: decisive changed/unchecked falsifier or runtime error; 2: usage error.
Figures, observations and document watches are informational and never fail the run.
RPC_URLS_<chainId>/RPC_URL_<chainId> configure ordered providers; RPC_URLS/RPC_URL apply to Ethereum.`;

const DOCUMENT_PATH = resolve("shared/data/failure-scenario-documents.json");
const documentSchema = z.object({
  sourceId: z.string(), url: z.url(), publisher: z.string(), fetchedAt: z.iso.datetime(),
  fingerprint: z.object({
    contentHash: z.string().regex(/^[a-f0-9]{64}$/), lastModified: z.string().nullable(),
    etag: z.string().nullable(), revision: z.string().nullable(),
    fileHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  }).optional(),
  normalizedText: z.string().optional(), unavailableReason: z.string().optional(),
}).strict();
const baselinesSchema = z.record(z.string(), z.record(z.string(), z.array(documentSchema)));
const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string) => { window: { document: Document; close(): void } };
};

/** Decode entities without running scripts. Attributes (nonces, build/asset URLs,
 * session tokens and cache-busters) are never text; retain substantive printed dates. */
export function documentText(html: string): string {
  const dom = new JSDOM(html);
  try {
    const document = dom.window.document;
    document.querySelectorAll('script, style, noscript, template, nav, header, footer, svg, [hidden], [style*="display:none"], [style*="display: none"], ix\\:hidden').forEach((node) => node.remove());
    const root = document.querySelector("main") ?? document.body;
    const blocks: Record<string, true> = { P: true, DIV: true, SECTION: true, ARTICLE: true, BR: true, LI: true, TR: true, TD: true, TH: true, H1: true, H2: true, H3: true, H4: true, H5: true, H6: true };
    function text(node: Node): string {
      if (node.nodeType === 3) return node.textContent ?? "";
      const parts = Array.from(node.childNodes, text).join("");
      return blocks[node.nodeName] ? ` ${parts} ` : parts;
    }
    return normalizeText(text(root));
  } finally {
    dom.window.close();
  }
}

function normalizeText(text: string): string {
  return text.normalize("NFC").replace(/\s+/gu, " ").trim();
}

/** Only printed revision markers/dates, never a date inferred from the record label. */
function documentRevision(text: string, sourceId: string): string | null {
  const date = "(?:[A-Z][a-z]+ \\d{1,2},? \\d{4}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}/\\d{1,2}/\\d{4})";
  const revisions = text.match(new RegExp(`(?:last (?:update(?:d)?|modified|revised)|revision(?: date)?|version)\\s*[:–-]?\\s*${date}`, "gi"));
  if (revisions?.length) return [...new Set(revisions)].join("; ");
  const effective = text.slice(0, 2000).match(new RegExp(`effective(?: date)?\\s*[:–-]?\\s*(?:as of\\s+)?${date}`, "i"));
  if (effective) return effective[0];
  // The examination's printed signing date is the final full date, not an
  // earlier reserve measurement date; do not label arbitrary filing dates revisions.
  if (sourceId === "reserves-august") return text.match(new RegExp(date, "g"))?.at(-1) ?? null;
  return null;
}

async function fetchDocument(sourceId: string, url: string, publisher: string): Promise<ScenarioDocument> {
  const document: ScenarioDocument = { sourceId, url, publisher, fetchedAt: new Date().toISOString() };
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
      headers: { "User-Agent": "Pharos scenario document verification (https://pharos.watch)", Accept: "text/html, application/pdf, text/plain" },
    });
    if (!response.ok) throw new Error(`Publisher returned HTTP ${response.status} ${response.statusText}${response.status === 403 || response.status === 429 ? "; automated access is blocked or rate-limited; human retrieval required" : ""}`);
    const contentType = response.headers.get("content-type") ?? "";
    const bytes = Buffer.from(await response.arrayBuffer());
    let text: string;
    if (contentType.includes("application/pdf") || bytes.subarray(0, 5).toString() === "%PDF-") {
      try {
        text = normalizeText(execFileSync("pdftotext", ["-layout", "-", "-"], { input: bytes, encoding: "utf8", timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }));
      } catch (error) {
        throw new Error(`PDF text extraction failed (requires pdftotext from Poppler): ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (contentType.includes("text/html")) {
      text = documentText(bytes.toString("utf8"));
    } else if (contentType.includes("text/plain")) {
      text = normalizeText(bytes.toString("utf8"));
    } else {
      throw new Error(`Unsupported document content type: ${contentType || "missing"}`);
    }
    if (text.length < 100 || /^(?:just a moment|access denied|enable javascript)/i.test(text)) {
      throw new Error("Publisher did not return readable source text (empty document or access challenge); human retrieval required");
    }
    document.normalizedText = text;
    document.fingerprint = {
      contentHash: createHash("sha256").update(text, "utf8").digest("hex"),
      ...(contentType.includes("application/pdf") || bytes.subarray(0, 5).toString() === "%PDF-" ? { fileHash: createHash("sha256").update(bytes).digest("hex") } : {}),
      lastModified: response.headers.get("last-modified"), etag: response.headers.get("etag"), revision: documentRevision(text, sourceId),
    };
  } catch (error) {
    document.unavailableReason = error instanceof Error ? error.message : String(error);
  }
  return document;
}

function providerUrls(chainId: number): string[] {
  const defaults = chainId === 1
    ? ["https://rpc.flashbots.net", "https://eth.drpc.org", "https://eth-mainnet.public.blastapi.io", "https://ethereum.publicnode.com", "https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com", "https://rpc.ankr.com/eth"]
    : ["https://bsc-dataseed.binance.org", "https://bsc-mainnet.public.blastapi.io"];
  const chainName = chainId === 1 ? "ETHEREUM" : "BSC";
  const configured = process.env[`RPC_URLS_${chainId}`] ?? process.env[`RPC_URL_${chainId}`] ??
    process.env[`${chainName}_RPC_URLS`] ?? process.env[`${chainName}_RPC_URL`] ??
    (chainId === 1 ? process.env.RPC_URLS ?? process.env.RPC_URL : undefined);
  const urls = [...new Set([...(configured?.split(/[\s,]+/).filter(Boolean) ?? []), ...defaults])];
  for (const url of urls) assertCliUsage(/^https?:\/\//.test(url), `RPC provider for chain ${chainId} must be an HTTP(S) URL`);
  return urls;
}

/** Fall back per request, including archive reads and bounded historical log queries. */
function providerTransport(chainId: number, urls: string[]): Transport {
  const ordered = fallback(urls.map((url) => http(url, { timeout: 20_000, retryCount: 0 })), {
    rank: false, retryCount: 0,
  });
  return (config) => {
    const transport = ordered(config);
    return {
      ...transport,
      async request(args, options) {
        try {
          return await transport.request(args, options);
        } catch (error) {
          // A deterministic revert is an RPC answer, not provider unavailability.
          // Preserve it for selector probes and simulations that test reverts.
          if (error instanceof Error && ExecutionRevertedError.nodeMessage.test(error.message)) throw error;
          // Provider credentials/query tokens must not leak into report errors.
          let reason = error instanceof Error ? error.message : String(error);
          for (const url of urls) reason = reason.replaceAll(url, new URL(url).origin);
          throw new Error(`All ${urls.length} configured RPC providers for chain ${chainId} failed to serve ${args.method} (${urls.map((url) => new URL(url).hostname).join(", ")}). ${reason}`);
        }
      },
    };
  };
}

type ReportRow = {
  id: string;
  label: string;
  kind: "falsifier" | "figure" | "observation" | "document";
  recordField?: { collection: "keyFigures" | "exposure"; label: string };
  recordedStatus?: string;
  humanReviewReason?: string;
  documents?: { sourceId: string; url: string; publisher: string }[];
} & (ScenarioCheckVerdict | { verdict: "unchecked"; reason: string });

runDirectCli(import.meta.url, async () => {
  const { values } = parseStrictCliArgs(process.argv.slice(2), {
    options: { coin: { type: "string" }, block: { type: "string" }, json: { type: "boolean" }, "refresh-documents": { type: "boolean" } },
  });
  if (writeCliHelpIfRequested(values, USAGE)) return;
  const coinId = values.coin;
  assertCliUsage(coinId === undefined || (typeof coinId === "string" && Object.hasOwn(FAILURE_SCENARIO_CHECKS, coinId)),
    `Unknown registered coin: ${String(coinId)}; choose ${Object.keys(FAILURE_SCENARIO_CHECKS).join(", ")}`);
  const override = values.block === undefined ? undefined : BigInt(parseCliInteger(values.block, { name: "--block", min: 0 }));
  const all = FailureScenariosByIdSchema.parse(JSON.parse(readFileSync(resolve("data/failure-scenarios.json"), "utf8")));
  const selected = typeof coinId === "string" ? [coinId] : Object.keys(FAILURE_SCENARIO_CHECKS);
  const baselines: ScenarioDocumentBaselines = existsSync(DOCUMENT_PATH)
    ? baselinesSchema.parse(JSON.parse(readFileSync(DOCUMENT_PATH, "utf8"))) : {};
  const documentCache = new Map<string, Promise<ScenarioDocument>>();
  const refreshes: { coinId: string; id: string; sourceId: string; status: "recorded" | "unavailable" }[] = [];
  const chainIds = [...new Set(selected.flatMap((id) => FAILURE_SCENARIO_CHECKS[id]!.chainIds))];
  const chains: Partial<Record<number, NonNullable<ScenarioCheckContext["chains"][number]>>> = {};
  const pins: Record<number, { blockNumber: string; blockHash: string; timestamp: string } | { reason: string }> = {};
  const providers: Record<number, string[]> = {};
  const envPath = resolve(".env.local");
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  // Resolve every required chain before the first check, never one latest read per check.
  for (const chainId of chainIds) {
    const urls = providerUrls(chainId);
    providers[chainId] = urls.map((url) => new URL(url).hostname);
    try {
      const chain = chainId === 1 ? mainnet : bsc;
      const client = createPublicClient({ chain, transport: providerTransport(chainId, urls) });
      const block = await client.getBlock(override === undefined ? { blockTag: "latest" } : { blockNumber: override });
      if (block.number === null || block.hash === null) throw new Error("RPC returned an unmined block");
      chains[chainId] = { client, blockNumber: block.number };
      pins[chainId] = { blockNumber: block.number.toString(), blockHash: block.hash, timestamp: new Date(Number(block.timestamp) * 1000).toISOString() };
    } catch (error) {
      pins[chainId] = { reason: error instanceof Error ? error.message : String(error) };
    }
  }
  const coins: { coinId: string; reviewStatus: string; falsifiers: ReportRow[]; figures: ReportRow[]; observations: ReportRow[]; documents: ReportRow[] }[] = [];
  for (const id of selected) {
    const record = all[id];
    if (!record) throw new Error(`Registered coin has no scenario record: ${id}`);
    const falsifiers: ReportRow[] = [];
    const figures: ReportRow[] = [];
    const observations: ReportRow[] = [];
    const documents: ReportRow[] = [];
    const covered = new Set<string>();
    // One memo per coin per run: its checks share pinned reads, nothing crosses coins or runs.
    const memo = new Map<string, Promise<unknown>>();
    for (const check of FAILURE_SCENARIO_CHECKS[id]!.checks) {
      const kind = check.kind ?? "falsifier";
      const falsifier = kind === "falsifier" || kind === "document" ? record.falsifiers.find((entry) => entry.id === check.id) : undefined;
      if ((kind === "falsifier" || kind === "document") && !falsifier) throw new Error(`${id}: check references unknown falsifier ${check.id}`);
      // A document watch registers the human-review route, not a decisive chain verdict.
      if (falsifier) covered.add(check.id);
      if (check.kind === "figure" && !record[check.recordField.collection].some((entry) => entry.label === check.recordField.label)) {
        throw new Error(`${id}: figure check references unknown ${check.recordField.collection} entry ${check.recordField.label}`);
      }
      const context: ScenarioCheckContext = { record, chains, memo };
      let watched: { sourceId: string; url: string; publisher: string }[] | undefined;
      if (check.kind === "document") {
        watched = check.documentSources.map(({ sourceId, publisher }) => {
          const source = record.sources.find((entry) => entry.id === sourceId);
          if (!source) throw new Error(`${id}: missing document source ${sourceId}`);
          return { sourceId, url: source.url, publisher };
        });
        const fetched = await Promise.all(watched.map(({ sourceId, url, publisher }) => {
          const key = `${url}\n${publisher}`;
          if (!documentCache.has(key)) documentCache.set(key, fetchDocument(sourceId, url, publisher));
          return documentCache.get(key)!.then((document) => ({ ...document, sourceId }));
        }));
        context.documentWatch = { recorded: baselines[id]?.[check.id] ?? [], fetched };
        if (values["refresh-documents"] === true) {
          baselines[id] ??= {};
          // A transient failure must not erase a previously reviewed fingerprint.
          baselines[id][check.id] = fetched.map((document) => {
            refreshes.push({ coinId: id, id: check.id, sourceId: document.sourceId, status: document.fingerprint ? "recorded" : "unavailable" });
            return document.fingerprint ? document : baselines[id][check.id]?.find((entry) => entry.sourceId === document.sourceId) ?? document;
          });
        }
      }
      let result: ScenarioCheckVerdict;
      try {
        result = await check.run(context);
      } catch (error) {
        result = { verdict: "unavailable", reason: error instanceof Error ? error.message : String(error) };
      }
      const rows = kind === "falsifier" ? falsifiers : kind === "figure" ? figures : kind === "document" ? documents : observations;
      rows.push({
        id: check.id, label: check.label, kind,
        ...(check.kind === "figure" ? { recordField: check.recordField } : {}),
        ...(check.kind === "document" ? { documents: watched, humanReviewReason: check.humanReviewReason } : {}),
        ...(falsifier ? { recordedStatus: falsifier.status } : {}), ...result,
      });
    }
    for (const falsifier of record.falsifiers) {
      if (!covered.has(falsifier.id)) falsifiers.push({
        id: falsifier.id, label: falsifier.condition, kind: "falsifier", recordedStatus: falsifier.status,
        verdict: "unchecked", reason: "No registered check or document-watch human-review route; maintainer evidence review required",
      });
    }
    coins.push({ coinId: id, reviewStatus: record.review.status, falsifiers, figures, observations, documents });
  }
  if (values["refresh-documents"] === true) writeFileSync(DOCUMENT_PATH, `${JSON.stringify(baselines, null, 2)}\n`);
  const summary = {
    falsifiers: { holds: 0, changed: 0, unavailable: 0, unchecked: 0 },
    figures: { unchanged: 0, figuresToRefresh: 0, unavailable: 0 },
    observations: { holds: 0, changed: 0, unavailable: 0 },
    documents: { unchanged: 0, changed: 0, unavailable: 0 },
  };
  for (const coin of coins) {
    for (const row of coin.falsifiers) summary.falsifiers[row.verdict]++;
    for (const row of coin.figures) {
      if (row.verdict === "holds") summary.figures.unchanged++;
      else if (row.verdict === "changed") summary.figures.figuresToRefresh++;
      else summary.figures.unavailable++;
    }
    for (const row of coin.observations) {
      if (row.verdict !== "unchecked") summary.observations[row.verdict]++;
    }
    for (const row of coin.documents) {
      if (row.verdict === "holds") summary.documents.unchanged++;
      else if (row.verdict === "changed") summary.documents.changed++;
      else summary.documents.unavailable++;
    }
  }
  const documentWatchMeaning = "Matching substance fingerprints mean the reviewed source text and printed revision are unchanged, not that the underlying condition was re-decided. Last-Modified/ETag are corroborating transport evidence only; their drift is reported without changing the verdict. Documentary conditions remain human judgements; changed or unavailable watches never fail the run.";
  const report = { generatedAt: new Date().toISOString(), pins, providers, coins, summary, documentWatchMeaning, ...(values["refresh-documents"] === true ? { documentRefresh: refreshes } : {}) };
  if (values.json === true) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Pinned chains: ${JSON.stringify(pins)}`);
    console.log(`Ordered RPC providers: ${JSON.stringify(providers)}`);
    console.log(documentWatchMeaning);
    for (const coin of coins) {
      console.log(`\n${coin.coinId} (${coin.reviewStatus})`);
      for (const [title, rows] of [
        ["Decisive falsifier checks", coin.falsifiers],
        ["Published figures (informational; changed means figures to refresh)", coin.figures],
        ["Contextual observations (informational)", coin.observations],
        ["Document watches (source drift only; underlying condition needs human judgement)", coin.documents],
      ] as const) {
        if (rows.length === 0) continue;
        console.log(title);
        console.log("id\tlabel\trecord field\tverdict\tobserved\tpublished / recorded\treason");
        for (const row of rows) console.log([
          row.id, row.label, row.recordField ? `${row.recordField.collection}: ${row.recordField.label}` : "—", row.verdict,
          "observed" in row ? JSON.stringify(row.observed) ?? "—" : "—",
          "recorded" in row ? JSON.stringify(row.recorded) ?? "—" : "—", row.reason ?? "",
        ].join("\t"));
      }
    }
    const decisive = summary.falsifiers;
    console.log(`\nFalsifiers: ${decisive.holds} holds, ${decisive.changed} changed, ${decisive.unavailable} unavailable, ${decisive.unchecked} unchecked.`);
    console.log(`Figures: ${summary.figures.figuresToRefresh} figures to refresh, ${summary.figures.unchanged} unchanged, ${summary.figures.unavailable} unavailable.`);
    console.log(`Contextual observations: ${summary.observations.holds} holds, ${summary.observations.changed} changed, ${summary.observations.unavailable} unavailable.`);
    console.log(`Document watches: ${summary.documents.unchanged} unchanged, ${summary.documents.changed} changed, ${summary.documents.unavailable} unavailable.`);
    if (values["refresh-documents"] === true) console.log(`Explicit document refresh: ${JSON.stringify(refreshes)}. Failed fetches never overwrite an existing reviewed fingerprint.`);
    console.log("Only decisive changed or unchecked falsifiers fail this report. Unavailable always needs human review; exit 0 is not proof of complete verification.");
    console.log("Reports never mutate falsifiers or approval. Decisive changed requires maintainer review, not automatic status=met; figures and source watches are informational.");
  }
  if (summary.falsifiers.changed || summary.falsifiers.unchecked) process.exitCode = 1;
}, { label: "verify:failure-scenarios", usage: USAGE });
