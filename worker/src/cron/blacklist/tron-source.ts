import { BlacklistDecodeError, quarantineBlacklistDecodeFailure } from "../../lib/blacklist/decode-quarantine";
import { logWorkerEventArgs } from "../../lib/structured-log";
import { TronEventsResponseSchema } from "../../lib/external-api-schemas";
import type { ContractEventConfig } from "../../lib/blacklist-contracts";
import { getBlacklistEventBySignature } from "../../lib/blacklist-contracts";
import { type RateLimitedFetch } from "../../lib/evm-logs";
import { fetchJsonWithRetry } from "../../lib/fetch-retry";
import { decimalNumberFromBigInt } from "../../lib/bigint";
import { FetchRequestNotStartedError, throwIfAborted } from "../../lib/abort";
import { buildBlacklistRow, type BlacklistRow, type BlacklistScanCoverageOutcome, type TronScanTelemetry } from "../../lib/blacklist/shared";
import { blacklistRuntimeBudgetReached, blacklistSubrequestBudgetReached, type BlacklistRunBudget } from "../../lib/blacklist/run-budget";
import { logWorkerEvent } from "../../lib/structured-log";
import { canonicalTronAddress } from "@shared/lib/tron-address";

interface TronEventResult {
  block_number: number;
  block_timestamp: number;
  transaction_id: string;
  event_index: number;
  event_name: string;
  result: Record<string, string>;
}

interface TronEventsResponse {
  data: TronEventResult[];
  meta?: { links?: { next?: string } };
  success: boolean;
}

const TRONGRID_ORIGIN = "https://api.trongrid.io";
export const TRON_INDEXING_SAFETY_MS = 15 * 60_000;
const MAX_TRON_PAGES_PER_EVENT = 100;
const MAX_TRON_PAGINATION_URL_LENGTH = 4_096;

export interface FetchTronEventsIncrementalResult {
  rows: BlacklistRow[];
  maxBlock: number;
  scannedToTimestamp: number | null;
  safeHead: number;
  incomplete: boolean;
  apiError: boolean;
  /** Local budget/deadline admission stopped the scan before provider evidence. */
  localBudgetStop?: boolean;
  topicCount: number;
  coveredTopicCount: number;
  providerCalls: number;
  usedRpcLogs?: boolean;
  maxSplitDepth?: number;
  failureSamples?: string[];
  coverageOutcome?: BlacklistScanCoverageOutcome;
  tronRpc?: TronScanTelemetry;
}

export function validateTronPaginationUrl(
  candidate: string,
  contractAddress: string,
  eventName: string,
): string | null {
  if (candidate.length === 0 || candidate.length > MAX_TRON_PAGINATION_URL_LENGTH) return null;
  try {
    const url = new URL(candidate, TRONGRID_ORIGIN);
    const expectedPath = `/v1/contracts/${contractAddress}/events`;
    if (
      url.protocol !== "https:" ||
      url.origin !== TRONGRID_ORIGIN ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== "" ||
      url.pathname !== expectedPath ||
      url.searchParams.get("event_name") !== eventName
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function buildTronEventsUrl(args: {
  contractAddress: string;
  eventName: string;
  lastTimestampMs: number;
  safeHead: number;
  fingerprint?: string;
}): string {
  const url = new URL(`/v1/contracts/${args.contractAddress}/events`, TRONGRID_ORIGIN);
  url.searchParams.set("event_name", args.eventName);
  url.searchParams.set("limit", "200");
  url.searchParams.set("order_by", "block_timestamp,asc");
  url.searchParams.set("only_confirmed", "true");
  if (args.lastTimestampMs > 0) url.searchParams.set("min_block_timestamp", String(args.lastTimestampMs));
  url.searchParams.set("max_block_timestamp", String(args.safeHead));
  if (args.fingerprint) url.searchParams.set("fingerprint", args.fingerprint);
  return url.toString();
}

export function parseTronEvent(config: ContractEventConfig, evt: TronEventResult): BlacklistRow | null {
  const eventDef = getBlacklistEventBySignature(config, evt.event_name);
  if (!eventDef) return null;
  const eventType = eventDef.eventType;
  if (!/^[0-9a-f]{64}$/i.test(evt.transaction_id)
    || !Number.isSafeInteger(evt.event_index) || evt.event_index < 0
    || !Number.isSafeInteger(evt.block_number) || evt.block_number < 0
    || !Number.isSafeInteger(evt.block_timestamp) || evt.block_timestamp < 0) {
    throw new BlacklistDecodeError("invalid-log-identity");
  }

  // A configured field is required; legacy Tether names may use positional "0".
  const affectedAddress = canonicalTronAddress(eventDef.tronResultKey
    ? (evt.result[eventDef.tronResultKey] ?? "")
    : (evt.result._user || evt.result._blackListedUser || evt.result["0"] || ""));
  if (!affectedAddress) throw new BlacklistDecodeError("invalid-address");
  // Every configured Tron amount is the final uint256; USD1 has preceding indexed addresses.
  const amountPosition = eventDef.signature.slice(eventDef.signature.indexOf("(") + 1, -1).split(",").length - 1;
  const rawAmountStr = evt.result._balance || evt.result._value || evt.result.amount || evt.result[String(amountPosition)];
  const amount =
    eventDef.hasAmount && rawAmountStr && /^[0-9]+$/.test(rawAmountStr)
      ? decimalNumberFromBigInt(BigInt(rawAmountStr), config.decimals) : null;
  const timestamp = Math.floor(evt.block_timestamp / 1000);

  return buildBlacklistRow({
    id: `${config.chain.chainId}-${evt.transaction_id}-${evt.event_index}`,
    stablecoin: config.stablecoin,
    chain: config.chain,
    eventType,
    address: affectedAddress,
    amount,
    txHash: evt.transaction_id,
    blockNumber: evt.block_number,
    timestamp,
    contractAddress: config.contractAddress,
    configKey: config.configKey,
    eventSignature: eventDef.signature,
    eventTopic0: null,
  });
}

/**
 * Fetch Tron events incrementally.
 * NOTE: `lastTimestampMs` is a millisecond timestamp stored in `blacklist_sync_state.last_block`.
 */
export async function fetchTronEventsIncremental(
  config: ContractEventConfig,
  apiKey: string | null,
  lastTimestampMs: number,
  runBudget: BlacklistRunBudget,
  rateLimit: RateLimitedFetch,
  signal?: AbortSignal,
  db?: D1Database,
  safeHeadCeilingMs?: number,
): Promise<FetchTronEventsIncrementalResult> {
  const rows: BlacklistRow[] = [];
  const rowTimestamps = new Map<string, number>();
  let maxBlock = lastTimestampMs;
  let coverageCeiling: number | null = null;
  let incomplete = false;
  let apiError = false;
  let localBudgetStop = false;
  let coveredTopicCount = 0;
  let providerCalls = 0;
  const clockSafeHead = Math.min(safeHeadCeilingMs ?? Infinity, Date.now() - TRON_INDEXING_SAFETY_MS);
  if (lastTimestampMs > clockSafeHead) {
    // A cursor ahead of the clock-derived head cannot be scanned. Sibling
    // sources fail closed here instead of certifying a zero-width covered range.
    return {
      rows: [],
      maxBlock: lastTimestampMs,
      scannedToTimestamp: null,
      safeHead: clockSafeHead,
      incomplete: true,
      apiError: true,
      topicCount: config.events.length,
      coveredTopicCount: 0,
      providerCalls: 0,
      failureSamples: ["cursor-ahead"],
      coverageOutcome: "cursor_ahead",
    };
  }
  const safeHead = clockSafeHead;
  const headers: Record<string, string> = {};
  if (apiKey) headers["TRON-PRO-API-KEY"] = apiKey;

  for (const eventDef of config.events) {
    throwIfAborted(signal);
    if (blacklistRuntimeBudgetReached(runBudget)) {
      incomplete = true;
      localBudgetStop = true;
      break;
    }
    if (blacklistSubrequestBudgetReached(runBudget)) {
      incomplete = true;
      localBudgetStop = true;
      break;
    }

    const eventName = eventDef.signature.split("(")[0];
    let url: string | null = buildTronEventsUrl({
      contractAddress: config.contractAddress,
      eventName,
      lastTimestampMs,
      safeHead,
    });
    const seenUrls = new Set<string>();
    let pageCount = 0;

    while (url) {
      throwIfAborted(signal);
      if (blacklistRuntimeBudgetReached(runBudget)) {
        incomplete = true;
        localBudgetStop = true;
        break;
      }
      if (blacklistSubrequestBudgetReached(runBudget)) {
        incomplete = true;
        localBudgetStop = true;
        break;
      }
      if (pageCount >= MAX_TRON_PAGES_PER_EVENT || seenUrls.has(url)) {
        logWorkerEvent({
          scope: "lib",
          level: "warn",
          event: "sync_blacklist.trongrid_pagination_non_terminal",
          job: "sync-blacklist",
          provider: "trongrid",
          message: "TronGrid pagination did not terminate within its bounded page frontier",
          metadata: {
            configKey: config.configKey,
            eventName,
            pageCount,
            repeatedUrl: seenUrls.has(url),
          },
        });
        apiError = true;
        incomplete = true;
        break;
      }
      seenUrls.add(url);
      pageCount++;

      let admissionDeniedAttempts: number | null = null;
      let lastResponseOk = false;
      const json: TronEventsResponse | null = await rateLimit(async () => {
        const result = await fetchJsonWithRetry<unknown>(url!, { headers, signal }, 2, {
          deadlineMs: runBudget.deadlineMs,
          returnFinalResponse: true,
          onResponse: (response) => {
            lastResponseOk = response.ok;
          },
          beforeRequest: () => {
            if (blacklistRuntimeBudgetReached(runBudget) || blacklistSubrequestBudgetReached(runBudget)) return false;
            runBudget.subrequestBudget.count++;
            providerCalls++;
            return true;
          },
        }).catch((error: unknown) => {
          if (error instanceof FetchRequestNotStartedError) {
            admissionDeniedAttempts = error.attemptsStarted;
            return null;
          }
          throw error;
        });
        if (!result) return null;
        if (!result.response.ok) {
          apiError = true;
          return null;
        }
        const parsed = TronEventsResponseSchema.safeParse(result.body);
        if (!parsed.success) {
          logWorkerEventArgs("handler", "warn", "[blacklist] TronGrid response validation failed:", parsed.error.message);
          apiError = true;
          return null;
        }
        return parsed.data as TronEventsResponse;
      });

      if (!json?.success || !Array.isArray(json.data)) {
        // A bare admission denial, or a healthy page whose body read outlived the
        // deadline, is local budget exhaustion, not TronGrid evidence.
        if (admissionDeniedAttempts != null && (admissionDeniedAttempts === 0 || lastResponseOk)) {
          localBudgetStop = true;
          incomplete = true;
          break;
        }
        apiError = true;
        incomplete = true;
        break;
      }

      for (const evt of json.data) {
        if (evt.block_timestamp > safeHead) continue;
        try {
          const row = parseTronEvent(config, evt);
          if (!row) continue;
          if (evt.block_timestamp > maxBlock) maxBlock = evt.block_timestamp;
          rows.push(row);
          rowTimestamps.set(row.id, evt.block_timestamp);
        } catch (error) {
          if (!(error instanceof BlacklistDecodeError)) throw error;
          const quarantined = db != null && await quarantineBlacklistDecodeFailure(
            db, config.configKey, `${evt.block_number}:${evt.transaction_id}:${evt.event_index}`,
            error.reason, evt, runBudget.deadlineMs,
          );
          if (!quarantined) {
            const ceiling = Number.isSafeInteger(evt.block_timestamp) ? evt.block_timestamp - 1 : lastTimestampMs;
            coverageCeiling = coverageCeiling == null ? ceiling : Math.min(coverageCeiling, ceiling);
          }
        }
      }

      const nextUrl = json.meta?.links?.next;
      if (nextUrl) {
        const validated = validateTronPaginationUrl(nextUrl, config.contractAddress, eventName);
        if (!validated) {
          logWorkerEvent({
            scope: "lib",
            level: "warn",
            event: "sync_blacklist.trongrid_pagination_url_rejected",
            job: "sync-blacklist",
            provider: "trongrid",
            message: "Rejected invalid TronGrid pagination URL",
            metadata: { configKey: config.configKey, eventName, reason: "invalid-url" },
          });
          apiError = true;
          incomplete = true;
          break;
        }
        const fingerprint = new URL(validated).searchParams.get("fingerprint");
        if (!fingerprint) {
          logWorkerEvent({
            scope: "lib",
            level: "warn",
            event: "sync_blacklist.trongrid_pagination_url_rejected",
            job: "sync-blacklist",
            provider: "trongrid",
            message: "Rejected TronGrid pagination URL without a continuation fingerprint",
            metadata: { configKey: config.configKey, eventName, reason: "missing-fingerprint" },
          });
          apiError = true;
          incomplete = true;
          break;
        }
        url = buildTronEventsUrl({
          contractAddress: config.contractAddress,
          eventName,
          lastTimestampMs,
          safeHead,
          fingerprint,
        });
      } else if (json.data.length >= 200) {
        // A saturated page without a continuation cannot prove the unseen tail.
        apiError = true;
        incomplete = true;
        break;
      } else {
        url = null;
      }
    }

    if (incomplete || apiError) break;
    coveredTopicCount++;
  }

  return {
    rows: coverageCeiling == null ? rows : rows.filter((row) => rowTimestamps.get(row.id)! <= coverageCeiling),
    maxBlock: coverageCeiling == null ? maxBlock : Math.min(maxBlock, coverageCeiling),
    scannedToTimestamp: coveredTopicCount === config.events.length ? Math.min(safeHead, coverageCeiling ?? safeHead) : null,
    safeHead,
    incomplete: incomplete || coverageCeiling != null,
    apiError,
    ...(localBudgetStop ? { localBudgetStop: true } : {}),
    topicCount: config.events.length,
    coveredTopicCount,
    providerCalls,
  };
}
