import {
  isTelegramRecapFactType,
  type TelegramRecapFactFamily,
  type TelegramRecapFactType,
} from "@shared/lib/telegram-recap-policy";
import { WORKER_ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { isFiniteNumber } from "@shared/lib/type-guards";
import { parseJsonObject } from "./json-parse";

export type TelegramRecapSeverity = "critical" | "warning" | "notice" | "info";

export interface TelegramRecapTapeRow {
  event_id: string;
  type: string;
  severity: string;
  ts: number;
  coin_id: string | null;
  chain?: string | null;
  payload_json: string;
}

export interface TelegramRecapFact {
  eventId: string;
  type: TelegramRecapFactType;
  family: TelegramRecapFactFamily;
  severity: TelegramRecapSeverity;
  ts: number;
  coinId: string;
  symbol: string;
  name: string;
  chain: string | null;
  payload: Record<string, unknown>;
}

function factFamily(type: TelegramRecapFactType): TelegramRecapFactFamily {
  if (type.startsWith("depeg.")) return "depeg";
  if (type.startsWith("dews.")) return "dews";
  if (type.startsWith("score.")) return "score";
  if (type.startsWith("freeze.")) return "freeze";
  if (type.startsWith("mint_burn.")) return "mint_burn";
  return "yield";
}

function parseSeverity(value: string): TelegramRecapSeverity | null {
  if (value === "critical" || value === "severe") return "critical";
  if (value === "warning" || value === "notice" || value === "info") return value;
  return null;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasSupportedPayload(type: TelegramRecapFactType, payload: Record<string, unknown>): boolean {
  switch (type) {
    case "depeg.opened":
    case "depeg.peak_worsened":
    case "depeg.resolved":
      return isString(payload.direction) && isFiniteNumber(payload.absDeviationBps);
    case "dews.escalated":
    case "dews.deescalated":
      return isString(payload.prevBand) && isString(payload.newBand);
    case "score.upgraded":
    case "score.downgraded":
      return isString(payload.prevGrade) && isString(payload.newGrade);
    case "freeze.blocked":
    case "freeze.unblocked":
    case "freeze.destroyed":
      return isString(payload.chainName) || isString(payload.chainId);
    case "mint_burn.large_mint":
    case "mint_burn.large_burn":
      return payload.amountUsd == null || isFiniteNumber(payload.amountUsd);
    case "yield.warning_emitted":
      return Array.isArray(payload.signals) || Array.isArray(payload.newSignals);
    case "yield.pys_dropped":
      return isFiniteNumber(payload.prevScore) && isFiniteNumber(payload.newScore);
  }
}

/**
 * Parse one immutable Tape row into a recap-safe fact. Unknown types, stale
 * ids, inactive catalog entries, malformed JSON, and incomplete payloads fail
 * closed. No inference, fetch, or database work occurs in this function.
 */
export function parseTelegramRecapFact(row: TelegramRecapTapeRow): TelegramRecapFact | null {
  if (!isTelegramRecapFactType(row.type) || !isString(row.event_id) || !isFiniteNumber(row.ts)) return null;
  if (!isString(row.coin_id)) return null;
  const coin = WORKER_ACTIVE_META_BY_ID.get(row.coin_id);
  if (!coin) return null;
  const severity = parseSeverity(row.severity);
  if (!severity) return null;
  const payload = parseJsonObject(row.payload_json);
  if (!payload || !hasSupportedPayload(row.type, payload)) return null;

  return {
    eventId: row.event_id,
    type: row.type,
    family: factFamily(row.type),
    severity,
    ts: row.ts,
    coinId: coin.id,
    symbol: coin.symbol,
    name: coin.name,
    chain: typeof row.chain === "string" && row.chain.trim() ? row.chain : null,
    payload,
  };
}

export function parseTelegramRecapFacts(rows: readonly TelegramRecapTapeRow[]): TelegramRecapFact[] {
  return rows.flatMap((row) => {
    const fact = parseTelegramRecapFact(row);
    return fact ? [fact] : [];
  });
}
