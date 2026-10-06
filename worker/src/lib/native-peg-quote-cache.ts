import { DEPEG_PRIMARY_PRICE_MAX_AGE_SEC } from "@shared/lib/depeg-config";
import { isNativePegEvent, type DepegQuoteDomain } from "@shared/lib/depeg-quote-domain";
import { normalizePegType } from "@shared/lib/peg-rates";
import { PersistedNativePegQuoteSchema, type PersistedNativePegQuote } from "@shared/types/native-peg-quote";
import { throwIfAborted } from "./abort";
import { prepareCacheUpsert } from "./db-cache";
import { batchExecute } from "./d1-primitives";
import type { NativePegQuote } from "./native-peg-quotes";

export const NATIVE_EVENT_QUOTE_CACHE_PREFIX = "depeg-native-quote:";

export function decodeNativeEventQuote(value: string | null): PersistedNativePegQuote | null {
  if (value == null) return null;
  try {
    const parsed = PersistedNativePegQuoteSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Retain the producer's upstream clock, and prevent older runs replacing newer quotes. */
export async function persistActiveNativeEventQuotes(
  db: D1Database,
  quotes: ReadonlyMap<string, NativePegQuote>,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (quotes.size === 0) return;
  const active = await db.prepare(
    `SELECT e.id, e.stablecoin_id, e.peg_type, e.peg_reference, e.source, p.quote_mode
     FROM depeg_events e LEFT JOIN depeg_event_provenance p ON p.event_id = e.id
     WHERE e.ended_at IS NULL`,
  ).all<DepegQuoteDomain & { id: number; stablecoin_id: string }>();
  const now = Math.floor(Date.now() / 1000);
  const statements: D1PreparedStatement[] = [];
  for (const event of active.results ?? []) {
    if (!isNativePegEvent(event)) continue;
    const quote = quotes.get(event.stablecoin_id);
    if (!quote || quote.stablecoinId !== event.stablecoin_id ||
        normalizePegType(event.peg_type) !== `pegged${quote.pegCurrency}`) continue;
    const parsed = PersistedNativePegQuoteSchema.safeParse({
      value: quote.price, observedAt: quote.updatedAt, source: "coingecko",
    });
    if (!parsed.success || parsed.data.observedAt > now ||
        now - parsed.data.observedAt > DEPEG_PRIMARY_PRICE_MAX_AGE_SEC) continue;
    statements.push(prepareCacheUpsert(db, {
      key: `${NATIVE_EVENT_QUOTE_CACHE_PREFIX}${event.id}`,
      value: JSON.stringify(parsed.data),
      updatedAt: parsed.data.observedAt,
    }, "if-newer"));
  }
  // Event-specific quotes are live inputs, not a historical archive.
  statements.push(db.prepare(
    `DELETE FROM cache WHERE key GLOB ?
     AND key NOT IN (SELECT ? || id FROM depeg_events WHERE ended_at IS NULL)`,
  ).bind(`${NATIVE_EVENT_QUOTE_CACHE_PREFIX}*`, NATIVE_EVENT_QUOTE_CACHE_PREFIX));
  await batchExecute(db, statements, { signal });
}
