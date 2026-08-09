import { fnv1a32 } from "@shared/lib/fnv1a";
import type { BatchMessage } from "../../lib/telegram";
import { TELEGRAM_SPLIT_VERSION } from "../../lib/telegram-constants";

/** Base36 FNV-1a, kept compact because the dedupe key is a D1 row key. */
export function hashDedupePart(value: string): string {
  return fnv1a32(value).toString(36);
}

/**
 * Build a stable dedupe key for the pending queue.
 *
 * The hash covers the PRE-split canonical message body (falling back to the
 * chunk HTML only when callers have not plumbed `canonicalHtml` through, e.g.
 * legacy or test paths), tagged with {@link TELEGRAM_SPLIT_VERSION} so any
 * future change to the chunking algorithm cleanly invalidates old rows rather
 * than orphaning them. The chunk index keeps split parts distinct.
 */
export function buildDedupeKey(message: BatchMessage, splitVersion: number = TELEGRAM_SPLIT_VERSION): string {
  const canonical = message.canonicalHtml ?? message.html;
  return `${message.chatId}:v${splitVersion}:${message.chunkIndex ?? 0}:${hashDedupePart(canonical)}`;
}
