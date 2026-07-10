import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildBlacklistContractBalanceKey } from "@shared/lib/blacklist";
import { getBlacklistTrackerMethodologyVersionAt } from "@shared/lib/blacklist-tracker-version";
import { runCliEntrypoint, writeCliHelpIfRequested } from "../../scripts/lib/cli-args.mjs";
import { tronBase58ToHex } from "../src/lib/tron-address";
import { CONTRACT_CONFIGS } from "../src/lib/blacklist-contracts";
import { fetchKycRipRows, parsePositiveInteger, type KycRipCurrentBalanceRow } from "./lib/kyc-rip";
import { parseDestructiveOperationArgs } from "./lib/destructive-operation-guard";
import { createRemoteD1Client, sqlString, type RemoteD1Client } from "./lib/remote-d1";
import frozenManifestJson from "./data/night-watch-blacklist-manifest-2026-07-09.json";

const SCRIPT_NAME = "worker/scripts/reconcile-night-watch-blacklist.ts";
const DEFAULT_DATABASE = "stablecoin-db";
const DEFAULT_TIMEOUT_MS = 30_000;
const TRONGRID_ORIGIN = "https://api.trongrid.io";
const TRON_INDEXING_SAFETY_MS = 15 * 60_000;
const MAX_PAGES_PER_EVENT = 100;
const PAGE_LIMIT = 200;
const USDT_DECIMALS = 6;
const REQUIRED_ARBITRUM_CONFIG_COUNT = CONTRACT_CONFIGS.filter((config) => config.chain.chainId === "arbitrum").length;
const WORKER_CWD = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `Usage: tsx ${SCRIPT_NAME} [options]

Guarded recovery for the immutable 2026-07-09 USDT/Tron Night Watch manifest.
Default mode is read-only. Apply mode requires the current D1 Time Travel bookmark.

Options:
  --execute                         Apply idempotent event/balance/cursor writes
  --confirm ${SCRIPT_NAME}  Required confirmation for --execute
  --time-travel-bookmark <value>    Current bookmark from wrangler d1 time-travel info
  --database <name>                 D1 database name (default: ${DEFAULT_DATABASE})
  --timeout-ms <ms>                 Provider timeout (default: ${DEFAULT_TIMEOUT_MS})
  --trongrid-api-key <key>          Optional TronGrid key
  --balance-provider-url <url>      Optional kyc.rip-compatible balance URL
  --dry-run                         Force read-only mode
  --remote                          Target remote D1 (default and only target)
  -h, --help                        Show this help`;

type FrozenEventType = "blacklist" | "unblacklist" | "destroy";

export type FrozenManifestEvent = {
  id: string;
  eventType: FrozenEventType;
  eventSignature: string;
  txHash: string;
  eventIndex: number;
  blockNumber: number;
  blockTimestampMs: number;
  address: string;
  amountRaw: string | null;
};

export type FrozenManifest = {
  schemaVersion: number;
  manifestId: string;
  source: string;
  auditedAt: string;
  contractAddress: string;
  configKey: string;
  stablecoin: "USDT";
  chainId: "tron";
  cursorExclusive: number;
  cutoffInclusive: number;
  expected: {
    eventCount: number;
    byEventType: Record<FrozenEventType, number>;
    destroyedAmountRaw: string;
    destroyedAmountNative: string;
  };
  eventsSha256: string;
  events: FrozenManifestEvent[];
};

export type ReconciliationOptions = {
  apply: boolean;
  help: boolean;
  database: string;
  timeoutMs: number;
  timeTravelBookmark: string | null;
  trongridApiKey: string | null;
  balanceProviderUrl: string | null;
};

type StoredEvent = {
  id: string;
  tx_hash: string;
  event_type: string;
  event_signature: string | null;
  address: string;
  block_number: number;
  timestamp: number;
  amount_native: number | null;
  source_event_index: number | null;
};

type CursorRow = {
  config_key: string;
  cursor_value: number | null;
  last_block: number;
  last_observed_safe_head: number | null;
};

type StoredBalance = {
  address: string;
  amount_native: number | null;
  source: string;
  config_key: string | null;
  contract_address: string | null;
};

type BalanceExpectation = {
  address: string;
  amountNative: number;
  source: "destroy_event" | "reconciliation_current_balance";
  observedAt: number;
};

type EventVerification = {
  presentCount: number;
  missingIds: string[];
  duplicateIdentityCount: number;
  identityConflicts: string[];
  destroyedAmountRaw: string;
};

type BalanceVerification = {
  expectedCount: number;
  matchingCount: number;
  mismatches: string[];
};

export type ReconciliationSummary = {
  mode: "dry-run" | "apply";
  status: "ready" | "verified" | "blocked" | "failed";
  runId: string | null;
  manifestId: string;
  manifestSha256: string;
  bookmarkVerified: boolean;
  expectedEventCount: number;
  upstreamFrozenEventCount: number;
  upstreamTailEventCount: number;
  presentEventCount: number;
  insertedEventCount: number;
  missingEventCount: number;
  duplicateIdentityCount: number;
  identityConflictCount: number;
  destroyedAmountExpectedRaw: string;
  destroyedAmountActualRaw: string;
  balanceReplayExpectedCount: number;
  balanceReplayMatchingCount: number;
  unresolvedManifestGapCount: number;
  tron: {
    cursorBefore: number | null;
    cursorAfter: number | null;
    safeHead: number;
    atSafeHead: boolean;
  };
  arbitrum: {
    configCount: number;
    atSafeHeadCount: number;
    minCursor: number | null;
    minSafeHead: number | null;
  };
  samples: {
    missingIds: string[];
    identityConflicts: string[];
    balanceMismatches: string[];
  };
};

export type ReconciliationDependencies = {
  d1?: RemoteD1Client;
  fetchImpl?: typeof fetch;
  now?: () => number;
  verifyBookmark?: (database: string, bookmark: string) => boolean;
  loadFrozenEvents?: () => Promise<FrozenManifestEvent[]>;
  loadTailEvents?: (safeHeadMs: number) => Promise<FrozenManifestEvent[]>;
  loadBalanceAmounts?: () => Promise<Map<string, number>>;
  log?: (message: string) => void;
};

const manifest = frozenManifestJson as FrozenManifest;

function canonicalEvents(events: readonly FrozenManifestEvent[]): string {
  return JSON.stringify(events);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function amountRawToNative(amountRaw: string): number {
  const value = BigInt(amountRaw);
  const divisor = 10n ** BigInt(USDT_DECIMALS);
  return Number(value / divisor) + Number(value % divisor) / Number(divisor);
}

function sumDestroyedAmountRaw(events: readonly FrozenManifestEvent[]): bigint {
  return events.reduce(
    (total, event) => total + (event.eventType === "destroy" && event.amountRaw ? BigInt(event.amountRaw) : 0n),
    0n,
  );
}

function sortEvents(events: readonly FrozenManifestEvent[]): FrozenManifestEvent[] {
  return [...events].sort(
    (left, right) =>
      left.blockTimestampMs - right.blockTimestampMs ||
      left.blockNumber - right.blockNumber ||
      left.id.localeCompare(right.id),
  );
}

export function validateFrozenManifest(input: FrozenManifest = manifest): void {
  if (input.schemaVersion !== 1) throw new Error(`Unsupported manifest schema ${input.schemaVersion}`);
  if (input.chainId !== "tron" || input.stablecoin !== "USDT") {
    throw new Error("Frozen manifest scope must remain USDT/Tron");
  }
  if (input.events.length !== input.expected.eventCount) {
    throw new Error("Frozen manifest event count does not match its acceptance contract");
  }
  const ids = new Set<string>();
  for (const event of input.events) {
    if (ids.has(event.id)) throw new Error(`Frozen manifest duplicates ${event.id}`);
    ids.add(event.id);
    if (event.id !== `tron-${event.txHash}-${event.eventIndex}`) {
      throw new Error(`Frozen manifest has a non-canonical event id: ${event.id}`);
    }
    if (event.blockTimestampMs <= input.cursorExclusive || event.blockTimestampMs > input.cutoffInclusive) {
      throw new Error(`Frozen manifest event lies outside the audited interval: ${event.id}`);
    }
    if (!/^0x[0-9a-f]{40}$/.test(event.address)) {
      throw new Error(`Frozen manifest has an invalid address: ${event.id}`);
    }
    if (event.eventType === "destroy" && !/^\d+$/.test(event.amountRaw ?? "")) {
      throw new Error(`Frozen manifest destroy is missing its raw amount: ${event.id}`);
    }
  }
  const ordered = sortEvents(input.events);
  if (sha256(canonicalEvents(ordered)) !== input.eventsSha256) {
    throw new Error("Frozen manifest SHA-256 does not match its event payload");
  }
  const typeCounts = ordered.reduce<Record<FrozenEventType, number>>(
    (counts, event) => ({ ...counts, [event.eventType]: counts[event.eventType] + 1 }),
    { blacklist: 0, unblacklist: 0, destroy: 0 },
  );
  for (const type of ["blacklist", "unblacklist", "destroy"] as const) {
    if (typeCounts[type] !== input.expected.byEventType[type]) {
      throw new Error(`Frozen manifest ${type} count does not match its acceptance contract`);
    }
  }
  if (sumDestroyedAmountRaw(ordered).toString() !== input.expected.destroyedAmountRaw) {
    throw new Error("Frozen manifest destroyed amount does not match its acceptance contract");
  }
}

export function parseReconciliationArgs(argv: string[]): ReconciliationOptions {
  const { mode, values } = parseDestructiveOperationArgs({
    argv,
    cliOptions: {
      database: { type: "string" },
      "timeout-ms": { type: "string" },
      "time-travel-bookmark": { type: "string" },
      "trongrid-api-key": { type: "string" },
      "balance-provider-url": { type: "string" },
    },
    defaultTarget: "--remote",
    localAllowed: false,
    scriptName: SCRIPT_NAME,
  });
  const help = values.help === true;
  const timeTravelBookmark = typeof values["time-travel-bookmark"] === "string" ? values["time-travel-bookmark"] : null;
  if (!mode.dryRun && !timeTravelBookmark) {
    throw new Error("Apply mode requires --time-travel-bookmark from wrangler d1 time-travel info");
  }
  return {
    apply: !mode.dryRun,
    help,
    database: typeof values.database === "string" ? values.database : DEFAULT_DATABASE,
    timeoutMs:
      typeof values["timeout-ms"] === "string"
        ? parsePositiveInteger(values["timeout-ms"], "--timeout-ms")
        : DEFAULT_TIMEOUT_MS,
    timeTravelBookmark,
    trongridApiKey: typeof values["trongrid-api-key"] === "string" ? values["trongrid-api-key"] : null,
    balanceProviderUrl: typeof values["balance-provider-url"] === "string" ? values["balance-provider-url"] : null,
  };
}

function verifyCurrentTimeTravelBookmark(database: string, bookmark: string): boolean {
  const raw = execFileSync("npx", ["wrangler", "d1", "time-travel", "info", database, "--json"], {
    cwd: WORKER_CWD,
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: 1024 * 1024,
  });
  const parsed = JSON.parse(raw) as { bookmark?: unknown };
  return typeof parsed.bookmark === "string" && parsed.bookmark === bookmark;
}

function getTronEventDefinitions(): Array<{
  eventName: string;
  eventType: FrozenEventType;
  eventSignature: string;
}> {
  return [
    { eventName: "AddedBlackList", eventType: "blacklist", eventSignature: "AddedBlackList(address)" },
    { eventName: "RemovedBlackList", eventType: "unblacklist", eventSignature: "RemovedBlackList(address)" },
    { eventName: "DestroyedBlackFunds", eventType: "destroy", eventSignature: "DestroyedBlackFunds(address,uint256)" },
  ];
}

function buildTronUrl(eventName: string, fromExclusive: number, toInclusive: number, fingerprint?: string): string {
  const url = new URL(`/v1/contracts/${manifest.contractAddress}/events`, TRONGRID_ORIGIN);
  url.searchParams.set("event_name", eventName);
  url.searchParams.set("limit", String(PAGE_LIMIT));
  url.searchParams.set("order_by", "block_timestamp,asc");
  url.searchParams.set("only_confirmed", "true");
  url.searchParams.set("min_timestamp", String(fromExclusive));
  url.searchParams.set("max_timestamp", String(toInclusive));
  if (fingerprint) url.searchParams.set("fingerprint", fingerprint);
  return url.toString();
}

function parseTronPageEvent(
  raw: unknown,
  definition: ReturnType<typeof getTronEventDefinitions>[number],
): FrozenManifestEvent {
  if (!raw || typeof raw !== "object") throw new Error("TronGrid returned a non-object event");
  const row = raw as Record<string, unknown>;
  const result = row.result as Record<string, unknown> | undefined;
  const txHash = row.transaction_id;
  const eventIndex = row.event_index;
  const blockNumber = row.block_number;
  const blockTimestampMs = row.block_timestamp;
  const address = result?._user ?? result?._blackListedUser ?? result?.["0"];
  const amountRaw = definition.eventType === "destroy" ? (result?._balance ?? result?.["1"]) : null;
  if (
    typeof txHash !== "string" ||
    !/^[0-9a-f]{64}$/i.test(txHash) ||
    !Number.isSafeInteger(eventIndex) ||
    !Number.isSafeInteger(blockNumber) ||
    !Number.isSafeInteger(blockTimestampMs) ||
    typeof address !== "string" ||
    !/^0x[0-9a-f]{40}$/i.test(address) ||
    (definition.eventType === "destroy" && (typeof amountRaw !== "string" || !/^\d+$/.test(amountRaw)))
  ) {
    throw new Error(`TronGrid returned a malformed ${definition.eventName} event`);
  }
  const normalizedTxHash = txHash.toLowerCase();
  return {
    id: `tron-${normalizedTxHash}-${eventIndex}`,
    eventType: definition.eventType,
    eventSignature: definition.eventSignature,
    txHash: normalizedTxHash,
    eventIndex: eventIndex as number,
    blockNumber: blockNumber as number,
    blockTimestampMs: blockTimestampMs as number,
    address: address.toLowerCase(),
    amountRaw: amountRaw as string | null,
  };
}

async function fetchTronPage(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{
  success?: unknown;
  data?: unknown;
  meta?: { links?: { next?: unknown } };
}> {
  let lastStatus: number | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    lastStatus = response.status;
    if (response.ok) {
      return (await response.json()) as {
        success?: unknown;
        data?: unknown;
        meta?: { links?: { next?: unknown } };
      };
    }
    await response.text().catch(() => "");
    if (response.status !== 429 && response.status < 500) break;
    if (attempt < 2) {
      const retryAfter = Number(response.headers.get("Retry-After"));
      const delayMs =
        Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(5_000, retryAfter * 1_000) : 1_000 * 2 ** attempt;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
    }
  }
  throw new Error(`TronGrid returned HTTP ${lastStatus ?? "unknown"}`);
}

async function fetchTronInterval(
  fetchImpl: typeof fetch,
  fromExclusive: number,
  toInclusive: number,
  timeoutMs: number,
  apiKey: string | null,
): Promise<FrozenManifestEvent[]> {
  const events: FrozenManifestEvent[] = [];
  const headers: Record<string, string> = {};
  if (apiKey) headers["TRON-PRO-API-KEY"] = apiKey;
  for (const definition of getTronEventDefinitions()) {
    let fingerprint: string | undefined;
    const seenFingerprints = new Set<string>();
    for (let page = 0; page < MAX_PAGES_PER_EVENT; page++) {
      const url = buildTronUrl(definition.eventName, fromExclusive, toInclusive, fingerprint);
      const payload = await fetchTronPage(fetchImpl, url, headers, timeoutMs);
      if (payload.success !== true || !Array.isArray(payload.data)) {
        throw new Error(`TronGrid ${definition.eventName} returned an invalid page`);
      }
      for (const raw of payload.data) {
        const event = parseTronPageEvent(raw, definition);
        if (event.blockTimestampMs > fromExclusive && event.blockTimestampMs <= toInclusive) {
          events.push(event);
        }
      }
      const next = payload.meta?.links?.next;
      if (next == null) break;
      if (typeof next !== "string") throw new Error("TronGrid pagination link is not a string");
      const nextUrl = new URL(next, TRONGRID_ORIGIN);
      if (
        nextUrl.origin !== TRONGRID_ORIGIN ||
        nextUrl.pathname !== `/v1/contracts/${manifest.contractAddress}/events` ||
        nextUrl.searchParams.get("event_name") !== definition.eventName
      ) {
        throw new Error("TronGrid returned an unsafe pagination link");
      }
      const nextFingerprint = nextUrl.searchParams.get("fingerprint");
      if (!nextFingerprint || seenFingerprints.has(nextFingerprint)) {
        throw new Error("TronGrid pagination did not advance");
      }
      seenFingerprints.add(nextFingerprint);
      fingerprint = nextFingerprint;
      if (page === MAX_PAGES_PER_EVENT - 1) {
        throw new Error(`TronGrid ${definition.eventName} exceeded the page cap`);
      }
    }
  }
  const byId = new Map<string, FrozenManifestEvent>();
  for (const event of events) {
    const existing = byId.get(event.id);
    if (existing && canonicalEvents([existing]) !== canonicalEvents([event])) {
      throw new Error(`TronGrid returned conflicting duplicates for ${event.id}`);
    }
    byId.set(event.id, event);
  }
  return sortEvents([...byId.values()]);
}

async function loadKycRipTronBalances(
  fetchImpl: typeof fetch,
  timeoutMs: number,
  providerUrl: string | null,
): Promise<Map<string, number>> {
  const { rows } = await fetchKycRipRows<KycRipCurrentBalanceRow>({
    mode: "current-balances",
    timeoutMs,
    minRows: 100,
    providerUrl: providerUrl ?? undefined,
    fetchImpl,
  });
  const balances = new Map<string, number>();
  for (const row of rows) {
    if (row.asset !== "USDT" || row.chain !== "TRON") continue;
    const address = row.address.startsWith("0x") ? row.address.toLowerCase() : await tronBase58ToHex(row.address);
    const amount = Number(row.frozen_balance);
    if (!address || !Number.isFinite(amount) || amount < 0) continue;
    balances.set(address.toLowerCase(), amount);
  }
  return balances;
}

function quotedList(values: readonly string[]): string {
  return values.map((value) => sqlString(value)).join(", ");
}

function loadStoredEvents(d1: RemoteD1Client, events: readonly FrozenManifestEvent[]): StoredEvent[] {
  if (events.length === 0) return [];
  const txHashes = [...new Set(events.map((event) => event.txHash))];
  const rows: StoredEvent[] = [];
  for (let index = 0; index < txHashes.length; index += 80) {
    const chunk = txHashes.slice(index, index + 80);
    rows.push(
      ...d1.query<StoredEvent>(
        `SELECT id, tx_hash, event_type, event_signature, address, block_number, timestamp,
              amount_native, source_event_index
       FROM blacklist_events
       WHERE chain_id = 'tron' AND tx_hash IN (${quotedList(chunk)})`,
      ),
    );
  }
  return [...new Map(rows.map((row) => [row.id, row])).values()];
}

function verifyEvents(expected: readonly FrozenManifestEvent[], stored: readonly StoredEvent[]): EventVerification {
  const rowsById = new Map(stored.map((row) => [row.id, row]));
  const missingIds: string[] = [];
  const identityConflicts: string[] = [];
  let duplicateIdentityCount = 0;
  let destroyedAmountRaw = 0n;
  for (const event of expected) {
    const row = rowsById.get(event.id);
    if (!row) {
      missingIds.push(event.id);
    } else {
      const expectedAmount = event.amountRaw ? amountRawToNative(event.amountRaw) : null;
      const amountMatches =
        expectedAmount == null
          ? true
          : row.amount_native != null && Math.abs(row.amount_native - expectedAmount) < 0.0000005;
      if (
        row.tx_hash.toLowerCase() !== event.txHash ||
        row.event_type !== event.eventType ||
        row.event_signature !== event.eventSignature ||
        row.address.toLowerCase() !== event.address ||
        row.block_number !== event.blockNumber ||
        row.timestamp !== Math.floor(event.blockTimestampMs / 1000) ||
        (row.source_event_index != null && row.source_event_index !== event.eventIndex) ||
        !amountMatches
      ) {
        identityConflicts.push(event.id);
      }
      if (event.eventType === "destroy" && row.amount_native != null) {
        destroyedAmountRaw += BigInt(Math.round(row.amount_native * 10 ** USDT_DECIMALS));
      }
    }
    const matchingIdentity = stored.filter(
      (candidate) =>
        candidate.tx_hash.toLowerCase() === event.txHash &&
        candidate.event_signature === event.eventSignature &&
        candidate.address.toLowerCase() === event.address &&
        candidate.block_number === event.blockNumber,
    );
    if (matchingIdentity.length > 1) duplicateIdentityCount += matchingIdentity.length - 1;
  }
  return {
    presentCount: expected.length - missingIds.length,
    missingIds,
    duplicateIdentityCount,
    identityConflicts,
    destroyedAmountRaw: destroyedAmountRaw.toString(),
  };
}

function loadCursorRows(d1: RemoteD1Client): { tron: CursorRow | null; arbitrum: CursorRow[] } {
  const rows = d1.query<CursorRow>(
    `SELECT config_key, cursor_value, last_block, last_observed_safe_head
     FROM blacklist_sync_state
     WHERE config_key = ${sqlString(manifest.configKey)} OR config_key LIKE 'arbitrum-%'`,
  );
  return {
    tron: rows.find((row) => row.config_key === manifest.configKey) ?? null,
    arbitrum: rows.filter((row) => row.config_key.startsWith("arbitrum-")),
  };
}

function buildBalanceExpectations(
  events: readonly FrozenManifestEvent[],
  currentAmounts: ReadonlyMap<string, number>,
  observedAt: number,
): { expectations: BalanceExpectation[]; unresolved: string[] } {
  const latest = new Map<string, FrozenManifestEvent>();
  for (const event of sortEvents(events)) latest.set(event.address, event);
  const expectations: BalanceExpectation[] = [];
  const unresolved: string[] = [];
  for (const event of latest.values()) {
    if (event.eventType === "unblacklist") continue;
    if (event.eventType === "destroy" && event.amountRaw) {
      expectations.push({
        address: event.address,
        amountNative: amountRawToNative(event.amountRaw),
        source: "destroy_event",
        observedAt: Math.floor(event.blockTimestampMs / 1000),
      });
      continue;
    }
    const currentAmount = currentAmounts.get(event.address);
    if (currentAmount == null) {
      unresolved.push(event.address);
      continue;
    }
    expectations.push({
      address: event.address,
      amountNative: currentAmount,
      source: "reconciliation_current_balance",
      observedAt,
    });
  }
  return { expectations, unresolved };
}

function loadStoredBalances(d1: RemoteD1Client, addresses: readonly string[]): StoredBalance[] {
  if (addresses.length === 0) return [];
  const rows: StoredBalance[] = [];
  for (let index = 0; index < addresses.length; index += 80) {
    const chunk = addresses.slice(index, index + 80).map((address) => address.toLowerCase());
    rows.push(
      ...d1.query<StoredBalance>(
        `SELECT address, amount_native, source, config_key, contract_address
       FROM blacklist_current_balances
       WHERE stablecoin = 'USDT' AND chain_id = 'tron'
         AND LOWER(address) IN (${quotedList(chunk)})`,
      ),
    );
  }
  return rows;
}

function verifyBalances(
  expectations: readonly BalanceExpectation[],
  stored: readonly StoredBalance[],
): BalanceVerification {
  const byAddress = new Map<string, StoredBalance[]>();
  for (const row of stored) {
    if (row.config_key !== manifest.configKey || row.contract_address !== manifest.contractAddress) continue;
    const address = row.address.toLowerCase();
    const matches = byAddress.get(address) ?? [];
    matches.push(row);
    byAddress.set(address, matches);
  }
  const mismatches: string[] = [];
  for (const expectation of expectations) {
    const rows = byAddress.get(expectation.address.toLowerCase()) ?? [];
    if (
      rows.length !== 1
      || rows[0]!.amount_native == null
      || Math.abs(rows[0]!.amount_native - expectation.amountNative) >= 0.0000005
    ) {
      mismatches.push(expectation.address);
    }
  }
  return {
    expectedCount: expectations.length,
    matchingCount: expectations.length - mismatches.length,
    mismatches,
  };
}

function eventUpsertStatement(
  event: FrozenManifestEvent,
  runId: string,
  observedAt: number,
  belongsToManifest: boolean,
): string {
  const amountNative = event.amountRaw ? amountRawToNative(event.amountRaw) : null;
  const timestamp = Math.floor(event.blockTimestampMs / 1000);
  const methodologyVersion = getBlacklistTrackerMethodologyVersionAt(timestamp);
  const amountSource = amountNative == null ? "unavailable" : "event";
  const amountStatus = amountNative == null ? "recoverable_pending" : "resolved";
  return `INSERT INTO blacklist_events
    (id, stablecoin, chain_id, chain_name, event_type, address, amount, amount_native,
     amount_usd_at_event, amount_source, amount_status, tx_hash, block_number, timestamp,
     methodology_version, contract_address, config_key, event_signature, event_topic0,
     suppression_reason, amount_attempt_count, amount_last_attempted_at, amount_last_error_class,
     amount_last_provider, explorer_tx_url, explorer_address_url, reconciliation_manifest_id,
     reconciliation_run_id, provenance_source, provenance_observed_at, source_event_index)
   VALUES (${sqlString(event.id)}, 'USDT', 'tron', 'Tron', ${sqlString(event.eventType)},
     ${sqlString(event.address)}, ${amountNative ?? "NULL"}, ${amountNative ?? "NULL"},
     ${amountNative ?? "NULL"}, ${sqlString(amountSource)}, ${sqlString(amountStatus)},
     ${sqlString(event.txHash)}, ${event.blockNumber}, ${timestamp}, ${sqlString(methodologyVersion)},
     ${sqlString(manifest.contractAddress)}, ${sqlString(manifest.configKey)},
     ${sqlString(event.eventSignature)}, NULL, NULL, 0, NULL, NULL, NULL,
     ${sqlString(`https://tronscan.org/#/transaction/${event.txHash}`)},
     ${sqlString(`https://tronscan.org/#/address/${event.address}`)},
     ${belongsToManifest ? sqlString(manifest.manifestId) : "NULL"}, ${sqlString(runId)},
     'night-watch-reconciliation:trongrid', ${observedAt}, ${event.eventIndex})
   ON CONFLICT(id) DO UPDATE SET
     reconciliation_manifest_id = COALESCE(blacklist_events.reconciliation_manifest_id, excluded.reconciliation_manifest_id),
     reconciliation_run_id = excluded.reconciliation_run_id,
     provenance_source = COALESCE(blacklist_events.provenance_source, excluded.provenance_source),
     provenance_observed_at = COALESCE(blacklist_events.provenance_observed_at, excluded.provenance_observed_at),
     source_event_index = COALESCE(blacklist_events.source_event_index, excluded.source_event_index);`;
}

function balanceUpsertStatement(expectation: BalanceExpectation, observedAt: number): string {
  const id = buildBlacklistContractBalanceKey(
    "USDT",
    "tron",
    expectation.address,
    manifest.configKey,
    manifest.contractAddress,
  );
  return `INSERT INTO blacklist_current_balances
    (id, stablecoin, chain_id, address, config_key, contract_address, amount_native, amount_usd,
     source, status, observed_at, last_successful_observed_at, attempt_count, last_attempted_at,
     last_error_class, consecutive_failures)
   VALUES (${sqlString(id)}, 'USDT', 'tron', ${sqlString(expectation.address)},
     ${sqlString(manifest.configKey)}, ${sqlString(manifest.contractAddress)},
     ${expectation.amountNative}, ${expectation.amountNative}, ${sqlString(expectation.source)},
     'resolved', ${expectation.observedAt}, ${expectation.observedAt}, 1, ${observedAt}, NULL, 0)
   ON CONFLICT(id) DO UPDATE SET
     config_key = excluded.config_key,
     contract_address = excluded.contract_address,
     amount_native = excluded.amount_native,
     amount_usd = excluded.amount_usd,
     source = excluded.source,
     status = 'resolved',
     observed_at = excluded.observed_at,
     last_successful_observed_at = excluded.observed_at,
     attempt_count = blacklist_current_balances.attempt_count + 1,
     last_attempted_at = excluded.last_attempted_at,
     last_error_class = NULL,
     consecutive_failures = 0
   WHERE COALESCE(blacklist_current_balances.observed_at, 0) <= excluded.observed_at
     AND COALESCE(blacklist_current_balances.last_attempted_at, 0) <= excluded.last_attempted_at
     AND (
       COALESCE(blacklist_current_balances.observed_at, 0) < excluded.observed_at
       OR COALESCE(blacklist_current_balances.last_attempted_at, 0) < excluded.last_attempted_at
       OR (
         blacklist_current_balances.amount_native IS excluded.amount_native
         AND blacklist_current_balances.amount_usd IS excluded.amount_usd
         AND blacklist_current_balances.source = excluded.source
         AND blacklist_current_balances.config_key = excluded.config_key
         AND blacklist_current_balances.contract_address = excluded.contract_address
       )
     );`;
}

function cursorValue(row: CursorRow | null): number | null {
  if (!row) return null;
  return Math.max(row.last_block ?? 0, row.cursor_value ?? 0);
}

function summarizeArbitrum(rows: readonly CursorRow[]): ReconciliationSummary["arbitrum"] {
  const cursors = rows.map((row) => cursorValue(row)).filter((value): value is number => value != null);
  const safeHeads = rows.map((row) => row.last_observed_safe_head).filter((value): value is number => value != null);
  return {
    configCount: rows.length,
    atSafeHeadCount: rows.filter((row) => {
      const cursor = cursorValue(row);
      return cursor != null && row.last_observed_safe_head != null && cursor >= row.last_observed_safe_head;
    }).length,
    minCursor: cursors.length > 0 ? Math.min(...cursors) : null,
    minSafeHead: safeHeads.length === rows.length && safeHeads.length > 0 ? Math.min(...safeHeads) : null,
  };
}

function auditRunStatement(args: {
  runId: string;
  mode: "apply";
  status: "running" | "verified" | "failed";
  bookmark: string;
  expectedCount: number;
  upstreamCount: number;
  eventVerification: EventVerification;
  insertedCount: number;
  balanceVerification: BalanceVerification;
  unresolvedCount: number;
  cursorBefore: number | null;
  cursorAfter: number | null;
  safeHead: number;
  arbitrum: ReconciliationSummary["arbitrum"];
  startedAt: number;
  completedAt: number | null;
  verificationJson: string;
}): string {
  return `INSERT INTO blacklist_reconciliation_runs
    (run_id, manifest_id, manifest_sha256, mode, status, time_travel_bookmark,
     expected_event_count, upstream_event_count, present_event_count, inserted_event_count,
     missing_event_count, duplicate_identity_count, expected_destroyed_amount_raw,
     actual_destroyed_amount_raw, balance_replay_expected_count, balance_replay_matching_count,
     unresolved_manifest_gap_count, tron_cursor_before, tron_cursor_after, tron_safe_head,
     arbitrum_min_cursor, arbitrum_min_safe_head, arbitrum_expected_config_count,
     arbitrum_at_safe_head_count, verification_json, started_at, completed_at)
   VALUES (${sqlString(args.runId)}, ${sqlString(manifest.manifestId)}, ${sqlString(manifest.eventsSha256)},
     ${sqlString(args.mode)}, ${sqlString(args.status)}, ${sqlString(args.bookmark)},
     ${args.expectedCount}, ${args.upstreamCount}, ${args.eventVerification.presentCount},
     ${args.insertedCount}, ${args.eventVerification.missingIds.length},
     ${args.eventVerification.duplicateIdentityCount}, ${manifest.expected.destroyedAmountRaw},
     ${args.eventVerification.destroyedAmountRaw}, ${args.balanceVerification.expectedCount},
     ${args.balanceVerification.matchingCount}, ${args.unresolvedCount},
     ${args.cursorBefore ?? "NULL"}, ${args.cursorAfter ?? "NULL"}, ${args.safeHead},
     ${args.arbitrum.minCursor ?? "NULL"}, ${args.arbitrum.minSafeHead ?? "NULL"},
     ${REQUIRED_ARBITRUM_CONFIG_COUNT}, ${args.arbitrum.atSafeHeadCount},
     ${sqlString(args.verificationJson)}, ${args.startedAt}, ${args.completedAt ?? "NULL"})
   ON CONFLICT(run_id) DO UPDATE SET
     status = excluded.status,
     present_event_count = excluded.present_event_count,
     inserted_event_count = excluded.inserted_event_count,
     missing_event_count = excluded.missing_event_count,
     duplicate_identity_count = excluded.duplicate_identity_count,
     actual_destroyed_amount_raw = excluded.actual_destroyed_amount_raw,
     balance_replay_expected_count = excluded.balance_replay_expected_count,
     balance_replay_matching_count = excluded.balance_replay_matching_count,
     unresolved_manifest_gap_count = excluded.unresolved_manifest_gap_count,
     tron_cursor_after = excluded.tron_cursor_after,
     tron_safe_head = excluded.tron_safe_head,
     arbitrum_min_cursor = excluded.arbitrum_min_cursor,
     arbitrum_min_safe_head = excluded.arbitrum_min_safe_head,
     arbitrum_expected_config_count = excluded.arbitrum_expected_config_count,
     arbitrum_at_safe_head_count = excluded.arbitrum_at_safe_head_count,
     verification_json = excluded.verification_json,
     completed_at = excluded.completed_at;`;
}

export async function runNightWatchBlacklistReconciliation(
  options: ReconciliationOptions,
  dependencies: ReconciliationDependencies = {},
): Promise<ReconciliationSummary> {
  validateFrozenManifest();
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const nowMs = dependencies.now?.() ?? Date.now();
  const startedAt = Math.floor(nowMs / 1000);
  const safeHeadMs = Math.max(manifest.cutoffInclusive, nowMs - TRON_INDEXING_SAFETY_MS);
  const loadFrozenEvents =
    dependencies.loadFrozenEvents ??
    (() =>
      fetchTronInterval(
        fetchImpl,
        manifest.cursorExclusive,
        manifest.cutoffInclusive,
        options.timeoutMs,
        options.trongridApiKey,
      ));
  const loadTailEvents =
    dependencies.loadTailEvents ??
    ((toInclusive) =>
      fetchTronInterval(fetchImpl, manifest.cursorExclusive, toInclusive, options.timeoutMs, options.trongridApiKey));
  const loadBalanceAmounts =
    dependencies.loadBalanceAmounts ??
    (() => loadKycRipTronBalances(fetchImpl, options.timeoutMs, options.balanceProviderUrl));

  const upstreamFrozen = sortEvents(await loadFrozenEvents());
  if (sha256(canonicalEvents(upstreamFrozen)) !== manifest.eventsSha256) {
    throw new Error("Live confirmed Tron events no longer match the frozen audited manifest");
  }
  const upstreamTail = sortEvents(await loadTailEvents(safeHeadMs));
  const frozenIds = new Set(manifest.events.map((event) => event.id));
  const tailIds = new Set(upstreamTail.map((event) => event.id));
  const omittedFrozenIds = [...frozenIds].filter((id) => !tailIds.has(id));
  if (omittedFrozenIds.length > 0) {
    throw new Error(`Live recovery interval omitted ${omittedFrozenIds.length} frozen event(s)`);
  }
  const currentAmounts = await loadBalanceAmounts();
  const { expectations, unresolved: unresolvedBalanceSources } = buildBalanceExpectations(
    upstreamTail,
    currentAmounts,
    startedAt,
  );
  if (unresolvedBalanceSources.length > 0) {
    throw new Error(
      `Balance replay lacks a confirmed amount for ${unresolvedBalanceSources.length} active address(es)`,
    );
  }

  const d1 = dependencies.d1 ?? createRemoteD1Client(options.database);
  const storedBefore = loadStoredEvents(d1, manifest.events);
  const eventsBefore = verifyEvents(manifest.events, storedBefore);
  if (eventsBefore.duplicateIdentityCount > 0 || eventsBefore.identityConflicts.length > 0) {
    throw new Error("Existing D1 event identities conflict with the frozen manifest; refusing automatic mutation");
  }
  const cursorRowsBefore = loadCursorRows(d1);
  const tronCursorBefore = cursorValue(cursorRowsBefore.tron);
  const balancesBefore = verifyBalances(
    expectations,
    loadStoredBalances(
      d1,
      expectations.map((item) => item.address),
    ),
  );
  const arbitrumBefore = summarizeArbitrum(cursorRowsBefore.arbitrum);

  if (!options.apply) {
    const unresolved =
      eventsBefore.missingIds.length +
      eventsBefore.duplicateIdentityCount +
      eventsBefore.identityConflicts.length +
      balancesBefore.mismatches.length +
      (tronCursorBefore != null && tronCursorBefore >= safeHeadMs ? 0 : 1) +
      Math.max(0, arbitrumBefore.configCount - arbitrumBefore.atSafeHeadCount);
    const summary: ReconciliationSummary = {
      mode: "dry-run",
      status:
        eventsBefore.duplicateIdentityCount === 0 && eventsBefore.identityConflicts.length === 0 ? "ready" : "blocked",
      runId: null,
      manifestId: manifest.manifestId,
      manifestSha256: manifest.eventsSha256,
      bookmarkVerified: false,
      expectedEventCount: manifest.expected.eventCount,
      upstreamFrozenEventCount: upstreamFrozen.length,
      upstreamTailEventCount: upstreamTail.length,
      presentEventCount: eventsBefore.presentCount,
      insertedEventCount: 0,
      missingEventCount: eventsBefore.missingIds.length,
      duplicateIdentityCount: eventsBefore.duplicateIdentityCount,
      identityConflictCount: eventsBefore.identityConflicts.length,
      destroyedAmountExpectedRaw: manifest.expected.destroyedAmountRaw,
      destroyedAmountActualRaw: eventsBefore.destroyedAmountRaw,
      balanceReplayExpectedCount: balancesBefore.expectedCount,
      balanceReplayMatchingCount: balancesBefore.matchingCount,
      unresolvedManifestGapCount: unresolved,
      tron: {
        cursorBefore: tronCursorBefore,
        cursorAfter: tronCursorBefore,
        safeHead: safeHeadMs,
        atSafeHead: tronCursorBefore != null && tronCursorBefore >= safeHeadMs,
      },
      arbitrum: arbitrumBefore,
      samples: {
        missingIds: eventsBefore.missingIds.slice(0, 10),
        identityConflicts: eventsBefore.identityConflicts.slice(0, 10),
        balanceMismatches: balancesBefore.mismatches.slice(0, 10),
      },
    };
    dependencies.log?.(JSON.stringify(summary, null, 2));
    return summary;
  }

  const bookmark = options.timeTravelBookmark!;
  const verifyBookmark = dependencies.verifyBookmark ?? verifyCurrentTimeTravelBookmark;
  if (!verifyBookmark(options.database, bookmark)) {
    throw new Error("Provided Time Travel bookmark is not the current D1 bookmark");
  }
  const runId = `${manifest.manifestId}:${bookmark}`;
  const insertedCount = eventsBefore.missingIds.length;
  const initialBalanceVerification: BalanceVerification = {
    expectedCount: expectations.length,
    matchingCount: balancesBefore.matchingCount,
    mismatches: balancesBefore.mismatches,
  };
  const runningVerification = JSON.stringify({ phase: "mutation", tailEventCount: upstreamTail.length });
  const statements = [
    auditRunStatement({
      runId,
      mode: "apply",
      status: "running",
      bookmark,
      expectedCount: manifest.expected.eventCount,
      upstreamCount: upstreamFrozen.length,
      eventVerification: eventsBefore,
      insertedCount,
      balanceVerification: initialBalanceVerification,
      unresolvedCount: eventsBefore.missingIds.length + balancesBefore.mismatches.length,
      cursorBefore: tronCursorBefore,
      cursorAfter: tronCursorBefore,
      safeHead: safeHeadMs,
      arbitrum: arbitrumBefore,
      startedAt,
      completedAt: null,
      verificationJson: runningVerification,
    }),
    ...upstreamTail.map((event) => eventUpsertStatement(event, runId, startedAt, frozenIds.has(event.id))),
    ...expectations.map((expectation) => balanceUpsertStatement(expectation, startedAt)),
    `UPDATE blacklist_sync_state
     SET last_block = MAX(last_block, ${safeHeadMs}),
         cursor_value = MAX(COALESCE(cursor_value, 0), ${safeHeadMs}),
         cursor_kind = 'tron_timestamp_ms',
         last_observed_safe_head = MAX(COALESCE(last_observed_safe_head, 0), ${safeHeadMs}),
         last_safe_head_observed_at = ${startedAt}
     WHERE config_key = ${sqlString(manifest.configKey)};`,
  ];
  // Close the bookmark-to-write window immediately before mutation.
  if (!verifyBookmark(options.database, bookmark)) {
    throw new Error("D1 changed after preflight; acquire a fresh Time Travel bookmark and retry");
  }
  d1.executeStatements(statements, "night-watch-blacklist-reconciliation");

  const storedAfter = loadStoredEvents(d1, manifest.events);
  const eventsAfter = verifyEvents(manifest.events, storedAfter);
  const cursorRowsAfter = loadCursorRows(d1);
  const tronCursorAfter = cursorValue(cursorRowsAfter.tron);
  const balancesAfter = verifyBalances(
    expectations,
    loadStoredBalances(
      d1,
      expectations.map((item) => item.address),
    ),
  );
  const arbitrumAfter = summarizeArbitrum(cursorRowsAfter.arbitrum);
  const destroyedMatches = eventsAfter.destroyedAmountRaw === manifest.expected.destroyedAmountRaw;
  const tronAtSafeHead = tronCursorAfter != null && tronCursorAfter >= safeHeadMs;
  const arbitrumMissingOrBehind = Math.max(0, REQUIRED_ARBITRUM_CONFIG_COUNT - arbitrumAfter.atSafeHeadCount);
  const unresolved =
    eventsAfter.missingIds.length +
    eventsAfter.duplicateIdentityCount +
    eventsAfter.identityConflicts.length +
    (destroyedMatches ? 0 : 1) +
    balancesAfter.mismatches.length +
    (tronAtSafeHead ? 0 : 1) +
    arbitrumMissingOrBehind;
  const verified = unresolved === 0;
  const completedAt = Math.floor((dependencies.now?.() ?? Date.now()) / 1000);
  const samples = {
    missingIds: eventsAfter.missingIds.slice(0, 10),
    identityConflicts: eventsAfter.identityConflicts.slice(0, 10),
    balanceMismatches: balancesAfter.mismatches.slice(0, 10),
    arbitrumExpectedConfigs: REQUIRED_ARBITRUM_CONFIG_COUNT,
    arbitrumObservedConfigs: arbitrumAfter.configCount,
    arbitrumAtSafeHeadCount: arbitrumAfter.atSafeHeadCount,
  };
  d1.executeStatements(
    [
      auditRunStatement({
        runId,
        mode: "apply",
        status: verified ? "verified" : "failed",
        bookmark,
        expectedCount: manifest.expected.eventCount,
        upstreamCount: upstreamFrozen.length,
        eventVerification: eventsAfter,
        insertedCount,
        balanceVerification: balancesAfter,
        unresolvedCount: unresolved,
        cursorBefore: tronCursorBefore,
        cursorAfter: tronCursorAfter,
        safeHead: safeHeadMs,
        arbitrum: arbitrumAfter,
        startedAt,
        completedAt,
        verificationJson: JSON.stringify(samples),
      }),
    ],
    "night-watch-blacklist-verification",
  );

  const summary: ReconciliationSummary = {
    mode: "apply",
    status: verified ? "verified" : "failed",
    runId,
    manifestId: manifest.manifestId,
    manifestSha256: manifest.eventsSha256,
    bookmarkVerified: true,
    expectedEventCount: manifest.expected.eventCount,
    upstreamFrozenEventCount: upstreamFrozen.length,
    upstreamTailEventCount: upstreamTail.length,
    presentEventCount: eventsAfter.presentCount,
    insertedEventCount: insertedCount,
    missingEventCount: eventsAfter.missingIds.length,
    duplicateIdentityCount: eventsAfter.duplicateIdentityCount,
    identityConflictCount: eventsAfter.identityConflicts.length,
    destroyedAmountExpectedRaw: manifest.expected.destroyedAmountRaw,
    destroyedAmountActualRaw: eventsAfter.destroyedAmountRaw,
    balanceReplayExpectedCount: balancesAfter.expectedCount,
    balanceReplayMatchingCount: balancesAfter.matchingCount,
    unresolvedManifestGapCount: unresolved,
    tron: {
      cursorBefore: tronCursorBefore,
      cursorAfter: tronCursorAfter,
      safeHead: safeHeadMs,
      atSafeHead: tronAtSafeHead,
    },
    arbitrum: arbitrumAfter,
    samples: {
      missingIds: eventsAfter.missingIds.slice(0, 10),
      identityConflicts: eventsAfter.identityConflicts.slice(0, 10),
      balanceMismatches: balancesAfter.mismatches.slice(0, 10),
    },
  };
  dependencies.log?.(JSON.stringify(summary, null, 2));
  return summary;
}

async function main(): Promise<void> {
  const options = parseReconciliationArgs(process.argv.slice(2));
  if (writeCliHelpIfRequested(options, USAGE)) return;
  await runNightWatchBlacklistReconciliation(options, { log: console.log });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCliEntrypoint(() => main(), { label: "reconcile-night-watch-blacklist", usage: USAGE });
}
